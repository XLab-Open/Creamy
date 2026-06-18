# `backend/hooks/hook_impl.py` 精读(C 档·极详)⭐

> `BuiltinImpl` 是**出厂行为全集**:`hookspecs.py` 声明的每个 hook,这里给默认实现
> (`name="builtin"`,最先注册)。读懂它 = 读懂 Creamy 开箱即用时每个 turn 阶段到底做了什么。
> 对照 [`hookspecs.md`](hookspecs.md)(契约)与 [`../app/framework.md`](../app/framework.md)(谁调)看。

---

## 导入

> **整块作用**:引入标准库、Agent、渠道消息类型、库存子系统(意图/后处理/常量)、embedding、工具函数。
> 导入清单本身就揭示了"出厂实现既含通用 agent 能力,又深度耦合了库存业务"。

```python
import json
#   解析模型输出(常是结构化 JSON)/序列化。
import sys
#   用 sys.exc_info() 在 save_state 里取当前异常,传给 lifespan.__aexit__。
from datetime import UTC, datetime
#   build_prompt 里拼"当前 UTC 时间"给模型。
from pathlib import Path
#   读工作区里的 AGENTS.md。
from typing import cast
#   类型断言(把 media 列表断言成 list[MediaItem] 等)。

import typer
#   register_cli_commands 的参数类型。
from loguru import logger
#   日志。

from backend.agent.agent import Agent
#   真正"跑模型 + 工具循环"的 Agent。run_model/run_model_stream 都委托它。见 agent/agent.md。
from backend.app.framework import CreamyFramework
#   框架类型(构造参数)。
from backend.channels.base import Channel
#   provide_channels 返回值的元素类型。
from backend.channels.message import ChannelMessage, MediaItem
#   ChannelMessage:渠道消息结构(出站消息用它);MediaItem:媒体附件项(图片等)。见 channels/message.md。
from backend.context.context import default_tape_context
#   build_tape_context 委托它。见 context/context.md。
from backend.core.events import AsyncStreamEvents
#   run_model_stream 的返回类型。
from backend.core.store import TapeStore
#   provide_tape_store 的返回类型。
from backend.core.tape_types import TapeContext
#   build_tape_context 的返回类型。
from backend.hooks.hookspecs import hookimpl
#   实现标记器:下面每个出厂实现都用 @hookimpl 装饰。
from backend.inventory.logicfunction import _inventory_embedding_signal
#   库存意图识别的"向量信号"函数(文本与库存原型向量的相似度)。见 inventory/logicfunction.md。
from backend.inventory.postprocess import LLMPostprocess
#   库存输出后处理器(查库存 + 生成回复)。见 inventory/postprocess.md。
from backend.inventory.sqlconstant import (
    _INVENTORY_KEYWORDS,                 # 库存关键词集合(关键词信号)
    INTENT_INVENTORY_SCORE_THRESHOLD,    # 判定"查库存"的融合分阈值
    INTENT_WEIGHT_EMBEDDING,             # 向量信号权重
    INTENT_WEIGHT_KEYWORD,               # 关键词信号权重
    INTENT_WEIGHT_MODEL,                 # 模型信号权重
)
#   意图打分用到的常量。见 inventory/sqlconstant.md。
from backend.llm.embedding import Embedding
#   embedding 客户端类型(意图识别的向量信号用)。见 llm/embedding.md。
from backend.utils.envelope import content_of, field_of
#   消息防御式取值(content_of 取正文、field_of 取字段)。
from backend.utils.types import Envelope, MessageHandler, State
#   类型别名。
```

---

## 模块常量:三段系统提示

> **整块作用**:定义系统提示的三段文本常量。这两大段提示词是**库存业务**耦合进默认实现的地方;
> 它们与下方 `intent_detection` + `postprocess_model_output` 共同构成"图像/自然语言 → 库存查询"链路。
> (这两段是**数据**不是代码,故按"整体讲解"而非逐行;关键约束摘录如下。)

```python
AGENTS_FILE_NAME = "AGENTS.md"
#   工作区里若存在该文件,system_prompt 会把它折叠进系统提示(CLAUDE.md 所述"AGENTS.md 自动并入")。

DEFAULT_SYSTEM_PROMPT = """...通用行为约束(见下要点)..."""
#   通用提示。三条关键约束:
#     1) 调用工具/技能完成任务;
#     2) 结束前必须判断"是否需要回复用户";且 **Creamy 会自动经正确渠道发出最终回复**——
#        所以**禁止让模型自己调 feishu/telegram 等发送工具**(否则重复发送)。需要回复时直接输出文本即可;
#     3) 上下文过长可能导致模型调用失败,可用 tape.info 看 token、用 tape.handoff 压缩历史。

STRUCTURED_OUTPUT_PROMPT = """...库存业务三步提示(见下要点)..."""
#   库存核心提示词,要求模型走三步:
#     第一步 判意图:chat / query_inventory / clarify_intent / clarify_target;
#     第二步 意图矫正:有图按品类(五金/衣服/布料)判,纯文本按是否含库存查询语义判;
#     第三步 按意图决定输出:query_inventory 必须输出严格 JSON(summary/items[name,spec,brand,material,confidence]/unknowns);
#            clarify_* 输出固定 JSON 的澄清问题;chat 用自然语言正常回复。
#   开头的 /no_think 是给模型"关思考链"的指令。
```

- **换业务时**只需覆盖 `system_prompt`/`intent_detection`/`postprocess_model_output` 这几个 hook,
  通用层(session/state/prompt/run/...)照用——这是 hook 优先架构的价值。

---

## 构造

> **整块作用**:建 Agent、库存后处理器,并**靠 import 触发工具注册副作用**;初始化意图识别的懒加载缓存。

```python
class BuiltinImpl:
    """Default hook implementations for basic runtime operations."""
    #   类 docstring:基础运行时操作的默认 hook 实现集合。

    def __init__(self, framework: CreamyFramework) -> None:
        from backend.tools import toolimpl  # noqa: F401
        #   关键:这是"为副作用而导入"。toolimpl 模块在被导入时,会用 @tool 把内置工具注册进全局工具表。
        #   noqa: F401 抑制"导入未使用"告警——它确实没被直接引用,要的就是导入这一动作。见 tools/toolimpl.md。
        self.framework = framework
        #   保存框架引用(on_error/dispatch_outbound 里要回调框架的路由)。
        self.agent = Agent(framework)
        #   建 Agent(真正跑模型+工具循环者)。run_model/run_model_stream 都委托它。
        self.llm_postprocess = LLMPostprocess()
        #   库存输出后处理器(postprocess_model_output 里用)。
        self._intent_embedding_client: Embedding | None = None
        #   意图识别用的 embedding 客户端;懒加载(首次需要时才建),初始为 None。
        self._inventory_proto_embeddings: list[list[float]] | None = None
        #   "库存原型向量"缓存:一组代表"库存查询语义"的向量,用于和用户输入算相似度。懒加载。
```

---

## turn 各阶段默认实现

### resolve_session
> **整块作用**:有现成且非空的 session_id 就用,否则用 `channel:chat_id` 兜底。
```python
    @hookimpl
    def resolve_session(self, message: ChannelMessage) -> str:
        session_id = field_of(message, "session_id")
        #   防御式取 session_id(message 可能是对象也可能是 dict)。
        if session_id is not None and str(session_id).strip():
            #   存在且去空格后非空,
            return str(session_id)
            #   直接用。
        channel = str(field_of(message, "channel", "default"))
        #   否则取渠道名(缺省 default)。
        chat_id = str(field_of(message, "chat_id", "default"))
        #   + 会话 id(缺省 default)。
        return f"{channel}:{chat_id}"
        #   兜底主键 channel:chat_id。
```

### load_state / save_state(成对管理 lifespan)
> **整块作用(load_state)**:turn 开始时打开消息携带的 lifespan(异步上下文,某些渠道用它持有资源),
> 并把 agent / 可选 context 放进 state。
```python
    @hookimpl
    async def load_state(self, message: ChannelMessage, session_id: str) -> State:
        lifespan = field_of(message, "lifespan")
        #   取消息可能携带的"生命周期上下文管理器"(异步)。
        if lifespan is not None:
            await lifespan.__aenter__()
            #   turn 开始:进入它(打开资源,如某些渠道的连接)。与 save_state 的 __aexit__ 配对。
        state = {"session_id": session_id, "_runtime_agent": self.agent}
        #   基础 state:会话 id + agent 引用(后续阶段/工具可能要用 agent)。
        if context := field_of(message, "context_str"):
            #   海象运算符:取 context_str,非空则同时赋给 context 变量并进入分支,
            state["context"] = context
            #   放进 state(供 build_prompt 拼前缀)。
        return state
```

> **整块作用(save_state)**:turn 收尾时关闭 lifespan,并把"当前是否有异常"透传给它的 __aexit__。
```python
    @hookimpl
    async def save_state(self, session_id: str, state: State, message: ChannelMessage, model_output: str) -> None:
        tp, value, traceback = sys.exc_info()
        #   取"当前正在处理的异常"三元组(类型/值/回溯)。
        #   为何要取?framework 把 save_state 放在 finally,turn 出错时也会进来;
        #   把异常透传给 __aexit__ 让上下文管理器能据此正确清理(标准 with 协议语义)。
        lifespan = field_of(message, "lifespan")
        #   取同一个 lifespan。
        if lifespan is not None:
            await lifespan.__aexit__(tp, value, traceback)
            #   退出它(关闭资源)。若无异常,三者均为 None(等价正常退出)。
```

### build_prompt(命令识别 + 上下文/时间 + 多模态)
> **整块作用**:`/` 开头识别为命令并短路库存逻辑;普通消息拼"上下文+当前时间+正文";有媒体则拼多模态块。
```python
    @hookimpl
    async def build_prompt(self, message: ChannelMessage, session_id: str, state: State) -> str | list[dict]:
        content = content_of(message)
        #   取消息正文。
        if content.startswith("/"):
            #   以 "/" 开头 = 内部命令(如 /help、/skill ...)。
            message.kind = "command"
            #   在消息对象上标记 kind=command。
            state["kind"] = "command"
            #   也写进 state——后续 intent_detection / postprocess 会据此短路(命令不走库存识别)。
            return content
            #   命令原文直接作为 prompt 返回。
        context = field_of(message, "context_str")
        #   取可选上下文文本。
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        #   当前 UTC 时间,ISO 格式。让模型"知道现在几点"(相对时间类问题需要)。
        context_prefix = f"{context}\n---Date: {now}---\n" if context else ""
        #   有上下文就拼"上下文 + 日期分隔行"作为前缀,否则空。
        text = f"{context_prefix}{content}"
        #   最终文本 = 前缀 + 正文。

        media = field_of(message, "media") or []
        #   取媒体附件列表(没有则空列表)。
        if not media:
            # logger.info("session.run.prompt state: text")
            return text
            #   无媒体 → 返回纯文本 prompt。

        media_parts: list[dict] = []
        #   有媒体:构造 OpenAI 多模态"内容块"列表。
        for item in cast("list[MediaItem]", media):
            #   断言为 MediaItem 列表后遍历。
            match item.type:
                #   按媒体类型分支。
                case "image":
                    data_url = await item.get_url()
                    #   取图片的可用 URL(可能是 data: URL,异步获取)。
                    if not data_url:
                        continue
                        #   取不到就跳过该图。
                    media_parts.append({"type": "image_url", "image_url": {"url": data_url}})
                    #   组成 OpenAI 多模态图片块。
                case _:
                    #   其它类型附件(文件等):
                    attachment_desc = f"[Attached {item.type}: {item.mime_type}"
                    #   组一段文本描述(类型 + MIME)。
                    if item.filename:
                        attachment_desc += f", filename={item.filename}"
                        #   有文件名就带上。
                    attachment_desc += "]"
                    media_parts.append({"type": "text", "text": attachment_desc})
                    #   以文本块形式告知模型"有这么个附件"。
        if media_parts:
            # logger.info("session.run.prompt state: media")
            return [{"type": "text", "text": text}, *media_parts]
            #   返回多模态 prompt:第一个是正文文本块,后面跟各媒体块。
        return text
        #   极端情况(媒体都没生成块)→ 退回纯文本。
```

### run_model / run_model_stream(都委托 Agent)
> **整块作用**:两个模型 hook 都把活交给 Agent;出厂同时提供,具体用哪个由 hook_runtime 决定。
```python
    @hookimpl
    async def run_model(self, prompt: str | list[dict], session_id: str, state: State) -> str:
        return await self.agent.run(session_id=session_id, prompt=prompt, state=state)
        #   非流式:委托 agent.run,返回整段文本。
    @hookimpl
    async def run_model_stream(self, prompt: str | list[dict], session_id: str, state: State) -> AsyncStreamEvents:
        return await self.agent.run_stream(session_id=session_id, prompt=prompt, state=state)
        #   流式:委托 agent.run_stream,返回事件流。
```
- 虽看似违反"二选一",出厂两者都给是为了让两种调用方都能被满足;`hook_runtime` 选用时只走其一。

### register_cli_commands(挂全部内置子命令)
> **整块作用**:把 cli 模块里的函数注册成 `creamy` 的各子命令。
```python
    @hookimpl
    def register_cli_commands(self, app: typer.Typer) -> None:
        from backend.cli import cli
        #   延迟导入 cli 模块(避免顶层循环)。
        app.command("run")(cli.run)
        #   creamy run:一次性跑一条消息走完整管线后退出。
        app.command("cli")(cli.chat)
        #   creamy cli:交互式 REPL。注意命令名是 cli,但函数叫 chat(历史改名遗留)。
        app.command("web")(cli.web)
        #   creamy web:只启 Web 网关渠道(给前端用)。
        app.add_typer(cli.login_app)
        #   挂一个 login 子应用(OAuth 登录相关的若干子命令)。
        app.command("hooks", hidden=True)(cli.list_hooks)
        #   creamy hooks:诊断"每个 hook 有哪些实现"。hidden=True 不在帮助里显示。
        app.command("gateway")(cli.gateway)
        #   creamy gateway:启动所有已配置渠道的监听(Telegram/飞书等)。
        app.command("install")(cli.install)
        #   creamy install:把插件依赖装进独立的 ~/.creamy 项目。
        app.command("uninstall")(cli.uninstall)
        #   creamy uninstall:卸载插件。
        app.command("update")(cli.update)
        #   creamy update:更新插件。
```
- 命令实现见 [`../cli/cli.md`](../cli/cli.md)。

### system_prompt(默认 + AGENTS.md + 结构化输出)
> **整块作用**:读工作区 AGENTS.md,把"默认提示 + AGENTS.md + 结构化输出提示"三段拼成系统提示。
```python
    def _read_agents_file(self, state: State) -> str:
        workspace = state.get("_runtime_workspace", str(Path.cwd()))
        #   取工作区路径(framework 在 process_inbound 起始放进 state 的);缺省当前目录。
        prompt_path = Path(workspace) / AGENTS_FILE_NAME
        #   工作区下的 AGENTS.md 路径。
        if not prompt_path.is_file():
            return ""
            #   没有该文件就返回空串(不影响拼接)。
        try:
            return prompt_path.read_text(encoding="utf-8").strip()
            #   读其内容(去首尾空白)。
        except OSError:
            return ""
            #   读失败(权限/编码等)也降级为空串,绝不让"读个可选文件"中断流程。

    @hookimpl
    def system_prompt(self, prompt: str | list[dict], state: State) -> str:
        base = DEFAULT_SYSTEM_PROMPT + "\n\n" + self._read_agents_file(state) + "\n\n" + STRUCTURED_OUTPUT_PROMPT
        #   三段拼接:通用约束 + 工作区 AGENTS.md(可空) + 库存结构化输出提示。
        return base
```

### provide_channels(出厂四渠道)
> **整块作用**:出厂提供 Telegram/飞书/CLI/Web 四个渠道适配器,都接入框架的入站处理器。
```python
    @hookimpl
    def provide_channels(self, message_handler: MessageHandler) -> list[Channel]:
        from backend.channels.cli import CliChannel
        from backend.channels.feishu import FeishuChannel
        from backend.channels.telegram import TelegramChannel
        from backend.channels.web import WebChannel
        #   延迟导入四个渠道实现(避免顶层循环;也只在需要时加载其重依赖)。
        return [
            TelegramChannel(on_receive=message_handler),
            #   Telegram 适配器,收到消息回调 message_handler(框架入站)。
            FeishuChannel(on_receive=message_handler),
            #   飞书适配器。
            CliChannel(on_receive=message_handler, agent=self.agent),
            #   CLI 适配器:额外要 agent(终端 REPL 直接驱动它)。
            WebChannel(on_receive=message_handler),
            #   Web 网关适配器(给前端的 LangGraph 协议)。见 channels/web.md。
        ]
```

### on_error(把错误回发给用户)
> **整块作用**:默认错误观察者——把错误包成一条出站消息(kind=error)发回用户所在渠道。
```python
    @hookimpl
    async def on_error(self, stage: str, error: Exception, message: Envelope | None) -> None:
        if message is not None:
            #   只有"有原始消息"(知道发回给谁)时才回发。
            outbound = ChannelMessage(
                session_id=field_of(message, "session_id", "unknown"),
                channel=field_of(message, "channel", "default"),
                chat_id=field_of(message, "chat_id", "default"),
                content=f"An error occurred at stage '{stage}': {error}",
                #   错误文案,带出错环节 stage 与异常内容。
                kind="error",
                #   标记为 error 类消息(渲染/统计可区分)。
            )
            await self.framework._hook_runtime.call_many("dispatch_outbound", message=outbound)
            #   广播 dispatch_outbound,把错误消息发出去。
```

### dispatch_outbound(经路由真正发出)
> **整块作用**:委托框架的出站路由真正发送;CLI 渠道不打这条 info 日志(避免污染 TUI)。
```python
    @hookimpl
    async def dispatch_outbound(self, message: Envelope) -> bool:
        content_of(message)
        #   触发一次内容取值(规整/校验副作用;返回值不用)。
        session_id = field_of(message, "session_id")
        #   取会话 id(用于日志)。
        if field_of(message, "output_channel") != "cli":
            #   非 CLI 渠道才记日志,
            logger.info("session.run.outbound session_id={}", session_id)
            #   记一条出站日志(CLI 在全屏 TUI 下打日志会破坏界面,故跳过)。
        return await self.framework.dispatch_via_router(message)
        #   交给框架的出站路由真正发送,返回是否成功。
```

### render_outbound(模型输出 → 一条 ChannelMessage)
> **整块作用**:把模型输出包成一条出站消息,沿用入站的 channel/chat_id/output_channel/kind。
```python
    @hookimpl
    def render_outbound(self, message: Envelope, session_id: str, state: State, model_output: str) -> list[ChannelMessage]:
        outbound = ChannelMessage(
            session_id=session_id,
            channel=field_of(message, "channel", "default"),
            chat_id=field_of(message, "chat_id", "default"),
            content=model_output,
            #   正文 = 模型(后处理后)输出。
            output_channel=field_of(message, "output_channel", "default"),
            #   沿用入站的 output_channel(决定具体走哪条输出通道)。
            kind=field_of(message, "kind", "normal"),
            #   沿用 kind(normal/command/error 等)。
        )
        return [outbound]
        #   返回单条(列表形式,契约要求 list)。
```

### provide_tape_store(默认文件存储)
> **整块作用**:出厂用写盘的 FileTapeStore,目录在 `~/.creamy/tapes`。
```python
    @hookimpl
    def provide_tape_store(self) -> TapeStore:
        """Provide the default tape storage backend for the framework."""
        from backend.memory.store import FileTapeStore
        #   延迟导入实现。
        return FileTapeStore(directory=self.agent.settings.home / "tapes")
        #   目录 = settings.home(默认 ~/.creamy)下的 tapes。这是"会话历史"的真相源之一。
        #   (docs/issue 里分析过:web 通道历史与这套 tape 是两条脱节的真相源。)见 memory/store.md。
```

### build_tape_context(委托 context 模块)
```python
    @hookimpl
    def build_tape_context(self) -> TapeContext:
        return default_tape_context()
        #   委托 context/context.py 的 default_tape_context()。见 context/context.md。
```

---

## ⭐ 库存意图识别:intent_detection(三信号融合)

> **整块作用**:命令短路;模型已明确澄清则直接采用;否则用"关键词 + 模型自报 + 向量相似度"
> 三信号加权融合,判定 `query_inventory` 还是 `chat`,结果写进 state["intent"]。

```python
    @hookimpl
    def intent_detection(self, message: ChannelMessage, model_output: str, state: State) -> None:  # noqa: C901
        #   noqa: C901:函数较复杂(分支多),抑制圈复杂度告警——这是有意为之的打分逻辑。
        if state.get("kind") == "command":
            return
            #   命令消息不做库存识别,直接结束。

        parsed: dict[str, object] = {}
        #   存放"模型输出解析成的 dict"。
        if isinstance(model_output, str) and model_output.strip():
            #   模型输出是非空字符串,
            try:
                loaded = json.loads(model_output)
                #   尝试解析为 JSON(STRUCTURED_OUTPUT_PROMPT 要求库存意图时输出 JSON)。
                if isinstance(loaded, dict):
                    parsed = loaded
                    #   是 dict 才采用。
            except Exception:
                parsed = {}
                #   不是合法 JSON(普通聊天回复)→ 空 dict。
        elif isinstance(model_output, dict):
            parsed = model_output
            #   已经是 dict 就直接用。

        clarify = parsed.get("intent")
        #   看模型是否自报了 intent。
        if clarify == "clarify_intent" or clarify == "clarify_target":
            state["intent"] = clarify
            #   模型已明确"需要澄清"→ 直接采用,
            # logger.info("session.run.intent_detection intent: {}", clarify)
            return
            #   结束(不再走融合打分)。

        try:
            content = json.loads(content_of(message))
            #   尝试把用户输入也按 JSON 解析(某些渠道把内容包成 JSON)。
        except Exception:
            content = content_of(message)
            #   不是 JSON 就用原文。
        # Channels wrap content as {"message": ...}; the CLI sends a plain string.
        if isinstance(content, dict):
            content = content.get("message", "")
            #   渠道常把正文包成 {"message": ...},取出真正文本;CLI 直接是字符串。
        content = str(content)
        #   统一成字符串。

        keyword_score = 1.0 if any(keyword in content for keyword in _INVENTORY_KEYWORDS) else 0.0
        #   信号①关键词:用户文本里出现任一库存关键词 → 1.0,否则 0.0。
        model_score = 1.0 if str(parsed.get("intent", "")).strip() == "query_inventory" else 0.0
        #   信号②模型:模型自报 intent 是 query_inventory → 1.0。
        embedding_score, embedding_ok = _inventory_embedding_signal(
            self._intent_embedding_client, content, self._inventory_proto_embeddings
        )
        #   信号③向量:用户文本与"库存原型向量"的相似度。
        #   embedding_ok 表示该信号是否可用(没配 embedding 时为 False)。见 inventory/logicfunction.md。

        w_kw = float(INTENT_WEIGHT_KEYWORD)
        #   关键词权重。
        w_mo = float(INTENT_WEIGHT_MODEL)
        #   模型权重。
        w_em = float(INTENT_WEIGHT_EMBEDDING)
        #   向量权重。
        if not embedding_ok:
            #   向量信号不可用时,
            denom = w_kw + w_mo
            #   只用关键词+模型两路,
            if denom > 0.0:
                w_kw, w_mo = w_kw / denom, w_mo / denom
                #   把这两路权重重新归一化(让它们之和仍为 1,保持打分尺度一致)。
            w_em = 0.0
            #   向量权重清零。

        fused = w_kw * keyword_score + w_mo * model_score + w_em * embedding_score
        #   加权融合得分。
        threshold = float(INTENT_INVENTORY_SCORE_THRESHOLD)
        #   判定阈值。
        intent = "query_inventory" if fused >= threshold else "chat"
        #   ≥阈值判为库存查询,否则闲聊。

        state["intent"] = intent
        #   写进 state,供 postprocess_model_output 据此分流。
        # logger.info("session.run.intent_detection intent: {}", intent)
```

---

## 库存输出后处理:postprocess_model_output

> **整块作用**:据 intent 分流——查库存 / 输出澄清问题 / 兜底序列化;命令与非 JSON(闲聊)原样返回。

```python
    @hookimpl
    def postprocess_model_output(self, model_output: str, state: State) -> str:
        if state.get("kind") == "command":
            return model_output
            #   命令:原样返回(命令的输出不需要库存后处理)。

        try:
            model_output = json.loads(model_output)
            #   尝试把输出解析为 JSON(库存/澄清意图时模型输出 JSON)。
        except Exception:
            return model_output
            #   不是 JSON(普通聊天的自然语言回复)→ 原样返回,不进库存链路。

        if state.get("intent") == "query_inventory":
            model_output = self.llm_postprocess.postprocess(model_output, state)
            #   库存查询:调后处理器——它会真正去查库存(SQL/向量)并组织成给用户的回复。见 inventory/postprocess.md。
        elif state.get("intent") in ("clarify_intent", "clarify_target"):
            model_output = self.llm_postprocess.clarify(model_output, state)
            #   澄清意图:输出澄清问题文本。
        elif isinstance(model_output, dict):
            model_output = json.dumps(model_output, ensure_ascii=False)
            #   其它(已是 dict 但无明确库存意图)→ 兜底序列化回字符串(ensure_ascii=False 保中文可读)。

        return model_output
        #   返回最终给用户的文本。
```

---

## 一句话总结

`BuiltinImpl` 把两层塞进默认实现:**通用层**(session/state/prompt/run/save/render/dispatch/
channels/tape——标准 turn)+ **业务层**(库存提示词 + 三信号意图识别 + 库存后处理)。换业务只需
覆盖业务层那几个 hook,通用层照用——这正是 hook 优先架构的价值。
