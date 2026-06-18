# `backend/llm/embedded_tools.py` 精读(C 档·极详)

## 这个文件在干嘛

**解析"内嵌在文本里的工具调用"**。有些模型不走原生 tool-call 通道,而是把工具调用以
`<tool_call>{...}</tool_call>` 文本块的形式塞进回复正文。本模块把这些块解析回结构化的工具调用,让
运行时能像原生 tool_call 一样执行它们。

> 在 `graph.py` 的 agent 节点里:模型若没产生原生 tool_calls,就调 `extract_embedded_tool_calls` 看正文里
> 有没有 `<tool_call>` 块,有就提升为正式 tool_calls。这是对"不规范但常见"的模型行为的兼容。

---

## 逐行精读

> **整块作用**:docstring + 导入 + 匹配 `<tool_call>{...}</tool_call>` 的正则。

```python
"""Embedded tool-call extraction — project-owned. ...(见上)..."""
from __future__ import annotations
import json   # 解析块内 JSON
import re     # 匹配 <tool_call> 块
from typing import Any

_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)
#   正则:抓 <tool_call> 与 </tool_call> 之间的一个 JSON 对象({...})。
#   \s* 容忍空白;.*? 非贪婪(多块时各自匹配);re.DOTALL 让 . 也匹配换行(JSON 可能多行)。
```

> **整块作用**:把文本里所有 `<tool_call>` 块解析成 LangChain 风格的 tool_call 列表。

```python
def extract_embedded_tool_calls(text: str | None) -> list[dict[str, Any]]:
    """Parse ``<tool_call>{...}</tool_call>`` blocks into LangChain-style tool calls."""
    if not text:
        return []
        #   空文本 → 无调用。
    calls: list[dict[str, Any]] = []
    for index, match in enumerate(_TOOL_CALL_RE.finditer(text)):
        #   遍历所有匹配块(index 用于生成唯一 id)。
        try:
            payload = json.loads(match.group(1))
            #   解析块内 JSON。
        except (ValueError, TypeError):
            continue
            #   不是合法 JSON → 跳过该块。
        if not isinstance(payload, dict):
            continue
            #   不是对象 → 跳过。
        name = payload.get("name")
        if not isinstance(name, str) or not name:
            continue
            #   没有有效工具名 → 跳过。
        args = payload.get("arguments", payload.get("args", {}))
        #   参数:兼容 "arguments" 或 "args" 两种键名。
        if not isinstance(args, dict):
            args = {}
            #   参数不是对象 → 当空参数。
        calls.append({"name": name, "args": args, "id": f"embedded_{index}"})
        #   组装成统一的 tool_call 形态(id 用 embedded_<序号> 标明来源)。
    return calls


__all__ = ["extract_embedded_tool_calls"]
```

---

## 怎么和别的文件连起来

- `llm/graph.py`:`agent_node` 里,模型无原生 tool_calls 时调它,把内嵌块提升为 `AIMessage.tool_calls`。

---

## 一句话总结

`embedded_tools.py` 兼容"把工具调用写进正文 `<tool_call>{...}</tool_call>"的模型:用正则 + JSON 解析把
它们还原成结构化 tool_call,让运行时照常执行。
