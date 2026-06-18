# `backend/channels/feishu.py` 精读(C 档·极详)

## 这个文件在干嘛

**飞书渠道适配器 `FeishuChannel`**(基于 `lark-oapi` 长连接 WebSocket)。职责:用 WS 接飞书消息事件 →
白名单校验 → 解析文本/图片(image/post)→ 交框架跑 turn → 把回复经飞书 OpenAPI 发回。还管理
tenant_access_token 的获取与缓存、消息内图片资源的下载。

> 与 Telegram 类似(去抖群聊渠道),但走的是飞书的 WS 事件 + OpenAPI 发送。注意:这与你之前接的
> **飞书 MCP 完全无关**——那是给 Claude Code 写云文档;这里是 Creamy 自己的聊天机器人渠道。
> 源码本身已带中文注释,本文逐行补全/深化。

---

## 顶部:导入与媒体类型映射

```python
from __future__ import annotations
import asyncio
import contextlib
import json
from time import monotonic         # 单调时钟(token 过期计时,不受系统时间调整影响)
from typing import Any, ClassVar

from aiohttp import ClientSession  # 调飞书 OpenAPI(发消息/取 token/下载资源)
from loguru import logger

from backend.agent.settings import FeishuSettings   # 飞书配置(app_id/secret/base_url/白名单)
from backend.channels.base import Channel
from backend.channels.message import ChannelMessage, MediaItem, MediaType
from backend.utils.types import MessageHandler

_MSG_TYPE_TO_MEDIA_TYPE: dict[str, MediaType] = {
    "image": "image",   # 单图消息
    "post": "image",    # 富文本(post)里可能含图,也归为 image
}
```

---

## 构造与开关

> **整块作用**:读配置、解析白名单、初始化 WS 任务/心跳/token 缓存等状态。enabled 看有无 app_id+secret;
> needs_debounce=True(群聊去抖)。

```python
class FeishuChannel(Channel):
    name = "feishu"
    _TOKEN_EXPIRE_SKEW_SECONDS: ClassVar[int] = 30
    #   token 过期提前量:剩 <30s 就视为要刷新(避免边界失效)。

    def __init__(self, on_receive: MessageHandler) -> None:
        self._on_receive = on_receive
        self._settings = FeishuSettings()
        self._allow_users = {uid.strip() for uid in (self._settings.allow_users or "").split(",") if uid.strip()}
        #   用户白名单(open_id 集合)。
        self._allow_chats = {cid.strip() for cid in (self._settings.allow_chats or "").split(",") if cid.strip()}
        #   群白名单(chat_id 集合)。
        self._ws_task: asyncio.Task[None] | None = None
        #   WS 主任务。
        self._ws_client: Any | None = None
        #   lark WS 客户端。
        self._ws_ping_task: asyncio.Task[None] | None = None
        #   心跳任务。
        self._loop: asyncio.AbstractEventLoop | None = None
        #   事件循环引用(WS 回调在别的线程,需用它跨线程调度协程)。
        self._token_lock = asyncio.Lock()
        #   取 token 的锁(防并发重复请求)。
        self._tenant_access_token: str | None = None
        #   缓存的 tenant token。
        self._tenant_access_token_expire_at = 0.0
        #   token 过期时刻(monotonic 秒)。

    @property
    def enabled(self) -> bool:
        return bool(self._settings.app_id and self._settings.app_secret)
        #   配了 app_id 与 app_secret 才启用。

    @property
    def needs_debounce(self) -> bool:
        return True
        #   群聊渠道:去抖。
```

---

## 生命周期:start / stop

> **整块作用(start)**:记录事件循环,起 WS 主任务。

```python
    async def start(self, stop_event: asyncio.Event) -> None:
        self._loop = asyncio.get_running_loop()
        #   记录当前事件循环(所有协程共用同一个;WS 回调里要用它 call_soon_threadsafe 调度协程)。
        self._ws_task = asyncio.create_task(self._run_websocket(stop_event))
        #   起 WS 长连接主任务。
        logger.info("feishu.start websocket mode enabled")

    async def stop(self) -> None:
        if self._ws_task is not None:
            self._ws_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ws_task
            self._ws_task = None
            #   取消 WS 主任务。
        if self._ws_ping_task is not None:
            self._ws_ping_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ws_ping_task
            self._ws_ping_task = None
            #   取消心跳任务。
        if self._ws_client is not None:
            with contextlib.suppress(Exception):
                await self._ws_client._disconnect()
            self._ws_client = None
            #   断开 WS 连接。
        logger.info("feishu.stopped")
```

---

## WS 事件回调 + 连接

> **整块作用(_on_message)**:lark SDK 在收到消息事件时(可能在别的线程)调它;它解析 payload 并用
> `call_soon_threadsafe` 把 `_build_message` 协程调度到主事件循环。

```python
    def _on_message(self, event: Any, lark: Any) -> None:
        loop = self._loop
        if loop is None:
            return
            #   还没记录到事件循环 → 忽略。
        payload_raw = lark.JSON.marshal(event)
        #   用 lark 的序列化把 event 转成 JSON 字符串。
        try:
            payload = json.loads(payload_raw)
        except json.JSONDecodeError:
            logger.warning("feishu.websocket invalid event payload")
            return
            #   解析失败 → 告警丢弃。
        if not isinstance(payload, dict):
            return
        event_payload = payload.get("event")
        if not isinstance(event_payload, dict):
            return
            #   取出 event 体。
        loop.call_soon_threadsafe(asyncio.create_task, self._build_message(event_payload))
        #   ⭐ 跨线程把"建消息并交框架"的协程安全调度到主事件循环执行
        #   (SDK 回调线程 ≠ 主协程线程,必须 call_soon_threadsafe)。
```

> **整块作用(_run_websocket)**:导入 lark、注册"收消息"事件处理器、建 WS 客户端、连接、起心跳、等停机信号、清理。

```python
    async def _run_websocket(self, stop_event: asyncio.Event) -> None:
        try:
            import lark_oapi as lark
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "Feishu websocket mode requires dependency 'lark-oapi'. Install it with: uv add lark-oapi"
            ) from exc
            #   缺依赖 → 明确报错并给安装命令。

        event_handler = (
            lark.EventDispatcherHandler
            .builder("", "")                                   # 创建事件分发器(飞书 SDK 的事件路由)
            .register_p2_im_message_receive_v1(lambda event: self._on_message(event, lark))  # 注册"收到 IM 消息"处理器
            .build()
        )
        #   收到飞书消息时转调 self._on_message(并把 lark 传进去用于序列化)。

        self._ws_client = lark.ws.Client(
            self._settings.app_id, self._settings.app_secret,  # 鉴权
            event_handler=event_handler,                       # 挂事件处理器
            log_level=lark.LogLevel.INFO,                      # 日志级别
        )
        await self._ws_client._connect()
        #   真正建立 WS 连接(握手完成才继续)。
        self._ws_ping_task = asyncio.create_task(self._ws_client._ping_loop())
        #   起心跳循环保活。
        try:
            await stop_event.wait()
            #   主协程在此挂起,连接持续工作,直到收到停机信号。
        finally:
            if self._ws_ping_task is not None:
                self._ws_ping_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._ws_ping_task
                self._ws_ping_task = None
                #   取消心跳。
            if self._ws_client is not None:
                with contextlib.suppress(Exception):
                    await self._ws_client._disconnect()
                self._ws_client = None
                #   断开连接、清引用。
```

---

## 发送与文本提取

> **整块作用(send / _extract_reply_text)**:把出站内容(可能是 JSON 包裹)抽成纯文本发回飞书。

```python
    async def send(self, message: ChannelMessage) -> None:
        text = self._extract_reply_text(message.content)
        if not text.strip():
            return
            #   空文本不发。
        await self._send_text(chat_id=message.chat_id, text=text)
        #   调飞书 API 发文本。

    @staticmethod
    def _extract_reply_text(content: str) -> str:
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            return content
            #   不是 JSON → 当纯文本。
        if isinstance(payload, dict):
            raw = payload.get("message", "")
            return str(raw) if raw is not None else ""
            #   是 {"message": ...} → 取 message。
        return content
```

> **整块作用(_extract_inbound_text)**:把飞书入站消息的 content(JSON)抽成文本——text 类取 "text",
> 其它类(image/post)取嵌套的 content 文本。

```python
    @staticmethod
    def _extract_inbound_text(message_type: str, content: str) -> str:
        if not content:
            return ""
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            return content
            #   非 JSON → 原样。
        if isinstance(payload, dict) and message_type == "text":
            raw = payload.get("text", "")
            return str(raw) if raw is not None else ""
            #   文本消息:content 形如 {"text": "..."}。
        elif isinstance(payload, dict) and message_type != "text":
            raw = payload.get("content", "")
            if raw:
                raw = raw[0][0]["text"]
                #   富文本(post)的嵌套结构:content[0][0]["text"] 取第一段文字。
            return str(raw) if raw is not None else ""
        return content
```

---

## 图片资源解析

> **整块作用**:从 content 里抽出 image_key(单图 / post 富文本两种结构),据此造惰性下载的 MediaItem。

```python
    @staticmethod
    def _json_dict(raw: str) -> dict[str, Any]:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(payload, dict):
            return payload
        return {}
        #   安全把字符串解析成 dict(失败/非 dict → 空 dict)。

    @staticmethod
    def _extract_image_keys(message_type: str, content: str) -> list[str]:
        payload = FeishuChannel._json_dict(content)
        if message_type == "image":
            key = str(payload.get("image_key", "")).strip()
            return [key] if key else []
            #   单图:content 直接含 image_key。
        if message_type != "post":
            return []
            #   既不是 image 也不是 post → 没图。
        keys: list[str] = []
        # post content format: {"content":[[{"tag":"img","image_key":"..."}], ...]}
        blocks = payload.get("content")
        if isinstance(blocks, list):
            for line in blocks:               # post 是"段落数组"
                if not isinstance(line, list):
                    continue
                for item in line:             # 每段是"元素数组"
                    if not isinstance(item, dict):
                        continue
                    if item.get("tag") != "img":
                        continue              # 只要 img 元素
                    key = str(item.get("image_key", "")).strip()
                    if key:
                        keys.append(key)
        return keys
        #   遍历 post 结构收集所有图片 key。

    def _extract_media_items(self, message_type: str, content: str, message_id: str) -> list[MediaItem]:
        media_type = _MSG_TYPE_TO_MEDIA_TYPE.get(message_type)
        if not media_type or not message_id:
            return []
            #   非媒体类型或无 message_id → 无媒体。
        image_keys = self._extract_image_keys(message_type, content)
        if not image_keys:
            return []
        return [
            MediaItem(
                type=media_type,
                mime_type="image/jpeg",
                filename=image_key,
                data_fetcher=lambda key=image_key: self._download_message_resource(message_id, key, "image"),  # type: ignore[misc]
                #   惰性下载:用 message_id + image_key 调资源接口(lambda 默认参数绑定当前 key,避免闭包陷阱)。
            )
            for image_key in image_keys
        ]
```

---

## 构造入站消息:_build_message ⭐

> **整块作用**:从飞书事件里取 chat/sender,白名单校验,按类型抽文本/图,打包成 ChannelMessage 交框架。

```python
    async def _build_message(self, event: dict[str, Any]) -> None:
        message = event.get("message")
        if not isinstance(message, dict):
            return
        chat_id = str(message.get("chat_id", ""))
        #   群/会话 id(事件体里带)。
        if not chat_id:
            return
        if self._allow_chats and chat_id not in self._allow_chats:
            return
            #   群白名单:不在则忽略。

        sender = event.get("sender")
        sender = sender if isinstance(sender, dict) else {}
        sender_id = sender.get("sender_id")
        sender_id = sender_id if isinstance(sender_id, dict) else {}
        sender_open_id = str(sender_id.get("open_id", ""))
        #   逐层防御取发送者 open_id。
        if self._allow_users and sender_open_id not in self._allow_users:
            return
            #   用户白名单:不在则忽略。

        message_type = str(message.get("message_type", "text"))
        message_id = str(message.get("message_id", ""))
        content_raw = str(message.get("content", ""))
        text = ""
        media_items: list[MediaItem] = []
        if message_type == "text":
            text = self._extract_inbound_text(message_type, content_raw).strip()
            if not text:
                return
                #   纯文本但空 → 忽略。
        elif message_type in {"image", "post"}:
            text = self._extract_inbound_text(message_type, content_raw).strip()
            media_items = self._extract_media_items(message_type, content_raw, message_id)
            if not media_items:
                return
                #   图片/富文本但没解析出图 → 忽略。
        else:
            text = self._extract_inbound_text(message_type, content_raw).strip()
            #   其它类型:尽力抽点文字。

        session_id = f"{self.name}:{chat_id}"
        #   会话 id = feishu:<chat_id>。
        if text.startswith("/"):
            inbound_content = text
            #   命令(/...)原样传。
        else:
            inbound_content = json.dumps({
                "message": text,
                "message_id": str(message.get("message_id", "")),
                "type": message_type,
                "chat_id": chat_id,
                "sender_id": sender_open_id,
            }, ensure_ascii=False)
            #   普通消息:打包成 JSON(intent_detection 那边解出 message)。
        inbound = ChannelMessage(
            session_id=session_id, channel=self.name, chat_id=chat_id,
            content=inbound_content,
            is_active=True,           # 飞书走 WS,收到即视为主动消息
            media=media_items,
            output_channel=self.name, # 回复走飞书自身(经 send → _send_text)
        )
        await self._on_receive(inbound)
        #   交给框架跑 turn。
```

---

## 飞书 OpenAPI:发消息 / 取 token / 通用请求 / 下载资源

> **整块作用(_send_text)**:用 tenant token 调 IM 发消息接口发文本。

```python
    async def _send_text(self, chat_id: str, text: str) -> None:
        token = await self._get_tenant_access_token()
        #   取(缓存的)tenant token。
        payload = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),  # 飞书要求 content 是 JSON 字符串
        }
        response = await self._request_json(
            "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id",
            headers={"Authorization": f"Bearer {token}"}, payload=payload,
        )
        if int(response.get("code", -1)) != 0:
            msg = response.get("msg", "unknown error")
            raise RuntimeError(f"Failed to send Feishu message: {msg}")
            #   飞书 code≠0 表示失败。
```

> **整块作用(_get_tenant_access_token)**:双检锁拿/刷 tenant token 并缓存(带过期提前量)。

```python
    async def _get_tenant_access_token(self) -> str:
        now = monotonic()
        cached = self._tenant_access_token
        if cached and now < self._tenant_access_token_expire_at - self._TOKEN_EXPIRE_SKEW_SECONDS:
            return cached
            #   ① 无锁快速路径:缓存还没临近过期 → 直接用。
        async with self._token_lock:
            #   ② 加锁(防多协程并发刷)。
            now = monotonic()
            cached = self._tenant_access_token
            if cached and now < self._tenant_access_token_expire_at - self._TOKEN_EXPIRE_SKEW_SECONDS:
                return cached
                #   双检:拿到锁后再确认一次(可能别的协程刚刷过)。
            response = await self._request_json(
                "POST", "/open-apis/auth/v3/tenant_access_token/internal",
                payload={"app_id": self._settings.app_id, "app_secret": self._settings.app_secret},
            )
            #   调鉴权接口换 token。
            if int(response.get("code", -1)) != 0:
                msg = response.get("msg", "unknown error")
                raise RuntimeError(f"Failed to get Feishu tenant access token: {msg}")
            token = str(response.get("tenant_access_token", ""))
            if not token:
                raise RuntimeError("Feishu tenant access token is empty.")
            expire = int(response.get("expire", 7200))
            #   有效期(秒,缺省 7200)。
            self._tenant_access_token = token
            self._tenant_access_token_expire_at = monotonic() + expire
            #   缓存 token 与过期时刻。
            return token
```

> **整块作用(_request_json)**:通用 JSON 请求封装(拼 URL、设头、发请求、解析 JSON)。

```python
    async def _request_json(self, method, path, payload, headers=None) -> dict[str, Any]:
        url = f"{self._settings.base_url.rstrip('/')}{path}"
        #   base_url + path。
        req_headers = {"Content-Type": "application/json; charset=utf-8"}
        if headers:
            req_headers.update(headers)
            #   合并自定义头(如 Authorization)。
        async with (
            ClientSession() as session,
            session.request(method, url, json=payload, headers=req_headers) as response,
        ):
            data = await response.json()
            #   发请求并解析 JSON 响应。
        if not isinstance(data, dict):
            raise RuntimeError("Unexpected Feishu API response format.")  # noqa: TRY004
            #   响应不是对象 → 视为契约错误。
        return data
```

> **整块作用(_download_message_resource)**:用 token 下载消息内的图片资源(MediaItem 的 data_fetcher 调它)。

```python
    async def _download_message_resource(self, message_id: str, file_key: str, file_type: str) -> bytes:
        token = await self._get_tenant_access_token()
        path = f"/open-apis/im/v1/messages/{message_id}/resources/{file_key}"
        #   资源接口:按 message_id + file_key 取。
        params = {"type": file_type}
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{self._settings.base_url.rstrip('/')}{path}"
        async with ClientSession() as session, session.get(url, params=params, headers=headers) as response:
            if response.status >= 400:
                body = await response.text()
                raise RuntimeError(f"Failed to download Feishu resource: status={response.status}, body={body}")
                #   HTTP 错误 → 抛含状态/响应体的错误。
            return await response.read()
            #   返回原始字节(交给 MediaItem.get_url 编码成 data URL)。
```

---

## 怎么和别的文件连起来

- `channels/handler.py`:needs_debounce=True → 去抖;`is_active=True` → 立即处理。
- `channels/message.py`:`MediaItem`(惰性下载)、`ChannelMessage`。
- `hook_impl.build_prompt`/`intent_detection`:解 JSON content 的 "message"、把图转多模态。
- `agent/settings.py`:`FeishuSettings`(app_id/secret/base_url/白名单)。

---

## 一句话总结

`FeishuChannel` 用 lark-oapi WS 长连接接飞书消息:WS 回调跨线程调度到主循环、白名单校验、解析文本与
图片(惰性下载、image/post 两种结构)、打包交框架、回复经 OpenAPI 发送;并带 tenant token 的双检锁缓存。
属去抖群聊渠道。
