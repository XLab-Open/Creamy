# `backend/hooks/hookspecs.py` 精读(C 档·极详)⭐

> **建议第一篇读这个。** 它是整个框架的"地图":定义 turn 管线上**每个扩展点(hook)的签名
> 与语义**。读懂这张契约,再看 `framework.py`(谁来调)和 `hook_impl.py`(怎么实现),全局就通。

## 这个文件在干嘛

用 pluggy 声明 **hook 契约** `CreamyHookSpecs`。"契约"= 只规定"有哪些扩展点、各自签名和语义",
**不含任何实现**(方法体是 `raise NotImplementedError` 或空)。框架在 `app/framework.py` 用
`add_hookspecs(CreamyHookSpecs)` 把这张契约登记给 pluggy;插件再用 `@hookimpl` 提供实现。

> 类比:hookspecs = 接口(interface);hook_impl = 实现(implementation);framework = 调用方。

---

## 顶部:导入与命名空间

> **整块作用**:引入类型依赖,声明 pluggy 命名空间字符串,并据它造出两个"标记器"——
> `hookspec`(标记规格方法,本文件用)与 `hookimpl`(标记实现方法,插件用)。

```python
"""Pluggy hook namespace and framework hook specifications."""
#   模块 docstring:点明本模块=命名空间定义 + hook 规格。

from __future__ import annotations
#   注解延迟求值:让下面方法签名里的类型(如 Channel)以字符串形式存在,
#   从而能引用"运行时未导入"的类型,也避免循环导入。

from typing import TYPE_CHECKING, Any
#   TYPE_CHECKING:一个常量,运行时恒为 False、类型检查时为 True。
#     用它包住"仅供类型注解"的导入,使这些导入在运行时不真正执行(防循环依赖)。
#   Any:放弃类型约束的逃生舱(下面 register_cli_commands 的 app 参数用它,避免硬依赖 typer)。

import pluggy
#   pluggy:插件系统库(pytest 同款)。提供 HookspecMarker / HookimplMarker / PluginManager。

from backend.core.events import AsyncStreamEvents
#   流式事件序列类型:run_model_stream 的返回类型(模型边生成边吐事件)。见 core/events.md。

from backend.core.store import AsyncTapeStore, TapeStore
#   tape 存储抽象的两个版本(异步 / 同步):provide_tape_store 的返回类型。见 core/store.md。

from backend.core.tape_types import TapeContext
#   tape 上下文类型:build_tape_context 的返回类型。见 core/tape_types.md。

from backend.utils.types import Envelope, MessageHandler, State
#   三个核心类型别名:
#     Envelope        —— 消息的统一载体(入站/出站,既可能是 dict 也可能是 ChannelMessage);
#     MessageHandler  —— 入站消息处理器的可调用类型(渠道收到消息后回调它);
#     State           —— 一次 turn 的状态 dict 类型别名。见 utils/types.md。

if TYPE_CHECKING:
    #   仅类型检查期成立的分支(运行时不执行,故不会真正 import channels,避免循环依赖:
    #   channels 反过来要 import hooks)。
    from backend.channels.base import Channel
    #   Channel 抽象基类:provide_channels 的元素类型。仅用于类型注解。

CREAMY_HOOK_NAMESPACE = "creamy"
#   pluggy 命名空间名。关键约定(CLAUDE.md):它同时也是 entry-point 组名——
#   外部插件必须注册到 entry-point group "creamy",框架才会去加载。

hookspec = pluggy.HookspecMarker(CREAMY_HOOK_NAMESPACE)
#   "规格标记器":用 @hookspec 装饰的方法被 pluggy 认作"某个 hook 的规格"。本文件大量用它。

hookimpl = pluggy.HookimplMarker(CREAMY_HOOK_NAMESPACE)
#   "实现标记器":用 @hookimpl 装饰的方法被认作"某个 hook 的实现"。
#   它被 backend/__init__.py 再导出成 `from backend import hookimpl`,供插件作者使用。
```

- **命名空间为什么重要**:pluggy 用命名空间把"一套相关的 hook"圈在一起;规格与实现的标记器
  必须用同一命名空间,否则 pluggy 不会把它们配对。

---

## 契约类与两种 hook 语义

> **整块作用**:定义契约类本身。后面每个方法是一个 hook。先理解两种语义,再逐个看:
> - `@hookspec(firstresult=True)`:按优先级依次调实现,**取第一个非 None 返回值就停**——
>   用于"只能有一个答案"的环节;配合"后注册者胜",外部插件能**覆盖**内置默认。
> - `@hookspec`(默认):**广播**——调所有实现并收集结果列表;用于"可多方参与"的环节。

```python
class CreamyHookSpecs:
    #   契约类:本身不会被实例化使用,只是承载一组 @hookspec 方法供 add_hookspecs 注册。
    """Hook contract for Creamy framework extensions."""
    #   类 docstring:说明这是 Creamy 扩展的 hook 契约。
```

---

## 逐个 hook(就是 turn 管线的各阶段)

### resolve_session(firstresult)
> 为一条入站消息算出 **session_id**(会话主键)。turn 的第一步。
```python
    @hookspec(firstresult=True)
    #   firstresult:多个实现时只取第一个非 None 结果(会话 id 只能有一个答案)。
    def resolve_session(self, message: Envelope) -> str:
        #   入参 message:入站消息;返回:该消息所属会话的 id 字符串。
        """Resolve session id for one inbound message."""
        #   文档:为一条入站消息解析会话 id。
        raise NotImplementedError
        #   规格不实现(出厂实现见 hook_impl.py:有自带 id 用之,否则 channel:chat_id)。
```

### load_state(firstresult)
> 加载该会话的**状态快照**(一个 dict),供后续阶段读写。
```python
    @hookspec(firstresult=True)
    #   规格上标 firstresult……
    def load_state(self, message: Envelope, session_id: str) -> State:
        #   入参:消息 + 会话 id;返回:状态 dict。
        """Load state snapshot for one session."""
        #   文档:加载某会话的状态快照。
        raise NotImplementedError
        #   ⚠️ 注意"规格 vs 用法"差异:framework 实际用 call_many 收集所有实现并 reversed 合并,
        #   而非严格 firstresult。读 app/framework.md 的 ② 步会看到这点。
```

### build_prompt(firstresult)
> 构造这次 turn 喂给模型的 prompt。
```python
    @hookspec(firstresult=True)
    #   只取第一个结果(这次 turn 的 prompt 只能有一个)。
    def build_prompt(self, message: Envelope, session_id: str, state: State) -> str | list[dict]:
        #   返回联合类型:纯文本 str,或"内容块列表"(OpenAI 多模态格式,带图片/附件时)。
        """Build model prompt for this turn.

        Returns either a plain text string or a list of content parts
        (OpenAI multimodal format) when media attachments are present.
        """
        #   文档:构造本 turn 的 prompt;有媒体附件时返回多模态内容块列表。
        raise NotImplementedError
```

### run_model / run_model_stream(都 firstresult,二选一实现)
> 真正跑模型的环节。`run_model` 返回整段文本;`run_model_stream` 返回事件流(边生成边吐)。
```python
    @hookspec(firstresult=True)
    #   firstresult:模型只跑一次,取一个结果。
    def run_model(self, prompt: str | list[dict], session_id: str, state: State) -> str:
        #   非流式:一次性返回整段文本输出。
        """Run model ... return plain text output. Should not be implemented if `run_model_stream` is implemented."""
        #   文档明确:若已实现 run_model_stream,就不要再实现这个(二选一)。
        raise NotImplementedError

    @hookspec(firstresult=True)
    def run_model_stream(self, prompt: str | list[dict], session_id: str, state: State) -> AsyncStreamEvents:
        #   流式:返回一个异步事件序列,调用方边迭代边拿到增量。
        """Run model ... return a stream of events. Should not be implemented if `run_model` is implemented."""
        #   文档明确:与 run_model 二选一。
        raise NotImplementedError
```
- **为什么二选一**:同时实现会产生"到底用哪个"的歧义。`hook_runtime` 做了适配:只实现其一,
  另一种调用方也能被满足(整段↔流式互相转换),见 [`hook_runtime.md`](hook_runtime.md)。

### save_state(广播)
> turn 之后持久化状态。framework 把它放在 `finally`,**即使模型出错也会调用**(收尾)。
```python
    @hookspec
    #   无 firstresult = 广播:所有实现都会被调用(可多方各自做收尾)。
    def save_state(self, session_id: str, state: State, message: Envelope, model_output: str) -> None:
        #   返回 None:它是"副作用型" hook(写盘/关资源),不产出值。
        """Persist state updates after one model turn."""
        #   文档:一次模型 turn 后持久化状态更新。
```

### render_outbound(广播)
> 把模型输出**渲染成出站消息**(可能多条)。各实现结果会被汇总。
```python
    @hookspec
    def render_outbound(self, message: Envelope, session_id: str, state: State, model_output: str) -> list[Envelope]:
        #   返回出站消息列表(单个实现也可返回多条;framework 会展平所有实现的结果)。
        """Render outbound messages from model output."""
        raise NotImplementedError
```

### dispatch_outbound(广播)
> 把一条出站消息真正发到外部渠道。
```python
    @hookspec
    def dispatch_outbound(self, message: Envelope) -> bool:
        #   返回 bool:是否成功送达(供调用方/日志判断)。
        """Dispatch one outbound message to external channel(s)."""
        raise NotImplementedError
```

### register_cli_commands(广播)
> 往根 Typer 应用挂 CLI 子命令(`__main__.py` 启动时触发)。
```python
    @hookspec
    def register_cli_commands(self, app: Any) -> None:
        #   app 实际是 typer.Typer;这里用 Any 避免让 hooks 模块硬依赖 typer(解耦)。
        """Register CLI commands onto the root Typer application."""
```

### on_error(广播)
> 观察任意阶段的错误。framework 出错时 `notify_error` 会广播给所有观察者。
```python
    @hookspec
    def on_error(self, stage: str, error: Exception, message: Envelope | None) -> None:
        #   stage:出错的环节名(如 "turn"/"run_model");message 可能为 None(并非所有错误都有消息)。
        """Observe framework errors from any stage."""
```

### system_prompt(广播)
> 提供拼到所有 prompt 前面的系统提示。多个实现会被拼接。
```python
    @hookspec
    def system_prompt(self, prompt: str | list[dict], state: State) -> str:
        #   返回一段系统提示文本;framework 会把所有实现的结果(reversed 后)用空行拼起来。
        """Provide a system prompt to be prepended to all model prompts."""
        raise NotImplementedError
```

### provide_tape_store(firstresult)
> 提供会话录制的 **tape 存储后端**。出厂返回 `FileTapeStore`(写 `~/.creamy/tapes`)。
```python
    @hookspec(firstresult=True)
    #   只用一个存储后端,故 firstresult。
    def provide_tape_store(self) -> TapeStore | AsyncTapeStore:
        #   返回同步或异步的 tape store 实例。
        """Provide a tape store instance for Creamy's conversation recording feature."""
        raise NotImplementedError
```

### provide_channels(广播)
> 提供消息渠道列表。出厂返回 Telegram/飞书/CLI/Web 四个适配器。
```python
    @hookspec
    def provide_channels(self, message_handler: MessageHandler) -> list[Channel]:
        #   入参 message_handler:渠道收到消息后要回调的"入站处理器"(即框架的 process_inbound 包装)。
        #   返回:一组 Channel。framework 会按 name 去重汇总。
        """Provide a list of channels for receiving messages."""
        raise NotImplementedError
```

### build_tape_context(firstresult)
> 构建用于拼装上下文消息的 tape 上下文。
```python
    @hookspec(firstresult=True)
    def build_tape_context(self) -> TapeContext:
        #   返回 TapeContext:决定"如何把历史 tape 组织成喂给模型的上下文"。见 context/context.md。
        """Build a tape context for the current session, to be used to build context messages."""
        raise NotImplementedError
```

### intent_detection(广播)
> 从消息/模型输出里识别意图(Creamy 里用于"库存查询 vs 闲聊"打分,写进 `state`)。
```python
    @hookspec
    def intent_detection(self, message: Envelope, model_output: str, state: State) -> None:
        #   返回 None:结果不是"返回值",而是写进 state["intent"](副作用型)。
        """Detect intent from message."""
        raise NotImplementedError
```

### postprocess_model_output(广播)
> 对模型输出做后处理(库存场景把结构化 JSON 转成给用户看的回复)。
```python
    @hookspec
    def postprocess_model_output(self, model_output: str, state: State) -> str:
        #   返回处理后的输出字符串(如把库存 JSON 渲染成自然语言回复)。
        """Postprocess model output."""
        raise NotImplementedError
```

---

## 怎么和别的文件连起来

- **谁调这些 hook**:`app/framework.py::process_inbound` 按上面顺序依次派发。
- **谁实现这些 hook**:`hooks/hook_impl.py::BuiltinImpl` 是出厂全集。
- **怎么安全派发**:`hooks/hook_runtime.py` 封装了 firstresult / 异步 / 容错。
- 涉及类型:`Envelope`/`State`/`MessageHandler`→[`../utils/types.md`](../utils/types.md);
  `AsyncStreamEvents`→[`../core/events.md`](../core/events.md);
  `TapeStore`→[`../core/store.md`](../core/store.md);
  `TapeContext`→[`../core/tape_types.md`](../core/tape_types.md)。
