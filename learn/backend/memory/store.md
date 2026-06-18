# `backend/memory/store.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

tape 存储的**落地实现层**(上层抽象在 `core/store.py`):
- `ForkTapeStore` —— "**可分叉**的 tape 存储"包装:用 contextvars 在一段作用域内把写入引到一个临时内存
  store,退出时再决定**合并回**父存储。让一次 turn 能"试写、可回退/可合并"。
- `FileTapeStore` —— 把每条 tape 持久化为 **JSONL 文件**(`<tape>.jsonl`),复用 `InMemoryQueryMixin` 的查询
  语义,并加了**模糊搜索**(rapidfuzz)。这是出厂 `provide_tape_store` 返回的实现。
- `TapeFile` —— 单个 tape 文件的读写助手(增量读、追加、自增 id、线程锁)。

> 回顾:`agent.tapes` 把 `provide_tape_store`(FileTapeStore)包成 `ForkTapeStore`;`run`/`run_stream` 在
> `fork_tape` 作用域内跑;`graph.py` 经 `Tape` 读写。会话历史最终就落在这里的 JSONL 文件。

---

## 顶部:导入、contextvars、模糊搜索常量

> **整块作用**:导入;定义三个 contextvar(当前临时 store / 当前 fork 的 tape 名 / 是否被 reset);模糊搜索参数。

```python
from __future__ import annotations
import contextlib
import contextvars   # ⭐ 用上下文变量在"当前 async 任务"范围内传递 fork 状态(不污染其它并发会话)
import itertools     # chain 拼接父/子条目
import json
import re
import threading     # TapeFile 的文件锁
from collections.abc import AsyncGenerator, Iterable
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from loguru import logger

from backend.core.store import (
    AsyncTapeStore, AsyncTapeStoreAdapter, InMemoryQueryMixin, InMemoryTapeStore, TapeStore, is_async_tape_store,
)
from backend.core.tape_types import TapeEntry, TapeQuery
from backend.utils.utils import get_entry_text   # 取条目文本(模糊搜索用)

current_store: contextvars.ContextVar[TapeStore] = contextvars.ContextVar("current_store")
#   当前作用域内的"临时写入 store"(fork 期间指向一个 InMemoryTapeStore)。
current_fork_tape: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_fork_tape", default=None)
#   当前 fork 的 tape 名。
current_tape_was_reset: contextvars.ContextVar[bool] = contextvars.ContextVar("current_tape_was_reset", default=False)
#   fork 期间该 tape 是否被 reset 过(决定合并时要不要先清父)。
WORD_PATTERN = re.compile(r"[a-z0-9_/-]+")   # 模糊搜索分词
MIN_FUZZY_QUERY_LENGTH = 3    # 短于 3 字符不做模糊
MIN_FUZZY_SCORE = 80          # 模糊匹配分阈值
MAX_FUZZY_CANDIDATES = 128    # 模糊候选上限
```

- **为什么用 contextvars**:并发多会话各自 fork 互不干扰——每个 async 任务有独立的 contextvar 视图。

---

## `ForkTapeStore`:可分叉存储 ⭐

> **整块作用**:包装父存储。平时读父、写父;但在 `fork()` 作用域内,写入改去临时内存 store,reset 只标记,
> 退出时按 merge_back 把临时内容合并回父。

```python
class ForkTapeStore:
    def __init__(self, parent: AsyncTapeStore | TapeStore) -> None:
        if is_async_tape_store(parent):
            self._parent = parent
        else:
            self._parent = AsyncTapeStoreAdapter(cast("TapeStore", parent))
        #   父存储统一成异步(同步的用适配器包一层)。

    @property
    def _current(self) -> TapeStore:
        return current_store.get(_empty_store)
        #   当前临时 store;不在 fork 中则是"空 store"哨兵。

    @property
    def _fork_tape(self) -> str | None:
        return current_fork_tape.get()
        #   当前 fork 的 tape 名。

    @property
    def _current_was_reset(self) -> bool:
        return current_tape_was_reset.get()
        #   当前 tape 是否被 reset 过。

    async def list_tapes(self) -> list[str]:
        return cast(list[str], await self._parent.list_tapes())
        #   列 tape 始终看父(临时层不影响"有哪些 tape")。

    async def reset(self, tape: str) -> None:
        self._current.reset(tape)
        #   先清临时层。
        if self._current is _empty_store or self._fork_tape != tape:
            await self._parent.reset(tape)
            return
            #   不在 fork、或 reset 的不是当前 fork 的 tape → 直接清父。
        current_tape_was_reset.set(True)
        #   否则(在 fork 中且就是当前 tape):只标记"被 reset",真正清父推迟到合并时(可回退)。

    async def fetch_all(self, query: TapeQuery[AsyncTapeStore]) -> Iterable[TapeEntry]:
        parent_entries: Iterable[TapeEntry] = []
        if not (query.tape == self._fork_tape and self._current_was_reset):
            #   除非"查的就是被 reset 的当前 fork tape"(那父内容应视为已清),否则读父。
            try:
                parent_entries = await self._parent.fetch_all(query)
            except Exception:
                parent_entries = []
                #   读父失败不致命,当空。
        this_entries: list[TapeEntry] = []
        if hasattr(self._current, "read"):
            for entry in cast(list[TapeEntry], self._current.read(query.tape) or []):
                #   再叠加临时层的条目。
                if query._kinds and entry.kind not in query._kinds:
                    continue
                    #   kind 过滤。
                if entry.kind == "anchor":  # noqa: SIM102
                    if query._after_last or (query._after_anchor and entry.payload.get("name") == query._after_anchor):
                        this_entries.clear()
                        parent_entries = []
                        continue
                        #   ⭐ 锚点开窗:遇到"目标锚点",把之前累积的(含父)全部丢弃——实现"只取该锚点之后"。
                this_entries.append(entry)
        return itertools.chain(parent_entries, this_entries)
        #   返回 父条目 + 临时层条目 的拼接(临时层是本次 fork 期间新写的)。
```

> **整块作用(脱敏)**:写入前把 prompt/content 里的非文本块(如图片)剔除,只留文本——避免大体积二进制
> 进 tape。

```python
    @staticmethod
    def _redact_prompt(prompt: list[dict]) -> Any:
        if not isinstance(prompt, list):
            return prompt
        new_prompt = []
        for part in prompt:
            if part.get("type") == "text":
                new_prompt.append(part)
                #   只保留 text 块(丢弃 image_url 等)。
        return new_prompt

    @staticmethod
    def _redact_payload(payload: dict) -> None:
        if "content" in payload:
            payload["content"] = ForkTapeStore._redact_prompt(payload["content"])
        elif "prompt" in payload:
            payload["prompt"] = ForkTapeStore._redact_prompt(payload["prompt"])
        #   对 content 或 prompt 字段脱敏(就地改)。

    async def append(self, tape: str, entry: TapeEntry) -> None:
        self._redact_payload(entry.payload)
        #   写前脱敏(不把多模态二进制写进 tape)。
        self._current.append(tape, entry)
        #   写到当前层(fork 中→临时 store;否则→空 store 哨兵,即"不真正写父"?见下)。
```

> 注意:`append` 写的是 `self._current`(临时层)。**不在 fork 时 `_current` 是空 store(append 是空操作)**
> ——所以正常写入都发生在 fork 作用域内(agent.run 总是包在 fork_tape 里),退出时再合并回父。

> **整块作用(fork)**:进入分叉作用域——把 contextvars 指向新临时 store;退出时按 merge_back 合并回父。

```python
    @contextlib.asynccontextmanager
    async def fork(self, tape: str, merge_back: bool = True) -> AsyncGenerator[None, None]:
        store = InMemoryTapeStore()
        #   本次 fork 的临时内存 store。
        token = current_store.set(store)
        tape_token = current_fork_tape.set(tape)
        reset_token = current_tape_was_reset.set(False)
        #   设置三个 contextvar(并保留 token 以便恢复)。
        try:
            yield
            #   作用域内:所有 append/reset 都作用在临时层。
        finally:
            was_reset = current_tape_was_reset.get()
            current_store.reset(token)
            current_fork_tape.reset(tape_token)
            current_tape_was_reset.reset(reset_token)
            #   恢复 contextvars(回到上层视图)。
            if merge_back:
                #   需要合并(正常会话):
                if was_reset:
                    await self._parent.reset(tape)
                    #   fork 中 reset 过 → 真正清父(此前只是标记)。
                entries = store.read(tape)
                if entries:
                    count = len(entries)
                    for entry in entries:
                        await self._parent.append(tape, entry)
                        #   把临时层的新条目逐条追加进父(持久化)。
                    logger.info(f'Merged {count} entries into tape "{tape}"')
            #   merge_back=False(如 temp/ 会话):临时内容丢弃,不入父。
```

- **fork 的意义**:一次 turn 在临时层试写,中途失败/取消可不污染父 tape;成功就合并回去。`temp/` 会话
  (agent.run 里 `merge_back = not session_id.startswith("temp/")`)用完即弃。

---

## 空 store 哨兵

> **整块作用**:不在 fork 时 `_current` 的占位——所有操作空实现/返回空。

```python
class EmptyTapeStore:
    """Sync TapeStore sentinel that always returns empty results."""
    def list_tapes(self) -> list[str]: return []
    def reset(self, tape: str) -> None: pass
    def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]: return []
    def append(self, tape: str, entry: TapeEntry) -> None: pass
    #   四个方法都空——表示"没有临时层"。

_empty_store = EmptyTapeStore()
#   单例哨兵。
```

---

## `FileTapeStore`:JSONL 持久化 + 模糊搜索 ⭐

> **整块作用**:每条 tape 一个 `.jsonl` 文件;复用 InMemoryQueryMixin 的查询;带关键词全文 + rapidfuzz 模糊。

```python
class FileTapeStore(InMemoryQueryMixin):
    """TapeStore implementation that persists tapes as JSONL files under a directory."""

    def __init__(self, directory: Path) -> None:
        self._directory = directory
        self._directory.mkdir(parents=True, exist_ok=True)
        #   确保目录存在(出厂是 ~/.creamy/tapes)。
        self._tape_files: dict[str, TapeFile] = {}
        #   tape 名 -> TapeFile 助手(缓存)。

    def fetch_all(self, query: TapeQuery) -> Iterable[TapeEntry]:
        if not query._query:
            result: Iterable[TapeEntry] = super().fetch_all(query)
            return result
            #   无关键词:直接用 mixin 的标准查询(锚点开窗/日期/kind/limit)。
        unlimited_query = replace(query, _limit=None)
        entries: Iterable[TapeEntry] = super().fetch_all(unlimited_query)
        #   有关键词:先不限量取出,再自己做关键词+模糊过滤。
        return self._filter_entries(list(entries), query._query, query._limit or 20)
```

> **整块作用(_filter_entries / _is_fuzzy_match)**:对条目做"包含 + 模糊"匹配,去重、限量、从新到旧。

```python
    def _filter_entries(self, entries: list[TapeEntry], query: str, limit: int) -> list[TapeEntry]:
        normalized_query = query.strip().lower()
        if not normalized_query:
            return []
        results: list[TapeEntry] = []
        seen: set[str] = set()
        count = 0
        for entry in reversed(entries):
            #   从最新往旧找。
            payload_text = get_entry_text(entry).lower()
            if payload_text in seen:
                continue
                #   去重(相同文本只取一次)。
            seen.add(payload_text)
            if normalized_query in payload_text or self._is_fuzzy_match(normalized_query, payload_text):
                results.append(entry)
                #   命中:子串包含 或 模糊匹配。
                count += 1
                if count >= limit:
                    break
                    #   够数就停。
        return results

    @staticmethod
    def _is_fuzzy_match(normalized_query: str, payload_text: str) -> bool:
        from rapidfuzz import fuzz, process
        #   延迟导入 rapidfuzz(可选依赖)。
        if len(normalized_query) < MIN_FUZZY_QUERY_LENGTH:
            return False
            #   太短不模糊(噪声大)。
        query_tokens = WORD_PATTERN.findall(normalized_query)
        if not query_tokens:
            return False
        query_phrase = " ".join(query_tokens)
        window_size = len(query_tokens)
        #   查询分词 → 词组 + 窗口大小。
        source_tokens = WORD_PATTERN.findall(payload_text)
        if not source_tokens:
            return False
        candidates: list[str] = []
        for token in source_tokens:
            candidates.append(token)
            if len(candidates) >= MAX_FUZZY_CANDIDATES:
                break
            #   单词候选(限量)。
        if window_size > 1:
            max_window_start = len(source_tokens) - window_size + 1
            for idx in range(max(0, max_window_start)):
                candidates.append(" ".join(source_tokens[idx : idx + window_size]))
                if len(candidates) >= MAX_FUZZY_CANDIDATES:
                    break
                #   多词查询:再加"滑动窗口词组"候选(匹配短语)。
        best_match = process.extractOne(query_phrase, candidates, scorer=fuzz.WRatio, score_cutoff=MIN_FUZZY_SCORE)
        #   在候选里找与查询词组最相似的;分数 ≥ 80 才算命中。
        return best_match is not None
```

> **整块作用(其余协议方法)**:取 TapeFile、列 tape、reset、append、read,都委托 TapeFile。

```python
    def _tape_file(self, tape: str) -> TapeFile:
        if tape not in self._tape_files:
            self._tape_files[tape] = TapeFile(self._directory / f"{tape}.jsonl")
            #   按需建该 tape 的文件助手。
        return self._tape_files[tape]

    def list_tapes(self) -> list[str]:
        result: list[str] = []
        for file in self._directory.glob("*.jsonl"):
            filename = file.stem
            if filename.count("__") != 1:
                continue
                #   只认 "<工作区hash>__<会话hash>" 形态的文件名(session_tape 生成的)。
            result.append(filename)
        return result

    def reset(self, tape: str) -> None:
        self._tape_file(tape).reset()
        #   清该 tape 文件。

    def append(self, tape: str, entry: TapeEntry) -> None:
        self._tape_file(tape).append(entry)
        #   追加一条到文件。

    def read(self, tape: str) -> list[TapeEntry] | None:
        return self._tape_file(tape).read()
        #   读全部(InMemoryQueryMixin.fetch_all 依赖它)。
```

---

## `TapeFile`:单文件读写助手

> **整块作用**:管理一个 jsonl 文件:线程锁、增量读(只读新增部分)、自增 id、追加。

```python
class TapeFile:
    """Helper for one tape file."""
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()        # 并发保护
        self._read_entries: list[TapeEntry] = []  # 已读到内存的条目缓存
        self._read_offset = 0                # 已读到的文件字节偏移(增量读用)

    def _next_id(self) -> int:
        if self._read_entries:
            return cast(int, self._read_entries[-1].id + 1)
        return 1
        #   下一个 id = 最后一条 id + 1(从 1 起)。

    def _reset(self) -> None:
        self._read_entries = []
        self._read_offset = 0
        #   清内存缓存与偏移。

    def reset(self) -> None:
        with self._lock:
            if self.path.exists():
                self.path.unlink()
                #   删文件。
            self._reset()

    def read(self) -> list[TapeEntry]:
        with self._lock:
            return self._read_locked()
            #   加锁读。

    def _read_locked(self) -> list[TapeEntry]:
        if not self.path.exists():
            self._reset()
            return []
            #   文件没了 → 清缓存返回空。
        file_size = self.path.stat().st_size
        if file_size < self._read_offset:
            # The file was truncated or replaced, so cached entries are stale.
            self._reset()
            #   文件变小(被截断/替换)→ 缓存失效,从头读。
        with self.path.open("r", encoding="utf-8") as handle:
            handle.seek(self._read_offset)
            #   ⭐ 从上次偏移继续读(增量读,不重复解析整文件)。
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                    #   坏行跳过。
                entry = self.entry_from_payload(payload)
                if entry is not None:
                    self._read_entries.append(entry)
                    #   解析成条目追加到缓存。
            self._read_offset = handle.tell()
            #   更新偏移到文件末尾。
        return list(self._read_entries)

    @staticmethod
    def entry_from_payload(payload: object) -> TapeEntry | None:
        if not isinstance(payload, dict):
            return None
        entry_id = payload.get("id")
        kind = payload.get("kind")
        entry_payload = payload.get("payload")
        meta = payload.get("meta")
        if not isinstance(entry_id, int):
            return None
        if not isinstance(kind, str):
            return None
        if not isinstance(entry_payload, dict):
            return None
            #   逐字段校验(坏数据返回 None)。
        if not isinstance(meta, dict):
            meta = {}
        if "date" in payload:
            date = payload["date"]
        else:
            date = datetime.fromtimestamp(payload.get("timestamp", 0.0), tz=UTC).isoformat()
            #   兼容旧格式:没有 date 就用 timestamp 转。
        return TapeEntry(entry_id, kind, dict(entry_payload), dict(meta), date)

    def append(self, entry: TapeEntry) -> None:
        with self._lock:
            self._read_locked()
            #   ⭐ 追加前先把文件读到最新(同步 id/offset,避免 id 冲突)。
            with self.path.open("a", encoding="utf-8") as handle:
                next_id = self._next_id()
                stored = TapeEntry(next_id, entry.kind, dict(entry.payload), dict(entry.meta), entry.date)
                #   重建带真实自增 id 的条目。
                handle.write(json.dumps(asdict(stored), ensure_ascii=False) + "\n")
                #   以 JSONL 一行写入。
                self._read_entries.append(stored)
                self._read_offset = handle.tell()
                #   同步缓存与偏移(避免下次 read 重读这行)。
```

---

## 怎么和别的文件连起来

- `core/store.py`:`InMemoryQueryMixin`(查询语义)、`InMemoryTapeStore`(fork 临时层)、协议与适配器。
- `core/tape_types.py`:`TapeEntry` / `TapeQuery`。
- `agent/agent.py`:`ForkTapeStore(get_tape_store())`;`run` 在 `fork_tape` 里跑。
- `hook_impl.provide_tape_store`:返回 `FileTapeStore(~/.creamy/tapes)`。
- `memory/tape.py`:`TapeService` 用 `ForkTapeStore.fork` 与底层引擎。

---

## 一句话总结

`memory/store.py` 是 tape 的落地实现:`ForkTapeStore` 用 contextvars 实现"作用域内试写、退出合并/回退";
`FileTapeStore` 把每条 tape 存成 JSONL 并支持关键词+rapidfuzz 模糊搜索;`TapeFile` 做单文件的增量读、
自增 id、加锁追加。会话历史最终就落在这里。
