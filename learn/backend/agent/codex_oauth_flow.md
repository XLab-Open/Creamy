# `backend/agent/codex_oauth_flow.py` 精读(C 档·极详)

## 这个文件在干嘛

**OpenAI Codex 的 OAuth PKCE 登录流程**的完整实现(项目自有,只依赖 `authlib` + 标准库):
- PKCE 授权码流程(本地 loopback 回调,或手动粘贴);
- token 持久化到 `$CODEX_HOME/auth.json`(默认 `~/.codex/auth.json`);
- token 刷新;
- "按 provider 取 token、自动刷新"的解析器。

> 它被 `codex_oauth.py`(seam)再导出,被 `auth.py`(CLI)调用。理解它就理解了 `creamy login openai`
> 背后到底发生了什么。**PKCE** 是给"无法安全保存 client secret 的客户端"(如 CLI)用的 OAuth 加固:
> 用一次性的 verifier/challenge 防授权码被截获利用。

---

## 顶部:导入、provider 集合与默认端点常量

> **整块作用**:导入(含本地 HTTP 服务、浏览器、PKCE 用的随机/base64、authlib 客户端);定义 Codex OAuth
> 的官方默认参数(client_id、authorize/token URL、scope、originator)。

```python
"""OpenAI Codex OAuth PKCE flow — project-owned ...(见上)..."""
from __future__ import annotations

import json          # 读写 auth.json
import os            # CODEX_HOME、chmod 权限
import secrets       # 生成 PKCE verifier 与 state(密码学安全随机)
import threading     # 本地回调服务用锁/事件做线程同步
import time          # 计算 token 过期时间、超时 deadline
import urllib.parse  # 解析回调 URL 的 query
import webbrowser    # 自动打开授权 URL
from base64 import urlsafe_b64decode, urlsafe_b64encode  # PKCE/JWT 的 base64url
from collections.abc import Callable
from contextlib import suppress      # 忽略 chmod 失败
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # 本地 loopback 回调服务
from pathlib import Path
from typing import Any

from authlib.integrations.httpx_client import OAuth2Client
#   authlib 的 OAuth2 客户端:负责构造授权 URL、用授权码换 token、刷新 token。

_CODEX_PROVIDERS = {"openai"}
#   仅支持 provider "openai"(resolver 对其它 provider 返回 None)。
_DEFAULT_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
#   与官方 Codex 客户端一致的 client_id(注释指明来源:codex-rs 的 CLIENT_ID)。
_DEFAULT_CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"  # noqa: S105
#   换/刷 token 的端点。
_DEFAULT_CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
#   授权端点(用户在浏览器登录处)。
_DEFAULT_CODEX_OAUTH_SCOPE = "openid profile email offline_access"
#   申请的权限:身份/资料/邮箱/离线访问(offline_access 才能拿 refresh_token)。
_DEFAULT_CODEX_OAUTH_ORIGINATOR = "codex_cli_rs"
#   originator 标识。
```

---

## 异常类型

> **整块作用**:定义流程专用异常,便于上层精确捕获(响应畸形 / 登录失败 / state 不符 / 缺授权码)。

```python
class CodexOAuthResponseError(TypeError):
    """Raised when Codex OAuth token response is malformed."""
    #   token 响应缺字段/类型不对时抛。

class CodexOAuthLoginError(RuntimeError):
    """Raised when Codex OAuth login flow cannot complete."""
    #   登录整体无法完成(超时/无回调等)。auth.py 专门 catch 它。

class CodexOAuthStateMismatchError(CodexOAuthLoginError):
    """Raised when OAuth state validation fails."""
    #   回调带回的 state 与发出的不一致(可能 CSRF)。

class CodexOAuthMissingCodeError(CodexOAuthLoginError):
    """Raised when OAuth redirect does not include authorization code."""
    #   回调里没有授权码。
```

> **整块作用**:回调超时/失败时的人类可读错误文案(列出可能原因与排查建议)。

```python
def _build_oauth_callback_error_message(*, redirect_uri: str, timeout_seconds: float) -> str:
    return (
        "Did not receive OAuth callback. "
        f"redirect_uri={redirect_uri!r}, timeout_seconds={timeout_seconds}. "
        "Possible causes: callback wait timed out, local callback port is unavailable, "
        "or redirect_uri is not a loopback HTTP address. "
        "Try increasing timeout_seconds or use prompt_for_redirect for manual paste."
    )
    #   把 redirect_uri/超时/常见原因/建议拼成一段提示,登录失败时给用户看。
```

---

## `codex_cli_api_key_resolver`:从 auth.json 读 token(不刷新)

> **整块作用**:返回一个"只对 openai 返回 token"的解析器,直接读 `auth.json` 里的 access_token(不做
> 过期判断/刷新)。是"简单读取版"resolver。

```python
def codex_cli_api_key_resolver(codex_home: str | Path | None = None) -> Callable[[str], str | None]:
    """Build a provider-scoped resolver that reads Codex CLI OAuth token. ..."""
    auth_path = _resolve_codex_auth_path(codex_home)
    #   先定位 auth.json 路径(闭包捕获,后续调用复用)。

    def _resolver(provider: str) -> str | None:
        if provider not in _CODEX_PROVIDERS:
            return None
            #   非 openai → None。
        try:
            payload = json.loads(auth_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
            #   文件不存在/坏 → None。
        if not isinstance(payload, dict):
            return None
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return None
        access_token = tokens.get("access_token")
        if not isinstance(access_token, str):
            return None
        token = access_token.strip()
        return token or None
        #   逐层防御取出 tokens.access_token;空串视为无。
    return _resolver
```

---

## token 数据类与路径解析

> **整块作用**:`OpenAICodexOAuthTokens` 是 token 四件套;`_resolve_codex_auth_path` 算出 auth.json 路径。

```python
@dataclass(frozen=True)
class OpenAICodexOAuthTokens:
    access_token: str       # 访问令牌(JWT)
    refresh_token: str      # 刷新令牌
    expires_at: int         # 过期时间(Unix 秒)
    account_id: str | None = None  # ChatGPT 账号 id(可空)

def _resolve_codex_auth_path(codex_home: str | Path | None = None) -> Path:
    if codex_home is None:
        codex_home = os.getenv("CODEX_HOME", "~/.codex")
        #   未传则用 CODEX_HOME 环境变量,缺省 ~/.codex。
    return Path(codex_home).expanduser() / "auth.json"
    #   目录 + auth.json。
```

---

## 读取与解析已存 token

> **整块作用(_parse_tokens)**:把 auth.json 的 dict 解析成 token 数据类;对"没存显式过期时间"做最佳努力
> 兜底(用 last_refresh + 1h 或 now + 1h)。

```python
def _parse_tokens(payload: dict[str, Any]) -> OpenAICodexOAuthTokens | None:
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        return None
        #   两个 token 必须都是字符串。
    access = access_token.strip()
    refresh = refresh_token.strip()
    if not access or not refresh:
        return None
        #   不能为空。
    expires_raw = tokens.get("expires_at")
    if isinstance(expires_raw, (int, float)):
        expires_at = int(expires_raw)
        #   有显式过期就用。
    else:
        # Codex CLI 文件可能不存显式过期 → 最佳努力兜底:
        last_refresh_raw = payload.get("last_refresh")
        last_refresh = int(last_refresh_raw) if isinstance(last_refresh_raw, (int, float)) else int(time.time())
        #   用 last_refresh,没有就用现在。
        expires_at = last_refresh + 3600
        #   兜底过期 = 基准 + 1 小时。
    account_id = tokens.get("account_id")
    if not isinstance(account_id, str):
        account_id = None
        #   account_id 可空。
    return OpenAICodexOAuthTokens(access_token=access, refresh_token=refresh, expires_at=expires_at, account_id=account_id)

def load_openai_codex_oauth_tokens(codex_home: str | Path | None = None) -> OpenAICodexOAuthTokens | None:
    auth_path = _resolve_codex_auth_path(codex_home)
    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
        #   文件缺失/坏 → None。
    if not isinstance(payload, dict):
        return None
    return _parse_tokens(payload)
    #   解析成 token 数据类。
```

---

## 保存 token

> **整块作用**:把 token 合并写回 auth.json(保留文件里已有的其它字段),更新 last_refresh,并把文件权限
> 收紧到 0600(仅本人可读写)。

```python
def save_openai_codex_oauth_tokens(tokens, codex_home=None) -> Path:
    auth_path = _resolve_codex_auth_path(codex_home)
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    #   确保目录存在。
    payload: dict[str, Any]
    try:
        raw = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = {}
        #   读不到旧内容就从空开始。
    payload = raw if isinstance(raw, dict) else {}
    tokens_node = payload.get("tokens")
    if not isinstance(tokens_node, dict):
        tokens_node = {}
        #   合并写:保留 tokens 节点里可能存在的其它键。
    tokens_node.update({
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "expires_at": tokens.expires_at,
    })
    if tokens.account_id:
        tokens_node["account_id"] = tokens.account_id
        #   有 account_id 才写。
    payload["tokens"] = tokens_node
    payload["last_refresh"] = int(time.time())
    #   记录本次刷新时间(供没有 expires_at 时兜底用)。
    auth_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    #   写回(缩进美化)。
    with suppress(OSError):
        os.chmod(auth_path, 0o600)
        #   收紧权限到仅本人读写;失败(如某些文件系统不支持)就忽略。
    return auth_path
```

---

## 刷新 token

> **整块作用**:用 refresh_token 走 authlib 换一组新 token。

```python
def refresh_openai_codex_oauth_tokens(refresh_token, *, timeout_seconds=15.0, client_id=..., token_url=...) -> OpenAICodexOAuthTokens:
    with OAuth2Client(client_id=client_id, timeout=timeout_seconds, trust_env=False) as oauth:
        #   trust_env=False:不读系统代理等环境(行为可控)。
        payload = oauth.refresh_token(url=token_url, refresh_token=refresh_token)
        #   调 token 端点刷新。
    return _tokens_from_token_payload(payload, account_id=None)
    #   把响应解析成 token 数据类(account_id 从新 access_token 里解)。
```

---

## PKCE 与授权 URL

> **整块作用(_build_pkce_pair)**:生成 PKCE verifier(此实现把它同时用作 challenge,见下 create_authorization_url)。

```python
def _build_pkce_pair() -> str:
    verifier = urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
    #   32 字节密码学随机 → base64url → 去 padding,得到 verifier 字符串。
    return verifier
```

> **整块作用(_build_authorize_url)**:用 authlib 构造带 PKCE(S256)与若干 Codex 特定参数的授权 URL。

```python
def _build_authorize_url(*, client_id, redirect_uri, code_challenge, state, authorize_url, scope, originator) -> str:
    with OAuth2Client(
        client_id=client_id, redirect_uri=redirect_uri, scope=scope,
        code_challenge_method="S256",   # PKCE:用 SHA256 派生 challenge
        trust_env=False,
    ) as oauth:
        url, _ = oauth.create_authorization_url(
            authorize_url,
            state=state,                       # 防 CSRF 的随机串(回调要原样带回)
            code_verifier=code_challenge,      # authlib 据此算出 S256 challenge 放进 URL
            id_token_add_organizations="true",  # noqa: S106  # Codex 特定参数
            codex_cli_simplified_flow="true",   # Codex 简化流程开关
            originator=originator,              # 来源标识
        )
    return str(url)
    #   返回完整授权 URL(用户去浏览器打开它登录)。
```

---

## 解析回调输入 / 判断 loopback

> **整块作用(_extract_code_and_state)**:从"回调 URL 或裸授权码"里抽出 code 与 state(手动粘贴时各种
> 形态都尽量兼容)。

```python
def _extract_code_and_state(input_value: str) -> tuple[str | None, str | None]:
    raw = input_value.strip()
    if not raw:
        return None, None
    parsed = urllib.parse.urlsplit(raw)
    query = urllib.parse.parse_qs(parsed.query)
    code = query.get("code", [None])[0]
    state = query.get("state", [None])[0]
    #   先按"完整 URL"解析 query。
    if isinstance(code, str) or isinstance(state, str):
        return code if isinstance(code, str) else None, state if isinstance(state, str) else None
        #   拿到任一就返回。
    if "code=" in raw:
        parsed_qs = urllib.parse.parse_qs(raw)
        code = parsed_qs.get("code", [None])[0]
        state = parsed_qs.get("state", [None])[0]
        return code if isinstance(code, str) else None, state if isinstance(state, str) else None
        #   退一步:用户可能只粘了 "code=...&state=..." 这段。
    return raw, None
    #   再退:把整串当作"裸授权码"。
```

> **整块作用(_is_loopback_redirect_uri)**:判断 redirect_uri 是否本地 loopback http(决定能否起本地回调服务)。

```python
def _is_loopback_redirect_uri(redirect_uri: str) -> bool:
    parsed = urllib.parse.urlsplit(redirect_uri)
    if parsed.scheme != "http":
        return False
        #   必须是 http(loopback 不用 https)。
    host = (parsed.hostname or "").strip().lower()
    return host in {"127.0.0.1", "localhost"}
    #   主机必须是回环地址。
```

---

## 本地回调服务

> **整块作用(_wait_for_local_oauth_callback)**:在 redirect_uri 指定的本地端口起一个一次性 HTTP 服务,
> 等浏览器把授权码回调过来;拿到或超时即停。这是"自动模式"的核心。

```python
def _wait_for_local_oauth_callback(*, redirect_uri, timeout_seconds) -> tuple[str | None, str | None] | None:
    if not _is_loopback_redirect_uri(redirect_uri):
        return None
        #   非 loopback 无法本地起服务 → 返回 None(上层会报"没收到回调")。
    parsed_redirect = urllib.parse.urlsplit(redirect_uri)
    host = parsed_redirect.hostname or "localhost"
    port = parsed_redirect.port
    path = parsed_redirect.path or "/"
    if port is None:
        return None
        #   没端口无法监听。

    lock = threading.Lock()
    state: dict[str, str | None] = {"code": None, "state": None}
    done = threading.Event()
    #   线程间共享:锁保护结果、事件标记"已收到回调"。

    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return
            #   静音默认访问日志(不污染终端)。

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path != path:
                self.send_response(404)
                self.end_headers()
                return
                #   非回调路径 → 404。
            query = urllib.parse.parse_qs(parsed.query)
            code = query.get("code", [None])[0]
            returned_state = query.get("state", [None])[0]
            with lock:
                state["code"] = code if isinstance(code, str) else None
                state["state"] = returned_state if isinstance(returned_state, str) else None
            done.set()
            #   取出 code/state 存入共享 dict,并置 done。
            body = b"<!doctype html><html><body><p>Authentication successful. Return to your terminal.</p></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            #   给浏览器回一个"认证成功,请回终端"的页面。

    try:
        server = ThreadingHTTPServer((host, port), _Handler)
    except OSError:
        return None
        #   端口被占等 → 起不来,返回 None。
    server.timeout = 0.2
    #   每次 handle_request 最多阻塞 0.2s,便于轮询 deadline。
    deadline = time.monotonic() + timeout_seconds
    try:
        while not done.is_set() and time.monotonic() < deadline:
            server.handle_request()
            #   循环处理请求,直到收到回调或超时。
    finally:
        server.server_close()
        #   一定关掉服务(释放端口)。
    if not done.is_set():
        return None
        #   超时没收到 → None。
    with lock:
        return state["code"], state["state"]
        #   返回收到的 code/state。
```

---

## 从 JWT 解 account_id(本模块自有版)

> **整块作用**:与 `codex_oauth.extract_codex_account_id` 同逻辑(此处供本模块换 token 后解析用)。

```python
def extract_openai_codex_account_id(access_token: str) -> str | None:
    parts = access_token.split(".")
    if len(parts) != 3:
        return None
    payload_segment = parts[1]
    padding = "=" * (-len(payload_segment) % 4)
    try:
        payload = json.loads(urlsafe_b64decode((payload_segment + padding).encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    auth = payload.get("https://api.openai.com/auth")
    if not isinstance(auth, dict):
        return None
    account_id = auth.get("chatgpt_account_id")
    if not isinstance(account_id, str):
        return None
    normalized = account_id.strip()
    return normalized or None
    #   解码 JWT payload → 取 chatgpt_account_id(逻辑同 codex_oauth.md 里那份)。
```

---

## 用授权码换 token

> **整块作用**:PKCE 授权码 → token。带上 verifier(服务端据 challenge 校验),并从新 access_token 解出 account_id。

```python
def _exchange_openai_codex_authorization_code(code, *, verifier, redirect_uri, timeout_seconds, client_id, token_url) -> OpenAICodexOAuthTokens:
    with OAuth2Client(client_id=client_id, redirect_uri=redirect_uri, code_challenge_method="S256", timeout=timeout_seconds) as oauth:
        payload = oauth.fetch_token(
            url=token_url, grant_type="authorization_code",
            code=code, code_verifier=verifier,   # 提交 verifier 证明"我就是发起授权的人"
        )
    account_id = extract_openai_codex_account_id(str(payload.get("access_token", "")))
    #   从换来的 access_token 解 account_id。
    return _tokens_from_token_payload(payload, account_id=account_id)
```

---

## `login_openai_codex_oauth`:登录主流程 ⭐

> **整块作用**:串起全流程——生成 PKCE/state → 构造授权 URL →(可选)开浏览器 → 等回调/手动粘贴 →
> 校验 state、检查 code → 换 token → 存盘 → 返回。`auth.py` 调的就是它。

```python
def login_openai_codex_oauth(*, codex_home=None, prompt_for_redirect=None, open_browser=True, browser_opener=None,
    redirect_uri="http://localhost:1455/auth/callback", timeout_seconds=300.0,
    client_id=..., authorize_url=..., token_url=..., scope=..., originator=...) -> OpenAICodexOAuthTokens:
    """Run minimal OpenAI Codex OAuth login flow and persist tokens."""

    verifier = _build_pkce_pair()
    #   ① 生成 PKCE verifier。
    state = secrets.token_hex(16)
    #   ② 生成防 CSRF 的 state。
    oauth_url = _build_authorize_url(client_id=client_id, redirect_uri=redirect_uri, code_challenge=verifier,
        state=state, authorize_url=authorize_url, scope=scope, originator=originator)
    #   ③ 构造授权 URL。

    if open_browser:
        opener = browser_opener or webbrowser.open
        opener(oauth_url)
        #   ④ 自动打开浏览器(可注入自定义 opener,便于测试)。

    if prompt_for_redirect is not None:
        callback_input = prompt_for_redirect(oauth_url)
        code, returned_state = _extract_code_and_state(callback_input)
        #   ⑤a 手动模式:让用户粘回回调 URL/码,解析出 code/state。
    else:
        callback_values = _wait_for_local_oauth_callback(redirect_uri=redirect_uri, timeout_seconds=timeout_seconds)
        #   ⑤b 自动模式:起本地服务等回调。
        if callback_values is None:
            message = _build_oauth_callback_error_message(redirect_uri=redirect_uri, timeout_seconds=timeout_seconds)
            raise CodexOAuthLoginError(message)
            #   没收到回调 → 报错(含排查建议)。
        code, returned_state = callback_values

    if returned_state and returned_state != state:
        raise CodexOAuthStateMismatchError
        #   ⑥ state 不符 → 拒绝(防 CSRF/串号)。
    if not isinstance(code, str) or not code.strip():
        raise CodexOAuthMissingCodeError
        #   ⑦ 没拿到授权码 → 报错。

    tokens = _exchange_openai_codex_authorization_code(code=code.strip(), verifier=verifier,
        redirect_uri=redirect_uri, timeout_seconds=timeout_seconds, client_id=client_id, token_url=token_url)
    #   ⑧ 用授权码 + verifier 换 token。
    save_openai_codex_oauth_tokens(tokens, codex_home)
    #   ⑨ 存盘(auth.json,权限 0600)。
    return tokens
    #   ⑩ 返回 token(auth.py 据此渲染结果)。
```

---

## `openai_codex_oauth_resolver`:带自动刷新的解析器 ⭐

> **整块作用**:返回一个 resolver(provider→token):读盘 → 没过期直接返回 → 快过期则刷新并存盘 →
> 刷新失败但还没过期则继续用旧的。用锁保证并发安全。

```python
def openai_codex_oauth_resolver(codex_home=None, *, refresh_skew_seconds=120, refresh_timeout_seconds=15.0,
    client_id=..., token_url=..., refresher=None) -> Callable[[str], str | None]:
    """Build a resolver for OpenAI Codex OAuth tokens with auto-refresh."""

    lock = threading.Lock()
    #   串行化"读-判断-刷新-写"避免并发竞态。
    if refresher is None:
        def refresher(refresh_token: str) -> OpenAICodexOAuthTokens:
            return refresh_openai_codex_oauth_tokens(refresh_token, timeout_seconds=refresh_timeout_seconds,
                client_id=client_id, token_url=token_url)
            #   默认刷新器(可注入自定义,便于测试)。

    def _resolver(provider: str) -> str | None:
        if provider not in _CODEX_PROVIDERS:
            return None
            #   非 openai → None。
        with lock:
            tokens = load_openai_codex_oauth_tokens(codex_home)
            if tokens is None:
                return None
                #   没登录 → None。
            now = int(time.time())
            if tokens.expires_at > now + refresh_skew_seconds:
                return tokens.access_token
                #   还很新(距过期 > 120s skew)→ 直接用,不刷新。
            try:
                refreshed = refresher(tokens.refresh_token)
                #   临近/已过期 → 刷新。
            except Exception:
                if tokens.expires_at > now:
                    return tokens.access_token
                    #   刷新失败但当前还没真过期 → 先凑合用旧的。
                return None
                #   已过期且刷新失败 → None。
            persisted = OpenAICodexOAuthTokens(
                access_token=refreshed.access_token, refresh_token=refreshed.refresh_token,
                expires_at=refreshed.expires_at,
                account_id=refreshed.account_id or tokens.account_id,  # 新的没带 account_id 就沿用旧的
            )
            save_openai_codex_oauth_tokens(persisted, codex_home)
            #   刷新结果存盘。
            return persisted.access_token
            #   返回新 token。
    return _resolver
```

---

## token 响应解析 + 导出

> **整块作用(_tokens_from_token_payload)**:把 OAuth 端点返回的 dict 校验并转成 token 数据类(算 expires_at)。

```python
def _tokens_from_token_payload(payload: dict[str, Any], *, account_id: str | None) -> OpenAICodexOAuthTokens:
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    expires_in = payload.get("expires_in")
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        raise CodexOAuthResponseError
        #   缺 token → 响应畸形。
    if not isinstance(expires_in, (int, float)):
        raise CodexOAuthResponseError
        #   缺有效期 → 畸形。
    normalized_access = access_token.strip()
    return OpenAICodexOAuthTokens(
        access_token=normalized_access,
        refresh_token=refresh_token.strip(),
        expires_at=int(time.time() + float(expires_in)),  # 绝对过期时间 = 现在 + expires_in
        account_id=account_id or extract_openai_codex_account_id(normalized_access),  # 优先用传入,否则从 token 解
    )

__all__ = [
    "CodexOAuthLoginError", "CodexOAuthMissingCodeError", "CodexOAuthStateMismatchError",
    "OpenAICodexOAuthTokens", "codex_cli_api_key_resolver", "extract_openai_codex_account_id",
    "load_openai_codex_oauth_tokens", "login_openai_codex_oauth", "openai_codex_oauth_resolver",
    "refresh_openai_codex_oauth_tokens", "save_openai_codex_oauth_tokens",
]
#   导出全部公开符号(seam 模块从这里再导出一部分)。
```

---

## 怎么和别的文件连起来

- `agent/codex_oauth.py`(seam):再导出 `login_openai_codex_oauth` / `openai_codex_oauth_resolver` /
  `load_openai_codex_oauth_tokens`;并加请求塑形工具。
- `agent/auth.py`:`creamy login openai` 调 `login_openai_codex_oauth`。
- `llm/client.py`:经 seam 的 `codex_access_token`(底层即本文件的 resolver)拿 OAuth token 访问 Codex 后端。

---

## 一句话总结

本文件是 Codex 的"OAuth 登录与凭据管理"全套:PKCE 授权码 + 本地回调/手动粘贴 + state 防 CSRF +
auth.json 存盘(0600)+ 自动刷新解析器。只靠 authlib 与标准库,不依赖上游 republic 包。
