# `backend/core/errors.py` 精读(C 档·极详)

## 这个文件在干嘛

定义 Creamy 的**统一错误模型**:一个粗粒度的错误种类枚举 `ErrorKind`,和一个携带"种类 + 消息 +
细节"的异常类 `AgentError`。还保留了 `RepublicError = AgentError` 这个**向后兼容别名**(老调用点
仍用 `RepublicError`,迁移期不破坏)。

> 你在 `app/framework.py` 的流式分支见过:错误事件被转成 `RepublicError(**data)` 再广播——用的
> 就是这里。`ErrorKind` 的取值"与线缆/事件里的 kind 字符串一致",是它能在事件↔异常间互转的关键。

---

## 逐行精读

> **整块作用**:模块 docstring 点明这是项目自有错误模型,并解释 RepublicError 为何作为别名存在。

```python
"""Error model — project-owned (no longer a republic facade).
#   定性:项目自有的错误模型(不再是上游 republic 的转发壳)。

``AgentError`` is the runtime error type; ``RepublicError`` is kept as an alias so
existing call sites keep working during the migration.
#   AgentError 是运行时错误类型;RepublicError 仅作别名,保证迁移期老代码不报错。
"""

from __future__ import annotations
#   注解延迟求值。

from enum import StrEnum
#   StrEnum:成员"既是枚举又是字符串"的枚举基类(Python 3.11+)。
#   选它的原因见下:让 ErrorKind.PROVIDER == "provider" 成立,从而枚举值能直接当线缆字符串用。

from typing import Any
#   Any:details 字典的值类型。
```

> **整块作用**:定义错误的"粗粒度分类"。值刻意等于线缆/事件里出现的 kind 字符串,实现"字符串↔枚举"无缝转换。

```python
class ErrorKind(StrEnum):
    """Coarse error categories (values match the wire/event ``kind`` strings)."""
    #   文档:粗粒度错误分类;其值与"线缆/事件中的 kind 字符串"一致。

    INVALID_INPUT = "invalid_input"
    #   输入非法(如 tape 查询传了非法日期)。
    CONFIG = "config"
    #   配置问题(如缺 API key)。
    PROVIDER = "provider"
    #   模型服务方报错(上游 API 返回错误)。
    TOOL = "tool"
    #   工具执行出错。
    TEMPORARY = "temporary"
    #   临时性错误(可重试,如限流/超时)。
    NOT_FOUND = "not_found"
    #   找不到(如 tape 里的 anchor 不存在)。
    UNKNOWN = "unknown"
    #   兜底未分类。framework 把事件 kind 转枚举时缺省就用它(ErrorKind(data.get("kind","unknown")))。
```

> **整块作用**:定义异常类。它在普通 Exception 之上多带"种类(kind)"和"结构化细节(details)",
> 并能序列化成 dict(便于放进事件/日志/线缆)。

```python
class AgentError(Exception):
    """A runtime error carrying a coarse :class:`ErrorKind` and a message."""
    #   文档:带 ErrorKind 与消息的运行时错误。

    def __init__(self, kind: ErrorKind, message: str, details: dict[str, Any] | None = None) -> None:
        self.kind = kind
        #   错误种类(枚举)。
        self.message = message
        #   人类可读消息。
        self.details = details
        #   可选的结构化细节(如哪个字段、上游返回体片段)。
        super().__init__(message)
        #   调用 Exception 基类构造,使 str()/日志里也能看到 message。

    def __str__(self) -> str:
        kind = getattr(self.kind, "value", self.kind)
        #   取枚举的字符串值;getattr 的容错:万一 kind 不是枚举(被赋了裸字符串),也能拿到值。
        return f"[{kind}] {self.message}"
        #   格式如 "[provider] rate limited",一眼看出种类。

    def as_dict(self) -> dict[str, Any]:
        kind = getattr(self.kind, "value", self.kind)
        #   同上取字符串值。
        payload: dict[str, Any] = {"kind": kind, "message": self.message}
        #   基础载荷:种类 + 消息。
        if self.details:
            payload["details"] = self.details
            #   有细节才加(保持载荷干净)。
        return payload
        #   返回可 JSON 化的 dict —— 用于塞进 StreamEvent 的 data、tape 的 error 条目、日志等。
```

- `__str__` 里 `getattr(self.kind, "value", self.kind)` 是个**防御点**:正常 `kind` 是 `ErrorKind`
  枚举(有 `.value`);但若某处把裸字符串赋给了 `kind`,这行也不会炸。framework 把错误事件转回
  `RepublicError` 前特意 `ErrorKind(...)` 转枚举,正是为了让这里显示正常。

> **整块作用**:向后兼容别名 + 导出清单。

```python
# Backward-compatible alias; call sites migrate to ``AgentError`` over time.
RepublicError = AgentError
#   别名:RepublicError 就是 AgentError。老代码写 RepublicError 仍可用;新代码用 AgentError。

__all__ = ["AgentError", "ErrorKind", "RepublicError"]
#   公开三者。
```

---

## 怎么和别的文件连起来

- `app/framework.py`:流式分支把 `error` 事件 `{**data, "kind": ErrorKind(...)}` 转成
  `RepublicError(**data)` 广播——依赖这里的 `ErrorKind` 与构造签名。
- `core/store.py`:tape 查询里大量 `raise AgentError(ErrorKind.NOT_FOUND, ...)` /
  `ErrorKind.INVALID_INPUT`。
- `core/tape_types.py`:`TapeEntry.error(error)` 用 `error.as_dict()` 把异常存进 tape。

---

## 一句话总结

一个"带分类的异常 + 与线缆字符串对齐的枚举",让错误能在**异常 ↔ 事件 ↔ tape ↔ 日志**之间无损流转;
`RepublicError` 别名是迁移期的兼容垫片。
