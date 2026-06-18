# `backend/__init__.py` 精读(C 档·极详)

## 这个文件在干嘛

`backend` 包的入口模块(import 这个包时第一个被执行的代码)。它只做两件事:
1. **把三个最常用符号提到包顶层**(`CreamyFramework`、`hookimpl`、`tool`),形成稳定公开 API;
2. **确定包版本 `__version__`**,且用"三级回退"保证任何安装/开发场景下都拿得到值。

> 贯穿全项目的易错点:**发行名是 `creamy`,可导入的包名是 `backend`**。所以代码里永远写
> `from backend import ...`,而查发行包元数据时用名字 `creamy`。本文件两处都体现了这一点。

---

## 逐行精读(C 档)

### ① 导入 + 暴露公开 API

> **整块作用**:把分散在子模块里的三个核心能力"上提"到 `backend` 顶层,使用者无需记住
> 它们各自的深层路径;同时用 `__all__` 明确"对外承诺的稳定接口"就是这三者。

```python
"""Creamy framework package."""
#   包级 docstring(三引号字符串紧跟文件首部即成为模块 __doc__)。
#   作用:help(backend)、IDE 悬浮提示会显示它。内容只一句话——点明这是 Creamy 框架包。

from importlib import import_module
#   import_module:按"字符串模块名"在运行时动态导入一个模块,返回模块对象。
#   为什么不用普通 import?因为下面要导入的 backend._version 可能"不存在";
#   普通 `import backend._version` 在文件缺失时会让整个 backend 包导入直接失败,
#   而 import_module 放进 try 里,可被 except 捕获并回退。这是"运行时可选依赖"的标准手法。

from importlib.metadata import PackageNotFoundError
#   PackageNotFoundError:当向"已安装包数据库"查询一个并未安装的发行包时抛出的异常类型。
#   下面第②级回退要用它来判断"发行包 creamy 没装"。

from importlib.metadata import version as metadata_version
#   version 函数:读取"已安装发行包"的版本号(来自 wheel/sdist 的元数据)。
#   用 as 重命名为 metadata_version,是为了避免与本模块下面定义的变量名 version/__version__ 混淆。

from backend.app.framework import CreamyFramework
#   导入框架运行时类——整条 turn 管线的驱动者(process_inbound 在它身上)。
#   见 app/framework.md。放到顶层后,使用者可直接 `from backend import CreamyFramework`。

from backend.hooks.hookspecs import hookimpl
#   导入 pluggy 的"实现标记器"。插件作者用 @hookimpl 装饰自己的方法来实现某个 hook。
#   这里"再导出"它,是为了让插件作者写 `from backend import hookimpl`(而非更深的路径),
#   符合 CLAUDE.md 的约定。见 hooks/hookspecs.md。

from backend.tools.tools import tool
#   导入"工具装饰器"@tool:把一个普通 Python 函数登记成 agent 可调用的工具。
#   同样上提到顶层方便使用。见 tools/tools.md。

__all__ = ["CreamyFramework", "hookimpl", "tool"]
#   __all__ 控制两件事:① `from backend import *` 会导出哪些名字;
#   ② 等于对外宣告"这三者是受支持的稳定 API"——其它内部符号不保证稳定。
#   把公开面收窄到三个,降低使用者的认知负担(也是好库的惯例)。
```

- **设计取舍**:窄而稳的公开面 = 使用者只需记住"运行时 / 写插件 / 写工具"三个入口。

### ② 版本号三级回退

> **整块作用**:在"源码树开发 / editable 安装 / 正式 wheel 安装"等不同场景下,都能稳定地
> 得到一个 `__version__`。三级从"最权威"到"最兜底"依次降级,任何一级成功就停。

```python
try:
    #   第①级(最权威):优先读由 hatch-vcs 生成的 backend/_version.py。
    #   用 try/except 而非"先判断文件是否存在再读",遵循 Python 的 EAFP 风格
    #   (Easier to Ask Forgiveness than Permission),既避免 TOCTOU 竞态,也更简洁。
    __version__ = import_module("backend._version").version
    #   动态导入 backend._version 模块,取其模块级变量 version(一个字符串)。
    #   该文件由 git tag 派生(见 _version.md),所以它是"和 git 历史一致"的最准版本号。
except ModuleNotFoundError:
    #   只捕获"模块不存在"这一种异常——即 _version.py 没生成(纯源码树/某些打包场景)。
    #   故意不捕获更宽的 Exception:若 _version 内部真有别的错误,应让它抛出而非被悄悄吞掉。
    try:
        #   第②级:退而读"已安装发行包"的元数据版本。
        __version__ = metadata_version("creamy")
        #   关键细节:参数是发行名 "creamy",不是包名 "backend"。
        #   元数据数据库以发行名为键,查 "backend" 会查不到。这是本项目最容易踩的坑。
    except PackageNotFoundError:
        #   第②级也失败:说明这个包没有以"可被发现的发行包"方式安装
        #   (典型场景:直接在源码树里跑、或某些 editable 安装下元数据不可见)。
        __version__ = "0.0.0"
        #   第③级语义化兜底:宁可给一个"假版本" 0.0.0,也绝不让"取版本"这件小事
        #   导致 import backend 失败。下游若读 backend.__version__ 至少不会 AttributeError。
```

- **为什么值得这么小心**:`__version__` 会被 `creamy --version`、错误上报、缓存键等处读取。
  让它"在任何安装方式下都有值"是基础设施级的稳健性。

---

## 设计意图小结

- **窄公开面**:三个名字覆盖框架的全部常用入口。
- **版本解析容错**:三级回退 + 精确的异常捕获(只吞该吞的),保证健壮且不掩盖真错误。
