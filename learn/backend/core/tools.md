# `backend/core/tools.py` 精读(C 档·极详)

## 这个文件在干嘛

定义**工具抽象**——让"普通 Python 函数 / pydantic 模型"变成"模型可调用、带 JSON-schema 参数说明"
的工具:
- `Tool` —— 一个可被模型调用的单元(名字 + 描述 + 参数 schema + 处理器);
- `@tool` 装饰器 —— 从函数签名(用 pydantic `TypeAdapter` 生成 schema)或从 pydantic 模型(`model=`)
  构造 `Tool`;
- `ToolContext` —— 传给"上下文感知工具"的运行时上下文;
- `ToolAutoResult` —— 一次自动工具回合的结果形态(迁移期保留,主要用于类型)。

> 这是 `backend/__init__.py` 里 `from backend import tool` 的来源。具体内置工具(读文件、跑 shell、
> 发渠道消息等)用 `@tool` 注册在 `tools/`(见 [`../tools/toolimpl.md`](../tools/toolimpl.md));本文件
> 是它们的"地基"。

---

## 顶部导入 + 类型变量

> **整块作用**:导入反射/JSON/dataclass/类型工具与 pydantic(用来从类型生成 JSON schema、做入参校验)。

```python
"""Tool abstractions — project-owned (no longer a republic facade). ..."""
#   docstring:工具 = 带 JSON-schema 的可调用;@tool 从函数或 pydantic 模型构造。

from __future__ import annotations
import inspect
#   读函数签名(参数、注解、默认值),以及取 docstring 当描述。
import json
#   as_tool(json_mode=True) 时把 schema 序列化成字符串。
from collections.abc import Callable
#   处理器/装饰器的类型。
from dataclasses import dataclass, field
#   定义 ToolContext / ToolAutoResult / Tool。
from typing import TYPE_CHECKING, Any, Literal, NoReturn, TypeVar, overload
#   Literal:限定结果 kind;NoReturn:辅助"必抛异常"函数;overload:给 @tool 两种调用形态做精确类型。

from pydantic import BaseModel, TypeAdapter, validate_call
#   BaseModel:pydantic 模型基类;TypeAdapter:把任意类型注解转成 JSON schema;
#   validate_call:给函数加"调用时按注解校验入参"的包装。

if TYPE_CHECKING:
    from backend.core.errors import AgentError
    #   仅类型注解(ToolAutoResult.error 的类型)。

ModelT = TypeVar("ModelT", bound=BaseModel)
#   类型变量:绑定到 pydantic 模型,用于 from_model / tool_from_model 的泛型。
```

---

## `ToolContext`:传给上下文感知工具的运行时信息

> **整块作用**:当工具声明了 `context` 参数(`@tool(context=True)`),调用时会收到这个对象——里面有
> 当前 tape 名、run_id、以及 meta/state。

```python
@dataclass(frozen=True)
class ToolContext:
    """Runtime context handed to context-aware tools."""
    tape: str | None
    #   当前会话的 tape 名(可能为 None)。
    run_id: str
    #   本次运行 id(用于关联日志/流)。
    meta: dict[str, Any] = field(default_factory=dict)
    #   附加元信息。
    state: dict[str, Any] = field(default_factory=dict)
    #   当前 turn 的 state(工具据此读运行时信息,如 _runtime_agent)。
```

---

## `ToolAutoResult`:一次自动工具回合的结果

> **整块作用**:用一个统一结构表达"这回合产生了文本 / 工具调用 / 错误";配套三个工厂方法。
> docstring 说它是"迁移期保留、主要用于类型"的形态。

```python
@dataclass(frozen=True)
class ToolAutoResult:
    """Outcome of an auto tool turn: text, tool calls, or an error."""
    kind: Literal["text", "tools", "error"]
    #   三选一:纯文本 / 有工具调用 / 出错。
    text: str | None
    #   文本结果(kind=text 时)。
    tool_calls: list[dict[str, Any]]
    #   模型发起的工具调用列表。
    tool_results: list[Any]
    #   工具执行结果列表。
    error: AgentError | None
    #   错误(kind=error 时)。

    @classmethod
    def text_result(cls, text: str) -> ToolAutoResult:
        return cls(kind="text", text=text, tool_calls=[], tool_results=[], error=None)
        #   工厂:构造"纯文本"结果。

    @classmethod
    def tools_result(cls, tool_calls, tool_results) -> ToolAutoResult:
        return cls(kind="tools", text=None, tool_calls=tool_calls, tool_results=tool_results, error=None)
        #   工厂:构造"有工具调用 + 结果"的结果。

    @classmethod
    def error_result(cls, error, *, tool_calls=None, tool_results=None) -> ToolAutoResult:
        return cls(kind="error", text=None, tool_calls=tool_calls or [], tool_results=tool_results or [], error=error)
        #   工厂:构造"出错"结果(可附带已发生的调用/结果)。
```

---

## 内部小工具

> **整块作用**:命名转换、取可调用名、统一抛错(给 schema 生成与校验用)。

```python
def _to_snake_case(name: str) -> str:
    return "".join(["_" + c.lower() if c.isupper() else c for c in name]).lstrip("_")
    #   驼峰转蛇形:遇大写字母前加下划线并转小写;开头多余下划线去掉。
    #   用于从函数/模型名推导默认工具名(如 ReadFile -> read_file)。

def _callable_name(func: Callable[..., Any]) -> str:
    name = getattr(func, "__name__", None)
    #   优先取函数的 __name__。
    if isinstance(name, str) and name:
        return name
    return func.__class__.__name__
    #   没有(如可调用对象实例)就用其类名。

def _raise_value_error(message: str, *, cause: Exception | None = None) -> NoReturn:
    if cause is None:
        raise ValueError(message)
    raise ValueError(message) from cause
    #   统一抛 ValueError(可带 cause 链)。NoReturn 告诉类型检查器"此函数必抛、不返回"。

def _raise_type_error(message: str, *, cause: Exception | None = None) -> NoReturn:
    if cause is None:
        raise TypeError(message)
    raise TypeError(message) from cause
    #   同上,抛 TypeError。
```

---

## 从类型/签名生成 JSON schema

> **整块作用**:把"单个类型注解"和"整段函数签名"转成 OpenAI 工具所需的 JSON schema。

```python
def _schema_from_annotation(annotation: Any) -> dict[str, Any]:
    """Convert Python type annotations to JSON schema via Pydantic."""
    if annotation is inspect._empty:
        annotation = Any
        #   参数没写类型注解 → 当作 Any(任意)。
    try:
        return TypeAdapter(annotation).json_schema()
        #   用 pydantic TypeAdapter 把类型转成 JSON schema(支持 int/str/list/嵌套模型等)。
    except Exception as exc:
        _raise_value_error(f"Failed to build JSON schema for type: {annotation!r}", cause=exc)
        #   转不了就报错(链上原异常)。

def _schema_from_signature(signature, *, ignore_params=None) -> dict[str, Any]:
    ignore = ignore_params or set()
    #   要忽略的参数名(如 context 不暴露给模型)。
    properties: dict[str, Any] = {}
    required: list[str] = []
    for param in signature.parameters.values():
        if param.name in ignore:
            continue
            #   跳过被忽略的参数。
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
            #   跳过 *args / **kwargs(无法表达成固定 schema)。
        properties[param.name] = _schema_from_annotation(param.annotation)
        #   每个参数 → 一个 schema 属性。
        if param.default is param.empty:
            required.append(param.name)
            #   没有默认值 = 必填。
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    #   组装成 object schema。
    if required:
        schema["required"] = required
        #   有必填项才加 required。
    return schema
```

---

## `Tool`:核心数据类

> **整块作用**:表示一个工具(名字/描述/参数 schema/处理器/是否上下文感知),并提供"导出 schema、
> 执行、从函数/模型构造"等方法。

```python
@dataclass(frozen=True)
class Tool:
    """A Tool is a callable unit the model can invoke."""
    name: str
    #   工具名(模型按它来调用)。
    description: str = ""
    #   工具描述(给模型看,常取函数 docstring)。
    parameters: dict[str, Any] = field(default_factory=dict)
    #   参数的 JSON schema。
    handler: Callable[..., Any] | None = None
    #   实际执行函数;None 表示"只有 schema、不可执行"(纯声明)。
    context: bool = False
    #   是否上下文感知(调用时需注入 ToolContext)。

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }
        #   组装成 OpenAI "function tool" 格式的 schema(喂给模型的工具定义)。

    def as_tool(self, json_mode: bool = False) -> str | dict[str, Any]:
        schema = self.schema()
        if json_mode:
            return json.dumps(schema, indent=2)
            #   需要字符串形式就 JSON 序列化(某些提示词里直接贴 schema 文本)。
        return schema
        #   否则返回 dict。

    def run(self, *args: Any, **kwargs: Any) -> Any:
        handler = self.handler
        if handler is None:
            _raise_type_error(f"Tool '{self.name}' is schema-only and cannot be executed.")
            #   纯声明工具不能执行 → 报错。
        return handler(*args, **kwargs)
        #   有处理器就调用它。
```

> **整块作用(from_callable)**:从一个普通函数构造 Tool——推导名字/描述、生成参数 schema、并用
> validate_call 包装处理器以在执行时按注解校验入参。

```python
    @classmethod
    def from_callable(cls, func, *, name=None, description=None, context=False) -> Tool:
        signature = inspect.signature(func)
        #   读函数签名。
        if context and "context" not in signature.parameters:
            _raise_type_error("Tool context is enabled but the callable lacks a 'context' parameter.")
            #   声明 context=True 却没有 context 形参 → 报错(契约不符)。
        tool_name = name or _to_snake_case(_callable_name(func))
        #   工具名:显式优先,否则函数名转蛇形。
        tool_description = description if description is not None else (inspect.getdoc(func) or "")
        #   描述:显式优先,否则取函数 docstring。
        parameters = _schema_from_signature(signature, ignore_params={"context"} if context else None)
        #   参数 schema:从签名生成;若上下文感知则把 context 参数排除在对模型暴露的 schema 外。
        validated = validate_call(func)
        #   用 pydantic 包装:调用时按类型注解校验/转换入参(模型给的参数是 JSON,需校验)。
        return cls(name=tool_name, description=tool_description, parameters=parameters, handler=validated, context=context)
```

> **整块作用(from_model)**:从一个 pydantic 模型构造 Tool;没给处理器就默认"把入参 model_dump 返回"。

```python
    @classmethod
    def from_model(cls, model, handler=None, *, context=False) -> Tool:
        if handler is None:
            def _default_handler(payload: ModelT) -> Any:
                return payload.model_dump()
                #   默认处理器:把校验后的模型转回 dict 返回(纯"结构化输出"类工具)。
            handler_fn = _default_handler
        else:
            handler_fn = handler
            #   用调用方给的处理器。
        return tool_from_model(model, handler_fn, context=context)
        #   委托下面的 tool_from_model 完成构造。
```

---

## 从 pydantic 模型构造 schema / Tool

> **整块作用(schema_from_model)**:只生成"工具 schema"而不绑定执行(纯声明用)。

```python
def schema_from_model[ModelT: BaseModel](model, *, name=None, description=None) -> dict[str, Any]:
    """Create a tool schema from a Pydantic model without making it runnable."""
    model_name = name or _to_snake_case(model.__name__)
    #   名字:显式优先,否则模型类名转蛇形。
    model_description = description if description is not None else (model.__doc__ or "")
    #   描述:显式优先,否则模型 docstring。
    return {
        "type": "function",
        "function": {"name": model_name, "description": model_description, "parameters": model.model_json_schema()},
    }
    #   用 pydantic 的 model_json_schema() 作参数 schema。
```

> **整块作用(tool_from_model)**:造一个"用 pydantic 模型校验入参"的可执行 Tool;处理器内部先把
> kwargs 校验成模型实例,再(按需带 context)调用真正的 handler。

```python
def tool_from_model[ModelT: BaseModel](model, handler, *, name=None, description=None, context=False) -> Tool:
    """Create a runnable Tool that validates inputs via a Pydantic model."""
    tool_name = name or _to_snake_case(model.__name__)
    tool_description = description if description is not None else (model.__doc__ or "")

    if context:
        signature = inspect.signature(handler)
        if "context" not in signature.parameters:
            _raise_type_error("Tool context is enabled but the handler lacks a 'context' parameter.")
            #   同 from_callable:context=True 时 handler 必须有 context 形参。

    def _handler(*args: Any, **kwargs: Any) -> Any:
        tool_context = kwargs.pop("context", None)
        #   先把 context 从 kwargs 取出(它不属于模型字段)。
        parsed = model(*args, **kwargs)
        #   用剩余参数构造并校验模型实例(非法入参在此抛 pydantic 校验错误)。
        if context:
            return handler(parsed, context=tool_context)
            #   上下文感知:把校验后的模型 + context 一起交给 handler。
        return handler(parsed)
        #   否则只交模型。

    return Tool(
        name=tool_name, description=tool_description,
        parameters=model.model_json_schema(),
        #   参数 schema 来自模型。
        handler=_handler, context=context,
    )
```

---

## `@tool` 装饰器(两种用法,精确类型)

> **整块作用**:两个 `@overload` 声明 `@tool` 的两种调用形态(直接装饰 / 带参数装饰),第三个是真正
> 实现。装饰后函数变成一个 `Tool` 实例。

```python
@overload
def tool(func: Callable[..., Any], *, name=None, model=None, description=None, context=False) -> Tool: ...
#   形态①:@tool 直接装饰函数 → 返回 Tool。

@overload
def tool(func: None = None, *, name=None, model=None, description=None, context=False) -> Callable[[Callable[..., Any]], Tool]: ...
#   形态②:@tool(name=...) 带参数 → 返回"接收函数、返回 Tool"的装饰器。

def tool(func=None, *, name=None, model=None, description=None, context=False):
    """Decorator to convert a function into a :class:`Tool` instance."""

    def _create_tool(f: Callable[..., Any]) -> Tool:
        if model is not None:
            return tool_from_model(model, f, name=name, description=description, context=context)
            #   给了 model:用模型校验入参的方式构造。
        return Tool.from_callable(f, name=name, description=description, context=context)
        #   否则:从函数签名构造。

    if func is None:
        return _create_tool
        #   形态②:@tool(...) → 返回装饰器,稍后接收函数。
    return _create_tool(func)
    #   形态①:@tool → 直接构造并返回 Tool。
```

```python
__all__ = ["Tool", "ToolAutoResult", "ToolContext", "schema_from_model", "tool", "tool_from_model"]
#   导出全部公开符号。
```

---

## 怎么和别的文件连起来

- `backend/__init__.py`:`from backend import tool` 再导出本模块的 `tool`。
- `tools/tools.py` / `tools/toolimpl.py`:用 `@tool` 注册具体工具到全局工具表;`ToolContext` 在执行时
  注入(见 [`../tools/tools.md`](../tools/tools.md)、[`../tools/toolimpl.md`](../tools/toolimpl.md))。
- `agent/agent.py`:把 `Tool.schema()` 喂给模型、按模型返回的 tool_calls 调 `Tool.run`。

---

## 一句话总结

`tools.py` 是"把函数/模型变成模型可调用工具"的工厂:`@tool` 自动从签名/模型生成 JSON-schema 并用
pydantic 校验入参,`Tool` 承载 schema+处理器,`ToolContext` 给上下文感知工具注入运行时信息。
