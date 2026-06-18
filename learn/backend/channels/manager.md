# `backend/channels/manager.py` 精读(C 档·极详)

## 这个文件在干嘛

**渠道管理器 `ChannelManager`**:把"渠道层"与"框架 turn 管线"缝合起来。职责:
- 启动所有启用的渠道,收集它们的入站消息进一个队列;
- 按会话决定是否用去抖处理器(`on_receive`);
- 从队列取消息 → 调 `framework.process_inbound` 跑 turn(每条一个 task);
- 作为**出站路由**(`OutboundChannelRouter`)绑定到框架:`dispatch_output`(发出站)、`wrap_stream`
  (把模型流式事件包给渠道做实时输出)、`quit`(结束某会话);
- 管理在途 task 的生命周期与优雅关闭。

> 它是 `creamy gateway` / `creamy web` 的运行主体。`framework.bind_outbound_router(self)` 让框架的
> `_run_model` 流式分支能经 `wrap_stream` 把事件回灌到渠道——这就是 Web SSE / CLI 实时刷新的来路。

---

## 构造

> **整块作用**:拿到所有渠道、读渠道配置、决定流式开关与启用列表,初始化消息队列与任务/处理器表。

```python
class ChannelManager:
    def __init__(self, framework: CreamyFramework, enabled_channels: Collection[str] | None = None, stream_output: bool | None = None) -> None:
        self.framework = framework
        #   框架引用(跑 turn、绑路由)。
        self._channels: dict[str, Channel] = self.framework.get_channels(self.on_receive)
        #   向框架要所有渠道(provide_channels 广播),并把本管理器的 on_receive 作为它们的入站回调。
        self._settings = ChannelSettings()
        #   渠道配置(去抖/窗口/流式等)。
        self._stream_output = stream_output if stream_output is not None else self._settings.stream_output
        #   是否流式:显式参数优先,否则用配置。决定 process_inbound 的 stream_output。
        if enabled_channels is not None:
            self._enabled_channels = list(enabled_channels)
            #   显式指定启用哪些渠道。
        else:
            self._enabled_channels = self._settings.enabled_channels.split(",")
            #   否则从配置("all" 或逗号分隔)解析。
        self._messages = asyncio.Queue[ChannelMessage]()
        #   入站消息队列:渠道把消息放进来,主循环取出来跑 turn。
        self._ongoing_tasks: dict[str, set[asyncio.Task]] = {}
        #   每会话在途 turn 任务集合(用于 quit/shutdown 取消)。
        self._session_handlers: dict[str, MessageHandler] = {}
        #   每会话的入站处理器(普通 put 或 BufferedMessageHandler),按需创建并缓存。
```

---

## `on_receive`:渠道收到消息的统一入口

> **整块作用**:据渠道是否需去抖,为该会话懒创建合适的处理器,再把消息交给它。

```python
    async def on_receive(self, message: ChannelMessage) -> None:
        """收到消息后，根据消息的 channel 和 session_id 找到对应的处理器，并调用处理器处理消息。"""
        channel = message.channel
        session_id = message.session_id
        if channel not in self._channels:
            logger.warning(f"Received message from unknown channel '{channel}', ignoring.")
            return
            #   未知渠道 → 忽略(防御)。
        if session_id not in self._session_handlers:
            #   该会话还没有处理器,按渠道特性创建:
            handler: MessageHandler
            if self._channels[channel].needs_debounce:
                handler = BufferedMessageHandler(
                    self._messages.put,
                    active_time_window=self._settings.active_time_window,
                    max_wait_seconds=self._settings.max_wait_seconds,
                    debounce_seconds=self._settings.debounce_seconds,
                )
                #   需去抖(群聊)→ 用 BufferedMessageHandler 包住"入队"。
            else:
                handler = self._messages.put
                #   不需去抖 → 直接"入队"。
            self._session_handlers[session_id] = handler
            #   缓存(同会话后续复用同一处理器,去抖状态才能跨消息累积)。
        await self._session_handlers[session_id](message)
        #   把消息交给该会话的处理器(最终都会把消息放进 _messages 队列)。
```

---

## 出站路由能力(被框架当 OutboundChannelRouter 用)

> **整块作用(dispatch_output)**:把一条通用 Envelope 转成 ChannelMessage,找到目标渠道并 send。

```python
    def get_channel(self, name: str) -> Channel | None:
        return self._channels.get(name)
        #   按名取渠道。

    async def dispatch_output(self, message: Envelope) -> bool:
        channel_name = field_of(message, "output_channel", field_of(message, "channel"))
        #   优先用 output_channel,退而用 channel。
        if channel_name is None:
            return False
            #   不知道发哪 → 失败。
        channel_key = str(channel_name)
        channel = self.get_channel(channel_key)
        if channel is None:
            return False
            #   目标渠道不存在 → 失败。
        outbound = ChannelMessage(
            session_id=str(field_of(message, "session_id", f"{channel_key}:default")),
            channel=channel_key,
            chat_id=str(field_of(message, "chat_id", "default")),
            content=content_of(message),
            context=field_of(message, "context", {}),
            kind=field_of(message, "kind", "normal"),
        )
        #   用防御式取值把 Envelope(可能是 dict 或 ChannelMessage)规整成一条 ChannelMessage。
        await channel.send(outbound)
        #   调渠道的 send 真正发出。
        return True
```

> **整块作用(wrap_stream)**:把模型输出事件流交给目标渠道的 stream_events 去"包装"(实现实时输出)。

```python
    def wrap_stream(self, message: Envelope, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]:
        channel_name = field_of(message, "output_channel", field_of(message, "channel"))
        if channel_name is None:
            return stream
            #   不知道渠道 → 原样返回(不包装)。
        channel_key = str(channel_name)
        channel = self.get_channel(channel_key)
        if channel is None:
            return stream
            #   渠道不存在 → 原样返回。
        return channel.stream_events(message, stream)
        #   交给渠道包装:Web 在此做 SSE 回灌、CLI 做实时渲染(见各渠道 stream_events)。
        #   framework._run_model 流式分支里的 self._outbound_router.wrap_stream(...) 就调到这。
```

> **整块作用(quit)**:取消某会话所有在途 turn 任务(如用户在 CLI 退出该会话)。

```python
    async def quit(self, session_id: str) -> None:
        tasks = self._ongoing_tasks.pop(session_id, set())
        #   取出并移除该会话的任务集合。
        for task in tasks:
            task.cancel()
            #   取消每个任务。
            with contextlib.suppress(asyncio.CancelledError):
                await task
                #   等它真正结束(吞掉 CancelledError)。
        logger.info(f"channel.manager quit session_id={session_id}, cancelled {len(tasks)} tasks")
```

---

## 启用渠道筛选 + 任务完成回调

> **整块作用(enabled_channels)**:按配置筛出要启动的渠道("all" 时排除 cli,避免它干扰其它渠道)。

```python
    def enabled_channels(self) -> list[Channel]:
        if "all" in self._enabled_channels:
            # Exclude 'cli' channel from 'all' to prevent interference with other channels
            return [channel for name, channel in self._channels.items() if name != "cli" and channel.enabled]
            #   "all":启用除 cli 外所有 enabled 的渠道(cli 是交互终端,不该在 gateway 模式混入)。
        return [channel for name, channel in self._channels.items() if name in self._enabled_channels and channel.enabled]
        #   否则:只启用列表里且 enabled 的。
```

> **整块作用(_on_task_done)**:turn 任务结束时清理记账,并触发异常日志。

```python
    def _on_task_done(self, session_id: str, task: asyncio.Task) -> None:
        task.exception()  # to log any exception
        #   读取异常(若任务抛了异常,这会让它被"检索",避免"task exception never retrieved"告警;
        #   也借此触发记录)。
        tasks = self._ongoing_tasks.get(session_id, set())
        tasks.discard(task)
        #   从该会话集合移除本任务。
        if not tasks:
            self._ongoing_tasks.pop(session_id, None)
            #   集合空了就删键。
```

---

## 主循环 `listen_and_run` ⭐

> **整块作用**:绑路由 → 启动各渠道 → 不断从队列取消息、为每条起一个 turn 任务并记账;收到停止信号
> 或异常时优雅关闭。

```python
    async def listen_and_run(self) -> None:
        stop_event = asyncio.Event()
        #   全局停止信号(传给各渠道 start)。
        self.framework.bind_outbound_router(self)
        #   ⭐ 把自己作为出站路由绑给框架——framework 由此能 dispatch_output / wrap_stream / quit。
        for channel in self.enabled_channels():
            await channel.start(stop_event)
            #   启动每个启用渠道(开始监听)。
        logger.info("channel.manager started listening")
        try:
            while True:
                message = await wait_until_stopped(self._messages.get(), stop_event)
                #   从队列取下一条消息;若 stop_event 触发则提前返回(优雅退出)。
                task = asyncio.create_task(self.framework.process_inbound(message, self._stream_output))
                #   ⭐ 为这条消息起一个 turn 任务(异步并发处理多会话)。
                task.add_done_callback(functools.partial(self._on_task_done, message.session_id))
                #   结束时清理记账。
                self._ongoing_tasks.setdefault(message.session_id, set()).add(task)
                #   记入该会话的在途任务集合。
        except asyncio.CancelledError:
            logger.info("channel.manager received shutdown signal")
            #   被取消(Ctrl-C 等)→ 正常进入收尾。
        except Exception:
            logger.exception("channel.manager error")
            raise
            #   其它异常:记录并重抛。
        finally:
            self.framework.bind_outbound_router(None)
            #   解绑路由。
            await self.shutdown()
            #   关闭所有任务与渠道。
            logger.info("channel.manager stopped")
```

> **整块作用(shutdown)**:取消所有在途 turn 任务,再停止所有渠道。

```python
    async def shutdown(self) -> None:
        count = 0
        for tasks in self._ongoing_tasks.values():
            for task in tasks:
                task.cancel()
                #   取消每个在途任务。
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                    #   等其结束(吞 CancelledError)。
                count += 1
        self._ongoing_tasks.clear()
        #   清空记账。
        logger.info(f"channel.manager cancelled {count} in-flight tasks")
        for channel in self.enabled_channels():
            await channel.stop()
            #   停止每个渠道(关服务/连接)。
```

---

## 怎么和别的文件连起来

- `app/framework.py`:`bind_outbound_router(self)` 后,`_run_model` 用 `wrap_stream`、`dispatch_via_router`
  用 `dispatch_output`、`quit_via_router` 用 `quit`。
- `channels/handler.py`:群聊渠道经 `BufferedMessageHandler` 缓冲。
- `channels/base.py`:用 `needs_debounce`/`enabled`/`start`/`stop`/`send`/`stream_events`。
- `cli/cli.py`:`gateway`/`web` 命令构造 ChannelManager 并 `listen_and_run`。

---

## 一句话总结

`ChannelManager` 是渠道与框架的"调度中枢":启动渠道、缓冲并入队入站消息、为每条消息并发跑 turn、作为
出站路由把回复/流式事件送回渠道,并负责优雅关闭。它让"多渠道、多会话"在同一条管线上有序运转。
