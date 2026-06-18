# `backend/channels/telegram.py` 精读(C 档·极详)

## 这个文件在干嘛

**Telegram 渠道适配器 `TelegramChannel`**(基于 `python-telegram-bot`)。职责:长轮询收 Telegram 消息 →
过滤(私聊全收、群聊仅在被 @/回复时响应)→ 解析(文本/图片/语音/文件…转成统一形态 + 媒体附件)→
交给框架跑 turn → 把回复发回 Telegram;期间显示"正在输入"。它是**需要去抖**的群聊渠道。

> 与 CLI 不同:Telegram 把回复经 `send` 主动推送(而非流式渲染),所以 `_build_message` 里设
> `output_channel="null"` 关掉框架的常规出站,改由别处/send 发(见下分析)。

结构:消息类型判定 → 消息过滤器 `CreamyMessageFilter` → 媒体提取 → `TelegramChannel`(生命周期/收发)→
`TelegramMessageParser`(把各类 Telegram 消息解析成文本+元数据+媒体)。

---

## 顶部:导入、常量、消息类型判定

> **整块作用**:导入 telegram 库与项目类型;无权限提示语;`_message_type` 按字段判断消息是文本/图片/语音/…

```python
from __future__ import annotations
import asyncio
import contextlib
import json
from collections.abc import AsyncGenerator, Callable
from typing import Any, ClassVar

from loguru import logger
from telegram import Bot, Message, Update                      # telegram 数据类型
from telegram.ext import Application, CommandHandler, ContextTypes, filters  # telegram 应用/处理器/过滤器
from telegram.ext import MessageHandler as TelegramMessageHandler            # 重命名避免与项目 MessageHandler 冲突
from telegram.request import HTTPXRequest                      # 自定义请求(设超时/代理)

from backend.agent.settings import TelegramSettings           # telegram 配置(token/白名单/代理)
from backend.channels.base import Channel
from backend.channels.message import ChannelMessage, MediaItem, MediaType
from backend.utils.types import MessageHandler                # 项目入站回调类型
from backend.utils.utils import exclude_none                  # 去掉 dict 里 None 值

NO_ACCESS_MESSAGE = "You are not allowed to chat with me. Please deploy your own instance of Creamy."
#   非白名单聊天的拒绝提示。


def _message_type(message: Message) -> str:
    if getattr(message, "text", None):
        return "text"
        #   有 text → 文本。
    if getattr(message, "photo", None):
        return "photo"          # 图片
    if getattr(message, "audio", None):
        return "audio"          # 音频文件
    if getattr(message, "sticker", None):
        return "sticker"        # 贴纸
    if getattr(message, "video", None):
        return "video"          # 视频
    if getattr(message, "voice", None):
        return "voice"          # 语音
    if getattr(message, "document", None):
        return "document"       # 文档
    if getattr(message, "video_note", None):
        return "video_note"     # 圆形小视频
    return "unknown"
    #   都不是 → 未知(会被过滤掉)。
```

---

## 消息过滤器:CreamyMessageFilter

> **整块作用**:决定"哪些消息要处理"。私聊全收;群聊只在"被 @ / 关键词 creamy / 回复机器人"时处理。

```python
class CreamyMessageFilter(filters.MessageFilter):
    GROUP_CHAT_TYPES: ClassVar[set[str]] = {"group", "supergroup"}
    #   群聊类型集合。

    def _content(self, message: Message) -> str:
        return (getattr(message, "text", None) or getattr(message, "caption", None) or "").strip()
        #   取正文(text 或图片的 caption),去空格。

    def filter(self, message: Message) -> bool | dict[str, list[Any]] | None:
        msg_type = _message_type(message)
        if msg_type == "unknown":
            return False
            #   未知类型不处理。
        if message.chat.type == "private":
            return True
            #   私聊:全部处理。
        if message.chat.type in self.GROUP_CHAT_TYPES:
            bot = message.get_bot()
            bot_id = bot.id
            bot_username = (bot.username or "").lower()
            #   群聊:取机器人自身 id/用户名。
            mentions_bot = self._mentions_bot(message, bot_id, bot_username)
            reply_to_bot = self._is_reply_to_bot(message, bot_id)
            #   是否 @了机器人 / 是否在回复机器人。
            if msg_type != "text" and not getattr(message, "caption", None):
                return reply_to_bot
                #   非文本且无 caption(纯图/纯语音):只有"回复机器人"才处理(无法判断是否在叫它)。
            return mentions_bot or reply_to_bot
            #   文本/带 caption:被 @ 或 回复机器人 即处理。
        return False
        #   其它聊天类型不处理。

    def _mentions_bot(self, message: Message, bot_id: int, bot_username: str) -> bool:
        content = self._content(message).lower()
        mentions_by_keyword = "creamy" in content or bool(bot_username and f"@{bot_username}" in content)
        #   关键词命中:正文含 "creamy" 或 "@<bot用户名>"。
        entities = [*(getattr(message, "entities", None) or ()), *(getattr(message, "caption_entities", None) or ())]
        #   汇总文本实体 + caption 实体(Telegram 把 @提及、链接等标成 entity)。
        for entity in entities:
            if entity.type == "mention" and bot_username:
                mention_text = content[entity.offset : entity.offset + entity.length]
                if mention_text.lower() == f"@{bot_username}":
                    return True
                    #   实体是 @用户名 且正好是本机器人 → 命中。
                continue
            if entity.type == "text_mention" and entity.user and entity.user.id == bot_id:
                return True
                #   实体是"无用户名的提及"且指向本机器人 id → 命中。
        return mentions_by_keyword
        #   实体没命中就回退到关键词判断。

    @staticmethod
    def _is_reply_to_bot(message: Message, bot_id: int) -> bool:
        reply_to_message = message.reply_to_message
        if reply_to_message is None or reply_to_message.from_user is None:
            return False
            #   不是回复,或被回复者未知 → 否。
        return reply_to_message.from_user.id == bot_id
        #   被回复的那条是不是机器人发的。


MESSAGE_FILTER = CreamyMessageFilter()
#   全局过滤器实例(_build_message 里用它算 is_active)。
```

---

## 媒体类型映射 + 提取

> **整块作用**:Telegram 消息类型 → 统一 MediaType;从解析出的 metadata 里取出 data_fetcher 造 MediaItem。

```python
_MSG_TYPE_TO_MEDIA_TYPE: dict[str, MediaType] = {
    "photo": "image", "sticker": "image",   # 图片类
    "audio": "audio", "voice": "audio",     # 音频类
    "video": "video", "video_note": "video",# 视频类
    "document": "document",                 # 文档
}

def _extract_media_items(metadata: dict[str, Any]) -> list[MediaItem]:
    """Extract MediaItem from parsed metadata, removing data_url from it."""
    media_dict = metadata.get("media")
    if not isinstance(media_dict, dict):
        return []
        #   没有 media 信息 → 空。
    data_fetcher = media_dict.pop("data_fetcher", None)
    #   取出(并从 metadata 移除)"按需下载"回调。
    if not data_fetcher or not callable(data_fetcher):
        return []
        #   没有可用 fetcher → 空。
    msg_type = metadata.get("type", "")
    media_type = _MSG_TYPE_TO_MEDIA_TYPE.get(msg_type, "document")
    #   映射成统一媒体类型(默认 document)。
    mime_type = media_dict.get("mime_type", "")
    return [MediaItem(type=media_type, data_fetcher=data_fetcher, mime_type=mime_type, filename=media_dict.get("file_name"))]
    #   造一个 MediaItem(惰性下载;build_prompt 时才 get_url)。
```

---

## `TelegramChannel`:构造与开关

> **整块作用**:读配置、解析用户/群白名单、建解析器与"输入中"任务表;enabled 看有无 token;needs_debounce=True。

```python
class TelegramChannel(Channel):
    name = "telegram"
    _app: Application

    def __init__(self, on_receive: MessageHandler) -> None:
        self._on_receive = on_receive
        self._settings = TelegramSettings()
        #   配置(token/allow_users/allow_chats/proxy)。
        self._allow_users = {uid.strip() for uid in (self._settings.allow_users or "").split(",") if uid.strip()}
        #   用户白名单集合(逗号分隔解析)。
        self._allow_chats = {cid.strip() for cid in (self._settings.allow_chats or "").split(",") if cid.strip()}
        #   群白名单集合。
        self._parser = TelegramMessageParser(bot_getter=lambda: self._app.bot)
        #   消息解析器(传入"取 bot"的回调,供下载媒体)。
        self._typing_tasks: dict[str, asyncio.Task] = {}
        #   chat_id -> "正在输入"循环任务。

    @property
    def enabled(self) -> bool:
        return bool(self._settings.token)
        #   有 token 才启用(没配就不启动该渠道)。

    @property
    def needs_debounce(self) -> bool:
        return True
        #   群聊渠道:启用去抖(manager 用 BufferedMessageHandler 包它)。
```

---

## 生命周期:start / stop

> **整块作用(start)**:建 Telegram Application(可选代理),注册命令/消息处理器,初始化并开始长轮询。

```python
    async def start(self, stop_event: asyncio.Event) -> None:
        proxy = self._settings.proxy
        logger.info("telegram.start allow_users_count={} allow_chats_count={} proxy_enabled={}",
            len(self._allow_users), len(self._allow_chats), bool(proxy))
        get_updates_request = HTTPXRequest(read_timeout=30)
        #   长轮询读超时设 30s。
        builder = Application.builder().token(self._settings.token).get_updates_request(get_updates_request)
        #   用 token 建 Application builder。
        if proxy:
            builder = builder.proxy(proxy).get_updates_proxy(proxy)
            #   配了代理就给常规请求与拉更新都设代理。
        self._app = builder.build()
        self._app.add_handler(CommandHandler("start", self._on_start))
        #   /start 命令处理器。
        self._app.add_handler(CommandHandler("creamy", self._on_message, has_args=True, block=False))
        #   /creamy <文本> 命令(带参,非阻塞)→ 当普通消息处理。
        self._app.add_handler(TelegramMessageHandler(~filters.COMMAND, self._on_message, block=False))
        #   所有"非命令"消息 → _on_message。
        await self._app.initialize()
        await self._app.start()
        #   初始化并启动应用。
        updater = self._app.updater
        if updater is None:
            return
        await updater.start_polling(drop_pending_updates=True, allowed_updates=["message"])
        #   开始长轮询;丢弃启动前积压的更新;只订阅 message 类型。
        logger.info("telegram.start polling")

    async def stop(self) -> None:
        updater = self._app.updater
        with contextlib.suppress(Exception):
            if updater is not None and updater.running:
                await updater.stop()
                #   停轮询。
            await self._app.stop()
            await self._app.shutdown()
            #   停并关闭应用。
        for task in self._typing_tasks.values():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
                #   取消所有"正在输入"任务。
        self._typing_tasks.clear()
        logger.info("telegram.stopped")
```

---

## 发送与命令处理

> **整块作用(send)**:把出站文本发回 Telegram(兼容内容是 JSON 包裹的情形)。

```python
    async def send(self, message: ChannelMessage) -> None:
        chat_id = message.chat_id
        content = message.content
        try:
            data = json.loads(content)
            text = data.get("message", "")
            #   内容是 JSON({"message": ...})就取其 message。
        except json.JSONDecodeError:
            text = content
            #   否则就是纯文本。
        if not text.strip():
            return
            #   空文本不发。
        await self._app.bot.send_message(chat_id=chat_id, text=text)
        #   调 telegram API 发消息。
```

> **整块作用(_on_start / _on_message)**:/start 回欢迎(带群白名单校验);普通消息做白名单校验后交框架。

```python
    async def _on_start(self, update: Update, _context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.message is None:
            return
        if self._allow_chats and str(update.message.chat_id) not in self._allow_chats:
            await update.message.reply_text(NO_ACCESS_MESSAGE)
            return
            #   群不在白名单 → 拒绝。
        await update.message.reply_text("Creamy is online. Send text to start.")
        #   欢迎语。

    async def _on_message(self, update: Update, _context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.message is None or update.effective_user is None:
            return
        chat_id = str(update.message.chat_id)
        if self._allow_chats and chat_id not in self._allow_chats:
            return
            #   群白名单:不在则静默忽略。
        user = update.effective_user
        sender_tokens = {str(user.id)}
        if user.username:
            sender_tokens.add(user.username)
            #   发送者标识:id + 用户名。
        if self._allow_users and sender_tokens.isdisjoint(self._allow_users):
            await update.message.reply_text("Access denied.")
            return
            #   用户白名单:既不匹配 id 也不匹配用户名 → 拒绝。
        await self._on_receive(await self._build_message(update.message))
        #   通过校验 → 解析成 ChannelMessage 交给框架。
```

---

## 构造入站消息:_build_message ⭐

> **整块作用**:解析消息、处理 /creamy 前缀与命令、提取媒体与"被回复消息"、把正文+元数据打包成 JSON,
> 标记 is_active,挂上"正在输入"生命周期,并关掉常规出站(output_channel="null")。

```python
    async def _build_message(self, message: Message) -> ChannelMessage:
        chat_id = str(message.chat_id)
        session_id = f"{self.name}:{chat_id}"
        #   会话 id = telegram:<chat_id>。
        content, metadata = await self._parser.parse(message)
        #   解析出正文 + 元数据(含媒体)。
        if content.startswith("/creamy "):
            content = content[len("/creamy ") :]
            #   去掉 /creamy 前缀(命令带参形式)。
        if content.strip().startswith("/"):
            return ChannelMessage(session_id=session_id, content=content.strip(), channel=self.name, chat_id=chat_id)
            #   是内部命令(/...)→ 直接做成命令消息(不打包元数据、不挂媒体)。
        media_items = _extract_media_items(metadata)
        #   提取本条媒体。
        reply_meta = await self._parser.get_reply(message)
        if reply_meta:
            metadata["reply_to_message"] = reply_meta
            #   有"被回复消息"就并进元数据(给模型上下文)。
            reply_media = _extract_media_items(reply_meta)
            media_items.extend(reply_media)
            #   被回复消息里的媒体也带上。
        content = json.dumps({"message": content, **metadata}, ensure_ascii=False)
        #   把"正文 + 元数据"打包成一个 JSON 字符串作为 content(intent_detection 那边会解出 message)。
        is_active = MESSAGE_FILTER.filter(message) is not False
        #   是否"主动消息"(被 @/回复)→ 影响去抖处理器是否立即处理。
        return ChannelMessage(
            session_id=session_id, channel=self.name, chat_id=chat_id,
            content=content, media=media_items, is_active=is_active,
            lifespan=self.start_typing(chat_id),   # turn 期间显示"正在输入"
            output_channel="null",  # disable outbound for telegram messages
            #   关掉常规出站路由(回复通过别的方式/send 处理,避免与 typing/打包冲突)。
        )
```

---

## "正在输入"状态

> **整块作用(start_typing)**:作为 lifespan——turn 期间起一个循环持续发 typing 动作,结束时取消。

```python
    @contextlib.asynccontextmanager
    async def start_typing(self, chat_id: str) -> AsyncGenerator[None, None]:
        if chat_id in self._typing_tasks:
            yield
            return
            #   该 chat 已有 typing 任务(并发消息)→ 不重复起,直接 yield。
        task = asyncio.create_task(self._typing_loop(chat_id))
        self._typing_tasks[chat_id] = task
        #   起 typing 循环并登记。
        try:
            yield
            #   turn 期间。
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            del self._typing_tasks[chat_id]
            #   turn 结束:取消并注销。

    async def _typing_loop(self, chat_id: str) -> None:
        while True:
            try:
                await self._app.bot.send_chat_action(chat_id=chat_id, action="typing")
                #   发"正在输入"动作。
                await asyncio.sleep(4)  # Telegram typing status lasts for 5 seconds, so we refresh it every 4 seconds
                #   每 4s 刷一次(Telegram 的 typing 状态约持续 5s)。
            except Exception as e:
                logger.error(f"Error in typing loop for chat_id={chat_id}: {e}")
                break
                #   出错就停。
```

---

## `TelegramMessageParser`:把各类消息解析成文本+元数据+媒体

> **整块作用(parse/get_reply/_extract_links)**:总入口按类型分派到 `_parse_<type>`;汇总通用元数据;
> 解析被回复消息;抽取链接。

```python
class TelegramMessageParser:
    def __init__(self, bot_getter: Callable[[], Bot] | None = None) -> None:
        self._bot_getter = bot_getter
        #   取 bot 的回调(下载媒体用)。

    async def parse(self, message: Message) -> tuple[str, dict[str, Any]]:
        msg_type = _message_type(message)
        content, media = f"[Unsupported message type: {msg_type}]", None
        #   默认:不支持类型的占位。
        if msg_type == "text":
            content, media = getattr(message, "text", None) or "", None
            #   文本:直接取 text。
        else:
            parser = getattr(self, f"_parse_{msg_type}", None)
            if parser is not None:
                content, media = await parser(message)
                #   其它类型:动态找 _parse_photo/_parse_audio/... 来解析。
        metadata = exclude_none({
            "message_id": message.message_id,
            "type": _message_type(message),
            "username": message.from_user.username if message.from_user else "",
            "full_name": message.from_user.full_name if message.from_user else "",
            "sender_id": str(message.from_user.id) if message.from_user else "",
            "sender_is_bot": message.from_user.is_bot if message.from_user else None,
            "date": message.date.timestamp() if message.date else None,
            "links": self._extract_links(message),
            "media": media,
        })
        #   汇总通用元数据(发送者、时间、链接、媒体),exclude_none 去掉空字段。
        return content, metadata

    async def get_reply(self, message: Message) -> dict[str, Any] | None:
        reply_to = message.reply_to_message
        if reply_to is None or reply_to.from_user is None:
            return None
            #   没有被回复消息 → None。
        content, metadata = await self.parse(reply_to)
        #   递归解析被回复的那条。
        return {"message": content, **metadata}

    @staticmethod
    def _extract_links(message: Message) -> list[str] | None:
        entities = getattr(message, "entities", None)
        source_text = getattr(message, "text", None) or ""
        if not entities:
            entities = getattr(message, "caption_entities", None)
            source_text = getattr(message, "caption", None) or ""
            #   文本没实体就看 caption 的实体。
        if not entities:
            return None
        links: list[str] = []
        for entity in entities:
            url: str | None = None
            if entity.type == "text_link":
                url = getattr(entity, "url", None)
                #   text_link:url 直接在实体上。
            elif entity.type == "url":
                offset = getattr(entity, "offset", 0)
                length = getattr(entity, "length", 0)
                candidate = source_text[offset : offset + length].strip()
                url = candidate or None
                #   url 实体:按 offset/length 从原文切出链接文本。
            if url and url not in links:
                links.append(url)
                #   去重收集。
        return links or None
```

> **整块作用(各 _parse_<type>)**:把图片/音频/贴纸/视频/语音/文档/小视频解析成"展示文本 + 媒体元数据
> (含 data_fetcher 惰性下载)"。模式高度一致,逐个看:

```python
    async def _parse_photo(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        caption = getattr(message, "caption", None) or ""
        formatted = f"[Photo message] Caption: {caption}" if caption else "[Photo message]"
        #   展示文本(带 caption 则附上)。
        photos = getattr(message, "photo", None) or []
        if not photos:
            return formatted, None
        largest = photos[-1]
        #   photo 是多分辨率数组,取最后一个=最大分辨率。
        mime_type = "image/jpeg"
        media = exclude_none({
            "file_id": largest.file_id, "file_size": largest.file_size,
            "width": largest.width, "height": largest.height, "mime_type": mime_type,
            "data_fetcher": lambda: self._download_media(largest.file_id, largest.file_size),
            #   惰性下载回调(按需才真正下图)。
        })
        return formatted, media

    async def _parse_audio(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        audio = getattr(message, "audio", None)
        if audio is None:
            return "[Audio]", None
        title = audio.title or "Unknown"
        performer = audio.performer or ""
        duration = audio.duration or 0
        metadata = exclude_none({
            "file_id": audio.file_id, "mime_type": audio.mime_type, "file_size": audio.file_size,
            "duration": audio.duration, "title": audio.title, "performer": audio.performer,
            "data_fetcher": lambda: self._download_media(audio.file_id, audio.file_size),
        })
        if performer:
            return f"[Audio: {performer} - {title} ({duration}s)]", metadata
            #   有演唱者:展示 "演唱者 - 标题 (时长)"。
        return f"[Audio: {title} ({duration}s)]", metadata
        #   否则只展示标题+时长。

    async def _download_media(self, file_id: str, file_size: int) -> bytes | None:
        if not file_id:
            raise ValueError("file_id must not be empty")
        if self._bot_getter is None:
            raise RuntimeError("Telegram bot is not configured for media downloads.")
        if file_size > 2 * 1024 * 1024:  # limit to 2MB
            return None
            #   超 2MB 不下(省流/防大文件);返回 None 让 MediaItem.get_url 跳过。
        bot = self._bot_getter()
        if bot is None:
            raise RuntimeError("Telegram bot is not available for media downloads.")
        telegram_file = await bot.get_file(file_id)
        #   据 file_id 取文件句柄。
        if telegram_file is None:
            raise RuntimeError(f"Telegram file lookup returned no result for file_id={file_id}.")
        data = await telegram_file.download_as_bytearray()
        #   下载为字节。
        return bytes(data)

    async def _parse_sticker(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        sticker = getattr(message, "sticker", None)
        if sticker is None:
            return "[Sticker]", None
        emoji = sticker.emoji or ""
        set_name = sticker.set_name or ""
        mime_type = "image/webp" if not sticker.is_animated else "video/webm"
        #   静态贴纸 webp、动态贴纸 webm。
        metadata = exclude_none({
            "file_id": sticker.file_id, "width": sticker.width, "height": sticker.height,
            "mime_type": mime_type, "emoji": sticker.emoji, "set_name": sticker.set_name,
            "is_animated": sticker.is_animated,
            "data_fetcher": lambda: self._download_media(sticker.file_id, sticker.file_size),
        })
        if emoji:
            return f"[Sticker: {emoji} from {set_name}]", metadata
        return f"[Sticker from {set_name}]", metadata

    async def _parse_video(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        video = getattr(message, "video", None)
        duration = video.duration if video else 0
        caption = getattr(message, "caption", None) or ""
        formatted = f"[Video: {duration}s]"
        formatted = f"{formatted} Caption: {caption}" if caption else formatted
        #   展示文本(时长 + 可选 caption)。
        if video is None:
            return formatted, None
        metadata = exclude_none({
            "file_id": video.file_id, "file_size": video.file_size, "width": video.width,
            "height": video.height, "duration": video.duration, "mime_type": video.mime_type,
            "data_fetcher": lambda: self._download_media(video.file_id, video.file_size),
        })
        return formatted, metadata

    async def _parse_voice(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        voice = getattr(message, "voice", None)
        duration = voice.duration if voice else 0
        if voice is None:
            return f"[Voice message: {duration}s]", None
        metadata = exclude_none({
            "file_id": voice.file_id, "duration": voice.duration,
            "mime_type": voice.mime_type or "audio/ogg",   # 语音缺省 ogg
            "data_fetcher": lambda: self._download_media(voice.file_id, voice.file_size),
        })
        return f"[Voice message: {duration}s]", metadata

    async def _parse_document(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        document = getattr(message, "document", None)
        if document is None:
            return "[Document]", None
        file_name = document.file_name or "unknown"
        mime_type = document.mime_type or "application/octet-stream"   # 缺省二进制流
        caption = getattr(message, "caption", None) or ""
        formatted = f"[Document: {file_name} ({mime_type})]"
        formatted = f"{formatted} Caption: {caption}" if caption else formatted
        metadata = exclude_none({
            "file_id": document.file_id, "file_name": document.file_name, "file_size": document.file_size,
            "mime_type": mime_type,
            "data_fetcher": lambda: self._download_media(document.file_id, document.file_size),
        })
        return formatted, metadata

    async def _parse_video_note(self, message: Message) -> tuple[str, dict[str, Any] | None]:
        video_note = getattr(message, "video_note", None)
        duration = video_note.duration if video_note else 0
        if video_note is None:
            return f"[Video note: {duration}s]", None
        metadata = exclude_none({
            "file_id": video_note.file_id, "duration": video_note.duration,
            "mime_type": video_note.mime_type or "video/mp4",
            "data_fetcher": lambda: self._download_media(video_note.file_id, video_note.file_size),
        })
        return f"[Video note: {duration}s]", metadata
```

- 七个 `_parse_*` 模式一致:**生成一段人类可读的占位文本(给模型当"这里有张图/段语音"的提示)+ 一个
  带惰性 `data_fetcher` 的媒体元数据**。真正下载推迟到 `MediaItem.get_url`(且 >2MB 不下)。

---

## 怎么和别的文件连起来

- `channels/handler.py`:needs_debounce=True → manager 用 BufferedMessageHandler;`is_active` 决定立即/跟随。
- `channels/message.py`:`MediaItem`(惰性 data_fetcher)、`ChannelMessage`。
- `hook_impl.build_prompt`:把 media 经 `get_url` 转多模态;`intent_detection` 从 JSON content 取 "message"。
- `agent/settings.py`:`TelegramSettings`(token/白名单/代理)。

---

## 一句话总结

`TelegramChannel` 把 Telegram 接进 Creamy:长轮询收消息、私聊全收群聊按 @/回复过滤、把文本与各类媒体
(惰性下载、限 2MB)解析成统一消息交框架、turn 期间显示"正在输入"、回复经 send 推回。属去抖群聊渠道。
