# `backend/llm/messages.py` 精读(C 档·极详)

## 这个文件在干嘛

**Creamy 形态 ↔ LangChain 形态的双向桥**:
- 把 Creamy 的"角色字典消息"(`{"role":..,"content":..}`)转成 LangChain `BaseMessage`;
- 把 Creamy 的 `Tool` 包成 LangChain `StructuredTool`(模型可调用,执行时回调 Creamy 工具);
- 把 LangChain 消息再转回 tape 的消息载体。

> `graph.py` 用它把 tape 历史 + 本次 prompt 转成喂给模型的 LangChain 消息,并把 Creamy 工具包给模型。
> 这是"项目内部数据模型"与"LangChain 数据模型"之间的适配层。

---

## 顶部:导入与名字转换

> **整块作用**:导入 LangChain 消息/工具类型;`_model_name` 把工具名里的 "." 换成 "_"(对模型暴露的名字)。

```python
"""LangChain message/tool conversion — project-owned. ...(见上)..."""
from __future__ import annotations
import inspect   # 判断工具返回是否需 await
import json      # 工具结果/参数序列化
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from langchain_core.messages import (AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage)
#   LangChain 五种消息类型。
from langchain_core.tools import StructuredTool
#   LangChain 工具类型(带 schema + 可调用)。

from backend.tools.tools import model_tools  # noqa: F401  (kept for API parity)
#   导入但未直接用(保留以维持 API 对齐;noqa 抑制告警)。

if TYPE_CHECKING:
    from backend.core.tools import Tool, ToolContext   # 仅类型


def _model_name(name: str) -> str:
    return name.replace(".", "_")
    #   工具名 "fs.read" → "fs_read"。某些模型不接受名字里的 "."。
```

---

## 把 Tool 包成 LangChain StructuredTool

> **整块作用(_make_coroutine)**:为一个工具造一个异步执行函数:注入 context(若需要)、兼容同步/异步、
> 捕获异常返回 "error: ...",结果统一成字符串。

```python
def _make_coroutine(tool: Tool, context: ToolContext):
    async def _run(**kwargs: Any) -> str:
        try:
            output = tool.run(context=context, **kwargs) if tool.context else tool.run(**kwargs)
            #   上下文感知工具注入 context;否则直接调。
            if inspect.isawaitable(output):
                output = await output
                #   工具是 async 就 await。
        except Exception as exc:
            return f"error: {exc}"
            #   工具抛错 → 返回错误文本(而不是炸掉整个图)。
        return output if isinstance(output, str) else json.dumps(output, ensure_ascii=False, default=str)
        #   字符串直接返回;其它对象序列化成 JSON(default=str 兜底)。
    return _run


def build_lc_tools(tools: Iterable[Tool], context: ToolContext) -> list[StructuredTool]:
    """Wrap core ``Tool`` objects as LangChain ``StructuredTool`` (model-facing names)."""
    lc_tools: list[StructuredTool] = []
    for tool in tools:
        lc_tools.append(
            StructuredTool(
                name=_model_name(tool.name),                                  # 模型可见名(. → _)
                description=tool.description or "",                           # 工具说明
                args_schema=tool.parameters or {"type": "object", "properties": {}},  # 参数 schema(空则给空对象)
                coroutine=_make_coroutine(tool, context),                    # 执行回调(绑定了 context)
            )
        )
    return lc_tools
```

- LangGraph 的 `ToolNode` 会用这些 StructuredTool 执行模型发起的工具调用,最终回到 Creamy 的 `tool.run`。

---

## tool_calls 归一

> **整块作用**:把不同形态(OpenAI function 形态 / 已是 Creamy 形态)的 tool_calls 统一成 {name,args,id}。

```python
def _to_lc_tool_calls(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for call in tool_calls:
        function = call.get("function", {}) if isinstance(call, dict) else {}
        #   OpenAI 形态:{"function": {"name","arguments"}}。
        name = function.get("name") or call.get("name", "")
        #   名字:优先 function.name,否则 call.name。
        raw_args = function.get("arguments", call.get("args", {}))
        #   参数:优先 function.arguments,否则 call.args。
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args)
                #   OpenAI 的 arguments 常是 JSON 字符串 → 解析。
            except (ValueError, TypeError):
                args = {}
        else:
            args = raw_args or {}
            #   已是 dict 直接用。
        converted.append({"name": name, "args": args, "id": call.get("id", "")})
    return converted
```

---

## 角色字典 → LangChain 消息

> **整块作用**:把 Creamy 的角色字典(可能来自 tape 历史)转成 LangChain BaseMessage;可选前置系统提示。

```python
def to_lc_messages(messages: Iterable[dict[str, Any]], *, system_prompt: str | None = None) -> list[BaseMessage]:
    """Convert role-dict messages into LangChain ``BaseMessage`` objects."""
    lc_messages: list[BaseMessage] = []
    if system_prompt:
        lc_messages.append(SystemMessage(content=system_prompt))
        #   有系统提示就放最前。
    for message in messages:
        role = message.get("role")
        content = message.get("content", "")
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role in ("user", "human"):
            lc_messages.append(HumanMessage(content=content))   # 用户消息
        elif role == "assistant":
            tool_calls = message.get("tool_calls")
            if tool_calls:
                lc_messages.append(AIMessage(content=content or "", tool_calls=_to_lc_tool_calls(tool_calls)))
                #   带工具调用的 AI 消息。
            else:
                lc_messages.append(AIMessage(content=content))
                #   普通 AI 消息。
        elif role == "tool":
            lc_messages.append(ToolMessage(content=content, tool_call_id=message.get("tool_call_id", "")))
            #   工具结果消息(需带它对应的 tool_call_id)。
    return lc_messages
```

---

## LangChain 消息 → tape 载体

> **整块作用**:把 LangChain 消息(或角色字典)转回 tape 用的 {role, content}。

```python
def tape_payloads_from_messages(messages: Iterable[BaseMessage | dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert LangChain messages (or role dicts) back into tape message payloads."""
    payloads: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, dict):
            payloads.append(dict(message))
            continue
            #   已是字典 → 复制原样。
        if isinstance(message, SystemMessage):
            role = "system"
        elif isinstance(message, HumanMessage):
            role = "user"
        elif isinstance(message, ToolMessage):
            role = "tool"
        else:
            role = "assistant"
            #   其它(AIMessage 等)归 assistant。
        payloads.append({"role": role, "content": message.content})
    return payloads


__all__ = ["build_lc_tools", "tape_payloads_from_messages", "to_lc_messages"]
```

---

## 怎么和别的文件连起来

- `llm/graph.py`:`_prepare` 用 `to_lc_messages`(历史+prompt→LC 消息)、`build_lc_tools`(Tool→StructuredTool)。
- `core/tools.py`:`Tool`/`ToolContext`(被包装/注入)。

---

## 一句话总结

`messages.py` 是 Creamy ↔ LangChain 的翻译层:角色字典 ↔ BaseMessage、Creamy Tool → StructuredTool
(执行时回调原工具、容错、结果转字符串)、tool_calls 归一。让 tape 历史能喂给模型、模型结果能存回 tape。
