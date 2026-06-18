# `backend/utils/types.py` 精读(C 档·极详)

## 这个文件在干嘛

**框架中立的类型别名与协议**:定义贯穿全代码的 `Envelope`/`State`/`MessageHandler` 等别名、出站路由协议
`OutboundChannelRouter`、以及一次 turn 的结果 `TurnResult`。它是被几乎所有模块 import 的"类型词汇表"。

> 读这篇能把前面反复出现的 `Envelope`/`State`/`MessageHandler` 一次性厘清。

---

## 逐行精读

> **整块作用**:导入 + 四个核心类型别名。

```python
"""Framework-neutral data aliases."""
from __future__ import annotations
from collections.abc import AsyncIterable, Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any, Protocol
from backend.core.events import StreamEvent

type Envelope = Any
#   ⭐ 消息的统一别名 = Any。框架"不假设消息的具体类型"——可能是 dict,也可能是 ChannelMessage。
#   正因如此才需要 field_of/content_of 这种"防御式取值"(见 envelope.py)。

type State = dict[str, Any]
#   一次 turn 的状态字典(session_id/_runtime_agent/intent/context… 都塞这)。

type MessageHandler = Callable[[Envelope], Coroutine[Any, Any, None]]
#   入站处理器:接一个 Envelope、返回协程、无返回值。渠道收到消息就 await 它(即 manager.on_receive)。

type OutboundDispatcher = Callable[[Envelope], Coroutine[Any, Any, bool]]
#   出站派发器:接 Envelope、返回 bool(是否成功)。
```

> **整块作用(OutboundChannelRouter)**:出站路由的"鸭子接口"——框架据它把回复/流式事件交给渠道层。

```python
class OutboundChannelRouter(Protocol):
    async def dispatch_output(self, message: Envelope) -> bool: ...
    #   发一条出站消息。
    def wrap_stream(self, message: Envelope, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]: ...
    #   包装模型流式事件(实时回灌渠道)。
    async def quit(self, session_id: str) -> None: ...
    #   结束某会话。
```
- `ChannelManager` 正好实现了这三个方法,所以能被 `framework.bind_outbound_router(manager)` 当路由用
  (Protocol = 结构化类型,无需显式继承)。

> **整块作用(TurnResult)**:一次完整 turn 的结果对象(process_inbound 的返回值)。

```python
@dataclass(frozen=True)
class TurnResult:
    """Result of one complete message turn."""
    session_id: str                 # 会话 id
    prompt: str                     # 本 turn 用的 prompt
    model_output: str               # 模型(后处理后)输出
    outbounds: list[Envelope] = field(default_factory=list)   # 产生的出站消息
```

---

## 一句话总结

`utils/types.py` 是项目的"类型词汇表":`Envelope=Any`(消息不绑死类型,靠防御式取值)、`State`、
`MessageHandler`、出站路由协议 `OutboundChannelRouter`、turn 结果 `TurnResult`。
