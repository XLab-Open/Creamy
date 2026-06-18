# `backend/core/__init__.py` 精读(C 档·极详)

## 这个文件在干嘛

`core` 子包的入口。它本身**没有代码逻辑**,只有一段 docstring,作用是:**给整个 `core/` 定性**
——它是"中立的核心类型层"(runtime-agnostic foundation),即"不依赖任何第三方 agent 运行时"
的、项目自有的值类型与协议。后端其它部分都建立在它之上。

> "no longer a republic facade"(各 core 文件 docstring 反复出现):说明这些类型曾经是对某个
> 上游库("republic")的转发壳,现在已**收归项目自有**。这是迁移后的状态,理解历史有助于读懂
> 命名(如 `RepublicError` 仍作别名保留)。

---

## 逐行精读

> **整块作用**:用模块 docstring 列出 core 的六个子模块各自的职责,等于一张"core 目录索引"。

```python
"""Neutral core types — Creamy's runtime-agnostic foundation.
#   定性:中立的核心类型,Creamy 的"与运行时无关"的基座。

Project-owned value types and protocols that the rest of the backend builds on,
independent of any third-party agent runtime:
#   说明:这些是"项目自有"的值类型 + 协议,后端其余部分依赖它们,且不绑定任何第三方 agent 运行时。

* ``events``     — StreamEvent / StreamState / AsyncStreamEvents
#   events:流式事件三件套(turn 的增量进度)。见 events.md。
* ``errors``     — ErrorKind / AgentError
#   errors:错误模型(粗粒度种类枚举 + 异常类)。见 errors.md。
* ``tools``      — Tool / ToolContext / @tool
#   tools:工具抽象(模型可调用单元 + 上下文 + 装饰器)。见 tools.md。
* ``tape_types`` — TapeEntry / TapeQuery / TapeContext
#   tape_types:tape 值类型(条目 / 流式查询构造器 / 上下文选择规则)。见 tape_types.md。
* ``store``      — TapeStore / AsyncTapeStore protocols + in-memory store
#   store:tape 存储协议(同步/异步)+ 内存实现 + 查询语义。见 store.md。
* ``engine``     — ModelEngine / Tape (tape storage; model calls run via LangGraph)
#   engine:tape 存储引擎(注意:模型调用不在这,在 llm/graph.py;这里只存/放 tape)。见 engine.md。
"""
```

- **为什么单独定性很重要**:`core/` 是依赖图的"底座"——它**只被别人依赖,自己尽量不依赖上层**
  (尤其 `tape_types` 刻意做得 import-light,好让 `store` 依赖它而不成环)。读 core 各文件时,
  始终记住"它们是地基,不含业务"。

---

## 一句话总结

`core/__init__.py` 是张目录:它宣告 `core/` 是项目自有的"中立类型与协议基座",并列出六个子模块
的分工。真正内容在各子模块里。
