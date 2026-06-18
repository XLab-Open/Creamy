# `backend/cli/cli.py` 精读(C 档·极详)

## 这个文件在干嘛

**`creamy` 各子命令的实现**:`run`(一次性跑一条)、`cli`(交互 REPL,函数名 `chat`)、`web`(Web 网关)、
`gateway`(启所有渠道)、`hooks`(诊断)、以及插件管理 `install`/`uninstall`/`update`。`hook_impl.register_cli_commands`
把这些函数注册成子命令。`login_app`(OAuth)从 `agent/auth.py` 再导出。

> 注意区分:`channels/cli.py` 是"CLI 渠道(TUI 界面)";本文件 `cli/cli.py` 是"命令行子命令的入口函数"。
> 多数命令最终是建 `ChannelManager` 并 `listen_and_run`,或直接 `framework.process_inbound`。

---

## 顶部:导入

```python
"""Builtin CLI command adapter."""
# ruff: noqa: B008                      # 允许在默认值里用 typer.Option(...)(B008 默认禁这种)
from __future__ import annotations
import asyncio, json, os, subprocess, sys
from functools import lru_cache
from importlib import metadata
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname
import typer

from backend.agent.auth import app as login_app  # noqa: F401   # OAuth 登录子应用(register_cli_commands 挂它)
from backend.app.framework import CreamyFramework
from backend.channels.message import ChannelMessage
from backend.utils.envelope import field_of
```

---

## run:一次性跑一条消息

> **整块作用**:构造一条 ChannelMessage,过一遍 turn 管线,把出站消息打印出来。`creamy run "msg"`。

```python
def run(ctx, message=typer.Argument(...), channel=typer.Option("cli", ...), chat_id=typer.Option("local", ...),
        sender_id=typer.Option("human", ...), session_id=typer.Option(None, ...)) -> None:
    """Run one inbound message through the framework pipeline."""
    framework = ctx.ensure_object(CreamyFramework)
    #   从 Typer 上下文取框架(create_cli_app 的根回调塞进 ctx.obj 的)。
    inbound = ChannelMessage(
        session_id=f"{channel}:{chat_id}" if session_id is None else session_id,
        content=message, channel=channel, chat_id=chat_id, context={"sender_id": sender_id},
    )
    #   组装入站消息。
    result = asyncio.run(framework.process_inbound(inbound))
    #   ⭐ 同步跑一次完整 turn(非流式)。
    for outbound in result.outbounds:
        rendered = str(field_of(outbound, "content", ""))
        target_channel = str(field_of(outbound, "channel", "stdout"))
        target_chat = str(field_of(outbound, "chat_id", "local"))
        typer.echo(f"[{target_channel}:{target_chat}]\n{rendered}")
        #   把每条出站消息打印到终端。
```

---

## list_hooks:诊断

> **整块作用**:打印"每个 hook 有哪些实现"(`creamy hooks`,隐藏命令)。

```python
def list_hooks(ctx) -> None:
    """Show hook implementation mapping."""
    framework = ctx.ensure_object(CreamyFramework)
    report = framework.hook_report()
    if not report:
        typer.echo("(no hook implementations)")
        return
    for hook_name, adapter_names in report.items():
        typer.echo(f"{hook_name}: {', '.join(adapter_names)}")
        #   逐 hook 打印实现它的插件名。
```

---

## gateway / web / chat:三种"起服务"命令

> **整块作用**:都建 ChannelManager 并 listen_and_run,区别在启用哪些渠道、是否流式。

```python
def gateway(ctx, enable_channels=typer.Option([], "--enable-channel", ...)) -> None:
    """Start message listeners(like telegram)."""
    from backend.channels.manager import ChannelManager
    framework = ctx.ensure_object(CreamyFramework)
    manager = ChannelManager(framework, enabled_channels=enable_channels or None)
    #   不指定则用配置(通常 all,排除 cli)。
    asyncio.run(manager.listen_and_run())
    #   启动所有渠道监听(Telegram/飞书等),长跑。

def web(ctx) -> None:
    """Start the Web gateway (HTTP/SSE) for the browser frontend."""
    from backend.channels.manager import ChannelManager
    framework = ctx.ensure_object(CreamyFramework)
    manager = ChannelManager(framework, enabled_channels=["web"], stream_output=True)
    #   ⭐ 只启 web 渠道、开流式(前端 SSE 要逐 token)。这就是你跑前端时用的 `creamy web`。
    asyncio.run(manager.listen_and_run())

def chat(ctx, chat_id=typer.Option("local", ...), session_id=typer.Option(None, ...)) -> None:
    """Start the interactive CLI REPL."""
    from backend.channels.manager import ChannelManager
    framework = ctx.ensure_object(CreamyFramework)
    manager = ChannelManager(framework, enabled_channels=["cli"], stream_output=True)
    #   只启 cli 渠道(全屏 TUI)。注意:命令名是 `cli`,函数名是 chat。
    channel = manager.get_channel("cli")
    if channel is None:
        typer.echo("CLI channel not found. Please check your hook implementations.")
        raise typer.Exit(1)
    channel.set_metadata(chat_id=chat_id, session_id=session_id)  # type: ignore[attr-defined]
    #   把会话/聊天 id 设给 CLI 渠道。
    asyncio.run(manager.listen_and_run())
```

---

## 插件管理:在独立 uv 项目里装插件

> **整块作用**:Creamy 插件依赖装进**独立的 uv 项目**(`~/.creamy/creamy-project`),不污染主 venv。
> 下面一组 helper + install/uninstall/update 命令围绕"用 uv 操作那个项目"。

```python
@lru_cache(maxsize=1)
def _find_uv() -> str:
    import shutil, sysconfig
    bin_path = sysconfig.get_path("scripts")
    uv_path = shutil.which("uv", path=os.pathsep.join([bin_path, os.getenv("PATH", "")]))
    if uv_path is None:
        raise FileNotFoundError("uv executable not found in PATH or scripts directory.")
    return uv_path
    #   定位 uv 可执行(脚本目录 + PATH)。

@lru_cache(maxsize=1)
def _default_project() -> Path:
    from ..agent.settings import load_settings
    settings = load_settings()
    project = settings.home / "creamy-project"
    project.mkdir(exist_ok=True, parents=True)
    return project
    #   插件项目目录 = ~/.creamy/creamy-project(CLAUDE.md 说的"独立 uv 项目")。

def _is_in_venv() -> bool:
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    #   是否在虚拟环境里(插件操作要求在 venv 内)。

project_opt = typer.Option(default_factory=_default_project, help="...", envvar="CREAMY_PROJECT")
#   --project 选项(可用 CREAMY_PROJECT 覆盖)。

def _uv(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    uv_executable = _find_uv()
    if not _is_in_venv():
        typer.secho("Please install Creamy in a virtual environment to use this command.", err=True, fg="red")
        raise typer.Exit(1)
        #   不在 venv → 拒绝(防污染系统环境)。
    env = {**os.environ, "VIRTUAL_ENV": sys.prefix}
    try:
        return subprocess.run([uv_executable, *args], env=env, check=True, cwd=cwd)
    except subprocess.CalledProcessError as e:
        typer.secho(f"Command 'uv {' '.join(args)}' failed with exit code {e.returncode}.", err=True, fg="red")
        raise typer.Exit(e.returncode) from e
        #   跑 uv 子命令;失败转成 Typer 退出码。

CREAMY_CONTRIB_REPO = "https://github.com/bubbuild/bub-contrib.git"
#   官方 contrib 仓库(裸包名默认从这装)。注:URL 仍是旧的 bub-contrib(rebrand 遗留)。
```

> **整块作用(_build_requirement)**:把用户给的 spec(git URL / owner/repo / 包名)转成 uv add 能认的 requirement。

```python
def _build_requirement(spec: str) -> str:
    if spec.startswith(("git@", "https://")):
        return f"git+{spec}"                       # 完整 git URL
    elif "/" in spec:
        repo, *rest = spec.partition("@")
        ref = "".join(rest)
        return f"git+https://github.com/{repo}.git{ref}"   # owner/repo[@ref]
    else:
        name, has_ref, ref = spec.partition("@")
        if has_ref:
            ref = f"@{ref}"
            return f"git+{CREAMY_CONTRIB_REPO}{ref}#subdirectory=packages/{name}"   # contrib 子包
        else:
            return name                            # PyPI 包名
```

> **整块作用(_build_local_requirement_path / _build_creamy_requirement)**:为新建插件项目算出"如何依赖 creamy
> 本体"——本地 editable / 本地路径 / VCS / PyPI 各情形。

```python
def _build_local_requirement_path(url: str, subdirectory=None) -> str | None:
    parsed = urlsplit(url)
    if parsed.scheme != "file":
        return None                                # 非本地文件 URL → None
    path = parsed.path
    if parsed.netloc and parsed.netloc != "localhost":
        path = f"//{parsed.netloc}{path}"
    local_path = Path(url2pathname(unquote(path)))
    if subdirectory:
        local_path /= subdirectory
    return os.fspath(local_path)                   # file:// URL → 本地路径

def _build_creamy_requirement() -> list[str]:
    dist = metadata.distribution("creamy")
    dist_name = dist.name
    direct_url_text = dist.read_text("direct_url.json")   # 安装来源信息
    if not direct_url_text:
        return [dist_name]                          # 没有 → 按名(PyPI)
    direct_url = json.loads(direct_url_text)
    requirement_url = str(direct_url["url"])
    subdirectory = direct_url.get("subdirectory")
    normalized_subdirectory = subdirectory if isinstance(subdirectory, str) and subdirectory else None
    local_path = _build_local_requirement_path(requirement_url, normalized_subdirectory)
    if local_path is not None:
        dir_info = direct_url.get("dir_info")
        editable = isinstance(dir_info, dict) and bool(dir_info.get("editable"))
        return ["--editable", local_path] if editable else [local_path]   # 本地(可 editable)
    vcs_info = direct_url.get("vcs_info")
    if isinstance(vcs_info, dict):
        vcs = vcs_info.get("vcs")
        requested_revision = vcs_info.get("requested_revision")
        if isinstance(vcs, str) and vcs:
            requirement_url = f"{vcs}+{requirement_url}"
        if isinstance(requested_revision, str) and requested_revision:
            requirement_url = f"{requirement_url}@{requested_revision}"
    if normalized_subdirectory:
        requirement_url = f"{requirement_url}#subdirectory={normalized_subdirectory}"
    return [requirement_url]                         # VCS 安装
    #   目的:让插件项目以"和当前 creamy 一致的方式"依赖 creamy 本体。

def _ensure_project(project: Path) -> None:
    if (project / "pyproject.toml").is_file():
        return                                       # 已初始化
    _uv("init", "--bare", "--name", "creamy-project", "--app", cwd=project)   # uv 初始化裸项目
    creamy_requirement = _build_creamy_requirement()
    _uv("add", "--active", "--no-sync", *creamy_requirement, cwd=project)     # 加 creamy 依赖
```

> **整块作用(install/uninstall/update)**:对插件项目执行 uv add/remove/sync。

```python
def install(specs=typer.Argument(default_factory=list, ...), project=project_opt) -> None:
    """Install a plugin into Creamy's environment, or sync if no specs."""
    _ensure_project(project)
    if not specs:
        _uv("sync", "--active", "--inexact", cwd=project)      # 无参 → 同步环境
    else:
        _uv("add", "--active", *map(_build_requirement, specs), cwd=project)  # 装指定插件

def uninstall(packages=typer.Argument(..., ...), project=project_opt) -> None:
    """Uninstall a plugin from Creamy's environment."""
    _ensure_project(project)
    _uv("remove", "--active", *packages, cwd=project)

def update(packages=typer.Argument(default_factory=list, ...), project=project_opt) -> None:
    """Update selected package or all packages."""
    _ensure_project(project)
    if not packages:
        _uv("sync", "--active", "--upgrade", "--inexact", cwd=project)        # 全部升级
    else:
        package_args: list[str] = []
        for pkg in packages:
            package_args.extend(["--upgrade-package", pkg])
        _uv("sync", "--active", "--inexact", *package_args, cwd=project)      # 升级指定包
```

---

## 怎么和别的文件连起来

- `hooks/hook_impl.py`:`register_cli_commands` 把这些函数注册成 `creamy` 子命令(run/cli/web/gateway/...)。
- `app/framework.py`:`process_inbound`(run)、`hook_report`(hooks)。
- `channels/manager.py`:gateway/web/chat 建它并 listen_and_run。
- `agent/auth.py`:`login_app`(OAuth 子应用)。

---

## 一句话总结

`cli/cli.py` 实现 `creamy` 的全部子命令:`run` 跑一条、`cli/web/gateway` 起不同渠道的服务、`hooks` 诊断、
`install/uninstall/update` 在独立 uv 项目里管理插件依赖(不污染主 venv)。
