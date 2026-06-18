# `backend/memory/tape.py` 精读(C 档·极详)

## 这个文件在干嘛

**tape 高层服务 `TapeService`**:在 `ModelEngine`(引擎)+ `ForkTapeStore`(可分叉存储)之上,提供 agent
日常要用的便捷操作——会话 tape 定位、统计(info)、确保起始锚点、列锚点、归档、重置、handoff(交接)、
搜索、追加事件、fork 作用域。还定义两个值类型 `TapeInfo`/`AnchorSummary`。

> 回顾:`agent.tapes` 就是 `TapeService`。agent.run 用它的 `session_tape`/`fork_tape`/`ensure_bootstrap_anchor`/
> `handoff`/`append_event`;CLI 状态栏用 `info`。

---

## 顶部:导入与值类型

> **整块作用**:导入引擎/存储/类型;定义 `TapeInfo`(统计摘要)与 `AnchorSummary`(锚点摘要)。

```python
import contextlib
import hashlib   # session_tape 用 md5 算 tape 名
import json
from collections.abc import AsyncGenerator
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from pydantic.dataclasses import dataclass   # 带校验的 dataclass

from backend.core.engine import ModelEngine, Tape
from backend.core.store import AsyncTapeStore
from backend.core.tape_types import TapeEntry, TapeQuery
from backend.memory.store import ForkTapeStore


@dataclass(frozen=True)
class TapeInfo:
    """Runtime tape info summary."""
    name: str                          # tape 名
    entries: int                       # 总条目数
    anchors: int                       # 锚点数
    last_anchor: str | None            # 最后一个锚点名
    entries_since_last_anchor: int     # 最后锚点之后的条目数(衡量"当前段"多长)
    last_token_usage: int | None       # 最近一次 run 的 token 用量

@dataclass(frozen=True)
class AnchorSummary:
    """Rendered anchor summary."""
    name: str                          # 锚点名
    state: dict[str, object]           # 锚点携带的状态
```

---

## 构造

> **整块作用**:持有引擎(读写 tape)、归档目录、可分叉存储。

```python
class TapeService:
    def __init__(self, engine: ModelEngine, archive_path: Path, store: ForkTapeStore) -> None:
        self._llm = engine        # ModelEngine(命名沿用 llm,但只管 tape 存储)
        self._archive_path = archive_path  # 归档目录(reset --archive 时备份到此)
        self._store = store       # ForkTapeStore(fork/search 用)
```

---

## info:统计摘要

> **整块作用**:读全部条目,统计总数/锚点数/最后锚点/最后锚点后条目数/最近 token 用量。

```python
    async def info(self, tape_name: str) -> TapeInfo:
        tape = self._llm.tape(tape_name)
        entries = list(await tape.query_async.all())
        #   取全部条目。
        anchors = [(i, entry) for i, entry in enumerate(entries) if entry.kind == "anchor"]
        #   找出所有锚点及其下标。
        if anchors:
            last_anchor = anchors[-1][1].payload.get("name")
            entries_since_last_anchor = len(entries) - anchors[-1][0] - 1
            #   有锚点:最后锚点名 + 它之后的条目数。
        else:
            last_anchor = None
            entries_since_last_anchor = len(entries)
            #   无锚点:全部都算"未分段"。
        last_token_usage: int | None = None
        for entry in reversed(entries):
            if entry.kind == "event" and entry.payload.get("name") == "run":
                #   从最新往旧找 "run" 事件。
                with contextlib.suppress(AttributeError):
                    token_usage = entry.payload.get("data", {}).get("usage", {}).get("total_tokens")
                    if token_usage and isinstance(token_usage, int):
                        last_token_usage = token_usage
                        break
                        #   取到 total_tokens 就停(最近一次用量)。
        return TapeInfo(
            name=tape.name, entries=len(entries), anchors=len(anchors),
            last_anchor=str(last_anchor) if last_anchor else None,
            entries_since_last_anchor=entries_since_last_anchor,
            last_token_usage=last_token_usage,
        )
```

---

## 锚点相关:ensure_bootstrap_anchor / anchors

> **整块作用**:确保 tape 有"起始锚点"(没有就 handoff 一个);列出最近若干锚点摘要。

```python
    async def ensure_bootstrap_anchor(self, tape_name: str) -> None:
        tape = self._llm.tape(tape_name)
        anchors = list(await tape.query_async.kinds("anchor").all())
        #   查锚点。
        if not anchors:
            await tape.handoff_async("session/start", state={"owner": "human"})
            #   一个锚点都没有 → 建 "session/start" 起始锚点(后续读历史以它为起点)。

    async def anchors(self, tape_name: str, limit: int = 20) -> list[AnchorSummary]:
        tape = self._llm.tape(tape_name)
        entries = list(await tape.query_async.kinds("anchor").all())
        #   取所有锚点。
        results: list[AnchorSummary] = []
        for entry in entries[-limit:]:
            #   取最近 limit 个。
            name = str(entry.payload.get("name", "-"))
            state = entry.payload.get("state")
            state_dict: dict[str, object] = dict(state) if isinstance(state, dict) else {}
            results.append(AnchorSummary(name=name, state=state_dict))
        return results
```

---

## 归档 / 重置

> **整块作用(_archive)**:把整条 tape 导出成带时间戳的 .bak;(reset)可选先归档再清空,并重建起始锚点。

```python
    async def _archive(self, tape_name: str) -> Path:
        tape = self._llm.tape(tape_name)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        self._archive_path.mkdir(parents=True, exist_ok=True)
        archive_path = self._archive_path / f"{tape.name}.jsonl.{stamp}.bak"
        #   归档文件名带时间戳。
        with archive_path.open("w", encoding="utf-8") as f:
            for entry in await tape.query_async.all():
                f.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
                #   逐条导出为 JSONL。
        return archive_path

    async def reset(self, tape_name: str, *, archive: bool = False) -> str:
        tape = self._llm.tape(tape_name)
        archive_path: Path | None = None
        if archive:
            archive_path = await self._archive(tape_name)
            #   需要就先备份。
        await tape.reset_async()
        #   清空 tape。
        state = {"owner": "human"}
        if archive_path is not None:
            state["archived"] = str(archive_path)
            #   记下归档位置。
        await tape.handoff_async("session/start", state=state)
        #   清空后重建起始锚点。
        return f"Archived: {archive_path}" if archive_path else "ok"
```

---

## handoff / search / append_event

> **整块作用**:交接(写锚点+事件,实现历史压缩);搜索;追加事件。

```python
    async def handoff(self, tape_name: str, *, name: str, state: dict[str, Any] | None = None) -> list[TapeEntry]:
        tape = self._llm.tape(tape_name)
        entries = await tape.handoff_async(name, state=state)
        #   委托 Tape.handoff_async:写 anchor + handoff event。
        return cast(list[TapeEntry], entries)
        #   agent 的"自动 handoff(上下文溢出)"就调它。

    async def search(self, query: TapeQuery[AsyncTapeStore]) -> list[TapeEntry]:
        return list(await self._store.fetch_all(query))
        #   直接走 ForkTapeStore 查询(含模糊搜索)。

    async def append_event(self, tape_name: str, name: str, payload: dict[str, Any], **meta: Any) -> None:
        tape = self._llm.tape(tape_name)
        await tape.append_async(TapeEntry.event(name=name, data=payload, **meta))
        #   追加一条 event 条目(agent 循环里大量用:loop.start/loop.step/command/run 等)。
```

---

## session_tape:会话 → tape 名

> **整块作用**:用"工作区 hash __ 会话 hash"算出 tape 名,定位该会话的 Tape。

```python
    def session_tape(self, session_id: str, workspace: Path) -> Tape:
        workspace_hash = hashlib.md5(str(workspace.resolve()).encode("utf-8"), usedforsecurity=False).hexdigest()[:16]
        #   工作区路径 → 16 位 md5(隔离不同工作区的同名会话)。
        tape_name = (
            workspace_hash + "__" + hashlib.md5(session_id.encode("utf-8"), usedforsecurity=False).hexdigest()[:16]
        )
        #   tape 名 = <工作区hash>__<会话hash>(FileTapeStore.list_tapes 也按这个 "__" 形态过滤)。
        return self._llm.tape(tape_name)
        #   返回该 tape 视图。
```

- CLI 状态栏显示 `session:<会话hash>` 就是取这个名 `split("__")[-1]`。

---

## fork_tape:分叉作用域

> **整块作用**:委托 ForkTapeStore.fork —— 进入"试写"作用域,退出按 merge_back 合并/丢弃。

```python
    @contextlib.asynccontextmanager
    async def fork_tape(self, tape_name: str, merge_back: bool = True) -> AsyncGenerator[None, None]:
        async with self._store.fork(tape_name, merge_back=merge_back):
            yield
            #   agent.run/run_stream 把整次 turn 包在这里(temp/ 会话 merge_back=False 即丢弃)。
```

---

## 怎么和别的文件连起来

- `agent/agent.py`:`self.tapes` = TapeService;用 session_tape/fork_tape/ensure_bootstrap_anchor/handoff/append_event。
- `core/engine.py`:`ModelEngine`/`Tape`(底层读写)。
- `memory/store.py`:`ForkTapeStore`(fork/search/持久化)。
- `channels/cli.py`:`info` 供状态栏显示 token/会话。

---

## 一句话总结

`TapeService` 是 agent 用的"tape 工具箱":定位会话 tape、统计、起始/列举锚点、归档重置、handoff 交接、
搜索、追加事件、fork 作用域。它把引擎+存储的能力包成好用的高层 API。
