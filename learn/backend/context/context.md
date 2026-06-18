# `backend/context/context.py` 精读(C 档·极详)

## 这个文件在干嘛

定义 Creamy 的**默认 tape 上下文选择器**:把 tape 里存的各类条目(锚点/消息/工具调用/工具结果)**转成
喂给模型的角色字典消息列表**。`hook_impl.build_tape_context` 就返回这里的 `default_tape_context()`。

> 回顾:`TapeContext.select` 是个"选择器函数";`engine.Tape.read_messages_async` 在锚点开窗后调
> `build_messages` → 若有 select 就用它。本文件提供的 `_select_messages` 就是那个 select——决定"历史长什么
> 样喂给模型"。比 `core/tape_types._default_messages`(只取 message)更完整:它还原工具调用/结果/锚点。

---

## 顶部与入口

> **整块作用**:导入;`default_tape_context` 返回一个用 `_select_messages` 作选择器的 TapeContext。

```python
"""Tape context helpers."""
from __future__ import annotations
import json
from collections.abc import Iterable
from typing import Any

from backend.core.tape_types import TapeContext, TapeEntry


def default_tape_context() -> TapeContext:
    """Return the default context selection for Creamy."""
    return TapeContext(select=_select_messages)
    #   anchor 用默认(LAST_ANCHOR:取最后锚点之后),select 用下面的完整还原器。
```

---

## `_select_messages`:把条目还原成消息序列 ⭐

> **整块作用**:遍历(已按锚点开窗的)条目,按 kind 还原:锚点→说明消息、message→原样、tool_call→带
> tool_calls 的 assistant 消息、tool_result→tool 消息(并与上一批 tool_call 配对)。

```python
def _select_messages(entries: Iterable[TapeEntry], _context: TapeContext) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    pending_calls: list[dict[str, Any]] = []
    #   pending_calls:上一条 tool_call 的调用列表,用来给随后的 tool_result 配 id/name。

    for entry in entries:
        match entry.kind:
            case "anchor":
                _append_anchor_entry(messages, entry)        # 锚点 → 一条说明消息
            case "message":
                _append_message_entry(messages, entry)       # 普通消息 → 原样
            case "tool_call":
                pending_calls = _append_tool_call_entry(messages, entry)  # 工具调用 → assistant(带 tool_calls),记下 calls
            case "tool_result":
                _append_tool_result_entry(messages, pending_calls, entry) # 工具结果 → tool 消息(配对)
                pending_calls = []                           # 配对完清空
    return messages
```

- 注意:`event` 等其它 kind 不进消息(它们是审计/统计用,不喂模型)。

---

## 各类条目的还原

> **整块作用(锚点)**:把锚点渲染成一条 assistant 说明消息(让模型知道"这里有个分段点及其状态")。

```python
def _append_anchor_entry(messages: list[dict[str, Any]], entry: TapeEntry) -> None:
    payload = entry.payload
    content = f"[Anchor created: {payload.get('name')}]: {json.dumps(payload.get('state'), ensure_ascii=False)}"
    #   形如 "[Anchor created: session/start]: {"owner": "human"}"。
    messages.append({"role": "assistant", "content": content})
```

> **整块作用(消息)**:message 条目的 payload 本身就是角色字典,原样加入。

```python
def _append_message_entry(messages: list[dict[str, Any]], entry: TapeEntry) -> None:
    payload = entry.payload
    if isinstance(payload, dict):
        messages.append(dict(payload))   # 复制后加入(避免改到 tape 内部)
```

> **整块作用(工具调用)**:把 calls 归一,产出一条带 tool_calls 的 assistant 消息,并返回 calls 供配对。

```python
def _append_tool_call_entry(messages: list[dict[str, Any]], entry: TapeEntry) -> list[dict[str, Any]]:
    calls = _normalize_tool_calls(entry.payload.get("calls"))
    if calls:
        messages.append({"role": "assistant", "content": "", "tool_calls": calls})
        #   content 空、tool_calls 带调用(符合 OpenAI 消息格式)。
    return calls
    #   返回 calls,供随后 tool_result 配 id/name。
```

> **整块作用(工具结果)**:把每个结果做成一条 tool 消息,按序与 pending_calls 配对(补 tool_call_id/name)。

```python
def _append_tool_result_entry(messages, pending_calls, entry) -> None:
    results = entry.payload.get("results")
    if not isinstance(results, list):
        return
    for index, result in enumerate(results):
        messages.append(_build_tool_result_message(result, pending_calls, index))
        #   每个结果一条 tool 消息(按 index 与对应调用配对)。


def _build_tool_result_message(result, pending_calls, index) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "tool", "content": _render_tool_result(result)}
    #   基础 tool 消息:角色 tool + 渲染后的结果文本。
    if index >= len(pending_calls):
        return message
        #   没有对应调用(数量不匹配)→ 就返回基础消息。
    call = pending_calls[index]
    call_id = call.get("id")
    if isinstance(call_id, str) and call_id:
        message["tool_call_id"] = call_id
        #   补上对应调用的 id(OpenAI 要求 tool 消息带 tool_call_id 才能配对)。
    function = call.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        if isinstance(name, str) and name:
            message["name"] = name
            #   补上工具名。
    return message
```

---

## 小工具

> **整块作用**:归一 tool_calls 为 dict 列表;把工具结果渲染成字符串。

```python
def _normalize_tool_calls(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    calls: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, dict):
            calls.append(dict(item))   # 只保留 dict 项
    return calls


def _render_tool_result(result: object) -> str:
    if isinstance(result, str):
        return result                  # 字符串直接用
    try:
        return json.dumps(result, ensure_ascii=False)   # 对象 → JSON
    except TypeError:
        return str(result)             # 不可序列化 → str 兜底
```

---

## 怎么和别的文件连起来

- `core/tape_types.py`:`TapeContext`(select 字段)、`build_messages`(有 select 就调它)。
- `core/engine.py`:`Tape.read_messages_async` → `build_messages` → 本文件的 `_select_messages`。
- `hook_impl.build_tape_context`:返回 `default_tape_context()`。
- `llm/graph.py`:`_prepare` 用 `read_messages_async` 拿到的历史(即本文件还原的消息)转成 LC 消息喂模型。

---

## 一句话总结

`context.py` 决定"tape 历史以什么形态喂给模型":默认选择器把锚点/消息/工具调用/工具结果还原成完整的
OpenAI 风格消息序列(含 tool_calls 与 tool_call_id 配对),比"只取纯消息"的默认更忠实地重建对话历史。
