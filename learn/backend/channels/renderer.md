# `backend/channels/renderer.py` 精读(C 档·极详)

## 这个文件在干嘛

**交互式 CLI 的终端渲染助手**(基于 `rich` 库)。`CliRenderer` 负责把欢迎面板、助手回复、命令输出、
错误、以及**流式打字效果**漂亮地画到终端。它是纯"展示层",被 `channels/cli.py` 的 TUI 调用。

> 这里有 Creamy 的冰淇淋 logo(🍦)、"CREAMY" 字块、欢迎面板布局。是你之前改前端品牌时对应的"终端版"。

---

## 顶部:导入与 ASCII 美术常量

> **整块作用**:导入 rich 组件;定义助手标记 emoji、冰淇淋 logo(球+蛋筒两色)、"CREAMY" 字块。
> 这些字符串是**美术数据**(整体讲解,不逐字符注释)。

```python
"""CLI rendering helpers."""
from __future__ import annotations
import os
#   读 USER 环境变量(欢迎语用)。
from dataclasses import dataclass
#   CliRenderer 用 dataclass(持有一个 console)。

from rich import box                 # 自定义边框样式(_SPLIT_BOX)
from rich.align import Align         # 居中对齐
from rich.cells import cell_len      # 计算字符显示宽度(emoji 占 2 列,缩进对齐用)
from rich.console import Console, Group  # 控制台 + 组合多个可渲染对象
from rich.live import Live           # 流式"实时刷新"区域(打字机效果)
from rich.panel import Panel         # 带边框面板
from rich.table import Table         # 表格/网格布局
from rich.text import Text           # 富文本

from backend.channels.message import MessageKind
#   消息种类(normal/command/error),决定面板标题与颜色。

ASSISTANT_MARKER = "🍦"
#   助手回复前缀:冰淇淋 emoji(本身带色,不另加样式)。

CREAMY_SCOOP = "\n".join(["▄███▄", "███████", "▝█████▘"])
#   冰淇淋"球"部分(三行块字符)。
CREAMY_CONE = "\n".join(["▜███▛", "▜█▛", "▀"])
#   冰淇淋"蛋筒"部分。
CREAMY_WORDMARK = "\n".join([
    "▄▀▀ █▀▄ █▀▀ ▄▀▄ █▄ ▄█ █ █",
    "█   █▀▄ █▀  █▀█ █▀█▀█  █ ",
    "▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀   ▀  ▀ ",
])
#   "CREAMY" 的块字母艺术字(欢迎面板右侧)。
```

---

## logo / 分隔框 / 版本号 工具

> **整块作用**:把球+蛋筒拼成双色 logo;定义"只画中间竖线"的边框;取简化版本号。

```python
def _creamy_logo() -> Text:
    logo = Text(justify="center")
    #   居中富文本。
    logo.append(CREAMY_SCOOP + "\n", style="bold magenta")
    #   球:洋红色。
    logo.append(CREAMY_CONE, style="bold yellow")
    #   蛋筒:黄色。
    return logo
    #   双色冰淇淋。

_SPLIT_BOX = box.Box("    \n  │ \n    \n  │ \n    \n    \n  │ \n    \n")
#   自定义边框:只在列之间画竖线 │,没有外框/横线。用于欢迎面板左右两栏之间的分隔。
#   (rich 的 Box 用一个 8 行模板字符串描述边框各部分,这里只填了竖线位。)

def _creamy_version() -> str:
    try:
        from backend._version import __version__
        #   读版本(见 _version.md)。
        return str(__version__).split("+", 1)[0].split(".dev", 1)[0]
        #   只保留基础版本(如 0.1.1),去掉 "+gHASH.dDATE" 和 ".devN" 后缀,显示更干净。
    except Exception:
        return "dev"
        #   读不到就显示 "dev"。
```

---

## `CliRenderer`:渲染器

> **整块作用**:持有一个 rich Console;以下方法各画一种内容。

```python
@dataclass
class CliRenderer:
    """Rich-based renderer for interactive CLI."""
    console: Console
    #   rich 控制台(输出目标)。
```

### 欢迎面板

> **整块作用(_welcome_panel)**:构造一个两栏面板——左栏问候+logo+模型/工作区;右栏使用提示+CREAMY 字标;
> 两栏间只有一条竖线分隔。

```python
    def _welcome_panel(self, *, model: str, workspace: str) -> Panel:
        user = os.getenv("USER") or "there"
        #   取系统用户名(没有就 "there")。
        version = _creamy_version()
        #   版本号(面板标题用)。

        left = Group(
            Text(""),                                                  # 空行
            Align.center(Text(f"Welcome back {user}!", style="bold")), # 居中问候
            Text(""),
            Align.center(_creamy_logo()),                              # 居中冰淇淋 logo
            Align.center(Text(model, style="cyan")),                   # 模型名(青色)
            Align.center(Text(str(workspace), style="bright_black")),  # 工作区路径(灰色)
        )
        #   左栏:问候 + logo + 会话身份(模型/工作区)。

        tips = Text()
        tips.append("Tips for getting started\n\n", style="bold magenta")
        #   右栏标题。
        tips.append("• Type ", style="")
        tips.append("'/help'", style="green")
        tips.append(" to list all commands\n")
        #   提示:/help 列命令。
        tips.append("• Prefix a line with ", style="")
        tips.append("','", style="green")
        tips.append(" to run an internal/shell command\n")
        #   提示:以 "," 前缀跑内部/shell 命令。
        tips.append("• Press ", style="")
        tips.append("Ctrl-X", style="green")
        tips.append(" to toggle shell mode\n")
        #   提示:Ctrl-X 切 shell 模式。
        tips.append("• ", style="")
        tips.append("PgUp/PgDn", style="green")
        tips.append(" scroll · ", style="")
        tips.append("Ctrl-T", style="green")
        tips.append(" mouse-scroll · drag to copy\n")
        #   提示:翻页/鼠标滚动/拖选复制。
        tips.append("• Type ", style="")
        tips.append("'/quit'", style="green")
        tips.append(" (or Ctrl-D) to exit\n\n")
        #   提示:/quit 或 Ctrl-D 退出。
        tips.append("Just type your message and press Enter to chat.", style="bright_black")
        #   收尾说明。

        wordmark = Text(CREAMY_WORDMARK, style="bold magenta", justify="center")
        #   "CREAMY" 字标(洋红、居中)。

        right = Table.grid(expand=True, padding=0)
        #   右栏用无边框网格:左放 tips,右放字标,二者并排无分隔线。
        right.add_column(ratio=1, vertical="middle")
        right.add_column(justify="center", width=27, vertical="middle")
        right.add_row(tips, Align.center(wordmark, vertical="middle"))

        body = Table(box=_SPLIT_BOX, show_header=False, show_edge=False, expand=True, pad_edge=False)
        #   外层表:用 _SPLIT_BOX(只画中间竖线),无表头/外边。
        body.add_column(justify="center", ratio=1, vertical="middle")  # 左栏占 1
        body.add_column(ratio=2, vertical="middle")                    # 右栏占 2
        body.add_row(left, right)

        return Panel(body, title=f"Creamy v{version}", title_align="left", border_style="magenta", padding=(0, 2))
        #   外层面板:标题 "Creamy v<版本>",洋红边框。
```

> **整块作用(welcome / welcome_ansi)**:把欢迎面板打到 console;或渲染成 ANSI 字符串(给全屏 TUI 用,
> 因为 TUI 不能直接 print,要把字符串喂给 prompt_toolkit)。

```python
    def welcome(self, *, model: str, workspace: str) -> None:
        self.console.print(self._welcome_panel(model=model, workspace=workspace))
        #   直接打印欢迎面板(普通 CLI 模式)。

    def welcome_ansi(self, *, model: str, workspace: str, width: int) -> str:
        """Render the welcome panel to an ANSI string (for the full-screen TUI ...)."""
        tmp = Console(width=width, force_terminal=True, color_system="standard")
        #   建一个指定宽度、强制当终端、标准色的临时 Console(用于捕获 ANSI 输出)。
        with tmp.capture() as cap:
            tmp.print(self._welcome_panel(model=model, workspace=workspace))
            #   把面板渲染进捕获缓冲。
        return cap.get()
        #   返回带 ANSI 转义的字符串(cli.py 的全屏 TUI 用 prompt_toolkit 的 ANSI 转换它)。
```

### 各类输出

> **整块作用**:info(灰字提示)、panel(按种类做带框面板)、command_output、assistant_output。

```python
    def info(self, text: str) -> None:
        if not text.strip():
            return
            #   空文本不打。
        self.console.print(Text(text, style="bright_black"))
        #   灰色提示文本。

    def panel(self, kind: MessageKind, text: str) -> Panel:
        title, border_style = self._panel_style(kind)
        #   据种类取标题与边框色。
        return Panel(text, title=title, border_style=border_style)
        #   带框面板。

    def command_output(self, text: str) -> None:
        if not text.strip():
            return
        self.console.print(self.panel("command", text))
        #   命令输出 → 绿色 "Command" 面板。

    def assistant_output(self, text: str) -> None:
        if not text.strip():
            return
        self.console.print(self._assistant_block(text))
        #   助手回复 → 无框块(带 🍦 前缀)。
```

> **整块作用(_assistant_block)**:把助手回复渲染成"🍦 + 首行,后续行缩进对齐"的无框块。

```python
    def _assistant_block(self, text: str) -> Text:
        """Unboxed assistant reply: a leading marker with indented continuation."""
        block = Text()
        lines = text.splitlines() or [""]
        #   按行拆;空文本兜底成 [""]。
        block.append(f"{ASSISTANT_MARKER} ")
        #   首行前加 "🍦 "。
        block.append(lines[0])
        #   首行内容。
        indent = " " * (cell_len(ASSISTANT_MARKER) + 1)
        #   续行缩进 = emoji 显示宽度(cell_len:🍦 占 2 列)+ 1 空格,与首行文字对齐。
        for line in lines[1:]:
            block.append("\n" + indent)
            block.append(line)
            #   每个续行换行 + 缩进 + 内容。
        return block

    def error(self, text: str) -> None:
        if not text.strip():
            return
        self.console.print(self.panel("error", text))
        #   错误 → 红色 "Error" 面板。
```

### 流式打字效果

> **整块作用**:start/update/finish 三步实现"实时打字 + 收尾定稿"。中途用 transient(临时)Live 区域显示
> 增长中的尾部,结束时清掉临时区、把最终内容正式打印一次。

```python
    def start_stream(self, kind: MessageKind) -> Live:
        # Stream a bounded, transient plain-text tail ... then print the final block/panel exactly once.
        live = Live(
            Text(""),
            console=self.console,
            auto_refresh=False,      # 手动刷新(由 update 控制)
            transient=True,          # 临时:结束后自动擦除这块区域(不留残影)
            vertical_overflow="crop",# 超高则裁剪(不让它撑出视口、产生滚动残留)
        )
        live.start()
        live.refresh()
        return live
        #   返回 Live 句柄(供 update/finish 用)。

    def update_stream(self, live: Live, *, kind: MessageKind, text: str) -> None:
        max_lines = max(1, self.console.size.height - 2)
        #   最多显示"视口高度-2"行(留点余量,确保不溢出)。
        tail = "\n".join(text.splitlines()[-max_lines:])
        #   只显示文本的最后 max_lines 行(打字时滚动尾部)。
        live.update(Text(tail), refresh=True)
        #   更新临时区并刷新。

    def finish_stream(self, live: Live, *, kind: MessageKind, text: str) -> None:
        live.stop()  # clears the transient typing region
        #   停止 Live → 擦除临时打字区。
        if not text.strip():
            return
            #   空结果不打。
        if kind == "normal":
            self.console.print(self._assistant_block(text))
            #   普通回复 → 🍦 无框块(正式定稿,只打一次)。
        else:
            self.console.print(self.panel(kind, text))
            #   命令/错误 → 对应面板。
```

- **设计要点**:打字过程用 `transient` Live 显示"尾部",避免长输出滚屏留下半截帧;最终内容在
  `finish_stream` 里用正式样式**完整打印一次**。

### 面板样式映射

> **整块作用**:种类 → (标题, 边框色)。

```python
    @staticmethod
    def _panel_style(kind: MessageKind) -> tuple[str, str]:
        match kind:
            case "error":
                return "Error", "red"        # 错误:红
            case "command":
                return "Command", "green"    # 命令:绿
            case _:
                return "Assistant", "blue"   # 其它:蓝
```

---

## 怎么和别的文件连起来

- `channels/cli.py`:CLI 的 TUI 创建 `CliRenderer`,用 `welcome_ansi`/`assistant_output`/
  `start_stream`/`update_stream`/`finish_stream` 渲染交互。
- `channels/message.py`:`MessageKind` 决定样式。
- `backend/_version.py`:版本号。

---

## 一句话总结

`renderer.py` 是 CLI 的"美术与排版层":画冰淇淋品牌欢迎面板、把助手回复渲染成 🍦 缩进块、用临时 Live
区域实现"打字机式流式输出 + 收尾定稿"。纯展示,无业务逻辑。
