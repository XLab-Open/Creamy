# `backend/app/framework.py` 精读(C 档·极详)⭐

> 框架的**心脏**。`CreamyFramework` 持有 pluggy 插件管理器,用 `process_inbound` 驱动一条
> 入站消息走完整条 turn 管线。对照 [`../hooks/hookspecs.md`](../hooks/hookspecs.md)(每步调哪个 hook)读最清楚。

---

## 顶部导入与 .env

> **整块作用**:引入依赖,并在**模块导入时**就加载 `.env`(只要 import 本模块,`CREAMY_*` 配置/密钥就生效)。

```python
"""Hook-first Creamy framework runtime."""
#   模块 docstring:hook 优先的框架运行时。

from __future__ import annotations
#   注解延迟求值(让方法签名里的类型以字符串保存,可引用未导入类型、避免循环依赖)。

from dataclasses import dataclass
#   dataclass:下面用它定义不可变的 PluginStatus。
from pathlib import Path
#   Path:面向对象的路径 API(工作区目录用)。
from typing import TYPE_CHECKING, Any, cast
#   TYPE_CHECKING:仅类型检查期为真(包住 Channel 的导入);Any:宽松类型;cast:类型断言(运行时无副作用)。

import pluggy
#   插件框架。
import typer
#   CLI 框架(create_cli_app 用)。
from dotenv import load_dotenv
#   读取 .env 的函数。
from loguru import logger
#   日志。

from backend.core.errors import ErrorKind, RepublicError
#   ErrorKind:错误种类枚举;RepublicError:统一的自定义异常。流式分支里把错误事件转成它。见 core/errors.md。
from backend.core.store import AsyncTapeStore, TapeStore
#   tape 存储抽象(异步/同步)。get_tape_store 的返回类型。
from backend.core.tape_types import TapeContext
#   tape 上下文类型(build_tape_context 返回)。
from backend.hooks.hook_runtime import HookRuntime
#   安全派发层:本文件所有 hook 调用都经它。见 hooks/hook_runtime.md。
from backend.hooks.hookspecs import CREAMY_HOOK_NAMESPACE, CreamyHookSpecs
#   命名空间字符串 + hook 契约类。下面用它们初始化 pluggy。
from backend.utils.envelope import content_of, field_of, unpack_batch
#   消息防御式工具:content_of 取正文、field_of 取字段(兼容 dict/对象)、unpack_batch 展平出站批次。见 utils/envelope.md。
from backend.utils.types import Envelope, MessageHandler, OutboundChannelRouter, TurnResult
#   类型别名:消息载体 / 入站处理器 / 出站路由协议 / turn 结果。见 utils/types.md。

if TYPE_CHECKING:
    #   仅类型检查期(运行时不导入,避免 channels↔app 循环)。
    from backend.channels.base import Channel
    #   Channel 抽象基类:get_channels 返回值的元素类型。

load_dotenv()
#   模块级执行:导入本模块即把 .env 载入环境变量。
#   影响:任何 import backend.app.framework 的路径(包括 CLI 启动)都会让 CREAMY_MODEL/CREAMY_API_KEY 等就位。
#   实践意义:运行 creamy 前把配置写进 .env 即可,无需手动 export。
```

> **整块作用**:用不可变数据类记录"单个插件加载成功/失败 + 原因",供诊断。

```python
@dataclass(frozen=True)
#   frozen=True:实例不可变(创建后字段不能改),适合做"状态快照"。
class PluginStatus:
    is_success: bool
    #   该插件是否加载成功。
    detail: str | None = None
    #   失败原因(成功时为 None)。
```

---

## 构造:只搭骨架,不放行为

> **整块作用**:建 pluggy 管理器、注册"契约"、建安全派发层、初始化状态表与出站路由占位。
> **此刻还没有任何 hook 实现**——行为要等 `load_hooks()`。

```python
class CreamyFramework:
    """Minimal framework core. Everything grows from hook skills."""
    #   类 docstring:核心极小,一切由 hook 生长。

    def __init__(self) -> None:
        self.workspace = Path.cwd().resolve()
        #   工作区 = 当前工作目录的绝对路径。AGENTS.md、相对路径解析都基于它;可被 --workspace 覆盖。
        self._plugin_manager = pluggy.PluginManager(CREAMY_HOOK_NAMESPACE)
        #   pluggy 核心,命名空间固定为 "creamy"。所有 hook 注册/调用都通过它。
        self._plugin_manager.add_hookspecs(CreamyHookSpecs)
        #   注册"契约"(只是"有哪些 hook、签名如何"),此时还没有任何实现。
        self._hook_runtime = HookRuntime(self._plugin_manager)
        #   把 pluggy 管理器包进安全派发层(reversed 优先级 / async / 容错都在它里面)。
        self._plugin_status: dict[str, PluginStatus] = {}
        #   插件名 -> 加载状态。供 hook_report / 诊断。
        self._outbound_router: OutboundChannelRouter | None = None
        #   出站路由:渠道管理器启动后会 bind 进来,用于把模型流式事件回灌渠道、发出站消息。初始无。
```

---

## 加载插件:内置先、外部后(优先级的根)

> **整块作用(_load_builtin_hooks)**:注册出厂实现 `BuiltinImpl`,名字固定 `"builtin"`,并记录成败。

```python
    def _load_builtin_hooks(self) -> None:
        from backend.hooks.hook_impl import BuiltinImpl
        #   延迟导入(放函数内而非文件顶部):BuiltinImpl 会反向 import 很多模块,顶层导入易成环。

        impl = BuiltinImpl(self)
        #   实例化出厂实现,把框架自身(self)注入,使它能回调框架的路由等能力。

        try:
            self._plugin_manager.register(impl, name="builtin")
            #   向 pluggy 注册。名字固定 "builtin",且"先注册"——这是优先级最低位(会被后注册者覆盖)。
        except Exception as exc:
            self._plugin_status["builtin"] = PluginStatus(is_success=False, detail=str(exc))
            #   注册失败:记录失败 + 原因(但不抛出,尽量让框架可启动)。
        else:
            self._plugin_status["builtin"] = PluginStatus(is_success=True)
            #   注册成功:记录成功。
```

> **整块作用(load_hooks)**:先注册 builtin,再遍历 entry-point 组 `creamy` 注册外部插件。
> **"内置先、外部后"= "后注册者胜"优先级的根源**。单个外部插件失败被隔离,不连累其它。

```python
    def load_hooks(self) -> None:
        import importlib.metadata
        #   标准库:读取"已安装包声明的 entry points"。延迟导入即可。

        self._load_builtin_hooks()
        #   ① 先注册内置实现。
        for entry_point in importlib.metadata.entry_points(group="creamy"):
            #   ② 遍历所有声明在 entry-point 组 "creamy" 下的外部插件(第三方包通过 pyproject 声明)。
            try:
                plugin = entry_point.load()
                #   加载 entry point 指向的对象(可能是一个对象,也可能是一个类)。
                if callable(plugin):
                    #   若它是"可调用"(通常是个类),
                    plugin = plugin(self)
                    #   就实例化它并注入框架引用(让插件能拿到框架)。
                self._plugin_manager.register(plugin, name=entry_point.name)
                #   以 entry point 名注册。"后注册" → 在 reversed 取实现时排到 builtin 前面 → 可覆盖默认。
            except Exception as exc:
                #   单个插件加载/注册失败:
                logger.warning(f"Failed to load plugin '{entry_point.name}': {exc}")
                #   记 warning(不抛出,故障隔离:坏插件不拖垮整个框架)。
                self._plugin_status[entry_point.name] = PluginStatus(is_success=False, detail=str(exc))
            else:
                self._plugin_status[entry_point.name] = PluginStatus(is_success=True)
                #   成功:记录。
```

- **没有特权代码路径**:内置与外部插件走完全相同的注册/派发机制,差别只是注册先后。

---

## CLI 装配

> **整块作用**:建根命令 `creamy`,提供 `--workspace` 选项,把框架塞进上下文,并**广播**
> `register_cli_commands` 让所有插件挂子命令。

```python
    def create_cli_app(self) -> typer.Typer:
        """Create CLI app by collecting commands from hooks. Can be used for custom CLI entry point."""
        app = typer.Typer(name="creamy", help="Batteries-included, hook-first AI framework", add_completion=False)
        #   建根 Typer 应用。add_completion=False:不生成 shell 自动补全命令(精简)。

        @app.callback(invoke_without_command=True)
        #   注册"根回调":即使用户没敲任何子命令也会执行(便于设置全局选项)。
        def _main(
            ctx: typer.Context,
            #   Typer 注入的上下文对象(可挂载共享数据)。
            workspace: str | None = typer.Option(None, "--workspace", "-w", help="Path to the workspace"),
            #   全局可选项:覆盖工作区路径。
        ) -> None:
            if workspace:
                #   用户指定了工作区,
                self.workspace = Path(workspace).resolve()
                #   覆盖默认(当前目录)。
            ctx.obj = self
            #   把框架实例挂到 ctx.obj —— 各子命令通过 ctx 即可拿到框架(共享状态)。

        self._hook_runtime.call_many_sync("register_cli_commands", app=app)
        #   同步广播:让所有插件把各自的子命令注册到 app 上(内置挂了 run/cli/web/... 见 hook_impl.md)。
        return app
        #   返回装配好的 CLI 应用。
```

---

## ⭐ 核心:`process_inbound` —— 一次 turn 全流程

整个方法 = 按 [`hookspecs`](../hooks/hookspecs.md) 顺序派发各阶段,外层 try 兜底。分段精读:

> **①②③ resolve_session → load_state → build_prompt**

```python
    async def process_inbound(self, inbound: Envelope, stream_output: bool = False) -> TurnResult:
        """Run one inbound message through hooks and return turn result."""
        #   入参:inbound 入站消息;stream_output 是否要流式跑模型。返回:TurnResult(本 turn 全量结果)。

        try:
            #   整个 turn 包在 try 里,任何阶段出错都在末尾 except 统一处理(通知 + 重抛)。
            session_id = await self._hook_runtime.call_first(
                "resolve_session", message=inbound
            ) or self._default_session_id(inbound)
            #   ① 解析会话主键(firstresult)。`or` 的兜底:若所有实现都没返回(None/空串),
            #     则用 _default_session_id(channel:chat_id)。
            if isinstance(inbound, dict):
                #   若消息是 dict 形态(不同渠道形态不同),
                inbound.setdefault("session_id", session_id)
                #   把算出的 session_id 回填(setdefault:已有则不覆盖)。便于后续阶段直接读到。
            with logger.contextualize(session_id=session_id, channel=str(field_of(inbound, "channel", "-"))):
                #   上下文日志:本 with 块内所有 loguru 日志自动带上 session_id 和 channel 字段,便于排查。
                state = {"_runtime_workspace": str(self.workspace)}
                #   初始化本 turn 的 state(共享字典),先放工作区路径(供 system_prompt 读 AGENTS.md 用)。
                for hook_state in reversed(
                    await self._hook_runtime.call_many("load_state", message=inbound, session_id=session_id)
                ):
                    #   ② 加载状态:虽然 spec 标 firstresult,这里实际"收集所有 load_state 结果再反转"。
                    #      reversed 的意义:让"后注册插件"先 update、"内置 builtin"最后 update →
                    #      相同键时 builtin 的值最终生效(优先级最高)。
                    if isinstance(hook_state, dict):
                        #   每个实现的结果应是 dict,
                        state.update(hook_state)
                        #   合并进总 state。
                prompt = await self._hook_runtime.call_first(
                    "build_prompt", message=inbound, session_id=session_id, state=state
                )
                #   ③ 构造 prompt(firstresult)。可能是纯文本或多模态内容块列表。
                if not prompt:
                    #   没有任何 build_prompt 给出结果,
                    prompt = content_of(inbound)
                    #   退化为消息原文。
```

> **④⑤ run_model(try)+ save_state(finally 必执行)**

```python
                model_output = ""
                #   模型输出初始化为空串(确保即便 run_model 抛错,finally 里也有可用变量)。
                try:
                    model_output = await self._run_model(inbound, prompt, session_id, state, stream_output)
                    #   ④ 跑模型(下面专门讲)。可能抛错。
                finally:
                    #   无论 ④ 成功还是抛错都执行:
                    await self._hook_runtime.call_many(
                        "save_state",
                        session_id=session_id,
                        state=state,
                        message=inbound,
                        model_output=model_output,
                    )
                    #   ⑤ 广播 save_state(收尾):关闭 lifespan、落 tape 等。
                    #      放 finally 的关键意义:模型出错也要正确收尾,不泄漏资源、不丢已发生的状态。
```

> **⑥⑦⑧⑨ 意图 → 后处理 → 渲染出站 → 派发 → 返回;末尾 except 兜底**

```python
                await self._intent_detection(inbound, model_output, state)
                #   ⑥ 识别意图(库存 vs 闲聊),结果写进 state["intent"](副作用型)。
                model_output = await self._postprocess_model_output(inbound, model_output, state)
                #   ⑦ 后处理:据 intent 把模型输出加工成最终文本(库存场景把 JSON 渲染成回复)。

                outbounds = await self._collect_outbounds(inbound, session_id, state, model_output)
                #   ⑧ 渲染出站消息列表(含"无渲染结果时用模型输出兜底造一条")。
                for outbound in outbounds:
                    #   逐条出站消息,
                    await self._hook_runtime.call_many("dispatch_outbound", message=outbound)
                    #   ⑨ 广播 dispatch_outbound,真正发到渠道。
                return TurnResult(session_id=session_id, prompt=prompt, model_output=model_output, outbounds=outbounds)
                #   返回本 turn 的完整结果(会话 id / 用到的 prompt / 模型输出 / 出站消息)。
        except Exception as exc:
            #   turn 任意阶段抛出的异常:
            logger.exception("Error processing inbound message")
            #   记录完整堆栈。
            await self._hook_runtime.notify_error(stage="turn", error=exc, message=inbound)
            #   广播给所有 on_error 观察者(内置实现会把错误当一条消息发回用户)。
            raise
            #   再重抛——框架不"吞"错误,交由更上层(如渠道管理器)决定。
```

---

## `_run_model`:非流式 / 流式两条路

> **整块作用**:据 `stream_output` 选路。两路都先调对应的 hook_runtime 方法,**都处理"无任何模型
> 实现"的退化**;流式路还负责把事件回灌渠道并累积文本。

```python
    async def _run_model(
        self,
        inbound: Envelope,
        #   入站消息(用于退化返回 / 报错附带)。
        prompt: str | list[dict],
        #   已构造好的 prompt。
        session_id: str,
        state: dict[str, Any],
        stream_output: bool,
        #   是否要流式。
    ) -> str:
        if not stream_output:
            #   —— 非流式分支 ——
            output = await self._hook_runtime.run_model(prompt=prompt, session_id=session_id, state=state)
            #   调 hook_runtime.run_model(它会兼容"只实现了流式"的插件:替你消费完流再返回整段)。
            if output is None:
                #   没有任何插件具备模型能力,
                await self._hook_runtime.notify_error(
                    stage="run_model",
                    error=RuntimeError("no model skill returned output"),
                    message=inbound,
                )
                #   通知错误,
                return prompt if isinstance(prompt, str) else content_of(inbound)
                #   并退化:prompt 是字符串就回它,否则回消息原文(保证总有返回)。
            return output
            #   正常:返回整段输出。
        stream = await self._hook_runtime.run_model_stream(prompt=prompt, session_id=session_id, state=state)
        #   —— 流式分支 —— 取事件流(它会兼容"只实现了非流式"的插件:把整段结果包成单事件流)。
        if stream is None:
            #   同样处理"无模型实现":
            await self._hook_runtime.notify_error(
                stage="run_model",
                error=RuntimeError("no model skill returned output"),
                message=inbound,
            )
            return prompt if isinstance(prompt, str) else content_of(inbound)
        else:
            #   拿到事件流:
            parts: list[str] = []
            #   文本片段累积器(最终拼成整段返回)。
            if self._outbound_router is not None:
                #   若绑定了出站路由(渠道管理器),
                stream = self._outbound_router.wrap_stream(inbound, stream)  # type: ignore[assignment]
                #   ⭐ 关键:用 wrap_stream 包一层——模型边生成边把事件回灌到对应渠道。
                #      Web 的 SSE、CLI 的实时刷新都靠这一步(见 channels/manager.md)。
                #      type: ignore 是因为包装前后类型形态略不同,屏蔽类型检查噪声。
            async for event in stream:
                #   遍历(可能已被包装的)事件流:
                if event.kind == "text":
                    #   文本事件,
                    parts.append(str(event.data.get("delta", "")))
                    #   累积其增量 delta。
                elif event.kind == "error":
                    #   错误事件,
                    data = {
                        **event.data,
                        "kind": ErrorKind(event.data.get("kind", "unknown")),
                    }
                    #   重组错误数据:把 kind 字段从字符串转成 ErrorKind 枚举
                    #   (源码注释说明:否则 RepublicError 的 __str__ 显示不正常)。
                    await self._hook_runtime.notify_error(
                        stage="run_model", error=RepublicError(**data), message=inbound
                    )
                    #   广播错误。
            return "".join(parts)
            #   把所有文本增量拼成整段,作为模型输出返回。
```

---

## 诊断 / 路由 / 兜底 session

> **整块作用**:对外暴露诊断报告、出站路由的绑定与转发、以及兜底 session_id 生成。

```python
    def hook_report(self) -> dict[str, list[str]]:
        """Return hook implementation summary for diagnostics."""
        return self._hook_runtime.hook_report()
        #   委托 hook_runtime:返回"每个 hook 有哪些实现"。供 `creamy hooks` 命令用。

    def bind_outbound_router(self, router: OutboundChannelRouter | None) -> None:
        self._outbound_router = router
        #   渠道管理器启动后调用它,把出站路由绑进来(_run_model / dispatch_via_router 会用到)。

    async def dispatch_via_router(self, message: Envelope) -> bool:
        if self._outbound_router is None:
            #   还没绑路由,
            return False
            #   发不出去。
        return await self._outbound_router.dispatch_output(message)
        #   交给路由真正发送一条出站消息。

    async def quit_via_router(self, session_id: str) -> None:
        if self._outbound_router is not None:
            #   绑了路由才有意义,
            await self._outbound_router.quit(session_id)
            #   通知渠道"结束该会话"(如 CLI 退出某会话)。

    @staticmethod
    def _default_session_id(message: Envelope) -> str:
        #   兜底 session_id 生成(当没有 resolve_session 实现时用)。
        session_id = field_of(message, "session_id")
        #   先看消息自带。
        if session_id is not None:
            return str(session_id)
            #   有就用。
        channel = str(field_of(message, "channel", "default"))
        #   否则取渠道名(缺省 "default")。
        chat_id = str(field_of(message, "chat_id", "default"))
        #   + 会话 id(缺省 "default")。
        return f"{channel}:{chat_id}"
        #   拼成 "channel:chat_id"。
```

---

## 收集出站消息(含兜底)

> **整块作用**:广播 `render_outbound` 并展平所有结果;若一条都没渲染出,就用模型输出**兜底造一条**,
> 保证"总有回复"。

```python
    async def _collect_outbounds(
        self,
        message: Envelope,
        session_id: str,
        state: dict[str, Any],
        model_output: str,
    ) -> list[Envelope]:
        batches = await self._hook_runtime.call_many(
            "render_outbound",
            message=message,
            session_id=session_id,
            state=state,
            model_output=model_output,
        )
        #   广播 render_outbound,得到"多个批次"(每个实现返回一个 list)。
        outbounds: list[Envelope] = []
        #   汇总容器。
        for batch in batches:
            #   每个实现的返回,
            outbounds.extend(unpack_batch(batch))
            #   用 unpack_batch 展平后并入(单实现可返回多条;unpack 统一形态)。
        if outbounds:
            #   有渲染结果,
            return outbounds
            #   直接用。

        fallback: dict[str, Any] = {
            "content": model_output,
            #   兜底消息内容 = 模型输出。
            "session_id": session_id,
        }
        #   否则造一条兜底出站消息。
        channel = field_of(message, "channel")
        #   取入站渠道。
        chat_id = field_of(message, "chat_id")
        #   取入站会话。
        if channel is not None:
            fallback["channel"] = channel
            #   有就带上(让回复回到原渠道)。
        if chat_id is not None:
            fallback["chat_id"] = chat_id
        return [fallback]
        #   返回单条兜底消息——保证用户总能收到回复。
```

---

## 其余 hook 便捷封装

> **整块作用**:把"收集渠道 / 取 tape store / 拼系统提示 / 取 tape 上下文 / 后处理 / 意图识别"
> 各封装成一个便捷方法,供渠道管理器、CLI、process_inbound 调用。

```python
    def get_channels(self, message_handler: MessageHandler) -> dict[str, Channel]:
        channels: dict[str, Channel] = {}
        #   name -> Channel。
        for result in self._hook_runtime.call_many_sync("provide_channels", message_handler=message_handler):
            #   广播 provide_channels(同步),每个实现返回一组渠道。
            for channel in result:
                if channel.name not in channels:
                    #   按 name 去重,
                    channels[channel.name] = channel
                    #   先到先得(先注册的同名渠道保留)。
        return channels

    def get_tape_store(self) -> TapeStore | AsyncTapeStore | None:
        return cast("TapeStore | AsyncTapeStore | None", self._hook_runtime.call_first_sync("provide_tape_store"))
        #   firstresult:取第一个提供的 tape 存储后端(出厂为 FileTapeStore)。

    def get_system_prompt(self, prompt: str | list[dict], state: dict[str, Any]) -> str:
        return "\n\n".join(
            result
            for result in reversed(self._hook_runtime.call_many_sync("system_prompt", prompt=prompt, state=state))
            if result
        )
        #   广播 system_prompt → reversed → 过滤空串 → 用空行拼接。
        #   reversed 让 builtin(先注册)的系统提示排在最前;空串被 `if result` 过滤掉。

    def build_tape_context(self) -> TapeContext:
        return cast("TapeContext", self._hook_runtime.call_first_sync("build_tape_context"))
        #   firstresult:取 tape 上下文构建器结果。

    async def _postprocess_model_output(self, inbound: Envelope, model_output: str, state: dict[str, Any]) -> str:
        output = self._hook_runtime.call_first_sync("postprocess_model_output", model_output=model_output, state=state)
        #   调后处理 hook(firstresult,同步)。
        if output is None:
            #   后处理是必须项;没有实现就报错(框架认为这不该发生)。
            await self._hook_runtime.notify_error(
                stage="postprocess_model_output",
                error=RuntimeError("no postprocess skill returned output"),
                message=inbound,
            )
        return cast(str, output)
        #   返回后处理结果(即便为 None 也照原样返回,上面已通知错误)。

    async def _intent_detection(self, inbound: Envelope, model_output: str, state: dict[str, Any]) -> None:
        self._hook_runtime.call_first_sync("intent_detection", message=inbound, model_output=model_output, state=state)
        #   调意图识别 hook(firstresult,同步);它把结果写进 state["intent"],本方法无返回。
```

---

## 一句话总结

`CreamyFramework` 本身几乎无业务,只做两件事:**装配插件 + 按固定顺序把 turn 各阶段派发给对应
hook**。真实行为都在 `hook_impl.py` 和它委托的 `Agent`——这正是"hook 优先、核心极小"的落地。
