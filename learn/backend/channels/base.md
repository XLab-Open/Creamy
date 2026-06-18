# `backend/channels/base.py` 精读(C 档·极详)

## 这个文件在干嘛

定义**渠道抽象基类 `Channel`**。所有具体渠道(CLI/Web/Telegram/飞书)都继承它。它规定了渠道的最小
契约:`start`(开始监听)、`stop`(停止清理)是必须实现的;`send`(发消息)、`stream_events`(包装输出
流)、`needs_debounce`/`enabled`(行为开关)是可选覆盖的。

> "渠道共享同一条管线":不管哪个渠道,收到消息都调同一个 `on_receive` 把它送进 turn 管线;回复也经
> 同一套出站路由发回。`Channel` 抽象保证了这种一致性。

---

## 逐行精读

> **整块作用**:导入 + 定义抽象基类与其类级名字。

```python
import asyncio
#   start 接收 asyncio.Event 作为停止信号。
from abc import ABC, abstractmethod
#   ABC/abstractmethod:把 Channel 声明为抽象类,start/stop 为必须实现的抽象方法。
from collections.abc import AsyncIterable
#   stream_events 的流类型。
from typing import ClassVar
#   name 是"类变量"(每个子类一个固定值,不是实例属性)。

from backend.channels.message import ChannelMessage
#   send 的参数类型。
from backend.core.events import StreamEvent
#   stream_events 处理的事件类型。


class Channel(ABC):
    """Base class for all channels"""

    name: ClassVar[str] = "base"
    #   渠道名(类变量)。子类覆盖成 "cli"/"web"/"telegram"/"feishu"。
    #   管理器用它做注册/路由的键(get_channels 按 name 去重、dispatch 按 name 找渠道)。
```

> **整块作用**:两个必须实现的生命周期方法。

```python
    @abstractmethod
    async def start(self, stop_event: asyncio.Event) -> None:
        """Start listening for events and dispatching to handlers."""
        #   开始监听(如起 HTTP 服务、连 Telegram 长轮询)。stop_event 被 set 时应优雅退出。
        #   抽象方法:子类必须实现。

    @abstractmethod
    async def stop(self) -> None:
        """Stop the channel and clean up resources."""
        #   停止并清理资源(关服务、断连接)。子类必须实现。
```

> **整块作用**:两个行为开关属性(有默认值,子类按需覆盖)。

```python
    @property
    def needs_debounce(self) -> bool:
        """Whether this channel needs debounce to prevent overload. Default to False."""
        return False
        #   是否需要"去抖/批处理"(群聊里短时间多条消息合并成一次处理)。
        #   默认 False;Telegram/飞书这类群聊渠道会覆盖成 True(见 manager 用它选 BufferedMessageHandler)。

    @property
    def enabled(self) -> bool:
        """Whether this channel is enabled. Default to True."""
        return True
        #   是否启用。默认 True;某渠道可据配置(如缺 token)返回 False,manager 就不启动它。
```

> **整块作用**:两个可选能力——发消息、包装输出流。基类给空实现/透传。

```python
    async def send(self, message: ChannelMessage) -> None:
        """Send a message to the channel. Optional to implement."""
        # Do nothing by default
        return
        #   把一条出站消息发到该渠道。基类默认什么都不做(纯接收型渠道可不实现)。
        #   manager.dispatch_output 会调它。

    def stream_events(self, message: ChannelMessage, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]:
        """Optionally wrap the output stream for this channel."""
        return stream
        #   可选:包装模型的输出事件流(渠道借此把增量实时推给用户)。
        #   基类默认原样返回(不包装)。Web 渠道覆盖它做 SSE 回灌、CLI 覆盖它做实时渲染。
        #   framework._run_model 里的 outbound_router.wrap_stream → manager.wrap_stream → 这里。
```

---

## 怎么和别的文件连起来

- `channels/manager.py`:`needs_debounce` 决定是否用 BufferedMessageHandler;`enabled` 决定是否启动;
  `send` 被 dispatch_output 调;`stream_events` 被 wrap_stream 调。
- `channels/{cli,web,telegram,feishu}.py`:各自继承 Channel,覆盖相应方法。
- `hook_impl.provide_channels`:实例化四个渠道返回给框架。

---

## 一句话总结

`Channel` 是渠道契约:必须实现 start/stop;可选覆盖 send(发)/stream_events(流式包装)/needs_debounce/
enabled。它让"任意渠道都能以统一方式接进同一条 turn 管线"。
