# `backend/agent/codex_oauth.py` 精读(C 档·极详)

## 这个文件在干嘛

**接缝(seam)模块**:把 OAuth 登录/存储/刷新(在 `codex_oauth_flow.py`)**再导出**,并提供"Codex 请求
塑形"的工具——解析 token 里的 account_id、判断是否 Codex token、规整 Codex 后端 base URL、构造 Codex
所需请求头、以及"取当前可用 access token(自动刷新)"。

> 为什么要 seam:让其它调用点(`auth.py`、`llm/client.py`)**只依赖这一个稳定模块**,而不直接依赖底层
> flow 实现。这样底层换实现时,调用点不受影响。Codex 走的是 "ChatGPT 后端 Responses API",所以
> `llm/client.py` 能把一个 LangChain `ChatOpenAI` 指向 Codex 后端。

---

## 顶部:导入与常量

> **整块作用**:模块 docstring 说明 seam 定位;从 flow 模块再导出登录相关符号;定义 Codex 后端常量。

```python
"""OpenAI Codex OAuth — project seam. ...(见上)..."""
#   docstring:登录/存储/刷新在 flow 里,这里再导出;请求塑形也在本项目自有。

from __future__ import annotations
import base64
#   解码 JWT 的 payload 段(取 account_id)。
import json
#   解析解码后的 JSON。

from backend.agent.codex_oauth_flow import (
    CodexOAuthLoginError,                 # 登录失败异常
    OpenAICodexOAuthTokens,               # token 数据类
    load_openai_codex_oauth_tokens,       # 从磁盘读 token
    login_openai_codex_oauth,             # 执行登录流程
    openai_codex_oauth_resolver,          # 带自动刷新的 token 解析器工厂
)
#   把底层 flow 的关键符号"穿透"到本 seam,供外部统一从这里 import。

__all__ = [
    "CODEX_BASE_URL", "CODEX_ORIGINATOR", "CodexOAuthLoginError", "OpenAICodexOAuthTokens",
    "build_codex_headers", "codex_access_token", "extract_codex_account_id", "is_codex_token",
    "load_openai_codex_oauth_tokens", "login_openai_codex_oauth", "resolve_codex_api_base",
]
#   公开面 = 再导出的 + 本模块新增的塑形函数。

CODEX_BASE_URL = "https://chatgpt.com/backend-api"
#   Codex(ChatGPT 后端)基础 URL。
CODEX_ORIGINATOR = "codex_cli_rs"
#   originator 标识(Codex 后端要求的请求头之一,标明来源客户端)。
_CODEX_PROVIDER = "openai"
#   provider 名(resolver 只对 openai 返回 token)。
```

---

## `extract_codex_account_id`:从 JWT 解出账号 id

> **整块作用**:Codex 的 access token 是 JWT;从它的 payload 段解出 `chatgpt_account_id`(请求头要用)。

```python
def extract_codex_account_id(access_token: str) -> str | None:
    """Decode the ``chatgpt_account_id`` claim from a Codex OAuth JWT access token."""
    parts = access_token.split(".")
    #   JWT 由三段(header.payload.signature)用 "." 连接。
    if len(parts) != 3:
        return None
        #   不是三段 → 不是合法 JWT。
    segment = parts[1]
    #   取 payload 段。
    segment += "=" * (-len(segment) % 4)
    #   base64url 补齐 "="(JWT 通常去掉了 padding,解码前补回)。
    try:
        payload = json.loads(base64.urlsafe_b64decode(segment.encode("ascii")).decode("utf-8"))
        #   base64url 解码 → UTF-8 → JSON 解析。
    except Exception:
        return None
        #   任何解析失败都返回 None(健壮)。
    if not isinstance(payload, dict):
        return None
    auth = payload.get("https://api.openai.com/auth")
    #   account id 嵌在这个命名空间化的 claim 下。
    if not isinstance(auth, dict):
        return None
    account_id = auth.get("chatgpt_account_id")
    #   取目标字段。
    if not isinstance(account_id, str):
        return None
    return account_id.strip() or None
    #   去空格;空串视为无。
```

---

## `is_codex_token`:判断是不是 Codex token

> **整块作用**:能从中解出 account_id 的,就是 Codex OAuth token(用于区分普通 API key 与 Codex token)。

```python
def is_codex_token(access_token: str | None) -> bool:
    """A Codex OAuth access token is a JWT carrying a ``chatgpt_account_id``."""
    return access_token is not None and extract_codex_account_id(access_token) is not None
    #   非空且能解出 account_id → True。
```

---

## `resolve_codex_api_base`:规整后端 base URL

> **整块作用**:把任意给定的 base URL 规整成 Codex Responses 后端要求的 `.../backend-api/codex` 形态。

```python
def resolve_codex_api_base(api_base: str | None = None) -> str:
    """Normalize the Codex Responses backend base URL (``.../backend-api/codex``)."""
    raw = (api_base or CODEX_BASE_URL).rstrip("/")
    #   用传入值或默认,去掉结尾 "/"。
    if raw.endswith("/responses"):
        raw = raw[: -len("/responses")]
        #   若误带了 "/responses" 后缀,去掉(后面统一补 /codex)。
    return raw if raw.endswith("/codex") else f"{raw}/codex"
    #   保证以 "/codex" 结尾。
```

---

## `build_codex_headers`:构造 Codex 请求头

> **整块作用**:Codex 后端需要特定头:账号 id、Responses 实验开关、originator。缺 account_id 直接报错。

```python
def build_codex_headers(access_token: str, *, originator: str = CODEX_ORIGINATOR) -> dict[str, str]:
    """Build the headers the Codex backend requires for an OAuth access token."""
    account_id = extract_codex_account_id(access_token)
    #   从 token 解 account id。
    if account_id is None:
        raise ValueError("Codex OAuth token is missing chatgpt_account_id")
        #   没有就无法访问 Codex 后端 → 报错。
    return {
        "chatgpt-account-id": account_id,        # 账号 id 头
        "OpenAI-Beta": "responses=experimental", # 启用 Responses 实验特性
        "originator": originator,                # 来源客户端标识
    }
```

---

## `codex_access_token`:取当前可用 token(自动刷新)

> **整块作用**:封装 resolver——返回一个当前有效的 access token(过期会自动刷新);未登录/出错则 None。

```python
def codex_access_token(codex_home: str | None = None) -> str | None:
    """Return a current Codex access token (auto-refreshing), or ``None`` if not logged in."""
    try:
        resolver = openai_codex_oauth_resolver(codex_home)
        #   建带自动刷新的解析器(底层会按 expires_at 决定要不要刷新)。
        return resolver(_CODEX_PROVIDER)
        #   对 provider="openai" 求当前 token。
    except Exception:
        return None
        #   任何异常(没登录、文件坏、刷新失败)都安全返回 None。
```

---

## 怎么和别的文件连起来

- `agent/codex_oauth_flow.py`:本 seam 再导出它的登录/读取/resolver;塑形函数(headers/base/account_id)
  是本 seam 自有。
- `agent/auth.py`:`creamy login openai` 调 `login_openai_codex_oauth`。
- `llm/client.py`:用 `is_codex_token` / `resolve_codex_api_base` / `build_codex_headers` /
  `codex_access_token` 把 LangChain `ChatOpenAI` 指向 Codex 后端(OAuth 鉴权而非 API key)。

---

## 一句话总结

`codex_oauth.py` 是 Codex OAuth 的"对外接缝":再导出底层登录/刷新能力,并提供"解析 account_id、判断
token、规整 base URL、构造请求头、取自动刷新 token"这套**把请求塑形成 Codex 后端可接受形态**的工具。
