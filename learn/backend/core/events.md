# `backend/core/events.py` 精读(C 档·极详)

## 这个文件在干嘛

定义**流式输出**的三件套:
- `StreamEvent` —— 一次 turn 中吐出的**单个增量事件**(文本片段、工具调用、用量、错误……);
- `StreamState` —— 流**结束时**才确定的终态元数据(整体错误、token 用量);
- `AsyncStreamEvents` —— 把"事件异步迭代器"和"终态 StreamState"**捆在一起**的容器。

> 这是 `run_model_stream` 的返回类型,也是 `app/framework.py` 流式分支遍历的对象。模型边生成、
> 边以 `StreamEvent` 吐进来;`AsyncStreamEvents` 让消费方既能 `async for` 拿事件,又能在结束后
> 读 `.error` / `.usage`。

---

## 逐行精读

> **整块作用**:模块 docstring + 导入。点明"一次 turn 的进度 = StreamEvent 序列;AsyncStreamEvents
> 是带终态的异步包装"。

```python
"""Streaming events — project-owned (no longer a republic facade).
#   定性:项目自有的流式事件模型。

A turn surfaces incremental progress as a sequence of :class:`StreamEvent`.
``AsyncStreamEvents`` is the async wrapper carrying terminal ``StreamState``
(error / usage) alongside the event iterator.
#   说明:turn 用 StreamEvent 序列暴露增量;AsyncStreamEvents 在事件迭代器之外,
#         额外携带终态 StreamState(错误 / 用量)。
"""

from __future__ import annotations
#   注解延迟求值。

from collections.abc import AsyncIterator
#   AsyncIterator:异步迭代器的类型(事件流的底层类型)。

from dataclasses import dataclass
#   用 dataclass 定义 StreamState / StreamEvent。

from typing import TYPE_CHECKING, Any, Literal
#   TYPE_CHECKING:仅检查期导入 AgentError(避免和 errors 的潜在循环);
#   Any:data 字典值类型;Literal:把 kind 限定为固定几个字符串字面量。

if TYPE_CHECKING:
    from backend.core.errors import AgentError
    #   仅类型注解用(StreamState.error 的类型),运行时不导入。
```

> **整块作用**:定义"流终态"。它在流**被耗尽后**才有意义——记录整体是否出错、用了多少 token。

```python
@dataclass
#   普通(可变)dataclass:因为它会被"先创建空的、流结束后再填值"。
class StreamState:
    """Terminal metadata for a stream (set once the stream is exhausted)."""
    #   文档:流的终态元数据(流耗尽后才设定)。

    error: AgentError | None = None
    #   整条流层面的错误(若有);默认 None。
    usage: dict[str, Any] | None = None
    #   token 用量统计(prompt/completion 等);默认 None。
```

> **整块作用**:定义"单个增量事件"。`kind` 用 Literal 限定为 6 种;`data` 是该事件的负载字典。

```python
@dataclass(frozen=True)
#   frozen=True:单个事件一旦产生即不可变(更安全,可放进集合/共享)。
class StreamEvent:
    """A single incremental event emitted during a turn."""
    #   文档:turn 期间吐出的单个增量事件。

    kind: Literal[
        #   事件种类(只能是下面这几种字符串,IDE/类型检查会校验):
        "text",
        #   文本增量:data 里有 "delta"(framework 用 event.data.get("delta") 累积成整段)。
        "tool_call",
        #   模型发起的工具调用。
        "tool_result",
        #   工具执行结果。
        "usage",
        #   用量信息。
        "error",
        #   错误:framework 把它转成 RepublicError 广播。
        "final",
        #   最终事件(收尾标志)。
    ]
    data: dict[str, Any]
    #   该事件的负载(不同 kind 含义不同:text 有 delta、error 有 kind/message/...)。
```

> **整块作用**:把"事件异步迭代器 + 终态"包成一个对象。消费方 `async for` 拿事件,流结束后再读
> `.error`/`.usage`。

```python
class AsyncStreamEvents:
    """Async iterator of :class:`StreamEvent` plus terminal :class:`StreamState`."""
    #   文档:StreamEvent 的异步迭代器 + 终态 StreamState。

    def __init__(self, iterator: AsyncIterator[StreamEvent], *, state: StreamState | None = None) -> None:
        self._iterator = iterator
        #   底层事件异步迭代器(谁产出事件就是谁,如模型客户端的生成器)。
        self._state = state or StreamState()
        #   终态;调用方没传就建一个空的(后续由产出方填 error/usage)。

    def __aiter__(self) -> AsyncIterator[StreamEvent]:
        return self._iterator
        #   让本对象可被 `async for ... in stream` 直接迭代——返回内部迭代器即可。

    @property
    def error(self) -> AgentError | None:
        return self._state.error
        #   便捷读终态错误(等价 self._state.error)。

    @property
    def usage(self) -> dict[str, Any] | None:
        return self._state.usage
        #   便捷读终态用量。
```

- **设计要点**:事件序列是"流动的中间产物",终态是"流走完才知道的结论"。两者捆一起,消费方
  无需自己在循环外另存错误/用量——迭代完直接读属性即可。`hook_runtime.run_model_stream` 的退化
  路径就用 `AsyncStreamEvents(iterator(), state=StreamState())` 把单个 text 事件包成这种流。

> **整块作用**:导出三件套。

```python
__all__ = ["AsyncStreamEvents", "StreamEvent", "StreamState"]
```

---

## 怎么和别的文件连起来

- `hooks/hookspecs.py`:`run_model_stream` 返回 `AsyncStreamEvents`。
- `hooks/hook_runtime.py`:流式↔非流式适配时,构造 `StreamEvent("text", {"delta": ...})` 与
  `AsyncStreamEvents(...)`。
- `app/framework.py`:`async for event in stream` 按 `event.kind` 分流(text 累积、error 广播)。

---

## 一句话总结

`StreamEvent`(流动的增量)+ `StreamState`(走完才有的终态)+ `AsyncStreamEvents`(把两者捆在一起
的异步容器)= Creamy 流式输出的统一数据形态。
