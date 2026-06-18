# `backend/llm/graph.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

**模型单步执行(LangGraph)**——这是"真正调模型"的地方(`agent.py` 的循环每步调它)。一次 turn 是一张
编译好的 `StateGraph`:

```
START → agent → (有 tool_calls?) → tools → END
```

(`tools` 直接到 END——**每次调用只跑一步**;多步迭代由 agent 的外层策略循环负责。)`agent` 节点调聊天模型
并把**原生 + 内嵌 `<tool_call>`** 都提升为工具调用;`ToolNode` 执行它们。

- `run_step`:非流式跑图,返回 `StepResult`;
- `stream_step`:`graph.astream(stream_mode=["messages","values"])` —— messages 模式吐逐 token 增量、
  values 模式带终态——翻译成 `StreamEvent`。

> 回顾 agent.py:`_run_once` 据 stream_output 调本文件的 `run_step` / `stream_step`。`ModelEngine` 只管 tape,
> **模型网络调用就在这里**(经 `client.build_chat_model` 得到的 LangChain 模型 + LangGraph 编排)。

---

## 顶部:导入

> **整块作用**:导入 LangChain 消息、LangGraph 构图原语、项目错误/事件/tape/工具/客户端/转换。

```python
"""Model turn execution — project-owned (LangGraph). ...(见上)..."""
from __future__ import annotations
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage
#   AIMessageChunk:流式时的增量块。
from langgraph.graph import END, START, MessagesState, StateGraph
#   LangGraph:状态图、起止节点、内置"消息状态"。
from langgraph.prebuilt import ToolNode
#   预制的"执行工具调用"节点。
from loguru import logger

from backend.core.errors import AgentError, ErrorKind
from backend.core.events import AsyncStreamEvents, StreamEvent, StreamState
from backend.core.tape_types import TapeEntry            # 往 tape 追加条目
from backend.core.tools import ToolContext
from backend.llm.client import build_chat_model          # 造模型
from backend.llm.embedded_tools import extract_embedded_tool_calls  # 内嵌 tool_call 提取
from backend.llm.messages import build_lc_tools, to_lc_messages     # 形态转换

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langchain_core.runnables import Runnable
    from langchain_core.tools import StructuredTool
    from backend.agent.settings import AgentSettings
    from backend.core.engine import Tape
    from backend.core.tools import Tool
```

---

## `StepResult`:单步结果

> **整块作用**:非流式单步的结果(与 `ToolAutoResult` 鸭子兼容,故 agent 能统一处理)。三个工厂方法。

```python
@dataclass(frozen=True)
class StepResult:
    """Outcome of a single model turn (duck-compatible with ``ToolAutoResult``)."""
    kind: Literal["text", "tools", "error"]   # 这步是出文本/出工具调用/出错
    text: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[Any] = field(default_factory=list)
    error: AgentError | None = None
    usage: dict[str, Any] | None = None

    @classmethod
    def text_result(cls, text: str) -> StepResult:
        return cls(kind="text", text=text)
    @classmethod
    def tools_result(cls, tool_calls, tool_results) -> StepResult:
        return cls(kind="tools", tool_calls=tool_calls, tool_results=tool_results)
    @classmethod
    def error_result(cls, error: AgentError) -> StepResult:
        return cls(kind="error", error=error)
    #   三个语义化构造器,与 agent._resolve_tool_auto_result 的判定对应。
```

---

## 小工具

> **整块作用**:抽内容文本(兼容多模态)、造 user 载荷、造 OpenAI 形态 tool_call。

```python
def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
        #   纯字符串直接返回。
    if isinstance(content, list):
        parts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        return "".join(parts)
        #   多模态内容块 → 拼所有 text 块。
    return str(content) if content is not None else ""
    #   其它 → str。

def _user_payload(prompt: str | list[dict]) -> dict[str, Any]:
    return {"role": "user", "content": prompt}
    #   把 prompt 包成 user 角色消息(存 tape / 转 LC 用)。

def _openai_tool_call(name: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }
    #   组装成 OpenAI function tool_call 形态(存 tape / 回传给 agent 用)。
```

---

## 构图 `_build_graph` ⭐

> **整块作用**:编译单步图。agent 节点调模型并补内嵌工具调用;should_continue 决定有工具就去 tools 节点否则结束。

```python
def _build_graph(model: Runnable, lc_tools: list[StructuredTool]):
    """Compile the single-turn ``START → agent → (tools?) → END`` graph."""

    async def agent_node(state: MessagesState) -> dict[str, list[BaseMessage]]:
        message = await model.ainvoke(state["messages"])
        #   ⭐ 调聊天模型(真正的网络请求),得到 AI 消息。
        if not getattr(message, "tool_calls", None):
            #   模型没产生原生 tool_calls:
            embedded = extract_embedded_tool_calls(_content_text(message.content))
            #   看正文里有没有 <tool_call> 内嵌块。
            if embedded:
                message = AIMessage(content=message.content, tool_calls=embedded, id=getattr(message, "id", None))
                #   有就重建一条带 tool_calls 的 AI 消息(把内嵌提升为正式工具调用)。
        return {"messages": [message]}
        #   返回追加的消息(LangGraph MessagesState 会累积)。

    def should_continue(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END
        #   最后一条有 tool_calls → 去 tools 节点执行;否则结束。

    builder = StateGraph(MessagesState)
    #   用内置 MessagesState(自动累积 messages 列表)。
    builder.add_node("agent", agent_node)        # agent 节点
    builder.add_node("tools", ToolNode(lc_tools))# tools 节点(执行工具调用)
    builder.add_edge(START, "agent")             # 开始 → agent
    builder.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    #   agent 之后按 should_continue 分支:去 tools 或 END。
    builder.add_edge("tools", END)               # tools → 直接 END(每次只跑一步工具)
    return builder.compile()
    #   编译成可执行图。
```

- **关键设计**:`tools → END`(不回 agent),所以"调用工具后让模型继续"由 **agent.py 的外层循环**驱动
  (它把 tool 结果作为下一步 continue),而非图内部循环。职责清晰:图=单步,循环=多步。

---

## 结果拆解

> **整块作用**:从最终消息列表里分出 AI 消息与工具消息;再提取文本、tool_calls、tool_results。

```python
def _split_messages(messages: list[BaseMessage]) -> tuple[AIMessage | None, list[ToolMessage]]:
    ai_message: AIMessage | None = None
    tool_messages: list[ToolMessage] = []
    for message in messages:
        if isinstance(message, ToolMessage):
            tool_messages.append(message)   # 工具结果
        elif isinstance(message, AIMessage):
            ai_message = message            # AI 消息(取最后一个)
    return ai_message, tool_messages

def _result_from_messages(messages: list[BaseMessage]) -> tuple[str, list[dict[str, Any]], list[Any]]:
    ai_message, tool_messages = _split_messages(messages)
    text = _content_text(ai_message.content) if ai_message is not None else ""
    #   AI 文本。
    tool_calls: list[dict[str, Any]] = []
    if ai_message is not None and ai_message.tool_calls:
        tool_calls = [
            _openai_tool_call(call["name"], call.get("args") or {}, call.get("id") or f"call_{i}")
            for i, call in enumerate(ai_message.tool_calls)
        ]
        #   把 AI 的 tool_calls 转成 OpenAI 形态(缺 id 就生成 call_<i>)。
    tool_results = [tm.content for tm in tool_messages]
    #   工具结果取各 ToolMessage 的 content。
    return text, tool_calls, tool_results
```

---

## 准备与记录(run/stream 共用)

> **整块作用(_prepare)**:建模型+工具+图、把 tape 历史+本次 prompt 转成 LC 消息、把用户消息先写进 tape。

```python
async def _prepare(tape, prompt, system_prompt, tools, model, settings, chat_model) -> tuple[Any, str, list[BaseMessage]]:
    run_id = uuid.uuid4().hex
    #   本步 run id。
    chat_model = chat_model or build_chat_model(settings, model)
    #   造聊天模型(可注入,便于测试)。
    context = ToolContext(tape=tape.name, run_id=run_id, state=dict(tape.context.state))
    #   工具上下文(tape 名/run_id/state 快照)。
    lc_tools = build_lc_tools(tools, context)
    #   Creamy Tool → LangChain StructuredTool。
    bound = chat_model.bind_tools(lc_tools) if lc_tools else chat_model
    #   有工具就把工具 schema 绑给模型(让它知道能调哪些)。
    graph = _build_graph(bound, lc_tools)
    #   编译图。

    history = await tape.read_messages_async(context=tape.context)
    #   从 tape 读历史消息(按上下文选择规则:默认最后锚点之后)。
    lc_messages = to_lc_messages([*history, _user_payload(prompt)], system_prompt=system_prompt)
    #   历史 + 本次用户输入 + 系统提示 → LangChain 消息序列。
    await tape.append_async(TapeEntry.message(_user_payload(prompt), run_id=run_id))
    #   把本次用户消息先写进 tape(即便后续失败,提问也已记录)。
    return graph, run_id, lc_messages
```

> **整块作用(_record_outcome)**:把这步结果写进 tape——有工具调用就记 tool_call+tool_result,否则记 assistant 文本。

```python
async def _record_outcome(tape, run_id, text, tool_calls, tool_results) -> None:
    if tool_calls:
        await tape.append_async(TapeEntry.tool_call(tool_calls, run_id=run_id))    # 记工具调用
        await tape.append_async(TapeEntry.tool_result(tool_results, run_id=run_id))# 记工具结果
    else:
        await tape.append_async(TapeEntry.message({"role": "assistant", "content": text}, run_id=run_id))
        #   记 AI 文本回复。
```

---

## `run_step`:非流式一步 ⭐

> **整块作用**:准备 → 跑图 → 出错记 error 返回 → 否则拆结果、记 tape、按有无工具返回 tools/text 结果。

```python
async def run_step(*, tape, prompt, system_prompt, tools, model, settings, chat_model=None) -> StepResult:
    """Run one non-streaming model turn and persist the resulting tape entries."""
    graph, run_id, lc_messages = await _prepare(tape, prompt, system_prompt, tools, model, settings, chat_model)
    log = logger.bind(run_id=run_id)
    try:
        final_state = await graph.ainvoke({"messages": lc_messages})
        #   非流式跑完整图(agent → 也许 tools → END)。
    except Exception as exc:
        log.exception("llm.run_step.error tape={}", tape.name)
        error = AgentError(ErrorKind.PROVIDER, str(exc))
        await tape.append_async(TapeEntry.error(error, run_id=run_id))
        #   出错:记 error 条目。
        return StepResult.error_result(error)
        #   返回错误结果(agent 据此判断是否上下文超长→自动 handoff)。
    text, tool_calls, tool_results = _result_from_messages(final_state["messages"])
    #   拆出文本/工具调用/工具结果。
    await _record_outcome(tape, run_id, text, tool_calls, tool_results)
    #   记 tape。
    if tool_calls:
        return StepResult.tools_result(tool_calls, tool_results)
        #   有工具 → tools 结果(agent 会 continue)。
    return StepResult.text_result(text)
    #   无工具 → 文本结果(agent 结束)。
```

---

## `stream_step`:流式一步 ⭐

> **整块作用**:用 astream 双模式跑图——messages 模式逐 token 吐 text 事件、values 模式取终态;结束时拆结果、
> 记 tape、发 final 事件。错误转 error+final(ok=False)。

```python
async def stream_step(*, tape, prompt, system_prompt, tools, model, settings, chat_model=None) -> AsyncStreamEvents:
    """Run one streaming model turn, returning events plus terminal state."""
    graph, run_id, lc_messages = await _prepare(tape, prompt, system_prompt, tools, model, settings, chat_model)
    log = logger.bind(run_id=run_id)
    state = StreamState()
    #   流终态容器(错误/用量)。

    async def _generate() -> AsyncIterator[StreamEvent]:
        final_messages: list[BaseMessage] = []
        try:
            async for mode, chunk in graph.astream({"messages": lc_messages}, stream_mode=["messages", "values"]):
                #   双模式流:messages(逐 token)+ values(每步完整状态)。
                if mode == "messages":
                    message, meta = chunk
                    if meta.get("langgraph_node") == "agent" and isinstance(message, AIMessageChunk):
                        #   只关心 agent 节点产出的 AI 增量块(不是 tool 节点的)。
                        delta = _content_text(message.content)
                        if delta:
                            yield StreamEvent("text", {"delta": delta})
                            #   ⭐ 吐一个文本增量事件(渠道据此实时显示打字)。
                elif mode == "values":
                    final_messages = chunk["messages"]
                    #   values 模式:保留最新完整消息列表(结束时用它拆结果)。
        except Exception as exc:
            log.exception("llm.stream_step.error tape={}", tape.name)
            error = AgentError(ErrorKind.PROVIDER, str(exc))
            state.error = error
            await tape.append_async(TapeEntry.error(error, run_id=run_id))
            yield StreamEvent("error", {"message": str(exc)})   # 发错误事件
            yield StreamEvent("final", {"text": "", "ok": False})# 发 final(失败)
            return

        text, tool_calls, tool_results = _result_from_messages(final_messages)
        #   流结束:拆出文本/工具调用/结果。
        await _record_outcome(tape, run_id, text, tool_calls, tool_results)
        #   记 tape。
        if tool_calls:
            yield StreamEvent("final", {"text": text, "tool_calls": tool_calls, "tool_results": tool_results})
            #   有工具 → final 带工具信息(agent._stream..._resolve_final_data 据此 continue)。
        else:
            yield StreamEvent("final", {"text": text, "ok": True})
            #   无工具 → final(成功)。

    return AsyncStreamEvents(_generate(), state=state)
    #   返回事件流 + 终态(供 agent / 渠道消费)。


__all__ = ["StepResult", "run_step", "stream_step"]
```

- **流式与非流式的对称**:两者都 `_prepare` → 跑图 → `_result_from_messages` → `_record_outcome`;区别只是
  流式额外逐 token 吐 text 事件、用 final 事件代替返回值。`final` 的形态正好喂给 agent 的 `_resolve_final_data`。

---

## 怎么和别的文件连起来

- `agent/agent.py`:`_run_once` 调 `run_step`/`stream_step`;据 `StepResult`/final 事件决定 text/continue/error。
- `llm/client.py`:`build_chat_model` 造模型。
- `llm/messages.py`:`to_lc_messages` / `build_lc_tools` 做形态转换。
- `llm/embedded_tools.py`:`extract_embedded_tool_calls` 补内嵌工具调用。
- `core/engine.py` / `core/tape_types.py`:读历史(read_messages_async)、写条目(TapeEntry.*)。

---

## 一句话总结

`graph.py` 是"模型单步执行器":编译 `START→agent→(tools?)→END` 的 LangGraph,agent 节点调模型(含内嵌
工具调用提升)、ToolNode 执行工具;`run_step` 非流式、`stream_step` 逐 token 流式。**真正的模型调用在此**,
多步循环留给 agent.py。
