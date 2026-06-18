# `backend/channels/web.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

**Web 网关渠道**:一个 aiohttp HTTP/SSE 服务,**用 LangGraph Platform 协议**对接移植进来的 deer-flow
前端(前端用 `@langchain/langgraph-sdk` 的 `useStream`)。它把 HTTP 请求翻译成 `ChannelMessage` 交给框架
跑 turn,再把 turn 的流式事件按 LangGraph 线缆格式 SSE 吐回前端。

> 这是你之前调试"流式不显示""历史重启丢失""多用户未隔离"的那个文件。本文当前版本**已含你加的
> 磁盘持久化**(`web_threads.json`),逐行讲清。整体设计见 `docs/web-gateway-design.md`,问题分析见
> `docs/issue/会话历史重启丢失.md` 与 `会话历史未按用户隔离.md`。

关键机制:
- **run_id 关联**:一次 `POST /threads/{id}/runs/stream` 生成 run_id,塞进消息 context;turn 的流式事件
  经 `stream_events` 用 run_id 找到对应的 per-run 队列,把增量回灌给该 HTTP 响应。
- **历史**:`self._threads`(thread_id→消息列表)+ 落盘到 `~/.creamy/web_threads.json`。

---

## 顶部:模块说明、导入、SSE 工具

> **整块作用**:docstring 讲清设计;导入 aiohttp 等;定义结束哨兵、SSE 帧格式化、时间戳工具。

```python
"""Web channel — HTTP/SSE gateway that speaks the LangGraph Platform protocol. ...(见上)..."""
from __future__ import annotations

import asyncio   # per-run 队列、事件
import json      # SSE 负载/历史文件序列化
import os        # 读 CREAMY_WEB_HOST/PORT/HOME 环境变量
import time      # _now_iso 时间戳
import uuid      # 生成 thread_id / run_id / 消息 id
from collections.abc import AsyncIterable
from pathlib import Path   # 历史文件路径(你加持久化时引入)
from typing import Any, ClassVar

from aiohttp import web    # HTTP 服务框架
from loguru import logger

from backend.channels.base import Channel        # 继承的渠道基类
from backend.channels.message import ChannelMessage  # 入站消息
from backend.core.events import StreamEvent      # 流式事件
from backend.utils.types import MessageHandler   # 入站回调类型

_END = object()
#   结束哨兵:stream_events 在流结束时往 per-run 队列推 (_END, None),通知 _runs_stream 跳出循环。


def _sse(event: str, data: Any, *, event_id: str | None = None) -> bytes:
    """Format one SSE frame the way the LangGraph SDK decoder expects."""
    payload = json.dumps(data, default=str, ensure_ascii=False)
    #   data 序列化成 JSON(default=str 兜底不可序列化对象;ensure_ascii=False 保中文)。
    parts = [f"event: {event}", f"data: {payload}"]
    #   SSE 两行:event: <类型> / data: <json>。
    if event_id:
        parts.append(f"id: {event_id}")
        #   可选 id 行(这里用 run_id,SDK 据此关联)。
    parts.append("")
    parts.append("")
    #   两个空行:SSE 规定一帧以空行结束(这里产生 "\n\n")。
    return "\n".join(parts).encode("utf-8")
    #   拼成字节,写进响应。


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
    #   UTC ISO 时间字符串(给 thread/state 对象的 created_at/updated_at)。
    #   注:每次调用都取"当下",所以这些时间戳不是"持久化的真实创建时间"(见 issue 文档的局限分析)。
```

---

## 类定义与构造(含持久化初始化)

> **整块作用**:声明渠道名/assistant id;构造里读 host/port、初始化 per-run 队列表与历史索引,并**从磁盘
> 加载历史**(你加的持久化)。

```python
class WebChannel(Channel):
    """aiohttp-based LangGraph-compatible gateway channel."""

    name: ClassVar[str] = "web"
    #   渠道名 "web"(manager 路由/去重的键;前端经它分发)。

    ASSISTANT_ID = "lead_agent"
    #   前端 useStream({ assistantId }) 锁定的 assistant/graph id;各资源对象里回这个值。

    def __init__(self, on_receive: MessageHandler, host: str | None = None, port: int | None = None) -> None:
        self._on_receive = on_receive
        #   框架入站回调(manager.on_receive)。收到 HTTP 请求后调它把消息送进管线。
        self._host = host or os.getenv("CREAMY_WEB_HOST", "127.0.0.1")
        #   监听地址(默认本机回环;可用 CREAMY_WEB_HOST 覆盖)。
        self._port = int(port or os.getenv("CREAMY_WEB_PORT", "8000"))
        #   监听端口(默认 8000)。
        self._runner: web.AppRunner | None = None
        #   aiohttp 运行器句柄(start 建、stop 清)。
        self._streams: dict[str, asyncio.Queue] = {}
        #   run_id -> per-run 队列。stream_events 往里塞 ("delta",文本)/(_END,None);_runs_stream 消费。
        self._threads: dict[str, list[dict[str, Any]]] = {}
        #   ⭐ 会话历史索引:thread_id -> [LangGraph 形状消息 {type,content,id}]。前端历史列表的数据源。
        home = Path(os.path.expanduser(os.getenv("CREAMY_HOME", "~/.creamy")))
        #   解析 CREAMY_HOME(默认 ~/.creamy)。
        self._store_path = home / "web_threads.json"
        #   历史落盘文件(与 tapes 同级)。
        self._load_threads()
        #   启动即从磁盘恢复历史(你加的持久化:解决"重启丢历史")。
```

---

## 持久化:加载 / 保存(你加的部分)

> **整块作用(_load_threads)**:启动时读 `web_threads.json` 恢复历史;文件不存在当空,损坏只告警不阻断启动。

```python
    def _load_threads(self) -> None:
        """启动时从磁盘恢复会话历史(文件不存在/损坏则视为空)。"""
        try:
            raw = self._store_path.read_text(encoding="utf-8")
            #   读文件文本。
            data = json.loads(raw)
            #   解析 JSON。
            if isinstance(data, dict):
                self._threads = {
                    str(tid): msgs for tid, msgs in data.items() if isinstance(msgs, list)
                }
                #   规整:键转字符串、只接受值是 list 的项(防御坏数据)。
                logger.info(f"web.channel restored {len(self._threads)} thread(s) from {self._store_path}")
                #   记一条"恢复了 N 条线程"日志(你测试时看到的就是它)。
        except FileNotFoundError:
            pass
            #   首次运行没文件 → 正常,留空。
        except Exception as exc:  # 损坏的历史文件不应阻止后端启动
            logger.warning(f"web.channel failed to load thread history: {exc}")
            #   其它异常(坏 JSON 等)→ 只告警,继续以空历史启动。
```

> **整块作用(_save_threads)**:原子写盘(临时文件 + replace),避免写一半被读到。

```python
    def _save_threads(self) -> None:
        """把会话历史原子写入磁盘(临时文件 + rename,避免半截写入)。"""
        try:
            self._store_path.parent.mkdir(parents=True, exist_ok=True)
            #   确保目录存在。
            tmp = self._store_path.with_suffix(".json.tmp")
            #   临时文件路径。
            tmp.write_text(json.dumps(self._threads, ensure_ascii=False, default=str), encoding="utf-8")
            #   先把全量历史写到临时文件。
            tmp.replace(self._store_path)
            #   原子 rename 覆盖正式文件(POSIX 上 rename 是原子的,杜绝"半截写入"被读到)。
        except Exception as exc:
            logger.warning(f"web.channel failed to persist thread history: {exc}")
            #   写盘失败只告警,不影响主流程。
```

- **局限提醒**(见 issue 文档):这套历史与 agent 的 tape 是**两条脱节真相源**;且**无 owner 字段**,
  所有用户共享同一份历史(多用户未隔离)。

---

## 渠道生命周期:start / stop

> **整块作用(start)**:建 aiohttp app、注册所有路由、起 TCP 服务。路由分两组:LangGraph 原生 API(根路径)
> 与网关资源 API(/api/*)。

```python
    @property
    def enabled(self) -> bool:
        return True
        #   始终启用(manager 据此决定要不要 start)。

    async def start(self, stop_event: asyncio.Event) -> None:
        app = web.Application()
        app.add_routes([
            web.get("/health", self._health),                                   # 健康检查(前端连接指示器轮询它)
            web.post("/threads", self._create_thread),                          # 建线程
            web.post("/threads/search", self._search_threads),                  # 列线程(前端历史列表)
            web.get("/threads/{thread_id}", self._get_thread),                  # 取单线程
            web.get("/threads/{thread_id}/state", self._thread_state),          # 取线程状态
            web.post("/threads/{thread_id}/history", self._thread_history),     # 取线程历史
            web.post("/threads/{thread_id}/runs/stream", self._runs_stream),    # ⭐ 跑一次 run(SSE 流)
            web.post("/assistants/search", self._assistants_search),            # 列 assistant
            web.get("/assistants/{assistant_id}", self._get_assistant),         # 取 assistant
            web.get("/api/models", self._list_models),                          # 模型列表(网关资源)
            web.get("/api/skills", self._list_skills),                          # 技能列表(网关资源)
        ])
        #   注释指明:LangGraph 原生 API 走根路径(前端 /api/langgraph/* 重写会剥前缀);资源 API 走 /api/*。
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        #   建并初始化运行器。
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        #   在 host:port 起监听。
        logger.info(f"web.channel listening on http://{self._host}:{self._port}")

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            #   清理运行器(关服务、释放端口)。
            self._runner = None
        logger.info("web.channel stopped")
```

---

## ⭐ 流路由:stream_events(把 turn 事件回灌到 per-run 队列)

> **整块作用**:被 manager.wrap_stream 调。它包装 turn 的事件流:每个文本增量塞进对应 run 的队列(供
> `_runs_stream` 取来组 SSE),同时原样 yield;流结束时往队列推 `_END`。

```python
    def stream_events(self, message: ChannelMessage, stream: AsyncIterable[StreamEvent]) -> AsyncIterable[StreamEvent]:
        run_id = message.context.get("run_id") if isinstance(message.context, dict) else None
        #   从消息 context 取 run_id(就是 _runs_stream 塞进去的)。
        queue = self._streams.get(run_id) if run_id else None
        #   据 run_id 找到对应的 per-run 队列。

        async def _wrap() -> AsyncIterable[StreamEvent]:
            try:
                async for event in stream:
                    #   遍历模型 turn 的事件。
                    if queue is not None and event.kind == "text":
                        delta = str(event.data.get("delta", ""))
                        if delta:
                            await queue.put(("delta", delta))
                            #   文本增量 → 塞进队列(_runs_stream 那边取来拼成 SSE values 帧)。
                    yield event
                    #   原样透传事件(framework._run_model 也在消费这同一个流累积文本)。
            finally:
                if queue is not None:
                    await queue.put((_END, None))
                    #   无论正常结束还是异常,都推 _END,让 _runs_stream 的消费循环能跳出。
        return _wrap()
```

- **这就是"流式回灌"的核心衔接**:turn 在 manager 循环里异步跑,事件经此进队列;HTTP 处理器
  `_runs_stream` 是另一协程,从队列取增量、按 LangGraph 格式发 SSE。run_id 是两者的纽带。

---

## 简单 HTTP 处理器

> **整块作用**:健康检查、建线程(落盘)、取线程、列线程、取状态/历史。

```python
    async def _health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "channel": self.name})
        #   健康检查:返回 ok。前端"连接状态指示器"轮询它。

    async def _create_thread(self, request: web.Request) -> web.Response:
        body = await _json_body(request)
        thread_id = body.get("thread_id") or str(uuid.uuid4())
        #   用前端给的 id,或生成新的。
        self._threads.setdefault(thread_id, [])
        #   建空历史。
        self._save_threads()
        #   落盘(你加的)。
        return web.json_response(self._thread_obj(thread_id))
        #   返回线程对象。

    async def _get_thread(self, request: web.Request) -> web.Response:
        thread_id = request.match_info["thread_id"]
        return web.json_response(self._thread_obj(thread_id))
        #   返回单个线程对象。

    async def _search_threads(self, request: web.Request) -> web.Response:
        return web.json_response([self._thread_obj(tid) for tid in self._threads])
        #   ⚠️ 返回"全部"线程(无 owner 过滤)——这就是 issue "多用户未隔离" 的根:前端历史列表的数据源。

    async def _thread_state(self, request: web.Request) -> web.Response:
        thread_id = request.match_info["thread_id"]
        return web.json_response(self._state_obj(thread_id))
        #   返回线程状态对象(含 messages)。

    async def _thread_history(self, request: web.Request) -> web.Response:
        thread_id = request.match_info["thread_id"]
        messages = self._threads.get(thread_id, [])
        if not messages:
            return web.json_response([])
            #   空历史 → 空数组。
        return web.json_response([self._state_obj(thread_id)])
        #   有历史 → 返回单元素的状态列表(SDK 期望"历史检查点"形态)。
```

---

## 资源处理器:模型列表 / 技能列表

> **整块作用(_list_models)**:把 Creamy 配置的模型按前端期望形状返回。

```python
    async def _list_models(self, request: web.Request) -> web.Response:
        """Surface Creamy's configured model in the frontend's expected shape."""
        raw = os.getenv("CREAMY_MODEL", "deepseek:deepseek-chat").strip()
        #   读配置模型(provider:model)。
        _, _, model_id = raw.partition(":")
        #   取 ":" 之后的 model_id 部分。
        model_id = model_id or raw
        #   没有 ":" 就用整串。
        return web.json_response({"models": [{
            "id": raw, "name": raw, "model": model_id, "display_name": raw, "supports_thinking": False,
        }]})
        #   返回单模型列表(前端模型选择器用)。
```

> **整块作用(_list_skills)**:扫描 `backend/skills/<name>/SKILL.md`,粗略抽出 description,返回技能列表。

```python
    async def _list_skills(self, request: web.Request) -> web.Response:
        """List Creamy's on-disk skills (``backend/skills/<name>/SKILL.md``)."""
        skills = []
        skills_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "skills")
        #   定位 backend/skills 目录(本文件上两级 + skills)。
        try:
            for name in sorted(os.listdir(skills_dir)):
                skill_md = os.path.join(skills_dir, name, "SKILL.md")
                if not os.path.isfile(skill_md):
                    continue
                    #   没有 SKILL.md 的子目录跳过。
                description = ""
                try:
                    with open(skill_md, encoding="utf-8") as fh:
                        head = fh.read(2000)
                        #   只读前 2000 字符够取 frontmatter。
                    for line in head.splitlines():
                        line = line.strip()
                        if line.lower().startswith("description:"):
                            description = line.split(":", 1)[1].strip()
                            break
                            #   粗略找 "description:" 行抽出描述。
                except OSError:
                    pass
                    #   读失败就留空描述。
                skills.append({"name": name, "description": description, "license": None, "category": "public", "enabled": True})
        except OSError:
            pass
            #   skills 目录不存在等 → 返回空列表。
        return web.json_response({"skills": skills})
```

---

## ⭐⭐ 核心端点:_runs_stream(跑一次 run 并 SSE 流式返回)

> **整块作用**:M1 核心。解析请求 → 追加用户消息并落盘 → 注册 per-run 队列 → 打开 SSE → 把 turn 交框架 →
> 消费队列逐帧发 values → turn 结束发最终 values + end。源码已有详细中文分步注释,逐行再讲:

```python
    async def _runs_stream(self, request: web.Request) -> web.StreamResponse:
        """创建一次 run 并以 SSE 流式返回其事件(M1 阶段的核心端点)。..."""
        # --- 1. 解析请求 ---
        thread_id = request.match_info["thread_id"]
        #   从 URL 取线程 id。
        body = await _json_body(request)
        #   读请求体。
        user_text = _extract_input_text(body)
        #   从 LangGraph runs 负载里抽出用户输入文本(见下 helper)。
        run_id = str(uuid.uuid4())
        #   生成本次 run 的唯一 id(关联流)。

        # --- 2. 追加用户消息 + 预分配 AI 消息 id ---
        messages = self._threads.setdefault(thread_id, [])
        #   取(或建)该线程的历史列表。
        user_msg = {"type": "human", "content": user_text, "id": str(uuid.uuid4())}
        messages.append(user_msg)
        #   把人类消息追加进历史。
        self._save_threads()
        #   ⭐(你加的)提问一追加就落盘——即使本次 run 崩了,问题也不丢。
        ai_id = str(uuid.uuid4())
        #   预分配 AI 消息 id:后续每帧"生成中"的 AI 消息都复用它,SDK 据 id 去重(更新而非追加)。

        # --- 3. 注册 per-run 队列 ---
        queue: asyncio.Queue = asyncio.Queue()
        self._streams[run_id] = queue
        #   以 run_id 注册队列,stream_events 才能找到它回灌增量。

        # --- 4. 打开分块 SSE 响应 ---
        response = web.StreamResponse(status=200, headers={
            "Content-Type": "text/event-stream",   # SSE 内容类型
            "Cache-Control": "no-cache",           # 不缓存
            "Connection": "keep-alive",            # 保持连接
            "X-Accel-Buffering": "no",             # 关代理缓冲,让增量立即刷出(否则会被攒着)
            "Content-Location": f"/threads/{thread_id}/runs/{run_id}",  # run 路径(SDK 也从这读 run_id)
        })
        await response.prepare(request)
        #   开始分块响应(后续可多次 write)。

        # --- 5. 首帧 metadata(run id) ---
        await response.write(_sse("metadata", {"run_id": run_id, "thread_id": thread_id}))
        #   显式发一帧 run/thread id(更稳妥)。

        # --- 6. 把 turn 交给框架(不阻塞等待模型) ---
        await self._on_receive(ChannelMessage(
            session_id=thread_id,
            channel=self.name,
            content=user_text,
            chat_id="web",                       # ⚠️ 写死 "web":所有用户共用,无身份区分(见 issue 多用户隔离)
            context={"run_id": run_id},          # ⭐ 把 run_id 塞进 context,stream_events 据它找队列
        ))
        #   on_receive 把消息入队,manager 循环异步起 turn;此调用立即返回。

        # --- 7. 消费队列,逐帧发 values ---
        assistant_content = ""
        #   累积 AI 文本。
        try:
            while True:
                kind, value = await queue.get()
                #   等队列里的下一项(由 stream_events 填充)。
                if kind is _END:
                    break
                    #   收到结束哨兵 → 跳出。
                # kind == "delta"
                assistant_content += value
                #   累积增量。
                snapshot = {"messages": [*messages, {"type": "ai", "content": assistant_content, "id": ai_id}]}
                #   构造完整状态快照:已有历史 + 正在增长的 AI 消息(复用 ai_id)。
                await response.write(_sse("values", snapshot, event_id=run_id))
                #   发一帧 values(SDK 的 useStream 据此更新界面——这就是"打字机"效果)。
        finally:
            self._streams.pop(run_id, None)
            #   无论如何注销队列,防泄漏(崩溃/取消的 run 也清掉)。

        # --- 8. 持久化最终 AI 消息 + 发最终帧 ---
        messages.append({"type": "ai", "content": assistant_content, "id": ai_id})
        #   把完成的 AI 消息追加进历史。
        self._save_threads()
        #   ⭐(你加的)AI 回复完成 → 落盘,重启可恢复整段对话。
        await response.write(_sse("values", {"messages": messages}, event_id=run_id))
        #   发最终 values(完整历史)。
        await response.write(_sse("end", None))
        #   发 end 帧关闭这次 run。
        await response.write_eof()
        #   结束响应体。
        return response
```

- **为什么流式曾"看起来一次性输出"**:不是这里的问题,而是 Next.js 对 SSE 做了 gzip 缓冲(你后来加
  `compress:false` 解决)。本端已用 `X-Accel-Buffering: no` 关代理缓冲并逐帧 write。

---

## 对象形状构造器

> **整块作用**:把内部历史包装成 LangGraph SDK 期望的 thread / state / assistant 对象形状。

```python
    def _thread_obj(self, thread_id: str) -> dict[str, Any]:
        messages = self._threads.get(thread_id, [])
        return {
            "thread_id": thread_id,
            "created_at": _now_iso(),          # ⚠️ 每次现算,非真实创建时间(issue 提到的局限)
            "updated_at": _now_iso(),
            "metadata": {"graph_id": self.ASSISTANT_ID},
            "status": "idle",
            "values": {"messages": messages} if messages else None,  # 有历史才给 values
        }

    def _state_obj(self, thread_id: str) -> dict[str, Any]:
        messages = self._threads.get(thread_id, [])
        return {
            "values": {"messages": messages},
            "next": [],
            "checkpoint": {"thread_id": thread_id, "checkpoint_id": str(uuid.uuid4())},  # 伪 checkpoint
            "metadata": {},
            "created_at": _now_iso(),
            "parent_checkpoint": None,
            "tasks": [],
        }
        #   拼出 SDK 期望的"线程状态/检查点"形状(很多字段是占位)。

    def _assistant_obj(self) -> dict[str, Any]:
        return {
            "assistant_id": self.ASSISTANT_ID, "graph_id": self.ASSISTANT_ID, "name": "Creamy",
            "created_at": _now_iso(), "updated_at": _now_iso(), "metadata": {}, "version": 1, "config": {},
        }
        #   assistant 对象(前端 useStream 需要)。
```

---

## 模块级 helper

> **整块作用**:安全读 JSON body;从 LangGraph runs 负载里防御式抽用户文本(兼容多种 SDK 形态)。

```python
async def _json_body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
        #   解析 JSON body;不是 dict 就当空。
    except Exception:
        return {}
        #   解析失败也返回空 dict(不抛)。


def _extract_input_text(body: dict[str, Any]) -> str:
    """Pull the user's text out of a LangGraph runs payload. ..."""
    inp = body.get("input")
    #   LangGraph runs 负载里用户输入在 input 下。
    if isinstance(inp, dict):
        msgs = inp.get("messages")
        if isinstance(msgs, list) and msgs:
            last = msgs[-1]
            #   取最后一条消息(最新用户输入)。
            if isinstance(last, dict):
                content = last.get("content", "")
                if isinstance(content, list):  # content blocks
                    return "".join(b.get("text", "") for b in content if isinstance(b, dict))
                    #   多模态内容块 → 把所有 text 拼起来。
                return str(content)
                #   普通字符串内容。
    if isinstance(inp, str):
        return inp
        #   input 直接是字符串的情形。
    return ""
    #   都不匹配 → 空串。
```

---

## 怎么和别的文件连起来

- `channels/manager.py`:`wrap_stream` → 本类 `stream_events`;`process_inbound` 经 on_receive 入队。
- `hook_impl.provide_channels`:实例化 WebChannel。
- 前端:`frontend/src/core/threads/hooks.ts` 的 `useThreads`/`useStream` 调这里的 `/threads/*` 端点。
- 相关问题文档:`docs/issue/会话历史重启丢失.md`、`会话历史未按用户隔离.md`。

---

## 一句话总结

`web.py` 把 Creamy 包装成"LangGraph Platform 兼容服务"给前端用:HTTP 端点维护线程/历史(已落盘),
`_runs_stream` 用 run_id + per-run 队列把 turn 的流式增量按 SSE 实时吐回前端。已知局限:历史与 tape
脱节、`chat_id` 写死无多用户隔离、时间戳非真实(见 issue 文档)。
