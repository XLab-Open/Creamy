# `backend/tools/tools.py` 精读(C 档·极详)

## 这个文件在干嘛

**工具注册表与对外 `@tool` 装饰器**。在 `core/tools.tool`(造 Tool)之上,再做三件事:
- 给工具包一层**调用日志**(开始/成功/失败 + 耗时);
- 把工具**自动登记进全局 `REGISTRY`**;
- 提供**名字解析**(运行时名 ↔ 模型可见名 `.`→`_`)、批量解析、渲染工具提示。

> `from backend import tool` 最终就是这里的 `tool`(经 `backend/__init__` 再导出 core 的?——注意:`__init__`
> 导出的是 `tools.tools.tool` 这一个带日志+注册的版本)。`agent`/`hook_impl` 用 `REGISTRY` 拿所有工具;
> `toolimpl.py` 用 `@tool` 把内置工具注册进来。

---

## 顶部:导入与全局注册表

```python
import inspect
import json
import time
from collections.abc import Callable, Iterable
from dataclasses import replace
from typing import Any, overload

from loguru import logger
from pydantic import BaseModel

from backend.core.tools import Tool
from backend.core.tools import tool as core_tool   # 底层造 Tool 的装饰器(见 core/tools.md)

REGISTRY: dict[str, Tool] = {}
#   全局工具表:工具名 -> Tool。@tool 装饰时自动登记到这里。agent 跑模型时取它。
```

---

## 给工具包日志

> **整块作用**:用一个包装 handler 替换原 handler——调用前后记日志、计耗时、异常照样抛。

```python
def _add_logging(tool: Tool) -> Tool:
    if tool.handler is None:
        return tool
        #   纯声明工具(无 handler)不包。
    handler = tool.handler

    async def wrapped(*args, **kwargs):
        call_kwargs = kwargs.copy()
        if tool.context:
            call_kwargs.pop("context", None)
            #   日志里不打 context(它是运行时对象,不必记)。
        _log_tool_call(tool.name, args, call_kwargs)
        #   记 "tool.call.start name=... { 参数 }"。
        start = time.monotonic()
        try:
            result = handler(*args, **kwargs)
            if inspect.isawaitable(result):
                result = await result
                #   兼容同步/异步工具。
        except Exception:
            elapsed_time = (time.monotonic() - start) * 1000
            logger.exception("tool.call.error name={} elapsed_time={:.2f}ms", tool.name, elapsed_time)
            raise
            #   失败:记 error + 耗时,然后重抛(由上层处理)。
        else:
            elapsed_time = (time.monotonic() - start) * 1000
            logger.info("tool.call.success name={} elapsed_time={:.2f}ms", tool.name, elapsed_time)
            return result
            #   成功:记 success + 耗时。

    return replace(tool, handler=wrapped)
    #   返回"换了 handler"的新 Tool(Tool 不可变,用 replace)。
```

> **整块作用(日志参数渲染)**:把参数值安全地缩短/序列化成可读字符串(避免日志过长/不可序列化)。

```python
def _shorten_text(text: str, width: int = 30, placeholder: str = "...") -> str:
    if len(text) <= width:
        return text
    available = width - len(placeholder)
    if available <= 0:
        return placeholder
    return text[:available] + placeholder
    #   超长截断并加省略号。

def _render_value(value: Any) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False)
    except TypeError:
        rendered = repr(value)
        #   不可 JSON 化 → repr。
    rendered = _shorten_text(rendered, width=100, placeholder="...")
    #   限长 100。
    if rendered.startswith('"') and not rendered.endswith('"'):
        rendered = rendered + '"'
    if rendered.startswith("{") and not rendered.endswith("}"):
        rendered = rendered + "}"
    if rendered.startswith("[") and not rendered.endswith("]"):
        rendered = rendered + "]"
    #   截断后补上闭合符号,日志更易读(不留半截 "/{/[)。
    return rendered

def _log_tool_call(name: str, args: Any, kwargs: dict[str, Any]) -> None:
    params: list[str] = []
    for value in args:
        params.append(_render_value(value))          # 位置参数
    for key, value in kwargs.items():
        rendered = _render_value(value)
        params.append(f"{key}={rendered}")           # 关键字参数
    params_str = f" {{ {', '.join(params)} }}" if params else ""
    logger.info("tool.call.start name={}{}", name, params_str)
```

---

## `@tool` 装饰器(带注册)

> **整块作用**:调 core_tool 造 Tool,加日志,登记进 REGISTRY。支持"直接装饰"与"带参装饰"两种用法。

```python
@overload
def tool(func: Callable, *, name=..., model=..., description=..., context=...) -> Tool: ...
@overload
def tool(func: None = ..., *, name=..., model=..., description=..., context=...) -> Callable[[Callable], Tool]: ...
#   两个重载:精确表达两种调用形态的返回类型。

def tool(func=None, *, name=None, model=None, description=None, context=False):
    """Decorator to convert a function into a Tool instance."""
    result = core_tool(func=func, name=name, model=model, description=description, context=context)
    #   先用底层装饰器。可能返回 Tool(直接装饰)或装饰器(带参)。
    if isinstance(result, Tool):
        tool_instance = _add_logging(result)
        REGISTRY[tool_instance.name] = tool_instance
        return tool_instance
        #   形态①:@tool 直接装饰 → 加日志 + 注册 + 返回 Tool。
    def decorator(func: Callable) -> Tool:
        tool_instance = _add_logging(result(func))
        REGISTRY[tool_instance.name] = tool_instance
        return tool_instance
    return decorator
    #   形态②:@tool(name=...) → 返回一个"接函数、加日志、注册"的装饰器。
```

- **副作用注册**:`toolimpl.py` 模块被 import 时,里面每个 `@tool` 都会执行,把工具登记进 REGISTRY。
  这就是 `hook_impl.__init__` 里 `import toolimpl  # noqa` 的目的。

---

## 名字解析(运行时名 ↔ 模型可见名)

> **整块作用**:模型看到的工具名把 `.` 换成 `_`(如 `fs.read`→`fs_read`);这里做双向解析,让"模型回传的
> 名字"能映射回 REGISTRY 的真实名。

```python
def _to_model_name(name: str) -> str:
    return name.replace(".", "_")
    #   运行时名 → 模型可见名。

def _tool_name_index() -> dict[str, str]:
    real_names = {tool_name.casefold(): tool_name for tool_name in REGISTRY}
    #   真实名(小写)→ 真实名。
    alias_names = {_to_model_name(tool_name).casefold(): tool_name for tool_name in REGISTRY}
    #   模型可见名(小写)→ 真实名。
    return {**alias_names, **real_names}
    #   合并(真实名优先)。用于把任意形态的名解析回真实名。

def resolve_tool_name(name: str) -> str | None:
    """Resolve a user/model-provided tool name to the runtime registry name."""
    key = name.strip().casefold()
    if not key:
        return None
    return _tool_name_index().get(key)
    #   解析单个名字(找不到返回 None)。

def _resolve_explicit_tool_names(names: Iterable[str]) -> tuple[set[str], set[str]]:
    resolved: set[str] = set()
    unknown: set[str] = set()
    for name in names:
        normalized_name = name.strip()
        if resolved_name := resolve_tool_name(normalized_name):
            resolved.add(resolved_name)     # 解析成功
        else:
            unknown.add(normalized_name)    # 未知名
    return resolved, unknown

def _raise_unknown_tool_names(names: set[str]) -> None:
    formatted = ", ".join(sorted(repr(name) for name in names))
    raise ValueError(f"unknown tool name(s): {formatted}")
    #   有未知名 → 报错。

def resolve_tool_names(names: Iterable[str] | None = None, *, exclude: Iterable[str] = ()) -> set[str]:
    """Resolve tool names from either runtime names or model-facing aliases."""
    excluded, unknown_excluded = _resolve_explicit_tool_names(exclude)
    if unknown_excluded:
        _raise_unknown_tool_names(unknown_excluded)
        #   排除集里有未知名 → 报错。
    if names is None:
        return set(REGISTRY) - excluded
        #   names=None → 返回"全部工具 - 排除"。subagent 用它给子 agent 全工具(排除 subagent 自身)。
    resolved, unknown = _resolve_explicit_tool_names(names)
    if unknown:
        _raise_unknown_tool_names(unknown)
    return resolved - excluded
    #   指定了 names → 解析后再去掉排除集。
```

---

## 模型工具转换 + 提示渲染

> **整块作用**:把工具改成模型可见名;把工具列表渲染成提示文本(供系统提示)。

```python
def model_tools(tools: Iterable[Tool]) -> list[Tool]:
    """Helper to convert a list of Tool instances into a format accepted by LLMs."""
    return [replace(tool, name=_to_model_name(tool.name)) for tool in tools]
    #   每个工具复制一份、把名字换成模型可见名(. → _)。

def render_tools_prompt(tools: Iterable[Tool]) -> str:
    """Render a human-readable description of tools for model prompts."""
    if not tools:
        return ""
    lines = []
    for tool in tools:
        line = f"- {_to_model_name(tool.name)}"
        if tool.description:
            line += f": {tool.description}"
        lines.append(line)
        #   每工具一行 "- 名字: 描述"。
    return f"<available_tools>\n{'\n'.join(lines)}\n</available_tools>"
    #   包进 <available_tools> 标签(agent._system_prompt 拼进系统提示)。
```

---

## 怎么和别的文件连起来

- `core/tools.py`:底层 `tool`(造 Tool)、`Tool`。
- `tools/toolimpl.py`:用本文件的 `@tool` 注册所有内置工具到 REGISTRY。
- `agent/agent.py`:`REGISTRY`(选工具)、`render_tools_prompt`(系统提示)、`resolve_tool_names`(白名单/subagent)。
- `llm/messages.py`:`build_lc_tools` 用 `_model_name` 同款转换。

---

## 一句话总结

`tools.py` 是工具层门面:`@tool` 在造 Tool 基础上加调用日志并登记进全局 `REGISTRY`;提供运行时名 ↔
模型可见名(`.`↔`_`)的双向解析、批量解析(白名单/排除)、以及把工具渲染成系统提示。
