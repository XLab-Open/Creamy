# `backend/hooks/hook_runtime.py` 精读(C 档·极详)

> `HookRuntime` 是对 pluggy 派发的**安全封装层**。`framework.py` 从不直接调
> `plugin_manager.hook.*`,全部经过它。它解决三件事:**优先级顺序、同步/异步混用、故障隔离**,
> 并实现 `firstresult`/广播两种语义,以及 run_model 流式↔非流式互相适配。

## 这个文件在干嘛

把"怎么用 pluggy 调 hook"的所有细节收拢到一个类里。原因:pluggy 原生的 `hook.xxx(...)` 调用
方式无法满足 Creamy 的需要——我们要 reversed 优先级、要 async 实现、要单实现失败不连累其它、
要"取第一个非 None"与"收集全部"两种模式。于是封装成 `HookRuntime`,framework 只面向它编程。

---

## 顶部导入

> **整块作用**:引入反射工具(判断协程)、类型、pluggy、日志,以及流式事件相关类型。

```python
"""Hook execution runtime with per-adapter fault isolation."""
#   模块 docstring:带"按适配器(实现)粒度的故障隔离"的 hook 执行运行时。

from __future__ import annotations
#   注解延迟求值。

import inspect
#   inspect:反射库。这里只用它的 isawaitable —— 判断一个返回值是不是"可 await 的协程/Future",
#   从而支持"hook 实现既可写 def 也可写 async def"。

from collections.abc import AsyncGenerator
#   AsyncGenerator:异步生成器的类型注解(run_model_stream 的退化路径里用作返回标注)。

from typing import Any, cast
#   Any:宽松类型;cast:仅供类型检查的"强制类型断言"(运行时无副作用)。

import pluggy
#   插件框架(类型注解用 pluggy.PluginManager)。

from loguru import logger
#   日志。

from backend.core.events import AsyncStreamEvents, StreamEvent, StreamState
#   流式三件套:AsyncStreamEvents(事件序列容器)、StreamEvent(单个事件)、StreamState(流状态)。
#   run_model 的两个适配方法里要"造流"或"消费流",故需要它们。见 core/events.md。

from backend.utils.types import Envelope
#   消息载体类型(notify_error 的 message 参数)。
```

---

## 类与哨兵

> **整块作用**:`HookRuntime` 只持有 pluggy 管理器;模块末尾定义一个"跳过"哨兵对象。

```python
class HookRuntime:
    """Safe wrapper around pluggy hook execution."""
    #   类 docstring:对 pluggy hook 执行的安全封装。

    def __init__(self, plugin_manager: pluggy.PluginManager) -> None:
        self._plugin_manager = plugin_manager
        #   唯一依赖:外部传入的 pluggy 插件管理器(framework 在 __init__ 里建好并传进来)。

# ……(文件最末尾)……
_SKIP_VALUE = object()
#   哨兵对象:表示"这个实现这次应被跳过"(典型场景:同步派发路径遇到了 async 实现)。
#   为什么用 object() 而不是 None?因为 None 是合法返回值;用一个"全局唯一对象"才能与
#   "实现确实返回了 None"明确区分(`is _SKIP_VALUE` 判断身份相等,绝不误判)。
```

---

## 取实现的顺序:reversed = 后注册者优先

> **整块作用**:拿到某 hook 的所有实现并**反转**顺序——这是"后注册者胜"优先级的技术落点。

```python
    def _iter_hookimpls(self, hook_name: str) -> list[Any]:
        hook = getattr(self._plugin_manager.hook, hook_name, None)
        #   pluggy 把每个 hook 暴露成 plugin_manager.hook 上的一个属性(hook caller)。
        #   用 getattr + 默认 None,做到"该 hook 不存在也不报错"。
        if hook is None or not hasattr(hook, "get_hookimpls"):
            #   该名字下没有 hook,或拿到的对象不是合法 hook caller(没有 get_hookimpls 方法)。
            return []
            #   返回空列表 = 没有任何实现可调。
        return list(reversed(hook.get_hookimpls()))
        #   get_hookimpls() 按 pluggy 规则返回实现列表(默认"后注册的在后")。
        #   这里 reversed 之后变成"后注册的在前" —— 于是在 call_first 里后注册者先被取用。
```

- **这是"后注册者胜"的机制核心**。配合 framework 的"内置先注册、外部插件后注册",外部插件
  在 `firstresult` hook 上排到 builtin 前面 → 先返回 → 覆盖默认行为。无需任何特权代码路径。

> **整块作用**:只把"该实现签名里声明了的参数"传给它——让 hook 实现可以只写自己关心的参数。

```python
    @staticmethod
    def _kwargs_for_impl(impl: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        return {name: kwargs[name] for name in impl.argnames if name in kwargs}
        #   impl.argnames:pluggy 解析出的"该实现函数声明的参数名"集合。
        #   字典推导:从框架给的全量 kwargs 里,只挑出该实现真正需要的键。
        #   效果:你的 hook 实现可写 `def f(self, message)` 而不必照抄全部参数,多余的会被自动剔除。
```

---

## 四个派发入口:first/many × async/sync

> **整块作用(call_first)**:firstresult 语义的异步版——按优先级逐个调,**第一个非 None 即返回**。

```python
    async def call_first(self, hook_name: str, **kwargs: Any) -> Any:
        """Run hook implementations in precedence order and return first non-None value."""
        for impl in self._iter_hookimpls(hook_name):
            #   按 reversed 优先级遍历实现(后注册者先)。
            call_kwargs = self._kwargs_for_impl(impl, kwargs)
            #   裁剪出该实现需要的参数。
            value = await self._invoke_impl_async(
                hook_name=hook_name, impl=impl, call_kwargs=call_kwargs, kwargs=kwargs
            )
            #   异步调用该实现(内部会 await 协程结果)。
            if value is _SKIP_VALUE:
                #   该实现被标记跳过(异步路径里目前不会发生,但保持与同步一致的处理)。
                continue
            if value is not None:
                #   拿到第一个有意义(非 None)的结果。
                return value
                #   立即返回,后面的实现不再调用(firstresult 语义)。
        return None
        #   所有实现都没给出非 None 结果。
```

> **整块作用(call_many)**:广播语义的异步版——调所有实现,收集全部非跳过返回值。

```python
    async def call_many(self, hook_name: str, **kwargs: Any) -> list[Any]:
        """Run all implementations and collect successful return values."""
        results: list[Any] = []
        #   结果收集器。
        for impl in self._iter_hookimpls(hook_name):
            call_kwargs = self._kwargs_for_impl(impl, kwargs)
            value = await self._invoke_impl_async(
                hook_name=hook_name, impl=impl, call_kwargs=call_kwargs, kwargs=kwargs
            )
            if value is _SKIP_VALUE:
                continue
                #   跳过被标记的实现(不进收集)。
            results.append(value)
            #   其余(含返回 None 的)都收集——广播语义不过滤 None。
        return results
```

> **整块作用(call_first_sync)**:firstresult 的同步版,用于 bootstrap 阶段(不在 async 上下文)。

```python
    def call_first_sync(self, hook_name: str, **kwargs: Any) -> Any:
        """Synchronous variant of call_first for bootstrap hooks."""
        for impl in self._iter_hookimpls(hook_name):
            call_kwargs = self._kwargs_for_impl(impl, kwargs)
            value = self._invoke_impl_sync(hook_name=hook_name, impl=impl, call_kwargs=call_kwargs, kwargs=kwargs)
            #   同步调用;若实现是 async,会被标 _SKIP_VALUE(同步上下文无法 await)。
            if value is _SKIP_VALUE:
                continue
            if value is not None:
                return value
        return None
```

> **整块作用(call_many_sync)**:广播的同步版。

```python
    def call_many_sync(self, hook_name: str, **kwargs: Any) -> list[Any]:
        """Synchronous variant of call_many for bootstrap hooks."""
        results: list[Any] = []
        for impl in self._iter_hookimpls(hook_name):
            call_kwargs = self._kwargs_for_impl(impl, kwargs)
            value = self._invoke_impl_sync(hook_name=hook_name, impl=impl, call_kwargs=call_kwargs, kwargs=kwargs)
            if value is _SKIP_VALUE:
                continue
            results.append(value)
        return results
```

- 同步版服务于 `register_cli_commands`/`provide_channels`/`provide_tape_store`/`system_prompt`/
  `build_tape_context`/`intent_detection`/`postprocess_model_output` 等在非 async 路径调用的 hook。

---

## 错误观察者派发:on_error(吞掉观察者自身的错)

> **整块作用**:把错误广播给所有 `on_error` 观察者;**观察者自己再抛错也只记 warning**,
> 绝不让"处理错误"反过来破坏主流程。

```python
    async def notify_error(self, *, stage: str, error: Exception, message: Envelope | None) -> None:
        """Call on_error hooks, swallowing observer failures."""
        for impl in self._iter_hookimpls("on_error"):
            #   遍历所有 on_error 实现。
            call_kwargs = self._kwargs_for_impl(impl, {"stage": stage, "error": error, "message": message})
            #   裁剪参数(观察者可只声明它关心的,如只要 error)。
            try:
                value = impl.function(**call_kwargs)
                #   调用观察者。impl.function 是被 @hookimpl 装饰的原始函数。
                if inspect.isawaitable(value):
                    #   观察者可能是 async。
                    await value
                    #   等它完成。
            except Exception:
                #   观察者自身抛错——绝不向上传播(否则错误处理会引发新错误,雪上加霜)。
                logger.opt(exception=True).warning(
                    "hook.on_error_failed stage={} adapter={}",
                    stage,
                    impl.plugin_name or "<unknown>",
                )
                #   只记一条带堆栈的 warning,标明是哪个 stage、哪个适配器(插件)失败。
```

> **整块作用(notify_error_sync)**:on_error 的同步派发版,逻辑相同,但 async 观察者会被警告"不支持"。

```python
    def notify_error_sync(self, *, stage: str, error: Exception, message: Envelope | None) -> None:
        """Synchronous on_error dispatch for bootstrap paths."""
        for impl in self._iter_hookimpls("on_error"):
            call_kwargs = self._kwargs_for_impl(impl, {"stage": stage, "error": error, "message": message})
            try:
                value = impl.function(**call_kwargs)
                #   同步调用观察者。
            except Exception:
                logger.opt(exception=True).warning(
                    "hook.on_error_failed stage={} adapter={}",
                    stage,
                    impl.plugin_name or "<unknown>",
                )
                continue
                #   该观察者失败,跳到下一个。
            if inspect.isawaitable(value):
                #   同步路径里却返回了协程——无法 await,只能告警提示"此处不支持 async on_error"。
                logger.warning(
                    "hook.async_not_supported hook=on_error adapter={}",
                    impl.plugin_name or "<unknown>",
                )
```

---

## 底层调用:async / sync 两个 _invoke

> **整块作用(_invoke_impl_async)**:实际调用一个实现;若返回协程就 await(支持 def/async def 都行)。

```python
    async def _invoke_impl_async(self, *, hook_name, impl, call_kwargs, kwargs) -> Any:
        value = impl.function(**call_kwargs)
        #   调用实现函数。同步实现到此即得结果;异步实现得到的是协程对象。
        if inspect.isawaitable(value):
            #   是协程/Future。
            value = await value
            #   await 得到真正结果。
        return value
```

> **整块作用(_invoke_impl_sync)**:同步路径调用实现;遇到 async 实现无法 await,记 warning 并跳过。

```python
    def _invoke_impl_sync(self, *, hook_name, impl, call_kwargs, kwargs) -> Any:
        value = impl.function(**call_kwargs)
        #   同步调用。
        if inspect.isawaitable(value):
            #   实现却是 async,但当前在同步上下文,没有事件循环可 await。
            logger.warning(
                "hook.async_not_supported hook={} adapter={}",
                hook_name,
                impl.plugin_name or "<unknown>",
            )
            #   告警:此 hook 在同步路径用 async 实现属用法错误。
            return _SKIP_VALUE
            #   返回哨兵,让上层 for 循环跳过它(而不是把"一个协程对象"当结果)。
        return value
```

---

## 诊断:hook_report

> **整块作用**:生成"每个 hook → 有哪些插件实现了它"的映射,供 `creamy hooks` 命令排查。

```python
    def hook_report(self) -> dict[str, list[str]]:
        """Build a hook->adapters mapping for diagnostics."""
        report: dict[str, list[str]] = {}
        #   结果:hook 名 -> [实现它的插件名,...]。
        for hook_name, hook_caller in sorted(self._plugin_manager.hook.__dict__.items()):
            #   遍历 plugin_manager.hook 上的所有属性(每个 hook 一个 caller),按名排序输出稳定。
            if hook_name.startswith("_") or not hasattr(hook_caller, "get_hookimpls"):
                #   跳过私有属性、以及不是 hook caller 的项。
                continue
            adapter_names = [impl.plugin_name for impl in hook_caller.get_hookimpls()]
            #   取该 hook 的所有实现来自哪些插件。
            if adapter_names:
                #   有实现才记录(没人实现的 hook 不列)。
                report[hook_name] = adapter_names
        return report
```

---

## ⭐ run_model 的流式↔非流式适配(呼应"二选一实现")

> **整块作用(run_model)**:调用方想要"整段文本"。找第一个有模型能力的插件:它若有非流式实现
> 就直接用;若只有流式实现,就**替调用方把流消费完**、拼成整段返回。

```python
    async def run_model(self, prompt: str | list[dict], session_id: str, state: dict[str, Any]) -> str | None:
        """Run the first `run_model` hook found and return its result."""
        for _, plugin in reversed(self._plugin_manager.list_name_plugin()):
            #   list_name_plugin() 返回 [(name, plugin), ...];reversed 同样实现"后注册者优先"。
            #   注意这里遍历的是"插件对象",目的是先判断"这个插件具备哪种模型能力"。
            if hasattr(plugin, "run_model"):
                #   该插件实现了非流式 run_model。
                output = await self.call_first("run_model", prompt=prompt, session_id=session_id, state=state)
                #   用 call_first 真正取结果(仍按优先级)。
                return cast(str, output)
                #   直接返回整段文本。
            elif hasattr(plugin, "run_model_stream"):
                #   该插件只实现了流式。
                stream = await self.call_first("run_model_stream", prompt=prompt, session_id=session_id, state=state)
                #   取到事件流。
                text = ""
                #   累积器。
                async for event in stream:
                    #   替调用方把整个流消费完。
                    if event.kind == "text":
                        text += str(event.data.get("delta", ""))
                        #   把每个文本事件的增量拼起来。
                return text
                #   返回拼好的整段文本。
        return None
        #   没有任何插件具备模型能力(framework 据此报错并退化)。
```

> **整块作用(run_model_stream)**:调用方想要"事件流"。反过来:插件有流式就直接给;只有非流式
> 就把整段结果**包成一个单元素的 text 事件流**返回。

```python
    async def run_model_stream(self, prompt: str | list[dict], session_id: str, state: dict[str, Any]) -> AsyncStreamEvents | None:
        """Run the first `run_model_stream` hook found and fallback to `run_model` hook."""
        for _, plugin in reversed(self._plugin_manager.list_name_plugin()):
            if hasattr(plugin, "run_model_stream"):
                #   有流式实现 —— 直接返回它的事件流。
                return cast(
                    "AsyncStreamEvents | None",
                    await self.call_first("run_model_stream", prompt=prompt, session_id=session_id, state=state),
                )
            elif hasattr(plugin, "run_model"):
                #   只有非流式 —— 临时造一个"只含一个 text 事件"的流来满足调用方。
                async def iterator() -> AsyncGenerator[StreamEvent, None]:
                    #   定义一个异步生成器。
                    result = await self.call_first("run_model", prompt=prompt, session_id=session_id, state=state)
                    #   先拿到整段文本。
                    yield StreamEvent("text", {"delta": result})
                    #   作为单个 text 事件吐出(delta=整段结果)。
                return AsyncStreamEvents(iterator(), state=StreamState())
                #   用生成器 + 新建的 StreamState 包成 AsyncStreamEvents 返回。
        return None
        #   没有模型能力。
```

- **设计巧思**:`hookspecs` 要求"二选一实现",但 framework 在不同场景(流式/非流式)都可能调用。
  这两个方法把"插件实现的形态"与"调用方需要的形态"解耦——任意一边只实现一种,都能跑通。

---

## 一句话总结

`HookRuntime` 把"pluggy 怎么调"全部收拢:**reversed 优先级、参数裁剪、async/sync 兼容、错误吞并、
firstresult/广播、流式↔非流式适配**。framework 因此能只关心"调哪个 hook、什么顺序"。
