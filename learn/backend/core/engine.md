# `backend/core/engine.py` 精读(C 档·极详)

## 这个文件在干嘛

提供**tape 存储引擎**:`ModelEngine`(拥有"每条 tape 的追加式存储"与默认选择上下文)和 `Tape`
(对单条 tape 的异步视图)。

> ⚠️ 名字容易误导:`ModelEngine` **不跑模型**!模型调用走 LangGraph(在 `llm/graph.py`)。本引擎
> 只负责 tape 的**持久化与回放**:读消息 / 追加 / 查询 / handoff(交接) / 重置。把它理解成"会话
> 录音带的读写机",不是"模型调用器"。

整个 tape 体系分三层,职责清晰:
- `tape_types.py` —— 值类型(TapeEntry/TapeQuery/TapeContext);
- `store.py` —— 存储协议与实现(数据存哪、查询语义);
- `engine.py`(本文)—— 在 store 之上提供**好用的异步操作视图**(Tape / ModelEngine)。

---

## 顶部导入

> **整块作用**:模块 docstring 澄清"只存不跑模型";导入 store 抽象与 tape 值类型。

```python
"""Tape-storage engine — project-owned (no longer a republic facade).
#   定性:项目自有的 tape 存储引擎。

``ModelEngine`` owns per-tape append-only storage and the default selection
context; ``Tape`` is the per-tape async view returned by :meth:`ModelEngine.tape`.
#   ModelEngine:持有"每条 tape 的追加式存储"+默认选择上下文;Tape:ModelEngine.tape() 返回的单条视图。

Model calls do **not** run here — they run through LangGraph in ``llm/graph.py``.
This engine only persists and replays tape entries (messages, anchors, events):
the storage subset ``read_messages_async`` / ``append_async`` / ``query_async`` /
``handoff_async`` / ``reset_async``.
#   重申:模型调用不在这,在 llm/graph.py。本引擎只做 tape 条目(消息/锚点/事件)的存与放。
"""

from __future__ import annotations
#   注解延迟求值。

import inspect
#   用 inspect.isawaitable 兼容 build_messages 可能返回"协程或同步结果"两种情况。

from typing import Any, cast
#   Any:消息字典值类型;cast:把 sync store 断言成 TapeStore 后再包成异步适配器。

from backend.core.store import (
    AsyncTapeStore,            # 异步存储协议
    AsyncTapeStoreAdapter,     # 把同步 store 包成异步的适配器
    TapeStore,                 # 同步存储协议
    is_async_tape_store,       # 判断一个 store 是不是异步实现
)
from backend.core.tape_types import TapeContext, TapeEntry, TapeQuery, build_messages
#   tape 值类型 + build_messages(把 entries 按 context 选成 prompt 消息列表)。见 tape_types.md。
```

---

## `Tape`:单条 tape 的异步视图

> **整块作用**:封装"对某一条 tape(按名字)的所有读写操作"。它持有底层 async store、一个默认
> 上下文、以及可选的"局部上下文覆盖"。

```python
class Tape:
    """A scoped, async view over a single tape's append-only storage."""
    #   文档:对单条 tape 追加式存储的、限定范围的异步视图。

    def __init__(self, name: str, *, store: AsyncTapeStore, default_context: TapeContext) -> None:
        self._name = name
        #   这条 tape 的名字(通常 = session_id)。
        self._store = store
        #   底层异步存储(由 ModelEngine 传入,可能是适配过的同步 store)。
        self._default_context = default_context
        #   默认选择上下文(决定"读消息时取哪段、怎么选")。
        self._local_context: TapeContext | None = None
        #   局部覆盖:若设了,优先用它而非默认。

    def __repr__(self) -> str:
        return f"<Tape name={self._name}>"
        #   调试友好的字符串表示。

    @property
    def name(self) -> str:
        return self._name
        #   只读:tape 名。

    @property
    def context(self) -> TapeContext:
        return self._local_context or self._default_context
        #   生效上下文 = 局部覆盖优先,否则默认。

    @context.setter
    def context(self, value: TapeContext | None) -> None:
        self._local_context = value
        #   设置局部上下文(传 None 即清除覆盖,回落默认)。

    @property
    def query_async(self) -> TapeQuery[AsyncTapeStore]:
        return TapeQuery(tape=self._name, store=self._store)
        #   造一个"针对本 tape、绑定 async store"的查询构造器(链式 API,见 tape_types.md)。
```

> **整块作用(read_messages_async)**:把 tape 里存的条目,按选择上下文取出并转成"prompt 消息列表"。

```python
    async def read_messages_async(self, *, context: TapeContext | None = None) -> list[dict[str, Any]]:
        active_context = context or self.context
        #   本次用的上下文:显式传入优先,否则用生效上下文。
        query = active_context.build_query(self.query_async)
        #   让上下文把"选哪段"翻译成具体的 TapeQuery(如 last_anchor()/after_anchor(...))。
        entries = await self._store.fetch_all(query)
        #   执行查询,异步取回匹配的条目。
        messages = build_messages(entries, active_context)
        #   把条目按上下文规则选/转成消息列表(默认只取 kind=="message" 的 payload)。
        if inspect.isawaitable(messages):
            #   build_messages 的 selector 可能是异步的(返回协程),
            messages = await messages
            #   那就 await 它。
        return messages
        #   返回最终消息列表(喂给模型的历史上下文)。
```

> **整块作用(append/reset)**:向本 tape 追加一条条目;清空本 tape。

```python
    async def append_async(self, entry: TapeEntry) -> None:
        await self._store.append(self._name, entry)
        #   追加一条 TapeEntry(消息/工具调用/事件…)。append-only:只增不改。

    async def reset_async(self) -> None:
        await self._store.reset(self._name)
        #   清空本 tape 的全部条目(重新开始一段会话)。
```

> **整块作用(handoff_async)**:做一次"交接"——写入一个锚点(anchor)+ 一个 handoff 事件。
> 这是上下文压缩/分段的机制:后续读消息可"只取最后一个锚点之后",从而丢弃旧历史、缩短上下文。

```python
    async def handoff_async(
        self,
        name: str,
        #   交接点名字(锚点名)。
        *,
        state: dict[str, Any] | None = None,
        #   交接时要携带/快照的状态。
        **meta: Any,
        #   额外元信息(随条目一起存)。
    ) -> list[TapeEntry]:
        anchor = TapeEntry.anchor(name, state=state, **meta)
        #   造一个 anchor 条目(标记"从这里起是新一段")。
        event = TapeEntry.event("handoff", {"name": name, "state": state or {}}, **meta)
        #   再造一个 handoff 事件条目(记录这次交接发生过、带了什么 state)。
        await self._store.append(self._name, anchor)
        #   先写锚点。
        await self._store.append(self._name, event)
        #   再写事件。
        return [anchor, event]
        #   返回刚写入的两条(调用方可能要用)。
```

- **锚点(anchor)是 tape 的"分段标记"**。`TapeContext` 默认 `LAST_ANCHOR` = 只取"最后一个锚点
  之后"的条目——配合 handoff,就能实现"压缩历史/开新段"。这呼应了系统提示里提到的 `tape.handoff`
  工具(让模型主动缩短上下文)。

---

## `ModelEngine`:存储 + 默认上下文的拥有者

> **整块作用**:持有一个(必要时被适配成异步的)store 和一个默认上下文;`tape(name)` 据此产出
> 一个 `Tape` 视图。

```python
class ModelEngine:
    """Append-only tape storage + default context (model calls live in LangGraph)."""
    #   文档再次强调:它=追加式 tape 存储+默认上下文;模型调用在 LangGraph。

    def __init__(
        self,
        tape_store: TapeStore | AsyncTapeStore,
        #   传入的存储(同步或异步均可)。
        context: TapeContext | None = None,
        #   默认选择上下文(不传则用 TapeContext() 默认规则)。
    ) -> None:
        if is_async_tape_store(tape_store):
            #   传入的已经是异步 store,
            self._store: AsyncTapeStore = tape_store
            #   直接用。
        else:
            self._store = AsyncTapeStoreAdapter(cast("TapeStore", tape_store))
            #   是同步 store —— 用适配器包成异步(内部用 asyncio.to_thread 把同步调用丢线程池)。
            #   这样上层统一面向 AsyncTapeStore 编程,无需关心底层同步/异步。
        self._context = context or TapeContext()
        #   默认上下文。

    @property
    def context(self) -> TapeContext:
        return self._context
        #   只读默认上下文。

    @context.setter
    def context(self, value: TapeContext) -> None:
        self._context = value
        #   允许替换默认上下文。

    def tape(self, name: str, *, context: TapeContext | None = None) -> Tape:
        return Tape(name, store=self._store, default_context=context or self._context)
        #   工厂:对指定名字的 tape 产出一个 Tape 视图;可临时指定该视图的默认上下文。
```

- **关键设计:同步/异步统一**。`provide_tape_store` 可能给同步 store(如 FileTapeStore),也可能
  给异步的;`ModelEngine` 用 `is_async_tape_store` 判断,同步的就用 `AsyncTapeStoreAdapter` 包一层,
  对上层呈现统一的异步接口。

---

## 怎么和别的文件连起来

- `core/store.py`:提供 `TapeStore`/`AsyncTapeStore` 协议、`AsyncTapeStoreAdapter`、
  `is_async_tape_store`、`InMemoryTapeStore`。见 store.md。
- `core/tape_types.py`:`TapeEntry`(条目)、`TapeQuery`(查询构造)、`TapeContext`(选择规则)、
  `build_messages`。见 tape_types.md。
- 上层:`agent/` 与 `memory/` 用 `ModelEngine`/`Tape` 读写会话历史;`hook_impl.provide_tape_store`
  提供底层 store(出厂 FileTapeStore)。

---

## 一句话总结

`engine.py` 是 tape 的"读写机":`ModelEngine` 拥有存储+默认上下文并统一同步/异步,`Tape` 提供对
单条会话录音带的 读消息 / 追加 / handoff交接 / 重置 操作。**它只管存放与回放,不碰模型调用**。
