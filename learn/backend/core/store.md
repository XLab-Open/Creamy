# `backend/core/store.py` 精读(C 档·极详)

## 这个文件在干嘛

tape 体系的**存储层**:
- 两个 `Protocol`:`TapeStore`(同步)/ `AsyncTapeStore`(异步)—— 定义"存储该有哪些方法";
- `is_async_tape_store` —— 运行时判断一个 store 是不是异步实现;
- `InMemoryQueryMixin` —— **把 `TapeQuery` 的查询语义在内存里实现**(锚点开窗、日期/全文/kind 过滤、
  limit),供具体 store 复用(`memory/store.py` 的 FileTapeStore 也建立在它之上);
- `InMemoryTapeStore` —— 一个完整的内存存储实现;
- `AsyncTapeStoreAdapter` —— 把同步 store 包成异步(用线程池)。

> 这是"会话历史到底怎么存、怎么查"的核心。`engine.py` 在它之上提供好用的视图;
> `hook_impl.provide_tape_store` 出厂返回的 `FileTapeStore`(在 `memory/store.py`)就复用了这里的
> `InMemoryQueryMixin` 查询语义。

---

## 顶部导入

> **整块作用**:导入并发/反射/时间/类型工具,以及错误类型与 TapeEntry。

```python
"""Tape stores — project-owned (no longer a republic facade). ..."""
#   docstring:协议 + 内存 store + 同步转异步适配器 + 查询语义 mixin。

from __future__ import annotations
import asyncio
#   AsyncTapeStoreAdapter 用 asyncio.to_thread 把同步调用丢到线程池(不阻塞事件循环)。
import inspect
#   is_async_tape_store 用 inspect.iscoroutinefunction 判断 append 是不是协程函数。
import json
#   全文匹配时把条目序列化成 JSON 字符串再找子串。
from collections.abc import Iterable, Sequence
#   返回/参数类型。
from datetime import UTC, datetime, time
from datetime import date as date_type
#   日期边界解析(把 "2026-06-13" 之类转成带时区的 datetime 区间)。
from typing import TYPE_CHECKING, Protocol, TypeGuard
#   Protocol:结构化接口;TypeGuard:让 is_async_tape_store 能"窄化"类型。

from backend.core.errors import AgentError, ErrorKind
#   查询里抛 AgentError(NOT_FOUND/INVALID_INPUT)。
from backend.core.tape_types import TapeEntry
#   条目类型(实际值)。

if TYPE_CHECKING:
    from backend.core.tape_types import TapeQuery
    #   仅类型注解(运行时不需要,避免不必要导入)。
```

---

## 两个存储协议

> **整块作用**:用 `Protocol` 定义"同步 store / 异步 store 各该有哪些方法"。Protocol = 结构化类型,
> 任何实现了这些方法的类都"算"是 store,无需显式继承(鸭子类型 + 静态检查)。

```python
class TapeStore(Protocol):
    """Append-only tape storage interface."""
    def list_tapes(self) -> list[str]: ...          # 列出所有 tape 名
    def reset(self, tape: str) -> None: ...          # 清空某 tape
    def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]: ...  # 按查询取条目
    def append(self, tape: str, entry: TapeEntry) -> None: ...         # 追加一条

class AsyncTapeStore(Protocol):
    """Async append-only tape storage interface."""
    async def list_tapes(self) -> list[str]: ...     # 同上,异步版
    async def reset(self, tape: str) -> None: ...
    async def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]: ...
    async def append(self, tape: str, entry: TapeEntry) -> None: ...
```
- 四个方法定义了 tape 存储的最小能力面:列举 / 清空 / 查询 / 追加(**没有"改/删单条"——append-only**)。

> **整块作用**:运行时判断"这个 store 是异步实现吗"。

```python
def is_async_tape_store(store: TapeStore | AsyncTapeStore) -> TypeGuard[AsyncTapeStore]:
    return hasattr(store, "append") and inspect.iscoroutinefunction(store.append)
    #   判据:有 append 且 append 是协程函数 → 认定为异步 store。
    #   返回 TypeGuard[AsyncTapeStore]:为 True 时,类型检查器会把 store 窄化成 AsyncTapeStore。
    #   engine.ModelEngine.__init__ 用它决定要不要包适配器。
```

---

## 查询辅助函数(供 mixin 用)

> **整块作用(_anchor_index)**:在条目序列里找"某个锚点"的下标,支持正向/反向、可选名字、可选起点。
> 这是"按锚点开窗"的底层。

```python
def _anchor_index(entries, name, *, default, forward, start=0) -> int:
    rng = range(start, len(entries)) if forward else range(len(entries) - 1, start - 1, -1)
    #   遍历方向:forward 从前往后,否则从后往前(找"最后一个锚点"要反向)。
    for idx in rng:
        entry = entries[idx]
        if entry.kind != "anchor":
            continue
            #   只看锚点条目。
        if name is not None and entry.payload.get("name") != name:
            continue
            #   指定了名字就要名字匹配;name=None 表示"任意锚点"。
        return idx
        #   命中,返回下标。
    return default
    #   没找到返回默认值(调用方常传 -1 表示"未找到")。
```

> **整块作用(_parse_datetime_boundary)**:把"日期或日期时间字符串"解析成带 UTC 时区的 datetime;
> 纯日期会按"是起点还是终点"补成当天 00:00 或 23:59:59.999999。

```python
def _parse_datetime_boundary(value: str, *, is_end: bool) -> datetime:
    if "T" not in value and " " not in value:
        #   不含 T/空格 → 很可能是纯日期 "YYYY-MM-DD"。
        try:
            parsed_date = date_type.fromisoformat(value)
        except ValueError:
            pass
            #   解析失败就继续往下当 datetime 试。
        else:
            boundary_time = time.max if is_end else time.min
            #   终点用一天的最末时刻,起点用最早时刻(让"某天"覆盖全天)。
            return datetime.combine(parsed_date, boundary_time, tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(value)
        #   尝试完整 datetime 解析。
    except ValueError:
        try:
            parsed_date = date_type.fromisoformat(value)
            #   再退一步当纯日期。
        except ValueError as exc:
            raise AgentError(ErrorKind.INVALID_INPUT, f"Invalid ISO date or datetime: '{value}'.") from exc
            #   都不行 → 报"非法输入"错误(链式保留原异常)。
        boundary_time = time.max if is_end else time.min
        parsed = datetime.combine(parsed_date, boundary_time, tzinfo=UTC)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
        #   无时区 → 视为 UTC。
    return parsed.astimezone(UTC)
    #   有时区 → 统一换算到 UTC(保证比较口径一致)。
```

> **整块作用(_entry_in_datetime_range / _entry_matches_query)**:判断条目是否落在日期区间内 / 是否
> 全文命中关键词。

```python
def _entry_in_datetime_range(entry, start_dt, end_dt) -> bool:
    entry_dt = _parse_datetime_boundary(entry.date, is_end=False)
    #   把条目时间戳解析成 datetime。
    return start_dt <= entry_dt <= end_dt
    #   落在 [start, end] 内即为真。

def _entry_matches_query(entry, query: str) -> bool:
    needle = query.casefold()
    #   关键词归一化(casefold 比 lower 更彻底,适合大小写不敏感匹配)。
    haystack = json.dumps(
        {"kind": entry.kind, "date": entry.date, "payload": entry.payload, "meta": entry.meta},
        sort_keys=True, default=str,
    ).casefold()
    #   把整条条目序列化成稳定 JSON 字符串(sort_keys 保证可重复;default=str 兜底不可序列化对象)再归一化。
    return needle in haystack
    #   子串包含即命中(简单的"全文搜索")。
```

---

## `InMemoryQueryMixin`:把查询语义在内存里实现

> **整块作用**:实现 `fetch_all(query)` —— 按锚点开窗 → 日期过滤 → 全文过滤 → kind 过滤 → limit。
> 任何"能把整条 tape 读进内存"的 store(如 FileTapeStore)只要实现 `read()`,就能复用这套查询。

```python
class InMemoryQueryMixin:
    """Mixin to implement fetch_all() in-memory for simple stores."""

    def read(self, tape: str) -> list[TapeEntry] | None:
        raise NotImplementedError("InMemoryQueryMixin requires a read() method to be implemented.")
        #   抽象方法:子类必须提供"读出某 tape 全部条目"的实现。mixin 自己不知道数据存哪。

    def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]:  # noqa: C901
        #   noqa: C901:分支多(锚点/日期/全文/kind/limit),复杂度高是预期的。
        entries = self.read(query.tape) or []
        #   先把整条 tape 读进内存(None → 空)。
        start_index = 0
        end_index: int | None = None
        #   开窗区间 [start, end);默认全段。

        if query._between_anchors is not None:
            #   ① 两锚点之间:
            start_name, end_name = query._between_anchors
            start_idx = _anchor_index(entries, start_name, default=-1, forward=False)
            #   反向找起始锚点(取最近的同名锚点)。
            if start_idx < 0:
                raise AgentError(ErrorKind.NOT_FOUND, f"Anchor '{start_name}' was not found.")
                #   找不到就报 NOT_FOUND。
            end_idx = _anchor_index(entries, end_name, default=-1, forward=True, start=start_idx + 1)
            #   从起始锚点之后正向找结束锚点。
            if end_idx < 0:
                raise AgentError(ErrorKind.NOT_FOUND, f"Anchor '{end_name}' was not found.")
            start_index = min(start_idx + 1, len(entries))
            #   窗口从起始锚点的"下一条"开始(不含锚点本身)。
            end_index = min(max(start_index, end_idx), len(entries))
            #   结束于结束锚点处;max 保证不小于 start。
        elif query._after_last:
            #   ② 最后一个锚点之后:
            anchor_index = _anchor_index(entries, None, default=-1, forward=False)
            #   反向找任意锚点(即最后一个)。
            if anchor_index < 0:
                raise AgentError(ErrorKind.NOT_FOUND, "No anchors found in tape.")
            start_index = min(anchor_index + 1, len(entries))
            #   从它之后开始。
        elif query._after_anchor is not None:
            #   ③ 指定锚点之后:
            anchor_index = _anchor_index(entries, query._after_anchor, default=-1, forward=False)
            if anchor_index < 0:
                raise AgentError(ErrorKind.NOT_FOUND, f"Anchor '{query._after_anchor}' was not found.")
            start_index = min(anchor_index + 1, len(entries))

        sliced = entries[start_index:end_index]
        #   按算好的窗口切片(锚点开窗的结果)。

        if query._between_dates is not None:
            #   ④ 日期区间过滤:
            start_date, end_date = query._between_dates
            start_dt = _parse_datetime_boundary(start_date, is_end=False)
            end_dt = _parse_datetime_boundary(end_date, is_end=True)
            if start_dt > end_dt:
                raise AgentError(ErrorKind.INVALID_INPUT, "Start date must be earlier than or equal to end date.")
                #   起点晚于终点 → 非法输入。
            sliced = [entry for entry in sliced if _entry_in_datetime_range(entry, start_dt, end_dt)]
            #   只留落在区间内的。
        if query._query:
            #   ⑤ 全文关键词过滤:
            sliced = [entry for entry in sliced if _entry_matches_query(entry, query._query)]
        if query._kinds:
            #   ⑥ kind 过滤:
            sliced = [entry for entry in sliced if entry.kind in query._kinds]
        if query._limit is not None:
            #   ⑦ 数量上限:
            sliced = sliced[: query._limit]
        return sliced
        #   返回最终结果(过滤管道:开窗→日期→全文→kind→limit)。
```

- **这套过滤管道就是 `TapeQuery` 链式条件的"执行端"**:tape_types 里 `query.after_anchor(...)`
  设置 `_after_anchor` 字段,这里据该字段做开窗。两文件配合实现"声明查询 / 执行查询"分离。

---

## `InMemoryTapeStore`:完整的内存存储

> **整块作用**:用两个 dict 在内存里存所有 tape 与自增 id;实现协议四方法 + mixin 要求的 read()。
> 注释明说"非线程安全"。

```python
class InMemoryTapeStore(InMemoryQueryMixin):
    """In-memory tape storage (not thread-safe)."""

    def __init__(self) -> None:
        self._tapes: dict[str, list[TapeEntry]] = {}
        #   tape 名 -> 条目列表。
        self._next_id: dict[str, int] = {}
        #   tape 名 -> 下一个要分配的条目 id。

    def list_tapes(self) -> list[str]:
        return sorted(self._tapes.keys())
        #   列出所有 tape 名(排序,稳定输出)。

    def reset(self, tape: str) -> None:
        self._tapes.pop(tape, None)
        #   删条目。
        self._next_id.pop(tape, None)
        #   重置 id 计数。

    def read(self, tape: str) -> list[TapeEntry] | None:
        entries = self._tapes.get(tape)
        if entries is None:
            return None
            #   该 tape 不存在 → None(mixin 会当空处理)。
        return [entry.copy() for entry in entries]
        #   返回副本列表(防止外部改到内部存储)。

    def append(self, tape: str, entry: TapeEntry) -> None:
        next_id = self._next_id.get(tape, 1)
        #   取下一个 id(从 1 开始)。
        self._next_id[tape] = next_id + 1
        #   递增。
        stored = TapeEntry(next_id, entry.kind, dict(entry.payload), dict(entry.meta), entry.date)
        #   重建一条带真实 id 的条目(传入的 entry.id 通常是 0;这里赋真值),并复制 payload/meta。
        self._tapes.setdefault(tape, []).append(stored)
        #   追加到该 tape(没有就先建空列表)。
```

---

## `AsyncTapeStoreAdapter`:同步 store → 异步

> **整块作用**:把同步 store 的四个方法,用 `asyncio.to_thread` 丢到线程池执行,从而对外呈现
> 异步接口、且不阻塞事件循环。`ModelEngine` 在拿到同步 store 时自动用它包一层。

```python
class AsyncTapeStoreAdapter:
    """Adapt a sync TapeStore to AsyncTapeStore."""

    def __init__(self, store: TapeStore) -> None:
        self._store = store
        #   被包装的同步 store。

    async def list_tapes(self) -> list[str]:
        return await asyncio.to_thread(self._store.list_tapes)
        #   在线程池里跑同步 list_tapes,await 其结果(不卡事件循环)。

    async def reset(self, tape: str) -> None:
        await asyncio.to_thread(self._store.reset, tape)

    async def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]:
        return await asyncio.to_thread(self._store.fetch_all, query)

    async def append(self, tape: str, entry: TapeEntry) -> None:
        await asyncio.to_thread(self._store.append, tape, entry)
```

```python
__all__ = [
    "AsyncTapeStore", "AsyncTapeStoreAdapter", "InMemoryQueryMixin",
    "InMemoryTapeStore", "TapeStore", "is_async_tape_store",
]
#   导出全部公开符号。
```

---

## 怎么和别的文件连起来

- `core/tape_types.py`:`TapeQuery` 的 `_xxx` 字段在这里的 `fetch_all` 被消费;`TapeEntry` 是存储单位。
- `core/engine.py`:`is_async_tape_store` 判异步、`AsyncTapeStoreAdapter` 包同步。
- `memory/store.py`:`FileTapeStore` 复用 `InMemoryQueryMixin`(实现 read() 即可),把 tape 落到磁盘。
- `hook_impl.provide_tape_store`:出厂返回 FileTapeStore。

---

## 一句话总结

`store.py` 定义"tape 怎么存怎么查":两个 Protocol 约定接口,`InMemoryQueryMixin` 实现一整套"锚点
开窗 + 日期/全文/kind/limit"的查询管道(可被磁盘 store 复用),`InMemoryTapeStore` 是内存实现,
`AsyncTapeStoreAdapter` 让同步 store 也能异步用。
