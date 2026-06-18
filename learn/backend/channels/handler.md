# `backend/channels/handler.py` 精读(C 档·极详)

## 这个文件在干嘛

实现**带去抖与活跃窗口的缓冲消息处理器** `BufferedMessageHandler`。用于群聊类渠道(needs_debounce=True):
把短时间内的多条消息**攒成一批**再一次性处理,避免每条都触发一次模型调用;并用"活跃窗口"过滤掉
"机器人没被激活时的闲聊"。

> 它包在真正的处理器(把消息塞进 manager 队列的 `self._messages.put`)外面。manager 在 `on_receive` 里
> 据渠道的 `needs_debounce` 决定用不用它。

核心思路:
- **命令(`/`)**:立即处理,不缓冲。
- **主动消息(is_active,如 @机器人/私聊)**:记为活跃、攒入待处理、用短去抖等"还有没有后续";
- **跟随消息(非主动,但在活跃窗口内)**:也攒入,用较长的 max_wait 等;
- **活跃窗口外的非主动消息**:直接忽略(没人在跟机器人说话)。

---

## 构造

> **整块作用**:保存真实处理器与三个时间参数;初始化待处理缓冲、计时器、处理任务等内部状态。

```python
import asyncio
from loguru import logger
from backend.channels.message import ChannelMessage
from backend.utils.types import MessageHandler


class BufferedMessageHandler:
    """A message handler that buffers incoming messages and processes them in batch with debounce and active time window."""

    def __init__(self, handler: MessageHandler, *, active_time_window: float, max_wait_seconds: float, debounce_seconds: float) -> None:
        self._handler = handler
        #   真正的下游处理器(通常是 manager._messages.put:把合并后的消息入队)。
        self._pending_messages: list[ChannelMessage] = []
        #   待处理缓冲区(攒着,稍后 from_batch 合并)。
        self._last_active_time: float | None = None
        #   上次"主动消息"的时间戳(None 表示当前不在活跃态)。
        self._event = asyncio.Event()
        #   定时器到点时被 set,用于唤醒 _process。
        self._timer: asyncio.TimerHandle | None = None
        #   当前挂着的定时器句柄(可取消重置)。
        self._in_processing: asyncio.Task | None = None
        #   当前是否已有一个 _process 任务在等待处理(避免重复创建)。
        self._loop = asyncio.get_running_loop()
        #   当前事件循环(用 call_later 排定时器、用 loop.time 取单调时间)。

        self.active_time_window = active_time_window
        #   活跃窗口(秒):上次主动消息后这段时间内,跟随消息才被接纳。
        self.max_wait_seconds = max_wait_seconds
        #   跟随消息触发处理前的最大等待。
        self.debounce_seconds = debounce_seconds
        #   主动消息后的去抖等待(还在打字就再等等)。
```

---

## 计时器重置

> **整块作用**:清事件、取消旧定时器、排一个新的——到点把 `_event` set(唤醒 _process)。

```python
    def _reset_timer(self, timeout: float) -> None:
        self._event.clear()
        #   清掉"已到点"标志。
        if self._timer:
            self._timer.cancel()
            #   取消上一个定时器(实现"又来新消息就再等" = 去抖)。
        self._timer = self._loop.call_later(timeout, self._event.set)
        #   timeout 秒后把 _event set(届时 _process 的 await 返回,开始处理)。
```

---

## 处理一批

> **整块作用**:等定时器到点 → 把缓冲合并成一条 → 清缓冲/状态 → 交给下游处理器。

```python
    async def _process(self) -> None:
        await self._event.wait()
        #   阻塞直到 _reset_timer 设的定时器到点(期间若有新消息重置定时器,这里会继续等)。
        message = ChannelMessage.from_batch(self._pending_messages)
        #   把攒下的多条合并成一条(内容拼接、媒体合并)。
        self._pending_messages.clear()
        #   清空缓冲。
        self._in_processing = None
        #   标记"没有处理任务在跑了"。
        await self._handler(message)
        #   交给下游(入 manager 队列)。
```

---

## 入口 `__call__`:决策每条来消息怎么处理

> **整块作用**:这是渠道每收到一条消息就调的函数。按"命令/主动/跟随/忽略"四种情况分流。

```python
    async def __call__(self, message: ChannelMessage) -> None:
        now = self._loop.time()
        #   当前单调时间。
        if message.content.startswith("/"):
            logger.info("session.message received command session_id={}, content={}", message.session_id, message.content)
            await self._handler(message)
            return
            #   ① 命令:立即处理,不缓冲、不去抖(命令要即时)。

        if not message.is_active and (self._last_active_time is None or now - self._last_active_time > self.active_time_window):
            self._last_active_time = None
            logger.info("session.message received ignored session_id={}, content={}", message.session_id, message.content)
            return
            #   ② 非主动 且 不在活跃窗口内:忽略(没人在和机器人对话,群里的闲聊不打扰)。
            #      顺手把 last_active 清空(确认已脱离活跃态)。

        self._pending_messages.append(message)
        #   走到这里的消息(主动消息,或活跃窗口内的跟随消息)都先攒入缓冲。

        if message.is_active:
            self._last_active_time = now
            logger.info("session.message received active session_id={}, content={}", message.session_id, message.content)
            self._reset_timer(self.debounce_seconds)
            #   ③ 主动消息:刷新活跃时间;用"短去抖"等(用户可能还在连发)。
            if self._in_processing is None:
                self._in_processing = asyncio.create_task(self._process())
                #   若还没有处理任务,起一个(它会 await 定时器)。
        elif self._last_active_time is not None and self._in_processing is None:
            logger.info("session.receive followup session_id={} message={}", message.session_id, message.content)
            self._reset_timer(self.max_wait_seconds)
            self._in_processing = asyncio.create_task(self._process())
            #   ④ 跟随消息(活跃窗口内的非主动消息)且当前无处理任务:用"较长等待"起一个处理任务。
```

- **去抖的精髓**:每来一条(同批)消息就 `_reset_timer` 推迟触发;直到"安静"了 debounce/max_wait 秒,
  `_process` 才真正合并处理。这样"连发三条"只触发一次模型调用。

---

## 怎么和别的文件连起来

- `channels/manager.py`:`on_receive` 对 `needs_debounce=True` 的渠道用本类包裹 `self._messages.put`。
- `channels/message.py`:用 `is_active`/`content`/`from_batch`。
- 配置:三个时间参数来自 `ChannelSettings`(active_time_window/max_wait_seconds/debounce_seconds)。

---

## 一句话总结

`BufferedMessageHandler` 给群聊渠道做"去抖 + 活跃窗口"缓冲:命令立即处理;主动消息短去抖、跟随消息
长等待、窗口外忽略;到点把整批合并成一条再下发——把"连发多条"收敛成"一次处理"。
