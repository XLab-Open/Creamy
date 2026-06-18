# `backend/agent/auth.py` 精读(C 档·极详)

## 这个文件在干嘛

实现 `creamy login` 这个 CLI 子应用(目前只有一个子命令 `openai`)。作用:跑 **OpenAI Codex 的 OAuth
登录流程**,把拿到的 token 存到 `~/.codex/auth.json`。登录后用户可以 `CREAMY_MODEL=openai:gpt-5-codex`
且**不必再配 `CREAMY_API_KEY`**(改用 OAuth token 访问 ChatGPT 后端)。

> 它是个"薄 CLI 壳":真正的 OAuth 逻辑在 `codex_oauth_flow.py`,经 `codex_oauth.py` 这个 seam(接缝)
> 暴露。`hook_impl.register_cli_commands` 用 `app.add_typer(cli.login_app)` 把它挂进 `creamy`。

---

## 逐行精读

> **整块作用**:导入 + 建 login 子应用 + 默认回调地址常量。

```python
import os
#   读 CODEX_HOME 环境变量、展开 ~。
from pathlib import Path
#   路径类型。
import typer
#   CLI 框架。

from backend.agent.codex_oauth import (
    CodexOAuthLoginError,        # 登录失败异常(用于捕获并友好报错)
    OpenAICodexOAuthTokens,      # 登录成功返回的 token 数据类
    login_openai_codex_oauth,    # 真正执行登录流程的函数
)
#   从 seam 模块导入(它再转发自 codex_oauth_flow)。

DEFAULT_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback"
#   OAuth 回调地址(本地 loopback 端口 1455)。登录流程会在此起一个临时 HTTP 服务接回调。
app = typer.Typer(name="login", help="Authentication related commands")
#   建名为 "login" 的子应用;它会被挂到根命令下成为 `creamy login ...`。
```

> **整块作用**:登录成功后的结果渲染(打印账号、凭据文件路径、用法提示)。

```python
def _render_codex_login_result(tokens: OpenAICodexOAuthTokens, auth_path: Path) -> None:
    typer.echo("login: ok")
    #   成功提示。
    typer.echo(f"account_id: {tokens.account_id or '-'}")
    #   打印 ChatGPT account id(没有就 '-')。
    typer.echo(f"auth_file: {auth_path}")
    #   凭据文件位置(~/.codex/auth.json)。
    typer.echo("usage: set CREAMY_MODEL=openai:gpt-5-codex and omit CREAMY_API_KEY")
    #   用法提示:配这个 model、且不用配 API key。
```

> **整块作用**:手动模式下,提示用户在浏览器完成登录并把回调 URL/授权码粘回来。

```python
def _prompt_for_codex_redirect(authorize_url: str) -> str:
    typer.echo("Open this URL in your browser and complete the Codex sign-in flow:\n")
    typer.echo(authorize_url)
    #   打印授权 URL 让用户去浏览器打开。
    typer.echo("\nPaste the full callback URL or the authorization code.")
    return str(typer.prompt("callback")).strip()
    #   交互式读取用户粘贴的回调 URL 或授权码(去空格)。
```

> **整块作用**:确定 Codex 凭据目录(参数 > CODEX_HOME 环境变量 > ~/.codex)。

```python
def _resolve_codex_home(codex_home: Path | None) -> Path:
    if codex_home is not None:
        return codex_home.expanduser()
        #   显式传了就用(展开 ~)。
    return Path(os.getenv("CODEX_HOME", "~/.codex")).expanduser()
    #   否则用 CODEX_HOME 环境变量,缺省 ~/.codex。
```

> **整块作用(openai 命令)**:`creamy login openai` —— 收集选项,选定"自动等回调"还是"手动粘贴",
> 调登录流程,失败友好报错,成功渲染结果。

```python
@app.command()
def openai(
    codex_home: Path | None = typer.Option(None, "--codex-home", help="Directory to store Codex OAuth credentials"),  # noqa: B008
    #   凭据目录(可选)。
    open_browser: bool = typer.Option(True, "--browser/--no-browser", help="Open the OAuth URL in a browser"),
    #   是否自动开浏览器(默认开)。
    manual: bool = typer.Option(False, "--manual", help="Paste the callback URL or code instead of waiting for a local callback server"),
    #   手动模式:不起本地回调服务,改让用户粘贴。
    timeout_seconds: float = typer.Option(300.0, "--timeout", help="OAuth wait timeout in seconds"),
    #   等待回调的超时(秒)。
) -> None:
    """Login with OpenAI OAuth."""

    resolved_codex_home = _resolve_codex_home(codex_home)
    #   定位凭据目录。
    prompt_for_redirect = _prompt_for_codex_redirect if manual or not open_browser else None
    #   决定是否用"手动粘贴"回调:手动模式 或 不开浏览器时,用粘贴函数;否则 None(走本地回调服务)。

    try:
        tokens = login_openai_codex_oauth(
            codex_home=resolved_codex_home,
            prompt_for_redirect=prompt_for_redirect,
            open_browser=open_browser,
            redirect_uri=DEFAULT_CODEX_REDIRECT_URI,
            timeout_seconds=timeout_seconds,
        )
        #   ⭐ 执行真正的 OAuth 登录(逻辑见 codex_oauth_flow.md)。
    except CodexOAuthLoginError as exc:
        typer.echo(f"Codex login failed: {exc}", err=True)
        #   失败:打到 stderr。
        raise typer.Exit(1) from exc
        #   以退出码 1 结束(链上原异常)。

    _render_codex_login_result(tokens, resolved_codex_home / "auth.json")
    #   成功:渲染结果(账号/文件/用法)。
```

---

## 一句话总结

`auth.py` 是 `creamy login openai` 的 CLI 外壳:收集选项、选自动/手动回调模式、调
`login_openai_codex_oauth` 完成 Codex OAuth 登录并把凭据存到 `~/.codex/auth.json`。真正流程在
[`codex_oauth_flow.md`](codex_oauth_flow.md),经 [`codex_oauth.md`](codex_oauth.md) 接缝暴露。
