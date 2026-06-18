# `backend/agent/agent.py` 精读(C 档·极详)⭐

> 这是 `run_model` / `run_model_stream` 背后**真正干活**的地方:`Agent` 实现"**模型调用 + 工具循环 +
> tape 记录 + 自动 handoff(上下文溢出恢复)**"。`hook_impl.run_model*` 只是把活转交给它。
> 注意:**模型的实际网络调用在 `llm/graph.py`(LangGraph)**,本文件负责"循环编排 + tape"。

整体结构:
- `Agent.run` / `run_stream` —— 对外入口(非流式 / 流式)。
- `_agent_loop` → `_run_tools_with_auto_handoff` / `_stream_events_with_auto_handoff` —— 多步循环。
- `_run_once` —— 单步:拼系统提示 + 选工具 + 调 `run_step`/`stream_step`。
- `_run_command` —— `/` 内部命令的执行。
- 一堆模块级 helper(解析命令/参数、判上下文溢出错误、抽多模态文本等)。

---

## 顶部:导入与常量

> **整块作用**:导入 + 几个关键常量(继续提示语、$hint 正则、上下文溢出错误的识别正则、自动 handoff 次数)。

```python
"""Republic-driven runtime engine to process prompts."""
#   docstring(历史措辞):处理 prompt 的运行时引擎。

from __future__ import annotations
import asyncio          # 超时控制(asyncio.timeout)
import inspect          # 判断命令处理器返回是否需 await
import re               # 编译几个识别用正则
import shlex            # 把命令行字符串按 shell 规则切词
import time             # 计时(每步 elapsed_ms)
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Collection, Coroutine, Iterable
#   一堆抽象类型注解。
from contextlib import AsyncExitStack
#   流式场景:延迟关闭 fork_tape 上下文(直到流被消费完),用 AsyncExitStack 管理。
from dataclasses import dataclass, replace
#   replace 用于"在不可变 TapeContext 上塞进 state"。
from datetime import UTC, datetime
from functools import cached_property
#   tapes 属性懒构造并缓存。
from pathlib import Path
from typing import Any, Literal, overload

from loguru import logger

from backend.agent.settings import AgentSettings, load_settings          # 配置
from backend.app.framework import CreamyFramework                         # 框架(取 tape store / 系统提示)
from backend.core.engine import ModelEngine, Tape                         # tape 引擎与视图
from backend.core.errors import RepublicError                            # 错误类型
from backend.core.events import AsyncStreamEvents, StreamEvent, StreamState  # 流式三件套
from backend.core.store import AsyncTapeStore, InMemoryTapeStore          # 存储抽象/内存兜底
from backend.core.tape_types import TapeContext
from backend.core.tools import ToolAutoResult, ToolContext               # 工具结果/上下文
from backend.llm.graph import run_step, stream_step                       # ⭐ 真正调模型的两个函数(LangGraph)
from backend.memory.store import ForkTapeStore                           # "可回退/合并"的 tape 包装
from backend.memory.tape import TapeService                              # tape 高层服务(fork/anchor/event/handoff)
from backend.skills.skills import discover_skills, render_skills_prompt   # 技能发现与提示渲染
from backend.tools.tools import REGISTRY, render_tools_prompt             # 全局工具表 + 工具提示渲染
from backend.utils.types import State
from backend.utils.utils import workspace_from_state                      # 从 state 取工作区路径

CONTINUE_PROMPT = "Continue the task."
#   当一步只产生了工具调用(没出最终文本)时,下一步用这句催模型继续。
HINT_RE = re.compile(r"\$([A-Za-z0-9_.-]+)")
#   匹配 prompt 里的 $skillname —— 用户可用 $xxx 显式"点名"展开某技能。
_CONTEXT_LENGTH_PATTERNS = re.compile(
    r"context.{0,20}length|maximum.{0,20}context|token.{0,10}limit|prompt.{0,10}too long|tokens? > \d+ maximum",
    re.IGNORECASE,
)
#   识别"上下文超长/prompt 过长"类错误消息的正则(各家措辞不同,故一网打尽)。
MAX_AUTO_HANDOFF_RETRIES = 1
#   遇到上下文溢出时,自动 handoff(压缩历史)重试的最大次数。
```

---

## 构造 + tapes 服务(懒构造)

> **整块作用**:保存配置与框架引用;`tapes` 懒构造一个 `TapeService`(拿到 tape store、包成可 fork、
> 建 ModelEngine)。

```python
class Agent:
    """Agent that processes prompts using hooks and tools. Backed by republic."""

    def __init__(self, framework: CreamyFramework) -> None:
        self.settings = load_settings()
        #   加载全局配置单例。
        self.framework = framework
        #   保存框架引用(用于取 tape store、系统提示、tape 上下文)。

    @cached_property
    def tapes(self) -> TapeService:
        #   cached_property:首次访问才构造,之后复用同一个 TapeService。
        tape_store = self.framework.get_tape_store()
        #   从 hook 取 tape 存储(出厂 FileTapeStore)。
        if tape_store is None:
            tape_store = InMemoryTapeStore()
            #   没有任何实现就用内存兜底(至少能跑)。
        tape_store = ForkTapeStore(tape_store)
        #   包一层 ForkTapeStore:支持"分叉一份临时 tape、结束再决定是否合并回主 tape"。见 memory/store.md。
        llm = _build_llm(self.settings, tape_store, self.framework.build_tape_context())
        #   建 ModelEngine(只管 tape 存储 + 默认上下文;模型调用在 graph.py)。
        return TapeService(llm, self.settings.home / "tapes", tape_store)
        #   组装高层 tape 服务(fork/anchor/event/handoff 等)。见 memory/tape.md。
```

---

## 两个流式辅助构造器

> **整块作用**:把"同步可迭代"包成 AsyncStreamEvents;以及"在流耗尽后追加一个回调"(用于流结束时关闭
> fork_tape 上下文)。

```python
    @staticmethod
    def _events_from_iterable(iterable: Iterable) -> AsyncStreamEvents:
        async def generator() -> AsyncIterator:
            for item in iterable:
                yield item
                #   把普通可迭代逐个 yield 成异步事件。
        return AsyncStreamEvents(generator())

    @staticmethod
    def _events_with_callback(events: AsyncStreamEvents, callback: Callable[[], Coroutine[Any, Any, Any]]) -> AsyncStreamEvents:
        async def generator() -> AsyncIterator[StreamEvent]:
            async for event in events:
                yield event
                #   先把原事件透传。
            await callback()
            #   流走完后执行回调(如 stack.aclose 关闭 fork_tape)。
        return AsyncStreamEvents(generator(), state=events._state)
        #   复用原 events 的 state(保留 error/usage 终态)。
```

---

## `run`:非流式入口

> **整块作用**:拿到会话 tape、把 state 塞进上下文、在 fork_tape 内执行;`/` 开头走命令,否则进 agent 循环。

```python
    async def run(self, *, session_id, prompt, state, model=None, allowed_skills=None, allowed_tools=None) -> str:
        if not prompt:
            return "error: empty prompt"
            #   空 prompt 直接报错返回。
        tape = self.tapes.session_tape(session_id, workspace_from_state(state))
        #   按会话 id + 工作区拿到该会话的 Tape 视图。
        tape.context = replace(tape.context, state=state)
        #   把本次 turn 的 state 注入 tape 上下文(replace:不可变对象的"改一字段产新副本")。
        merge_back = not session_id.startswith("temp/")
        #   "temp/" 开头的临时会话不合并回主 tape(用完即弃);正常会话要合并。
        async with self.tapes.fork_tape(tape.name, merge_back=merge_back):
            #   分叉一份 tape 工作副本;退出 with 时按 merge_back 决定是否并回主 tape。
            await self.tapes.ensure_bootstrap_anchor(tape.name)
            #   确保有"起始锚点"(没有就建一个,作为历史分段起点)。
            if isinstance(prompt, str) and prompt.strip().startswith("/"):
                return await self._run_command(tape=tape, line=prompt.strip())
                #   "/" 开头 = 内部命令,走命令分支。
            return await self._agent_loop(tape=tape, prompt=prompt, model=model,
                                          allowed_skills=allowed_skills, allowed_tools=allowed_tools)
            #   否则进入多步 agent 循环。
```

---

## `run_stream`:流式入口

> **整块作用**:与 run 类似,但要把 fork_tape 的"关闭"推迟到**流被消费完**——用 AsyncExitStack 进入
> 上下文、再用 `_events_with_callback` 在流末尾 aclose。

```python
    async def run_stream(self, *, session_id, prompt, state, model=None, allowed_skills=None, allowed_tools=None) -> AsyncStreamEvents:
        if not prompt:
            error_events = [
                StreamEvent("text", {"delta": "error: empty prompt"}),
                StreamEvent("final", {"text": "error: empty prompt", "ok": False}),
            ]
            return self._events_from_iterable(error_events)
            #   空 prompt:返回一个"文本+final(ok=False)"的小流。
        tape = self.tapes.session_tape(session_id, workspace_from_state(state))
        tape.context = replace(tape.context, state=state)
        merge_back = not session_id.startswith("temp/")
        #   同 run。
        stack = AsyncExitStack()
        # the fork_tape context manager must not be exited until the last chunk of the stream is consumed.
        await stack.enter_async_context(self.tapes.fork_tape(tape.name, merge_back=merge_back))
        #   关键:用 ExitStack 进入 fork_tape,但**不在本函数里退出**——否则流还没消费完 tape 就被合并/关闭了。
        await self.tapes.ensure_bootstrap_anchor(tape.name)
        if isinstance(prompt, str) and prompt.strip().startswith("/"):
            result = await self._run_command(tape=tape, line=prompt.strip())
            events = self._events_from_iterable([
                StreamEvent("text", {"delta": result}),
                StreamEvent("final", {"text": result, "ok": True}),
            ])
            #   命令:同步执行,把结果包成"文本+final"小流。
        else:
            events = await self._agent_loop(tape=tape, prompt=prompt, model=model,
                                            allowed_skills=allowed_skills, allowed_tools=allowed_tools, stream_output=True)
            #   否则进入流式 agent 循环,得到事件流。
        return self._events_with_callback(events, callback=stack.aclose)
        #   给事件流"挂"一个收尾回调:流被消费完后 aclose 关闭 fork_tape(此时合并才安全)。
```

- **这段是流式正确性的关键**:fork_tape 必须"活到最后一个 chunk 被消费",否则会在生成中途就合并/关闭。

---

## `_run_command`:执行 `/` 内部命令

> **整块作用**:解析命令名与参数,从工具表 REGISTRY 找对应工具执行(找不到就当 bash 跑),计时并把
> 命令执行记成一条 tape 事件。

```python
    async def _run_command(self, tape: Tape, *, line: str) -> str:
        line = line[1:].strip()
        #   去掉开头的 "/"。
        if not line:
            raise ValueError("empty command")
            #   只有 "/" → 报错。
        name, arg_tokens = _parse_internal_command(line)
        #   切出命令名 + 参数 token 列表(shlex 切词)。
        start = time.monotonic()
        #   计时起点。
        context = ToolContext(tape=tape.name, run_id="run_command", state=tape.context.state)
        #   给工具的运行上下文(tape 名、run_id、state)。
        output = ""
        status = "ok"
        try:
            if name not in REGISTRY:
                output = await REGISTRY["bash"].run(context=context, cmd=line)
                #   命令名不是已注册工具 → 整行交给 bash 工具执行(把它当 shell 命令)。
            else:
                args = _parse_args(arg_tokens)
                #   解析 key=value / 位置参数。
                if REGISTRY[name].context:
                    args.kwargs["context"] = context
                    #   该工具是上下文感知的,就注入 context。
                output = REGISTRY[name].run(*args.positional, **args.kwargs)
                #   调用工具。
                if inspect.isawaitable(output):
                    output = await output
                    #   工具可能是 async,按需 await。
        except Exception as exc:
            status = "error"
            output = f"{exc!s}"
            raise
            #   出错:记状态、转存错误文本,然后重抛(由上层处理)。
        else:
            return output if isinstance(output, str) else str(output)
            #   成功:返回字符串结果。
        finally:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            #   耗时(毫秒)。
            output_text = output if isinstance(output, str) else str(output)
            event_payload = {
                "raw": line, "name": name, "status": status, "elapsed_ms": elapsed_ms,
                "output": output_text, "date": datetime.now(UTC).isoformat(),
            }
            await self.tapes.append_event(tape.name, "command", event_payload)
            #   无论成功失败,都把这次命令执行作为一条 "command" 事件记进 tape(可审计/回放)。
```

---

## `_agent_loop`:循环入口(分流式/非流式)

> **整块作用**:记一条 loop.start 事件;据 stream_output 选择"流式循环"或"非流式循环"。前两个 @overload
> 只为给类型检查器精确返回类型。

```python
    @overload
    async def _agent_loop(self, *, tape, prompt, model=..., allowed_skills=..., allowed_tools=..., stream_output: Literal[False] = ...) -> str: ...
    #   重载①:非流式 → 返回 str。
    @overload
    async def _agent_loop(self, *, tape, prompt, model=..., allowed_skills=..., allowed_tools=..., stream_output: Literal[True] = ...) -> AsyncStreamEvents: ...
    #   重载②:流式 → 返回事件流。

    async def _agent_loop(self, *, tape, prompt, model=None, allowed_skills=None, allowed_tools=None, stream_output=False) -> AsyncStreamEvents | str:
        next_prompt: str | list[dict] = prompt
        #   本轮要喂的 prompt(后续步骤可能改成 CONTINUE_PROMPT)。
        display_model = model or self.settings.model
        #   用于日志/事件展示的模型名。
        await self.tapes.append_event(tape.name, "loop.start", {
            "model": display_model, "prompt": prompt,
            "allowed_skills": list(allowed_skills) if allowed_skills else None,
            "allowed_tools": list(allowed_tools) if allowed_tools else None,
        })
        #   记录循环开始(模型、初始 prompt、白名单技能/工具)。
        if stream_output:
            state = StreamState()
            #   流终态容器(后续填 error/usage)。
            iterator = self._stream_events_with_auto_handoff(tape=tape, prompt=next_prompt, state=state,
                model=model, allowed_skills=allowed_skills, allowed_tools=allowed_tools)
            #   建流式循环的异步生成器。
            return AsyncStreamEvents(iterator, state=state)
            #   包成 AsyncStreamEvents 返回(共享同一个 state)。
        else:
            return await self._run_tools_with_auto_handoff(tape=tape, prompt=next_prompt,
                model=model, allowed_skills=allowed_skills, allowed_tools=allowed_tools)
            #   非流式:直接跑循环,返回最终文本。
```

---

## `_run_tools_with_auto_handoff`:非流式多步循环 ⭐

> **整块作用**:最多 `max_steps` 步。每步调 `_run_once`:得到文本就结束;得到工具调用就 continue;遇到
> 上下文溢出错误就自动 handoff(压缩历史)重试一次;其它错误抛出。每步都记 tape 事件。

```python
    async def _run_tools_with_auto_handoff(self, tape, prompt, model=None, allowed_skills=None, allowed_tools=None) -> str:
        auto_handoff_remaining = MAX_AUTO_HANDOFF_RETRIES
        #   剩余自动 handoff 次数。
        display_model = model or self.settings.model
        next_prompt = prompt
        for step in range(1, self.settings.max_steps + 1):
            #   主循环,1..max_steps。
            start = time.monotonic()
            await self.tapes.append_event(tape.name, "loop.step.start", {"step": step, "prompt": next_prompt})
            #   记一步开始。
            try:
                output = await self._run_once(tape=tape, prompt=next_prompt, model=model,
                    allowed_skills=allowed_skills, allowed_tools=allowed_tools)
                #   ⭐ 执行一步(拼提示+选工具+调模型)。
            except Exception as exc:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                logger.exception("llm.call.exception tape={} step={} model={} elapsed_ms={} prompt_chars={} error={}",
                    tape.name, step, display_model, elapsed_ms,
                    len(next_prompt) if isinstance(next_prompt, str) else len(_extract_text_from_parts(next_prompt)), str(exc))
                #   记异常日志(含 prompt 字符数,多模态时抽文本算长度)。
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "error",
                    "error": f"{exc!s}", "date": datetime.now(UTC).isoformat()})
                #   记一步出错事件。
                raise
                #   重抛。
            outcome = _resolve_tool_auto_result(output)
            #   把 _run_once 的结果归一成 _ToolAutoOutcome(text/continue/error)。
            elapsed_ms = int((time.monotonic() - start) * 1000)
            if outcome.kind == "text":
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "ok", "date": datetime.now(UTC).isoformat()})
                return outcome.text
                #   出了最终文本 → 记 ok 并返回,循环结束。
            if outcome.kind == "continue":
                if "context" in tape.context.state:
                    next_prompt = f"{CONTINUE_PROMPT} [context: {tape.context.state['context']}]"
                    #   有上下文就把它带进"继续"提示。
                else:
                    next_prompt = CONTINUE_PROMPT
                    #   否则纯"继续"。
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "continue", "date": datetime.now(UTC).isoformat()})
                continue
                #   只产生了工具调用 → 下一步继续(让模型基于工具结果接着做)。

            if auto_handoff_remaining > 0 and _is_context_length_error(outcome.error):
                #   错误且是"上下文超长",且还有自动 handoff 额度:
                auto_handoff_remaining -= 1
                logger.warning("auto_handoff: context length exceeded ... tape={} step={}", tape.name, step)
                await self.tapes.handoff(tape.name, name="auto_handoff/context_overflow",
                    state={"reason": "context_length_exceeded", "error": outcome.error})
                #   做一次 handoff(写锚点)——之后读历史只取新锚点后,等于截断旧历史。
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "auto_handoff",
                    "error": outcome.error, "date": datetime.now(UTC).isoformat()})
                next_prompt = prompt
                #   用原始 prompt 重试(此时历史已被锚点截短)。
                continue

            await self.tapes.append_event(tape.name, "loop.step", {
                "step": step, "elapsed_ms": elapsed_ms, "status": "error",
                "error": outcome.error, "date": datetime.now(UTC).isoformat()})
            raise RuntimeError(outcome.error)
            #   其它错误(或 handoff 额度用尽)→ 记错误并抛出。

        raise RuntimeError(f"max_steps_reached={self.settings.max_steps}")
        #   循环走满还没出文本 → 报"达到最大步数"。
```

- **核心循环语义**:`text` = 完成;`continue` = 还有工具要跑;`error` + 上下文超长 = 自动压缩重试一次;
  其它 error = 失败。`auto_handoff` 是 Creamy 应对"上下文爆了"的自愈机制。

---

## `_stream_events_with_auto_handoff`:流式多步循环

> **整块作用**:与上面非流式循环**逻辑完全对应**,区别是 `_run_once(stream_output=True)` 返回事件流,
> 本方法**边 yield 事件给上层、边**根据 `final` 事件判定本步 outcome,再决定结束/continue/handoff。

```python
    async def _stream_events_with_auto_handoff(self, tape, prompt, state: StreamState, model=None, allowed_skills=None, allowed_tools=None) -> AsyncGenerator[StreamEvent, None]:
        auto_handoff_remaining = MAX_AUTO_HANDOFF_RETRIES
        next_prompt = prompt
        for step in range(1, self.settings.max_steps + 1):
            start = time.monotonic()
            outcome = _ToolAutoOutcome(kind="text", text="", error="")
            #   本步 outcome 占位(默认 text 空;下面据 final 事件覆盖)。
            await self.tapes.append_event(tape.name, "loop.step.start", {"step": step, "prompt": next_prompt})
            output = await self._run_once(tape=tape, prompt=next_prompt, model=model,
                allowed_skills=allowed_skills, allowed_tools=allowed_tools, stream_output=True)
            #   流式执行一步,得到事件流 output。
            async for event in output:
                yield event
                #   ⭐ 把每个事件实时 yield 给上层(渠道据此 SSE/实时刷新)。
                if event.kind == "error":
                    elapsed_ms = int((time.monotonic() - start) * 1000)
                    await self.tapes.append_event(tape.name, "loop.step", {
                        "step": step, "elapsed_ms": elapsed_ms, "status": "error",
                        "error": event.data.get("message", ""), "date": datetime.now(UTC).isoformat()})
                    #   错误事件 → 记一步错误。
                elif event.kind == "final":
                    outcome = _resolve_final_data(event.data, output.error)
                    #   final 事件 → 据其数据(有无 tool_calls/text)算出本步 outcome。
            state.error = output.error
            state.usage = output.usage
            #   把本步流的终态(错误/用量)写回共享 state。
            elapsed_ms = int((time.monotonic() - start) * 1000)
            if outcome.kind == "text":
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "ok", "date": datetime.now(UTC).isoformat()})
                return
                #   出最终文本 → 记 ok 并结束生成器(流到此为止)。
            if outcome.kind == "continue":
                if "context" in tape.context.state:
                    next_prompt = f"{CONTINUE_PROMPT} [context: {tape.context.state['context']}]"
                else:
                    next_prompt = CONTINUE_PROMPT
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "continue", "date": datetime.now(UTC).isoformat()})
                continue
                #   还有工具 → 继续下一步(同非流式)。
            if auto_handoff_remaining > 0 and _is_context_length_error(outcome.error):
                auto_handoff_remaining -= 1
                logger.warning("auto_handoff: context length exceeded ... tape={} step={}", tape.name, step)
                await self.tapes.handoff(tape.name, name="auto_handoff/context_overflow",
                    state={"reason": "context_length_exceeded", "error": outcome.error})
                await self.tapes.append_event(tape.name, "loop.step", {
                    "step": step, "elapsed_ms": elapsed_ms, "status": "auto_handoff",
                    "error": outcome.error, "date": datetime.now(UTC).isoformat()})
                next_prompt = prompt
                continue
                #   上下文溢出 → 自动 handoff 重试(同非流式)。
            await self.tapes.append_event(tape.name, "loop.step", {
                "step": step, "elapsed_ms": elapsed_ms, "status": "error",
                "error": outcome.error, "date": datetime.now(UTC).isoformat()})
            raise RuntimeError(outcome.error)
            #   其它错误 → 抛出。
        raise RuntimeError(f"max_steps_reached={self.settings.max_steps}")
        #   超步数 → 报错。
```

- 它与 `_run_tools_with_auto_handoff` 是"流式 vs 非流式"的孪生:循环骨架一致,只是结果来源从"返回值"
  变成"遍历事件流 + 读 final"。

---

## 技能提示加载

> **整块作用**:发现工作区可用技能,过滤白名单,识别 prompt 里 `$skill` 点名要展开的技能,渲染成提示。

```python
    def _load_skills_prompt(self, prompt: str, workspace: Path, allowed_skills: set[str] | None = None) -> str:
        skill_index = {
            skill.name.casefold(): skill
            for skill in discover_skills(workspace)
            if allowed_skills is None or skill.name.casefold() in allowed_skills
        }
        #   发现技能并按名建索引;有白名单则只保留白名单内的。
        expanded_skills = set(HINT_RE.findall(prompt)) & set(skill_index.keys())
        #   prompt 里 $xxx 点名的、且确实存在的技能 → 这些要"展开"(给全文而非仅摘要)。
        return render_skills_prompt(list(skill_index.values()), expanded_skills=expanded_skills)
        #   渲染技能提示(展开的给全量,其余给摘要)。见 skills/skills.md。
```

---

## `_run_once`:执行一步 ⭐

> **整块作用**:据白名单选工具,拼系统提示,在超时内调 `stream_step`(流式)或 `run_step`(非流式)——
> 真正的模型网络调用发生在这两个 LangGraph 函数里。

```python
    @overload
    async def _run_once(self, *, tape, prompt, model=..., allowed_skills=..., allowed_tools=..., stream_output: Literal[False] = ...) -> ToolAutoResult: ...
    @overload
    async def _run_once(self, *, tape, prompt, model=..., allowed_skills=..., allowed_tools=..., stream_output: Literal[True] = ...) -> AsyncStreamEvents: ...
    #   两个重载:非流式返回 ToolAutoResult,流式返回事件流。

    async def _run_once(self, *, tape, prompt, model=None, allowed_tools=None, allowed_skills=None, stream_output=False) -> AsyncStreamEvents | ToolAutoResult:
        if allowed_tools is not None:
            allowed_tools = {name.casefold() for name in allowed_tools}
            #   工具白名单归一化(小写)。
        if allowed_skills is not None:
            allowed_skills = {name.casefold() for name in allowed_skills}
            tape.context.state["allowed_skills"] = list(allowed_skills)
            #   技能白名单归一化,并写进 state(供后续/工具读取)。
        if allowed_tools is not None:
            tools = [tool for tool in REGISTRY.values() if tool.name.casefold() in allowed_tools]
            #   有白名单:只取白名单内工具。
        else:
            tools = list(REGISTRY.values())
            #   否则用全部已注册工具。
        system_prompt = self._system_prompt(prompt, state=tape.context.state, allowed_skills=allowed_skills)
        #   拼系统提示(框架系统提示 + 工具提示 + 技能提示)。
        logger.info("llm.call.start tape={} model={} stream_output={} system_prompt_chars={} tools={}",
            tape.name, self.settings.model, stream_output, len(system_prompt), len(tools))
        #   记一次模型调用开始(便于排查)。
        async with asyncio.timeout(self.settings.model_timeout_seconds):
            #   给模型调用套超时(None=不限);超时会抛 TimeoutError 被上层捕获。
            if stream_output:
                return await stream_step(tape=tape, prompt=prompt, system_prompt=system_prompt,
                    tools=tools, model=model, settings=self.settings)
                #   流式:走 graph.stream_step,返回事件流。见 llm/graph.md。
            else:
                return await run_step(  # type: ignore[return-value]  # StepResult 与 ToolAutoResult 鸭子兼容
                    tape=tape, prompt=prompt, system_prompt=system_prompt,
                    tools=tools, model=model, settings=self.settings)
                #   非流式:走 graph.run_step,返回 StepResult(鸭子兼容 ToolAutoResult)。
```

---

## `_system_prompt`:拼系统提示

> **整块作用**:把"框架级系统提示 + 工具说明 + 技能说明"三块拼起来。

```python
    def _system_prompt(self, prompt, state, allowed_skills=None) -> str:
        blocks: list[str] = []
        if result := self.framework.get_system_prompt(prompt=prompt, state=state):
            blocks.append(result)
            #   ① 框架系统提示(广播 system_prompt 拼出来的;含 DEFAULT/AGENTS.md/结构化输出)。
        tools_prompt = render_tools_prompt(REGISTRY.values())
        if tools_prompt:
            blocks.append(tools_prompt)
            #   ② 工具说明(把可用工具渲染成提示)。
        workspace = workspace_from_state(state)
        prompt_text = prompt if isinstance(prompt, str) else _extract_text_from_parts(prompt)
        #   取 prompt 文本(多模态时抽 text 部分,用于 $skill 识别)。
        if skills_prompt := self._load_skills_prompt(prompt_text, workspace, allowed_skills):
            blocks.append(skills_prompt)
            #   ③ 技能说明。
        return "\n\n".join(blocks)
        #   三块用空行拼接。
```

---

## 模块级 helper

> **整块作用**:`_ToolAutoOutcome` 是步结果的内部归一类型;两个 `_resolve_*` 把不同形态结果归一;
> `_build_llm` 建引擎;`Args`/`_parse_*` 解析命令参数;`_is_context_length_error`/`_extract_text_from_parts` 杂项。

```python
@dataclass(frozen=True)
class _ToolAutoOutcome:
    kind: str       # "text" / "continue" / "error"
    text: str = ""  # text 结果
    error: str = "" # error 文本

def _resolve_final_data(final_data: dict[str, Any], error: RepublicError | None) -> _ToolAutoOutcome:
    if final_data.get("tool_calls") or final_data.get("tool_results"):
        return _ToolAutoOutcome(kind="continue")
        #   final 里有工具调用/结果 → 还要继续。
    if (text := final_data.get("text")) is not None:
        return _ToolAutoOutcome(kind="text", text=text)
        #   有最终文本 → text。
    error_message = error.message if error else ""
    return _ToolAutoOutcome(kind="error", error=error_message or "unknown error")
    #   都没有 → error。

def _resolve_tool_auto_result(output: ToolAutoResult) -> _ToolAutoOutcome:
    if output.kind == "text":
        return _ToolAutoOutcome(kind="text", text=output.text or "")
        #   文本结果。
    if output.kind == "tools" or output.tool_calls or output.tool_results:
        return _ToolAutoOutcome(kind="continue")
        #   有工具 → 继续。
    if output.error is None:
        return _ToolAutoOutcome(kind="error", error="tool_auto_error: unknown")
        #   无错误对象的异常情况 → 未知错误。
    error_kind = getattr(output.error.kind, "value", str(output.error.kind))
    return _ToolAutoOutcome(kind="error", error=f"{error_kind}: {output.error.message}")
    #   有错误 → 拼成 "kind: message"。

def _build_llm(settings: AgentSettings, tape_store: AsyncTapeStore, tape_context: TapeContext) -> ModelEngine:
    """Build the project tape-storage engine. Model calls run through LangGraph, not here."""
    _ = settings
    #   settings 当前未用到(占位,保持签名稳定/未来可用)。
    return ModelEngine(tape_store, tape_context)
    #   建 tape 引擎(只管存储 + 上下文)。

@dataclass(frozen=True)
class Args:
    positional: list[str]      # 位置参数
    kwargs: dict[str, Any]     # 关键字参数

def _parse_internal_command(line: str) -> tuple[str, list[str]]:
    body = line.strip()
    words = shlex.split(body)
    #   按 shell 规则切词(处理引号等)。
    if not words:
        return "", []
    return words[0], words[1:]
    #   首词=命令名,其余=参数 token。

def _parse_args(args_tokens: list[str]) -> Args:
    positional: list[str] = []
    kwargs: dict[str, str] = {}
    first_kwarg = False
    for token in args_tokens:
        if "=" in token:
            key, value = token.split("=", 1)
            kwargs[key] = value
            first_kwarg = True
            #   key=value → 关键字参数(并标记"已进入关键字段")。
        elif first_kwarg:
            raise ValueError(f"positional argument '{token}' cannot appear after keyword arguments")
            #   关键字参数之后又出现位置参数 → 非法(类似 Python 调用规则)。
        else:
            positional.append(token)
            #   普通位置参数。
    return Args(positional=positional, kwargs=kwargs)

def _is_context_length_error(error_msg: str) -> bool:
    """Check whether an error message indicates a context-length / prompt-too-long failure."""
    return bool(_CONTEXT_LENGTH_PATTERNS.search(error_msg))
    #   用预编译正则判断错误消息是否属"上下文超长"——决定要不要自动 handoff。

def _extract_text_from_parts(parts: list[dict]) -> str:
    """Extract text content from multimodal content parts."""
    return "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
    #   从多模态内容块里抽出所有 text 块文本(用于算长度/识别 $skill)。
```

---

## 一句话总结

`Agent` 是"会用工具的多步推理引擎":每步拼系统/工具/技能提示 → 经 LangGraph 调模型 → 出文本则结束、
出工具调用则继续、上下文爆了则自动 handoff 截断历史重试;全过程以 tape 事件记录,支持流式与非流式。
**模型网络调用在 `llm/graph.py`,本文件只编排循环与 tape。**
