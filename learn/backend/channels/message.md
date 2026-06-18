# `backend/channels/message.py` 精读(C 档·极详)

## 这个文件在干嘛

定义渠道与框架之间的**结构化消息** `ChannelMessage`(入站/出站都用它),以及媒体附件 `MediaItem`。
这是 `Envelope` 的"具体类形态"之一(另一种是裸 dict;框架用 `field_of`/`content_of` 兼容两者)。

> `hook_impl` 的 `build_prompt`/`render_outbound`、`agent` 的 `ToolContext`、各渠道适配器都围着它转。
> 理解它的字段 = 理解一条消息在 Creamy 里携带哪些信息。

---

## 顶部:导入与类型别名

> **整块作用**:导入 + 定义两个 Literal 类型别名(消息种类、媒体种类)。

```python
from __future__ import annotations
import base64
#   MediaItem.get_url 把二进制数据编码成 data: URL 时用。
import contextlib
#   lifespan 字段的类型是异步上下文管理器。
from collections.abc import Awaitable, Callable
#   data_fetcher 的类型(返回 awaitable 的可调用)。
from dataclasses import dataclass, field, replace
#   定义数据类;field 处理可变默认值;replace 在 from_batch 里"复制并改字段"。
from typing import Any, Literal

type MessageKind = Literal["error", "normal", "command"]
#   消息种类:错误 / 普通 / 命令。影响渲染与是否走库存逻辑。
type MediaType = Literal["image", "audio", "video", "document"]
#   媒体种类。
```

---

## `MediaItem`:媒体附件

> **整块作用**:表示一个附件(图片/音频/…)。提供 `get_url`:有 URL 直接用,否则用 data_fetcher 拉取
> 二进制并编码成 data: URL。

```python
@dataclass
class MediaItem:
    """A media attachment on a channel message."""
    type: MediaType
    #   媒体种类。
    mime_type: str
    #   MIME 类型(如 image/png),拼 data URL 用。
    filename: str | None = None
    #   原文件名(可空)。
    url: str | None = None
    #   直接可用的 URL(可空)。
    data_fetcher: Callable[[], Awaitable[bytes]] | None = None
    #   惰性取数据的回调(可空)。某些渠道不直接给 URL,而是给一个"按需下载"的函数。

    async def get_url(self) -> str | None:
        """Get a URL for the media, fetching data if necessary."""
        if self.url:
            return self.url
            #   有现成 URL 直接返回。
        if self.data_fetcher is not None:
            data = await self.data_fetcher()
            #   否则调 fetcher 拿到二进制。
            return f"data:{self.mime_type};base64,{base64.b64encode(data).decode('utf-8')}"
            #   编码成 data:<mime>;base64,<...> 形式(可直接塞进 OpenAI 多模态 image_url)。
        return None
        #   两者都没有 → None(build_prompt 会跳过它)。
```

- `hook_impl.build_prompt` 正是调 `await item.get_url()` 把图片转成多模态块。

---

## `ChannelMessage`:核心消息结构

> **整块作用**:承载一条消息的全部信息——会话/渠道/内容/媒体/上下文/生命周期/输出渠道等。

```python
@dataclass
class ChannelMessage:
    """Structured message data from channels to framework."""
    session_id: str
    #   会话主键(贯穿状态、tape、流式路由)。
    channel: str
    #   来源渠道名(cli/web/telegram/feishu)。
    content: str
    #   消息正文。
    chat_id: str = "default"
    #   会话/群标识(同一渠道下区分不同聊天)。
    is_active: bool = False
    #   是否"主动消息"(@机器人/私聊)。BufferedMessageHandler 用它区分"立即处理 vs 跟随消息"。
    kind: MessageKind = "normal"
    #   消息种类(normal/command/error)。"/" 命令会被设成 command。
    context: dict[str, Any] = field(default_factory=dict)
    #   附加上下文(会被拼进 prompt 的 context_str)。
    media: list[MediaItem] = field(default_factory=list)
    #   媒体附件列表。
    lifespan: contextlib.AbstractAsyncContextManager | None = None
    #   可选的"turn 生命周期"上下文管理器:load_state 进入、save_state 退出(让渠道在 turn 期间持有资源)。
    output_channel: str = ""
    #   指定回复走哪个渠道(默认同来源渠道,见 __post_init__)。
```

> **整块作用(__post_init__)**:构造后自动补两件事——把 channel/chat_id 写进 context;输出渠道默认=来源渠道。

```python
    def __post_init__(self) -> None:
        self.context.update({"channel": "$" + self.channel, "chat_id": self.chat_id})
        #   往 context 里塞 channel(加 "$" 前缀,作为提示里的标记)和 chat_id —— 让模型/提示能感知来源。
        if not self.output_channel:  # output to the same channel by default
            self.output_channel = self.channel
            #   没显式指定输出渠道 → 回到来源渠道。
```

> **整块作用(context_str)**:把 context 拼成 "k=v|k=v" 字符串,供 build_prompt 当前缀。

```python
    @property
    def context_str(self) -> str:
        """String representation of the context for prompt building."""
        return "|".join(f"{key}={value}" for key, value in self.context.items())
        #   如 "channel=$telegram|chat_id=123"。hook_impl.build_prompt 把它拼到正文前。
```

> **整块作用(from_batch)**:把一批消息合并成一条(去抖批处理时用)——内容换行拼接、媒体合并、其余沿用
> 最后一条。

```python
    @classmethod
    def from_batch(cls, batch: list[ChannelMessage]) -> ChannelMessage:
        """Create a single message by combining a batch of messages."""
        if not batch:
            raise ValueError("Batch cannot be empty")
            #   空批次非法。
        template = batch[-1]
        #   以最后一条为模板(取它的 session/channel/chat_id 等)。
        content = "\n".join(message.content for message in batch)
        #   所有正文换行拼接。
        media = [item for message in batch for item in message.media]
        #   所有媒体合并。
        return replace(template, content=content, media=media)
        #   复制模板、只改 content/media —— 得到合并后的单条消息。BufferedMessageHandler._process 用它。
```

---

## 怎么和别的文件连起来

- `channels/handler.py`:`BufferedMessageHandler` 用 `is_active`/`content.startswith("/")` 决策,用
  `from_batch` 合并。
- `hook_impl.py`:`build_prompt` 用 `content_of`/`context_str`/`media`+`MediaItem.get_url`;
  `render_outbound` 造 `ChannelMessage`。
- `channels/manager.py`:`dispatch_output` 把通用 Envelope 转成 `ChannelMessage` 再 `channel.send`。

---

## 一句话总结

`ChannelMessage` 是消息在 Creamy 内的统一结构:带会话/渠道/内容/媒体/上下文/生命周期/输出渠道;
`MediaItem` 处理附件(含惰性转 data URL);`from_batch` 支持群聊去抖合并。
