# `backend/__main__.py` 精读(C 档·极详)

## 这个文件在干嘛

**CLI 启动引导**。控制台脚本 `creamy`(pyproject 把它映射到 `backend.__main__:app`)运行时,
真正被执行的就是这里在模块级构造出来的 `app` 对象。它把"框架装配"与"命令行"在此首次缝合:
**配日志 → 建框架 → 加载所有 hook 插件 → 让插件把各自的 CLI 子命令挂上来 → 得到一个 Typer 应用**。

> 记住整体思想:Creamy 里**连"有哪些命令行子命令"都不是硬编码的**,而是通过
> `register_cli_commands` 这个 hook 由各插件贡献。所以本文件几乎不含业务,只负责"按正确顺序
> 把零件装起来"。

---

## 逐行精读(C 档)

### ① 导入

> **整块作用**:引入 CLI 框架(typer)、框架运行时类、以及日志初始化函数。三者恰好对应下面
> 装配的三步。

```python
"""Creamy framework CLI bootstrap."""
#   模块 docstring:点明本模块是"CLI 启动引导"。

from __future__ import annotations
#   开启"注解延迟求值"(PEP 563 行为):本文件里的类型注解不在定义时立即求值,
#   而是当成字符串保存。好处是注解可引用尚未导入/定义的名字,也略省启动开销。
#   本项目所有模块几乎都加这一行,是统一约定。

import typer
#   Typer:基于类型注解自动生成命令行界面的库(底层是 click)。下面用它建根应用、加命令。

from backend.app.framework import CreamyFramework
#   框架运行时类。下面 create_cli_app 要实例化它来完成插件加载与命令收集。

from backend.observability.logging import setup_logging
#   日志初始化函数(配置 loguru:格式、级别、输出目标等)。见 observability/logging.md。
```

### ② 构建 CLI 应用(工厂函数)

> **整块作用**:按"日志 → 框架 → 加载插件 → 收集命令"的固定顺序装配出根 Typer 应用。
> 顺序不能乱:必须先有日志(便于记录后续错误)、先加载插件(命令才存在),最后才有可用的 app。

```python
def create_cli_app() -> typer.Typer:
    #   工厂函数:构建并返回根 CLI 应用。写成函数(而非直接在模块级堆代码)便于测试与复用。
    setup_logging()
    #   ① 第一步先配日志。放最前是为了:之后任何插件加载失败、命令执行报错,都能被规范地记录,
    #      而不是丢到默认的、难看的 stderr。
    framework = CreamyFramework()
    #   ② 建框架实例。此刻它只创建了 pluggy 插件管理器并注册了"契约"(hookspecs),
    #      但还没有任何 hook 的"实现"——也就是说现在框架是个"空壳+接口定义"。
    framework.load_hooks()
    #   ③ 关键一步:加载 hook 实现。内部顺序是"先注册内置 BuiltinImpl(name='builtin'),
    #      再按 entry-point 组 creamy 加载外部插件"。这个"内置先、外部后"的注册顺序,
    #      正是"后注册者胜"优先级的根源(详见 app/framework.md 的 load_hooks)。
    app = framework.create_cli_app()
    #   ④ 建 Typer 根应用,并通过广播 register_cli_commands hook,让所有已加载插件
    #      把自己的子命令挂上去(内置挂了 run/cli/web/gateway/install/... 见 hooks/hook_impl.md)。

    if not app.registered_commands:
        #   兜底分支:如果走到这里一个子命令都没注册成功(例如内置实现加载异常),
        #   app 会变成"没有任何命令"的空壳——直接跑 `creamy` 会给出难懂的报错。
        @app.command("help")
        #   于是临时补一个名为 help 的命令,保证至少有东西可执行。
        def _help() -> None:
            #   命令体:无参、无返回。
            typer.echo("No CLI command loaded.")
            #   打印一句友好提示,告诉用户"没有命令被加载",比框架默认报错更易懂。

    return app
    #   返回装配完成的 CLI 应用。
```

- **设计取舍**:把"兜底 help"放进来是一种**防御式可用性**——即便扩展点全炸,CLI 也不至于
  完全不可用,且给出可读的线索。

### ③ 模块级入口

> **整块作用**:在模块被导入时就构造好 `app`(因为控制台脚本需要的是这个模块级对象);
> 并支持 `python -m backend` 直接运行。

```python
app = create_cli_app()
#   模块级即调用工厂,得到 app。
#   为什么放模块级?因为 pyproject 里 console_scripts 指向 "backend.__main__:app",
#   入口机制会去取"模块里名为 app 的对象"——它必须在 import 时就存在。
#   副作用:import backend.__main__ 就会触发完整的日志配置 + 插件加载。

if __name__ == "__main__":
    #   仅当以 `python -m backend`(把本模块当主程序)运行时,下面才执行;
    #   被当普通模块 import 时不执行(此时只需要上面的 app 对象)。
    app()
    #   启动 CLI,解析命令行参数并分发到对应子命令。
```

---

## 连接

- 子命令具体做什么:看 [`cli/cli.md`](cli/cli.md)。
- "内置先、外部后"的注册细节与"后注册者胜":看 [`app/framework.md`](app/framework.md)。
- 外部插件也能通过 `register_cli_commands` 往 `creamy` 加自己的子命令。
