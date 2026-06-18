# `backend/utils/utils.py` 精读(C 档·极详)

## 这个文件在干嘛

杂项工具函数:去除 dict 里的 None、"运行协程直到停机信号"、从 state 取工作区路径、把 tape 条目转文本。
被各处零散调用。

---

## 逐行精读

> **整块作用(exclude_none)**:过滤掉 dict 里值为 None 的项。

```python
import asyncio
from collections.abc import Coroutine
from pathlib import Path
from typing import Any
from backend.core.tape_types import TapeEntry
from backend.utils.types import State


def exclude_none(d: dict[str, Any]) -> dict[str, Any]:
    """Exclude None values from a dictionary."""
    return {k: v for k, v in d.items() if v is not None}
    #   只保留非 None 项。telegram/feishu 解析元数据时用它清空字段。
```

> **整块作用(wait_until_stopped)**:并发跑一个协程与"等停机信号";谁先完成谁说了算——停机则取消协程并抛
> CancelledError,否则返回协程结果。

```python
async def wait_until_stopped[T](coro: Coroutine[None, None, T], stop_event: asyncio.Event) -> T:
    """Run a coroutine until a stop event is set."""
    task = asyncio.create_task(coro)
    #   把目标协程包成任务。
    waiter = asyncio.create_task(stop_event.wait())
    #   把"等停机信号"也包成任务。
    _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    #   等两者中任一先完成。
    if stop_event.is_set():
        task.cancel()
        await task
        raise asyncio.CancelledError("Operation cancelled due to stop event")
        #   停机信号到了 → 取消目标任务并抛 Cancelled(让上层优雅退出)。
    else:
        waiter.cancel()
        return task.result()
        #   目标先完成 → 取消 waiter,返回结果。
    #   ChannelManager.listen_and_run 用它:while 取消息时,Ctrl-C 等触发 stop_event 就能跳出。
```

> **整块作用(workspace_from_state)**:从 state 取工作区路径(没有就用当前目录)。

```python
def workspace_from_state(state: State) -> Path:
    raw = state.get("_runtime_workspace")
    if isinstance(raw, str) and raw.strip():
        return Path(raw).expanduser().resolve()
        #   有 _runtime_workspace(framework 放的)→ 展开并绝对化。
    return Path.cwd().resolve()
    #   否则用当前目录。agent/工具/技能发现都用它定位工作区。
```

> **整块作用(get_entry_text)**:把 tape 条目的 payload 转成文本(供模糊搜索匹配)。

```python
def get_entry_text(entry: TapeEntry) -> str:
    import yaml
    return yaml.safe_dump(entry.payload)
    #   用 YAML 序列化 payload 成文本(FileTapeStore._filter_entries 据它做关键词/模糊匹配)。
```

---

## 怎么和别的文件连起来

- `channels/manager.py`:`wait_until_stopped`(主循环)。
- `agent/agent.py`、`tools/toolimpl.py`、`inventory`:`workspace_from_state`。
- `memory/store.py`:`get_entry_text`(模糊搜索)。
- `channels/{telegram,feishu}.py`:`exclude_none`(清元数据)。

---

## 一句话总结

`utils/utils.py` 是杂项工具箱:去 None、协程与停机信号竞速、取工作区路径、tape 条目转文本。小而被多处复用。
