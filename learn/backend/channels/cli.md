# `backend/channels/cli.py` 精读(C 档·极详)

## 这个文件在干嘛

**交互式 CLI 渠道 `CliChannel`**:`creamy cli` 的终端界面。默认是 **prompt_toolkit 全屏 TUI**(可在应用内
滚动、resize 不留残影);设 `CREAMY_SIMPLE=1` 则退化为**简单行式 REPL**(用终端原生滚动)。它继承
`Channel`,把用户在终端的输入变成 `ChannelMessage` 交给框架,并用 `CliRenderer` 渲染回复与流式打字。

> 它与其它渠道不同:**直接持有 `agent`**(由 `provide_channels` 注入),且在 "all" 渠道里被排除(它是
> 前台交互终端,不该和后台 gateway 渠道混跑)。流式输出经 `stream_events` 实时刷到屏幕。

结构:
- TUI 内部辅助类:`_ScrollableWindow`(鼠标滚轮)、`_HistoryPane`(可滚动历史视口)。
- `CliChannel`:生命周期(start/stop/send)、输入处理、两种界面(`_run_tui` / `_run_simple`)、TUI 片段渲染、helper。

---

## 顶部:导入与常量

> **整块作用**:导入 prompt_toolkit(TUI 全套)、rich、agent/渠道/渲染器等;定义滚轮步长与两个配色常量。

```python
import asyncio
import contextlib
import os
from collections.abc import AsyncGenerator, AsyncIterable
from datetime import datetime
from hashlib import md5            # 用工作区路径算 hash 作历史文件名
from pathlib import Path

from prompt_toolkit import PromptSession                 # 简单 REPL 的会话
from prompt_toolkit.application import Application        # 全屏 TUI 应用
from prompt_toolkit.buffer import Buffer                 # 输入缓冲
from prompt_toolkit.completion import WordCompleter      # 工具名自动补全
from prompt_toolkit.filters import Condition             # 动态条件(鼠标开关)
from prompt_toolkit.formatted_text import ANSI, FormattedText, to_formatted_text  # 富文本片段
from prompt_toolkit.history import FileHistory           # 输入历史落盘
from prompt_toolkit.key_binding import KeyBindings       # 快捷键
from prompt_toolkit.layout import Layout
from prompt_toolkit.layout.containers import HSplit, VSplit, Window  # 布局容器
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.scrollable_pane import ScrollablePane     # 可滚动面板
from prompt_toolkit.mouse_events import MouseEvent, MouseEventType   # 鼠标事件
from prompt_toolkit.styles import Style
from prompt_toolkit.utils import get_cwidth              # 计算字符显示宽度(背景填充对齐)
from rich import get_console
from rich.live import Live

from backend.agent.agent import Agent
from backend.channels.base import Channel
from backend.channels.message import ChannelMessage
from backend.channels.renderer import CliRenderer        # 终端渲染(见 renderer.md)
from backend.core.events import StreamEvent
from backend.memory.tape import TapeInfo                 # tape 统计信息(状态栏显示 token 等)
from backend.tools.tools import REGISTRY                 # 工具表(补全用)
from backend.utils.envelope import field_of
from backend.utils.types import MessageHandler

Fragments = list[tuple[str, str]]
#   类型别名:prompt_toolkit 的"富文本片段列表"——每项是 (样式, 文本)。

WHEEL_STEP = 3
#   鼠标滚轮一格滚动 3 行历史。
ECHO_BG = "#3a3a3a"
#   回显用户输入那行的背景色(深灰,与模型输出区分)。
PREFIX_FG = "#d0d0d0"
#   cwd 前缀的前景色(灰白)。
```

---

## TUI 辅助类

> **整块作用(_ScrollableWindow)**:一个把鼠标滚轮事件转成"滚动回调"的历史 Window。

```python
class _ScrollableWindow(Window):
    """Inner history ``Window`` that routes mouse-wheel scroll through a callback."""

    def __init__(self, *args, on_scroll, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._on_scroll = on_scroll
        #   保存滚动回调(滚轮上下时调它移动视口)。

    def _mouse_handler(self, mouse_event: MouseEvent):
        if mouse_event.event_type == MouseEventType.SCROLL_UP:
            self._on_scroll(-WHEEL_STEP)
            return None
            #   滚轮向上 → 回调 -3(往历史上方滚)。
        if mouse_event.event_type == MouseEventType.SCROLL_DOWN:
            self._on_scroll(WHEEL_STEP)
            return None
            #   滚轮向下 → 回调 +3。
        return super()._mouse_handler(mouse_event)
        #   其它鼠标事件交给基类。
```

> **整块作用(_HistoryPane)**:可真正滚动只读历史的视口。普通 Window 会把 scroll 强制归零,故用
> ScrollablePane(离屏渲染再切片),并自己钳制滚动量、支持"跟随底部"。

```python
class _HistoryPane(ScrollablePane):
    """Scrollable viewport for the conversation history. ...(docstring 解释为何不能用普通 Window)..."""

    def __init__(self, content, follow) -> None:
        super().__init__(
            content,
            keep_cursor_visible=False,          # 关闭"保持光标可见"自动滚(光标在输入框,不在本面板)
            keep_focused_window_visible=False,  # 关闭"保持焦点窗口可见"自动滚
            show_scrollbar=True,                # 显示滚动条
            height=Dimension(weight=1),         # 占据 HSplit 留给它的空间
        )
        self._follow = follow
        #   一个返回 bool 的回调:是否"跟随底部"(实时输出时钉在最底)。
        self.max_scroll = 0
        #   可滚动的最大量(每次渲染算)。
        self.visible_height = 0
        #   可视高度(翻页步长用)。
        self.content_width = 0
        #   内容宽度(回显背景填充用)。

    def write_to_screen(self, screen, mouse_handlers, write_position, parent_style, erase_bg, z_index) -> None:
        virtual_width = write_position.width - (1 if self.show_scrollbar() else 0)
        #   去掉滚动条占的 1 列,得到内容可用宽度。
        virtual_height = self.content.preferred_height(virtual_width, self.max_available_height).preferred
        #   内容实际想要的高度。
        virtual_height = max(virtual_height, write_position.height)
        #   不小于视口高。
        virtual_height = min(virtual_height, self.max_available_height)
        #   不超过最大可用高。
        self.visible_height = write_position.height
        #   记录可视高。
        self.content_width = virtual_width
        #   记录内容宽。
        self.max_scroll = max(0, virtual_height - write_position.height)
        #   最大滚动量 = 内容高 - 视口高。
        if self._follow():
            self.vertical_scroll = self.max_scroll
            #   跟随底部:滚到最底(实时输出时一直显示最新)。
        else:
            self.vertical_scroll = max(0, min(self.vertical_scroll, self.max_scroll))
            #   否则把当前滚动量钳制在 [0, max] 内。
        super().write_to_screen(screen, mouse_handlers, write_position, parent_style, erase_bg, z_index)
        #   交给基类真正绘制。
```

---

## `CliChannel`:构造

> **整块作用**:保存 on_receive/agent,建消息模板与各 TUI 状态(模式、缓冲、历史行、跟随底部、鼠标捕获)。

```python
class CliChannel(Channel):
    """Interactive CLI channel. ...(默认全屏 TUI;CREAMY_SIMPLE=1 用简单 REPL)..."""

    name = "cli"
    _stop_event: asyncio.Event

    def __init__(self, on_receive: MessageHandler, agent: Agent) -> None:
        self._on_receive = on_receive
        #   入站回调(manager.on_receive)。
        self._agent = agent
        #   直接持有 agent(CLI 直驱;也用它取 tape 信息/设置)。
        self._message_template = {"chat_id": "cli_chat", "channel": self.name, "session_id": "cli_session"}
        #   CLI 消息的固定身份模板(单用户终端,固定会话)。
        self._mode = "auto"  # or "shell"
        #   输入模式:auto(普通对话)/ shell(每行当命令)。Ctrl-X 切换。
        self._main_task: asyncio.Task | None = None
        #   主循环任务句柄。
        self._renderer = CliRenderer(get_console())
        #   终端渲染器(见 renderer.md)。
        self._last_tape_info: TapeInfo | None = None
        #   最近一次 tape 统计(状态栏显示)。
        self._workspace = self._agent.framework.workspace
        #   工作区路径。
        # Full-screen TUI state.
        self._tui = False                 # 当前是否处于全屏 TUI 模式
        self._tui_app: Application | None = None   # TUI 应用
        self._tui_buffer: Buffer | None = None     # 输入缓冲
        self._tui_history_pane: _HistoryPane | None = None  # 历史视口
        self._tui_lines: list[Fragments] = []      # 历史内容(每条是片段列表)
        self._tui_stream_idx: int | None = None    # 当前流式输出写到历史的哪一行
        self._follow_bottom = True                 # 是否跟随底部
        self._mouse_capture = True                 # 鼠标捕获:默认开(滚轮滚动);Ctrl-T 关(改原生选择/复制)
```

---

## 生命周期:start / stop / send

> **整块作用**:start 起主循环任务;stop 取消它;send 只处理"错误消息"(把错误显示到界面)。

```python
    async def _refresh_tape_info(self) -> None:
        tape = self._agent.tapes.session_tape(self._message_template["session_id"], self._workspace)
        info = await self._agent.tapes.info(tape.name)
        self._last_tape_info = info
        #   取当前会话 tape 的统计信息(token 等),供状态栏显示。

    def set_metadata(self, session_id: str | None = None, chat_id: str | None = None) -> None:
        if session_id is not None:
            self._message_template["session_id"] = session_id
        if chat_id is not None:
            self._message_template["chat_id"] = chat_id
        #   允许外部(cli 命令)改会话/聊天 id。

    async def start(self, stop_event: asyncio.Event) -> None:
        self._stop_event = stop_event
        #   保存停止信号。
        self._main_task = asyncio.create_task(self._main_loop())
        #   起主循环(TUI 或简单 REPL)。

    async def stop(self) -> None:
        if self._main_task is not None:
            self._main_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._main_task
                #   取消主循环并等其结束。

    async def send(self, message: ChannelMessage) -> None:
        if message.kind != "error":
            return
            #   CLI 的正常回复经 stream_events 实时渲染了,这里只额外处理"错误"消息。
        if self._tui:
            self._tui_lines.append(self._tui_message_fragments("error", message.content))
            self._tui_refresh()
            return
            #   TUI 模式:把错误作为一行追加进历史并刷新。
        self._renderer.error(message.content)
        #   简单模式:直接渲染错误面板。

    async def _main_loop(self) -> None:
        if os.getenv("CREAMY_SIMPLE"):
            await self._run_simple()
            #   设了 CREAMY_SIMPLE → 简单 REPL。
        else:
            await self._run_tui()
            #   默认 → 全屏 TUI。
```

> **整块作用(message_lifespan)**:作为 ChannelMessage.lifespan 传入。turn 结束(__aexit__)时刷新 tape 统计、
> 置完成事件、刷新 TUI。

```python
    @contextlib.asynccontextmanager
    async def message_lifespan(self, request_completed: asyncio.Event) -> AsyncGenerator[None, None]:
        try:
            yield
            #   turn 期间(load_state __aenter__ ~ save_state __aexit__)什么都不做。
        finally:
            await self._refresh_tape_info()
            #   turn 收尾:刷新 tape 统计(token 变了)。
            request_completed.set()
            #   通知"本次请求完成"(简单 REPL 用它等待)。
            if self._tui:
                self._tui_refresh()
                #   TUI 模式刷新一次界面。
```

---

## 输入归一与提示样式

> **整块作用**:shell 模式下把输入加 "/" 前缀变成命令;按模式给提示符样式与状态栏文本。

```python
    def _normalize_input(self, raw: str) -> str:
        if self._mode != "shell":
            return raw
            #   auto 模式:原样。
        if raw.startswith("/"):
            return raw
            #   已是命令就不动。
        return f"/{raw}"
        #   shell 模式:补 "/" 使其被当成命令执行。

    def _prompt_styles(self) -> tuple[str, str]:
        if self._mode == "auto":
            return "fg:ansimagenta bold", "› "
            #   auto:洋红 "› "。
        return "fg:ansiyellow bold", "» "
        #   shell:黄色 "» "。

    def _status_text(self) -> str:
        info = self._last_tape_info
        now = datetime.now().strftime("%H:%M")
        session = field_of(info, "name", None) or self._message_template["session_id"]
        #   会话名:优先用 tape info 的 name。
        session = session.split("__")[-1]  # tape name is <workspace_hash>__<session_hash>
        #   tape 名形如 <工作区hash>__<会话hash>,取后半段显示更短。
        parts = [
            now,                                                       # 时间
            f"model:{self._agent.settings.model}",                    # 模型
            f"mode:{self._mode}",                                     # 模式
            f"mouse:{'scroll' if self._mouse_capture else 'select'}", # 鼠标模式
            f"session:{session}",                                    # 会话
        ]
        return "  ·  ".join(parts)
        #   拼成状态栏文本。
```

---

## 流式渲染:stream_events

> **整块作用**:被 manager.wrap_stream 调。TUI 模式委托 `_stream_events_tui`;简单模式用 rich Live 边收边刷
> (start/update/finish_stream)。

```python
    async def stream_events(self, message: ChannelMessage, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]:
        if self._tui:
            async for event in self._stream_events_tui(message, stream):
                yield event
            return
            #   TUI 模式:走 TUI 版流式渲染。
        live: Live | None = None
        text = ""
        try:
            async for event in stream:
                if event.kind == "text":
                    content = str(event.data.get("delta", ""))
                    if not content.strip() and not text:
                        continue  # skip leading whitespace-only events
                        #   跳过开头只有空白的事件(避免空打字框)。
                    if live is None:
                        live = self._renderer.start_stream(message.kind)
                        #   首个有效文本 → 启动 Live 打字区。
                    text += content
                    self._renderer.update_stream(live, kind=message.kind, text=text)
                    #   累积并刷新尾部。
                yield event
                #   原样透传(framework 也在消费这条流)。
        finally:
            if live is not None:
                self._renderer.finish_stream(live, kind=message.kind, text=text)
                #   收尾:擦临时区、正式打印完整回复一次。
```

---

## 全屏 TUI:_run_tui ⭐

> **整块作用**:搭建全屏界面(历史区 + 分隔线 + 输入行 + 状态栏),绑定快捷键,运行应用直到退出。

```python
    async def _run_tui(self) -> None:
        from backend.observability.logging import disable_console_logging
        # Logs to stderr would corrupt the full-screen TUI; keep them in the file sink only.
        disable_console_logging()
        #   关掉控制台日志(否则 stderr 日志会冲乱全屏界面;日志仍写文件)。
        self._tui = True
        await self._refresh_tape_info()
        #   标记 TUI 模式并取初始 tape 统计。

        self._tui_buffer = Buffer(
            completer=self._tool_completer(),   # 工具名补全
            complete_while_typing=True,         # 边打边补
            history=self._file_history(),       # 输入历史(落盘)
            multiline=False,                    # 单行输入
        )
        self._tui_lines.append(self._tui_welcome_fragments())
        #   历史首行 = 欢迎面板(渲成 ANSI 折进来)。

        kb = KeyBindings()
        #   定义快捷键:

        @kb.add("c-x", eager=True)
        def _toggle(event) -> None:
            self._mode = "shell" if self._mode == "auto" else "auto"
            event.app.invalidate()
            #   Ctrl-X:切 auto/shell 模式并重绘。

        @kb.add("c-t", eager=True)
        def _toggle_mouse(event) -> None:
            self._mouse_capture = not self._mouse_capture
            event.app.invalidate()
            #   Ctrl-T:切鼠标捕获(滚动 ↔ 原生选择复制)。

        @kb.add("c-c")
        def _ctrl_c(event) -> None:
            event.app.exit()
            #   Ctrl-C:退出。

        @kb.add("c-d")
        def _ctrl_d(event) -> None:
            if self._tui_buffer is not None and not self._tui_buffer.text:
                event.app.exit()
                #   Ctrl-D 且输入为空:退出(否则 Ctrl-D 不退,避免误删)。

        @kb.add("enter")
        def _enter(event) -> None:
            self._tui_accept()
            #   回车:提交输入。

        @kb.add("pageup")
        def _pageup(event) -> None:
            self._scroll(-self._page())
            #   PgUp:上滚一页。

        @kb.add("pagedown")
        def _pagedown(event) -> None:
            self._scroll(self._page())
            #   PgDn:下滚一页。

        input_window = Window(BufferControl(buffer=self._tui_buffer), height=1, wrap_lines=False)
        #   输入窗口(1 行)。
        history_window = _ScrollableWindow(
            FormattedTextControl(self._tui_history_text, focusable=False),  # 只读历史内容
            wrap_lines=True,
            on_scroll=self._scroll,                                        # 滚轮回调
        )
        self._tui_history_pane = _HistoryPane(history_window, follow=lambda: self._follow_bottom)
        #   历史视口(可滚动、跟随底部)。
        root = HSplit([
            self._tui_history_pane,                                        # 历史区
            Window(char="─", style="fg:#a8a8a8", height=1),               # 分隔线
            VSplit([
                Window(FormattedTextControl(self._tui_line_prefix), dont_extend_width=True, height=1),  # cwd+提示符
                input_window,                                             # 输入框
            ]),
            VSplit([
                Window(FormattedTextControl(self._tui_status_fragments), dont_extend_width=True, height=1),  # 状态栏
                Window(char="─", style="fg:#a8a8a8", height=1),
            ]),
            Window(height=2),  # spacer below the status bar
            #   状态栏下方留 2 行空白,把它抬离终端底边。
        ])
        self._tui_app = Application(
            layout=Layout(root, focused_element=input_window),  # 焦点在输入框
            key_bindings=kb,
            full_screen=True,
            mouse_support=Condition(lambda: self._mouse_capture),  # 鼠标支持随开关动态变化
        )
        self._tui_refresh()
        try:
            await self._tui_app.run_async()
            #   运行 TUI 直到退出。
        finally:
            self._stop_event.set()
            #   退出后置停止信号(让 manager 等优雅收尾)。
```

> **整块作用(_tui_accept)**:回车提交——回显输入、处理 /quit、把消息 fire-and-forget 交给框架。

```python
    def _tui_accept(self) -> None:
        buff = self._tui_buffer
        if buff is None:
            return
        text = (buff.text or "").strip()
        if text:
            buff.append_to_history()
            #   非空就存进输入历史。
        buff.reset()
        #   清空输入框。
        if not text:
            return
            #   空输入不处理。
        if text in {"/quit", "/exit"}:
            if self._tui_app is not None:
                self._tui_app.exit()
            return
            #   退出命令。
        self._tui_lines.append(self._tui_echo_fragments(text))
        #   把用户输入回显进历史(灰底行)。
        self._tui_stream_idx = None
        #   重置"流式写到哪行"。
        self._follow_bottom = True
        #   新输入 → 跟随底部。
        request = self._normalize_input(text)
        #   shell 模式补 "/"。
        message = ChannelMessage(
            session_id=self._message_template["session_id"],
            channel=self._message_template["channel"],
            chat_id=self._message_template["chat_id"],
            content=request,
            lifespan=self.message_lifespan(asyncio.Event()),  # 带生命周期(turn 后刷 tape/界面)
        )
        asyncio.create_task(self._on_receive(message))  # noqa: RUF006 - fire-and-forget TUI input dispatch
        #   异步提交(不阻塞 UI;turn 在后台跑,流式事件经 stream_events 回灌界面)。
        self._tui_refresh()
```

> **整块作用(_stream_events_tui)**:TUI 版流式——把增量写到历史里"同一行"(首次追加、后续就地更新),
> 实现打字机效果。

```python
    async def _stream_events_tui(self, message: ChannelMessage, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]:
        text = ""
        idx: int | None = None
        #   该回复在历史里的行索引(首次为 None)。
        async for event in stream:
            if event.kind == "text":
                content = str(event.data.get("delta", ""))
                if not content.strip() and not text:
                    yield event
                    continue
                    #   跳过开头空白。
                text += content
                frags = self._tui_message_fragments(message.kind, text)
                #   把累积文本渲成片段(带 🍦 前缀)。
                if idx is None:
                    self._tui_lines.append(frags)
                    idx = len(self._tui_lines) - 1
                    #   首次:追加为新一行,记下索引。
                else:
                    self._tui_lines[idx] = frags
                    #   后续:就地替换该行(打字机增长)。
                self._tui_refresh()
            yield event
```

---

## 滚动与刷新 / 片段渲染

> **整块作用**:翻页步长、滚动(含"滚到底重新跟随")、请求重绘。

```python
    def _page(self) -> int:
        pane = self._tui_history_pane
        if pane is not None and pane.visible_height:
            return max(1, pane.visible_height - 1)
            #   一页 = 可视高 - 1(留一行重叠,便于连读)。
        return 10
        #   兜底 10 行。

    def _scroll(self, delta: int) -> None:
        pane = self._tui_history_pane
        if pane is None:
            return
        new = pane.vertical_scroll + delta
        if new >= pane.max_scroll:
            new = pane.max_scroll
            self._follow_bottom = True
            #   滚到底 → 重新进入"跟随底部"。
        else:
            self._follow_bottom = False
            #   往上滚 → 脱离跟随(停在用户看的位置)。
        pane.vertical_scroll = max(0, new)
        if self._tui_app is not None:
            self._tui_app.invalidate()
            #   重绘。

    def _tui_refresh(self) -> None:
        app = self._tui_app
        if app is not None and app.is_running:
            app.invalidate()
            #   请求重绘(跟随底部的钉位在 _HistoryPane.write_to_screen 里做)。
```

> **整块作用**:把历史/前缀/状态栏/回显/消息/欢迎,各渲染成片段列表。

```python
    def _tui_history_text(self) -> Fragments:
        out: Fragments = []
        for i, block in enumerate(self._tui_lines):
            if i:
                out.append(("", "\n\n"))
                #   行间空一行。
            out.extend(block)
        return out
        #   把所有历史行拼成一个大片段列表。

    def _tui_line_prefix(self) -> Fragments:
        symbol_style, symbol = self._prompt_styles()
        return [(f"fg:{PREFIX_FG}", f"{Path.cwd().name} "), (symbol_style, symbol)]
        #   输入行前缀:cwd 目录名 + 提示符。

    def _tui_status_fragments(self) -> Fragments:
        return [("fg:#a8a8a8", "─ "), ("fg:ansimagenta", self._status_text()), ("fg:#a8a8a8", " ")]
        #   状态栏:横线 + 洋红状态文本。

    def _tui_echo_fragments(self, text: str) -> Fragments:
        # Echo the user's own input on a gray-background line ...
        symbol_style, symbol = self._prompt_styles()
        bg = f"bg:{ECHO_BG}"
        prefix = f"{Path.cwd().name} "
        frags: Fragments = [
            (f"fg:{PREFIX_FG} {bg}", prefix),   # 前缀(灰白字+灰底)
            (f"{symbol_style} {bg}", symbol),   # 提示符
            (bg, text),                         # 输入文本
        ]
        width = self._tui_history_pane.content_width if self._tui_history_pane else 0
        if width:
            used = get_cwidth(prefix) + get_cwidth(symbol) + get_cwidth(text)
            #   已用显示宽度。
            remainder = used % width
            pad = width - remainder if remainder else 0
            #   算需要补多少空格,让灰底填满整行(含换行后的最后一行)。
            if pad:
                frags.append((bg, " " * pad))
        return frags

    def _tui_message_fragments(self, kind: str, text: str) -> Fragments:
        if kind == "error":
            return [("bold ansired", "✖ "), ("ansired", text)]
            #   错误:红色 ✖。
        if kind == "command":
            return [("bold ansigreen", "$ "), ("ansigreen", text)]
            #   命令:绿色 $。
        lines = text.split("\n")
        frags: Fragments = [("", "🍦 "), ("", lines[0])]
        for line in lines[1:]:
            frags.append(("", "\n   " + line))
            #   普通回复:🍦 前缀 + 续行缩进 3 空格。
        return frags

    def _tui_welcome_fragments(self) -> Fragments:
        # Render the rich welcome panel to ANSI and fold it into the history ...
        width = max(20, get_console().width - 1)
        #   宽度 = 终端宽 - 1(给滚动条留列)。
        ansi = self._renderer.welcome_ansi(model=self._agent.settings.model, workspace=str(self._workspace), width=width)
        #   渲染欢迎面板为 ANSI 字符串(renderer.welcome_ansi)。
        return list(to_formatted_text(ANSI(ansi.rstrip("\n"))))  # type: ignore[arg-type]
        #   ANSI → prompt_toolkit 片段(全屏应用不能直接 print,必须折成片段进历史)。
```

---

## 简单 REPL(CREAMY_SIMPLE)

> **整块作用**:行式 REPL——打印欢迎、循环读输入、提交消息、等待完成。用终端原生滚动。

```python
    async def _run_simple(self) -> None:
        self._prompt = self._build_prompt(self._workspace)
        #   建 PromptSession。
        self._renderer.welcome(model=self._agent.settings.model, workspace=str(self._workspace))
        #   打印欢迎面板。
        await self._refresh_tape_info()
        request_completed = asyncio.Event()
        #   "本次请求完成"事件(同步等待用)。

        while not self._stop_event.is_set():
            try:
                raw = (await self._prompt.prompt_async(self._prompt_message)).strip()
                #   异步读一行输入。
            except KeyboardInterrupt:
                self._renderer.info("Interrupted. Use '/quit' to exit.")
                continue
                #   Ctrl-C:提示,不退出。
            except EOFError:
                break
                #   Ctrl-D:退出循环。
            if not raw:
                continue
                #   空行跳过。
            if raw in {"/quit", "/exit"}:
                break
                #   退出命令。
            self._renderer.console.print()
            #   打个空行分隔。
            request = self._normalize_input(raw)
            message = ChannelMessage(
                session_id=self._message_template["session_id"],
                channel=self._message_template["channel"],
                chat_id=self._message_template["chat_id"],
                content=request,
                lifespan=self.message_lifespan(request_completed),
            )
            await self._on_receive(message)
            #   提交消息。
            await request_completed.wait()
            #   等本次 turn 完成(简单模式是"一问一答"同步节奏)。
            request_completed.clear()
            #   复位事件,准备下一轮。
        self._renderer.info("Bye.")
        self._stop_event.set()
        #   退出收尾。

    def _prompt_message(self) -> FormattedText:
        symbol_style, symbol = self._prompt_styles()
        return FormattedText([("fg:ansibrightblack", f"{Path.cwd().name} "), (symbol_style, symbol)])
        #   简单模式的提示符。

    def _render_bottom_toolbar(self) -> FormattedText:
        return FormattedText([("fg:ansibrightblack", f"  {self._status_text()}")])
        #   底部状态条。

    def _build_prompt(self, workspace: Path) -> PromptSession[str]:
        kb = KeyBindings()

        @kb.add("c-x", eager=True)
        def _toggle_mode(event) -> None:
            self._mode = "shell" if self._mode == "auto" else "auto"
            event.app.invalidate()
            #   Ctrl-X 切模式。

        return PromptSession(
            completer=self._tool_completer(),
            complete_while_typing=True,
            key_bindings=kb,
            history=self._file_history(),
            bottom_toolbar=self._render_bottom_toolbar,
            style=Style.from_dict({"bottom-toolbar": "noreverse bg:default"}),
        )
        #   构造 PromptSession(补全/历史/状态条/快捷键)。
```

---

## 共享 helper

> **整块作用**:工具名补全器、输入历史文件(按工作区 hash 分文件)。

```python
    def _tool_completer(self) -> WordCompleter:
        def _sort_key(tool_name: str) -> tuple[str, str]:
            section, _, name = tool_name.rpartition(".")
            return (section, name)
            #   按 "section.name" 排序(同类工具聚一起)。
        tool_names = sorted((f",{name}" for name in REGISTRY), key=_sort_key)
        #   工具名前加 ","(CLI 里以 "," 触发命令补全)。
        return WordCompleter(tool_names, ignore_case=True, sentence=True)
        #   大小写不敏感的整句补全。

    def _file_history(self) -> FileHistory:
        history_file = self._history_file(self._agent.settings.home, self._workspace)
        history_file.parent.mkdir(parents=True, exist_ok=True)
        return FileHistory(str(history_file))
        #   输入历史落盘(prompt_toolkit FileHistory)。

    @staticmethod
    def _history_file(home: Path, workspace: Path) -> Path:
        workspace_hash = md5(str(workspace).encode("utf-8"), usedforsecurity=False).hexdigest()
        #   用工作区路径算 md5(usedforsecurity=False:仅作文件名,不是安全用途)。
        return home / "history" / f"{workspace_hash}.history"
        #   每个工作区一个独立历史文件(~/.creamy/history/<hash>.history)。
```

---

## 怎么和别的文件连起来

- `channels/renderer.py`:所有终端渲染。
- `channels/manager.py`:`stream_events` 经 wrap_stream 调;CLI 在 "all" 渠道里被排除。
- `agent/agent.py`:CLI 直接持有 agent(取 tape info/settings;消息仍经框架管线)。
- `hook_impl.provide_channels`:实例化 `CliChannel(on_receive, agent=self.agent)`。

---

## 一句话总结

`CliChannel` 是 `creamy cli` 的终端界面:默认 prompt_toolkit 全屏 TUI(可滚历史、打字机流式、Ctrl-X 切
模式、Ctrl-T 切鼠标),`CREAMY_SIMPLE=1` 退化为行式 REPL。它把输入变 ChannelMessage 交框架,用
`CliRenderer` 渲染回复。
