# `backend/core/tape_types.py` 精读(C 档·极详)

## 这个文件在干嘛

tape 体系的**值类型层**,三样东西:
- `TapeEntry` —— tape 里的一条**追加式条目**(消息/系统/锚点/工具调用/工具结果/错误/事件);
- `TapeQuery` —— 对单条 tape 的**不可变、链式(fluent)查询构造器**;
- `TapeContext` + `build_messages` —— **选择规则**:从存储的条目里挑出/转成"喂给模型的消息"。

> 设计要点(docstring 明说):本模块刻意做得 **import-light**(只依赖 errors),好让 `store.py`
> 依赖它而**不产生循环**。依赖方向:`store` → `tape_types`(单向)。

---

## 顶部导入 + 工具函数

> **整块作用**:导入 dataclass/类型工具;定义"当前 UTC 时间字符串"小工具(条目默认时间戳用)。

```python
"""Tape value types — project-owned (no longer a republic facade).
...
"""                                  # docstring:三类值类型 + import-light 以避免循环(见上)

from __future__ import annotations
#   注解延迟求值。

from collections.abc import Callable, Coroutine, Iterable
#   Callable:selector 类型;Coroutine:异步 selector 返回;Iterable:条目序列。

from dataclasses import dataclass, field, replace
#   dataclass/field 定义值类型;replace 用于"在不可变对象上产出修改副本"(fluent 查询的核心)。

from datetime import UTC, datetime
from datetime import date as date_type
#   时间:utc_now 生成时间戳;date 用于 between_dates 接受 date 对象。

from typing import TYPE_CHECKING, Any, Self, TypeVar, overload
#   Self:链式方法返回"自身类型";TypeVar/overload:给 TapeQuery 做 同步/异步 的精确类型重载。

from backend.core.errors import AgentError
#   唯一的跨模块依赖(import-light)。TapeEntry.error 用它。

if TYPE_CHECKING:
    from backend.core.store import AsyncTapeStore, TapeStore
    #   仅类型注解用(TapeQuery 泛型参数);运行时不导入,故 store→tape_types 不成环。


def utc_now() -> str:
    return datetime.now(UTC).isoformat()
    #   当前 UTC 时间的 ISO 字符串。作为 TapeEntry.date 的默认值工厂。
```

---

## `TapeEntry`:一条追加式条目

> **整块作用**:定义条目数据结构 + 一组"具名构造器"(classmethod 工厂),用语义化方式造各类条目。

```python
@dataclass(frozen=True)
#   frozen:条目不可变(append-only 语义的体现——存进去就不改)。
class TapeEntry:
    """A single append-only entry in a tape."""

    id: int
    #   条目自增 id(由存储层分配;构造工厂里先给 0,append 时由 store 赋真值)。
    kind: str
    #   条目种类字符串:message/system/anchor/tool_call/tool_result/error/event。
    payload: dict[str, Any]
    #   主负载(不同 kind 结构不同)。
    meta: dict[str, Any] = field(default_factory=dict)
    #   元信息(随条目存,如来源、标签);默认空 dict(用工厂避免可变默认值陷阱)。
    date: str = field(default_factory=utc_now)
    #   时间戳字符串;默认取 utc_now()。

    def copy(self) -> TapeEntry:
        return TapeEntry(self.id, self.kind, dict(self.payload), dict(self.meta), self.date)
        #   深一层拷贝(payload/meta 复制成新 dict),避免外部改到内部引用。InMemoryStore.read 用它。
```

> **整块作用(具名构造器)**:每个 classmethod 造一种 kind 的条目,统一 id=0(待 store 赋值),
> 让调用方写 `TapeEntry.message(...)` 而非手填 kind/payload。

```python
    @classmethod
    def message(cls, message: dict[str, Any], **meta: Any) -> TapeEntry:
        return cls(id=0, kind="message", payload=dict(message), meta=dict(meta))
        #   普通对话消息(payload 即消息体,如 {"role":"user","content":...})。

    @classmethod
    def system(cls, content: str, **meta: Any) -> TapeEntry:
        return cls(id=0, kind="system", payload={"content": content}, meta=dict(meta))
        #   系统消息(只含 content)。

    @classmethod
    def anchor(cls, name: str, state: dict[str, Any] | None = None, **meta: Any) -> TapeEntry:
        payload: dict[str, Any] = {"name": name}
        #   锚点:分段标记,必有 name。
        if state is not None:
            payload["state"] = dict(state)
            #   可选携带 state 快照(handoff 时用)。
        return cls(id=0, kind="anchor", payload=payload, meta=dict(meta))

    @classmethod
    def tool_call(cls, calls: list[dict[str, Any]], **meta: Any) -> TapeEntry:
        return cls(id=0, kind="tool_call", payload={"calls": calls}, meta=dict(meta))
        #   模型发起的一批工具调用。

    @classmethod
    def tool_result(cls, results: list[Any], **meta: Any) -> TapeEntry:
        return cls(id=0, kind="tool_result", payload={"results": results}, meta=dict(meta))
        #   工具执行结果。

    @classmethod
    def error(cls, error: AgentError, **meta: Any) -> TapeEntry:
        return cls(id=0, kind="error", payload=error.as_dict(), meta=dict(meta))
        #   错误条目:用 AgentError.as_dict() 序列化进 payload(见 errors.md)。

    @classmethod
    def event(cls, name: str, data: dict[str, Any] | None = None, **meta: Any) -> TapeEntry:
        payload: dict[str, Any] = {"name": name}
        #   通用事件:必有 name(如 "handoff")。
        if data is not None:
            payload["data"] = dict(data)
            #   可选事件数据。
        return cls(id=0, kind="event", payload=payload, meta=dict(meta))
```

---

## `TapeQuery`:不可变链式查询构造器

> **整块作用**:用"每次方法都 `replace` 出新副本"的方式,链式拼出一个查询条件,最后由 store 执行。
> 不可变 = 线程安全、可复用、无副作用。

```python
T = TypeVar("T", bound="TapeStore | AsyncTapeStore", covariant=True)
#   类型变量:绑定到"同步或异步 store";covariant 用于精确表达 all() 的返回随 store 类型而变。

@dataclass(frozen=True)
class TapeQuery[T: "TapeStore | AsyncTapeStore"]:
    #   PEP 695 泛型语法:TapeQuery 携带其 store 的类型(同步/异步),让 all() 重载能区分返回。
    """Immutable, fluent query over a single tape's entries."""

    tape: str
    #   目标 tape 名。
    store: T
    #   绑定的存储(决定 all() 是同步返回还是协程)。
    _query: str | None = None
    #   全文过滤关键词。
    _after_anchor: str | None = None
    #   "某锚点之后"。
    _after_last: bool = False
    #   "最后一个锚点之后"。
    _between_anchors: tuple[str, str] | None = None
    #   "两个锚点之间"。
    _between_dates: tuple[str, str] | None = None
    #   "两个日期之间"。
    _kinds: tuple[str, ...] = field(default_factory=tuple)
    #   只要某些 kind。
    _limit: int | None = None
    #   数量上限。
```

> **整块作用(链式方法)**:每个方法都返回 `replace(self, ...)` 的新查询——原对象不变,可安全链式。

```python
    def query(self, value: str) -> Self:
        return replace(self, _query=value)
        #   加"全文关键词过滤"。replace:复制当前查询并只改 _query 字段。

    def after_anchor(self, name: str) -> Self:
        if not name:
            return replace(self, _after_anchor=None, _after_last=False)
            #   传空名 = 清除"锚点之后"约束。
        return replace(self, _after_anchor=name, _after_last=False)
        #   设"指定锚点之后"(并清掉 after_last,二者互斥)。

    def last_anchor(self) -> Self:
        return replace(self, _after_anchor=None, _after_last=True)
        #   设"最后一个锚点之后"。

    def between_anchors(self, start: str, end: str) -> Self:
        return replace(self, _between_anchors=(start, end))
        #   设"两锚点之间"。

    def between_dates(self, start: str | date_type, end: str | date_type) -> Self:
        start_value = start.isoformat() if isinstance(start, date_type) else start
        #   date 对象统一转 ISO 字符串。
        end_value = end.isoformat() if isinstance(end, date_type) else end
        return replace(self, _between_dates=(start_value, end_value))
        #   设"两日期之间"。

    def kinds(self, *kinds: str) -> Self:
        return replace(self, _kinds=kinds)
        #   只保留指定 kind 的条目。

    def limit(self, value: int) -> Self:
        return replace(self, _limit=value)
        #   限制返回条数。
```

> **整块作用(all)**:执行查询。用 `@overload` 让类型检查器知道:store 是同步则返回 Iterable,
> 异步则返回 Coroutine——运行时只有一个真正实现。

```python
    @overload
    def all(self: TapeQuery[TapeStore]) -> Iterable[TapeEntry]: ...
    #   类型重载①:绑定同步 store 时,all() 直接返回可迭代条目。
    @overload
    async def all(self: TapeQuery[AsyncTapeStore]) -> Iterable[TapeEntry]: ...
    #   类型重载②:绑定异步 store 时,all() 是协程(需 await)。

    def all(self) -> Iterable[TapeEntry] | Coroutine[None, None, Iterable[TapeEntry]]:
        return self.store.fetch_all(self)
        #   真正实现:把自身(整个查询条件)交给 store.fetch_all 执行。
        #   同步 store 返回 Iterable,异步 store 返回协程——与上面两个 overload 对应。
```

---

## `TapeContext` + `build_messages`:选择规则

> **整块作用**:`TapeContext` 描述"读消息时取哪段、用什么 selector 转换";`build_messages` 据此
> 把条目转成消息列表。还有 LAST_ANCHOR 哨兵与若干类型别名。

```python
class _LastAnchor:
    def __repr__(self) -> str:
        return "LAST_ANCHOR"
        #   一个独特的哨兵类型,实例 repr 为 "LAST_ANCHOR"(便于调试)。

LAST_ANCHOR = _LastAnchor()
#   单例哨兵:表示"取最后一个锚点之后"。用对象而非字符串,避免与"锚点名字符串"混淆。

type AnchorSelector = str | None | _LastAnchor
#   anchor 选择器类型:锚点名 / None(取全部) / LAST_ANCHOR。
type SelectedMessages = list[dict[str, Any]] | Coroutine[Any, Any, list[dict[str, Any]]]
#   selector 的返回:消息列表,或返回它的协程(允许异步 selector)。
type ContextSelector = Callable[[Iterable[TapeEntry], "TapeContext"], SelectedMessages]
#   selector 签名:输入(条目, 上下文)→ 消息列表(或其协程)。
```

```python
@dataclass(frozen=True)
class TapeContext:
    """Rules for selecting tape entries into a prompt context. ..."""
    #   文档(含字段语义,见下):
    #     anchor:LAST_ANCHOR=最近锚点之后;None=全 tape;字符串=该锚点之后。
    #     select:锚点切片之后再调用的 selector(返回消息);None 则用默认。
    #     state:随上下文携带的状态字典。

    anchor: AnchorSelector = LAST_ANCHOR
    #   默认取"最后一个锚点之后"(配合 handoff 实现历史压缩)。
    select: ContextSelector | None = None
    #   可选自定义 selector(默认 None → 用 _default_messages)。
    state: dict[str, Any] = field(default_factory=dict)
    #   附带状态。

    def build_query(self, query: TapeQuery) -> TapeQuery:
        #   把 anchor 选择翻译成具体 TapeQuery(engine.read_messages_async 调它)。
        if self.anchor is None:
            return query
            #   None:不加锚点约束(取全部)。
        if isinstance(self.anchor, _LastAnchor):
            return query.last_anchor()
            #   LAST_ANCHOR:取最后锚点之后。
        return query.after_anchor(self.anchor)
        #   字符串:取该名锚点之后。
```

```python
def build_messages(entries: Iterable[TapeEntry], context: TapeContext) -> SelectedMessages:
    if context.select is not None:
        return context.select(entries, context)
        #   有自定义 selector 就用它(可能返回协程)。
    return _default_messages(entries)
    #   否则用默认:只挑 message 条目。

def _default_messages(entries: Iterable[TapeEntry]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for entry in entries:
        if entry.kind != "message":
            continue
            #   默认只关心"消息"条目,跳过锚点/事件/工具等。
        payload = entry.payload
        if not isinstance(payload, dict):
            continue
            #   payload 不是 dict 就跳过(健壮性)。
        messages.append(dict(payload))
        #   复制 payload 入列表(避免外部改到 tape 内部)。
    return messages
```

```python
__all__ = [
    "LAST_ANCHOR", "AnchorSelector", "ContextSelector", "SelectedMessages",
    "TapeContext", "TapeEntry", "TapeQuery", "build_messages", "utc_now",
]
#   导出全部公开符号。
```

---

## 怎么和别的文件连起来

- `core/engine.py`:`Tape.read_messages_async` 用 `context.build_query` + `store.fetch_all` +
  `build_messages`;`handoff_async` 造 `TapeEntry.anchor/event`。
- `core/store.py`:`InMemoryQueryMixin.fetch_all` 消费 `TapeQuery` 的各 `_xxx` 字段执行过滤;
  `AsyncTapeStoreAdapter` 把同步实现包成异步。
- `context/context.py`:`default_tape_context()` 产出定制的 `TapeContext`。

---

## 一句话总结

`tape_types.py` 是 tape 的"名词表":条目(TapeEntry)、查询(不可变链式 TapeQuery)、选择规则
(TapeContext + build_messages)。它 import-light、不依赖 store,从而让 store 反过来依赖它而不成环。
