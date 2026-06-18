# `backend/tools/channeltool/tool_feishu.py` 精读(C 档·极详)

## 这个文件在干嘛

**飞书发送工具的底层 HTTP 函数**(同步 `requests` 版):取 tenant_access_token、发飞书消息、从 session_id
解析 chat_id。`toolimpl.send_report` 工具用它把库存 Excel 报告发到飞书群。

> 注意:这与 `channels/feishu.py`(收消息的 WS 渠道,用 aiohttp 异步)不同——本文件是**主动发送**用的
> 同步小工具,服务于 `send.report` 这个工具。

---

## 取 tenant token

> **整块作用**:用 app_id/app_secret 换 tenant_access_token(此端点不带 Bearer 头)。

```python
import json
import requests
from backend.agent.settings import FeishuSettings


def get_feishu_tenant_access_token(settings: FeishuSettings) -> str:
    """Fetch tenant_access_token via app_id/app_secret (no Bearer header on this endpoint)."""
    if not settings.app_id or not settings.app_secret:
        raise ValueError("CREAMY_FEISHU_APP_ID and CREAMY_FEISHU_APP_SECRET must be configured in .env")
        #   缺配置 → 报错(提示配 .env)。
    base = settings.base_url.rstrip("/")
    response = requests.post(
        f"{base}/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": settings.app_id, "app_secret": settings.app_secret},
        timeout=30,
    )
    #   POST 鉴权接口换 token。
    response.raise_for_status()
    data = response.json()
    if int(data.get("code", -1)) != 0:
        raise RuntimeError(f"Failed to get Feishu tenant access token: {data.get('msg', data)}")
        #   飞书 code≠0 → 失败。
    token = str(data.get("tenant_access_token", ""))
    if not token:
        raise RuntimeError("Feishu tenant access token is empty")
    return token
```

---

## 发消息

> **整块作用**:用 token 调 IM 发消息接口,发送指定类型(text/file 等)的消息到某 chat。

```python
def send_feishu_message(*, base: str, auth_headers: dict[str, str], chat_id: str, msg_type: str, content: dict) -> dict:
    response = requests.post(
        f"{base}/open-apis/im/v1/messages",
        headers={**auth_headers, "Content-Type": "application/json"},   # 带 Authorization
        params={"receive_id_type": "chat_id"},                          # 按 chat_id 收件
        json={
            "receive_id": chat_id,
            "msg_type": msg_type,                                       # text / file 等
            "content": json.dumps(content, ensure_ascii=False),         # content 须是 JSON 字符串
        },
        timeout=30,
    )
    response.raise_for_status()
    data: dict = response.json()
    if int(data.get("code", -1)) != 0:
        raise RuntimeError(f"Feishu send message failed: {data.get('msg', data)}")
        #   失败抛错。
    return data
```

---

## 解析 chat_id

> **整块作用**:从 session_id(形如 "feishu:<chat_id>")抽 chat_id;否则回退到配置白名单的第一个群。

```python
def resolve_feishu_chat_id(settings: FeishuSettings, session_id: str) -> str:
    if ":" in session_id:
        channel, chat_id = session_id.split(":", 1)
        if channel == "feishu" and chat_id:
            return chat_id
            #   ① session 来自飞书渠道 → 直接用其 chat_id。
    allow = settings.allow_chats or ""
    chat_ids = [cid.strip() for cid in allow.split(",") if cid.strip()]
    if chat_ids:
        return chat_ids[0]
        #   ② 否则(如 CLI/定时任务触发的会话)→ 用白名单里第一个群。
    raise ValueError("cannot resolve Feishu chat_id from session_id or CREAMY_FEISHU_ALLOW_CHATS")
    #   ③ 都没有 → 报错(不知道发给谁)。
```

- 场景②很重要:`send.report` 可能由"每日定时盘点"触发(session 不是飞书来源),此时靠配置的群白名单
  决定发到哪个群。

---

## 怎么和别的文件连起来

- `tools/toolimpl.py`:`send_report` 工具调这三个函数(取 token → 上传文件 → 发文本 + 发文件)。
- `agent/settings.py`:`FeishuSettings`(app_id/secret/base_url/allow_chats)。
- 对比 `channels/feishu.py`:那是收消息(异步 WS),本文件是主动发(同步 requests)。

---

## 一句话总结

`tool_feishu.py` 是 `send.report` 的底层:换 tenant token、按 chat_id 发飞书消息、从 session 或配置解析目标
群。让 agent 能把库存盘点报告主动推送到飞书。
