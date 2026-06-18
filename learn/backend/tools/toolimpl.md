# `backend/tools/toolimpl.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

**内置工具的实现全集**:用 `@tool` 把一批工具登记进 `REGISTRY`——shell(bash/后台/读输出/kill)、文件
(fs.read/write/edit)、技能(skill)、tape(info/search/reset/handoff/anchors)、web.fetch、库存
(query.inventory)、飞书报告(send.report)、子 agent(subagent)、help、quit。

> 这是模型"能做什么"的清单。`hook_impl.__init__` 里 `import toolimpl` 就是为了触发这里所有 `@tool` 的
> 注册副作用。带 `context=True` 的工具执行时会收到 `ToolContext`(含 state/tape/run_id)。

---

## 顶部:导入、类型、常量、helper

```python
from __future__ import annotations
import asyncio, json, uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast
import requests
from pydantic import BaseModel, Field

from backend.agent.settings import FeishuSettings
from backend.core.store import AsyncTapeStore
from backend.core.tape_types import TapeQuery
from backend.core.tools import ToolContext
from backend.inventory.inventory_query import InventoryQuery          # 库存查询
from backend.skills.skills import discover_skills                      # 技能发现
from backend.tools.channeltool.tool_feishu import (                   # 飞书发送工具
    get_feishu_tenant_access_token, resolve_feishu_chat_id, send_feishu_message)
from backend.tools.filetool.file_impl import expansion_write_excel    # 写 Excel
from backend.tools.shelltool.shell_manager import shell_manager       # shell 管理器
from backend.tools.tools import resolve_tool_names, tool              # @tool + 名字解析

if TYPE_CHECKING:
    from backend.agent.agent import Agent

type EntryKind = Literal["event", "anchor", "system", "message", "tool_call", "tool_result"]
DEFAULT_COMMAND_TIMEOUT_SECONDS = 30   # bash 默认超时
DEFAULT_HEADERS = {"accept": "text/markdown"}  # web.fetch 默认头(偏好 markdown)
DEFAULT_REQUEST_TIMEOUT_SECONDS = 10
```

> **整块作用(helper)**:shell 非零退出抛错;从 context 取运行时 agent。

```python
def _raise_for_failed_shell(returncode: int | None, output: str) -> None:
    if returncode in (None, 0):
        return
        #   None(还在跑)或 0(成功)→ 不抛。
    body = output.strip() or "(no output)"
    raise RuntimeError(f"command exited with code {returncode}\noutput:\n{body}")
    #   非零退出 → 抛含退出码与输出的错误。

def _get_agent(context: ToolContext) -> Agent:
    if "_runtime_agent" not in context.state:
        raise RuntimeError("no runtime agent found in tool context")
        #   state 里没有 agent(load_state 放的)→ 报错。
    return cast("Agent", context.state["_runtime_agent"])
    #   取回 agent(tape 类工具、subagent、quit 都要它)。
```

> **整块作用(pydantic 输入模型)**:tape.search 与 subagent 的参数 schema(用 model= 让 @tool 据它生成 schema)。

```python
class SearchInput(BaseModel):
    query: str = Field(..., description="The search query string.")
    limit: int = Field(20, description="Maximum number of search results to return.")
    start: str | None = Field(None, description="Optional start date ... (ISO).")
    end: str | None = Field(None, description="Optional end date ... (ISO).")
    kinds: list[str] = Field(default=["message", "tool_result"], description="... entry kinds ...")
    #   搜索参数:查询词、数量、日期区间、kind 过滤。

class SubAgentInput(BaseModel):
    prompt: str | list[dict] = Field(..., description="The initial prompt ...")
    model: str | None = Field(None, description="The model ...")
    session: str = Field("temp", description="... 'inherit' ... 'temp' ...")
    allowed_tools: list[str] | None = Field(None, description="... allowed tool names ...")
    allowed_skills: list[str] | None = Field(None, description="... allowed skill names ...")
    #   子 agent 参数:提示、模型、会话策略、工具/技能白名单。
```

---

## Shell 工具:bash / bash.output / bash.kill

> **整块作用(bash)**:跑 shell 命令;background 则立即返回 shell_id,否则等结束(带超时,超时则终止)。

```python
@tool(context=True)
async def bash(cmd, cwd=None, timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS, background=False, *, context: ToolContext) -> str:
    """Run a shell command. Use background=true to keep it running and fetch output later via bash_output."""
    workspace = context.state.get("_runtime_workspace")
    target_cwd = cwd or workspace
    #   工作目录:显式 cwd 优先,否则工作区。
    shell = await shell_manager.start(cmd=cmd, cwd=target_cwd)
    #   启动子进程(见 shell_manager.md)。
    if background:
        return f"started: {shell.shell_id}"
        #   后台模式:立即返回 id,稍后用 bash.output 取结果。
    try:
        async with asyncio.timeout(timeout_seconds):
            shell = await shell_manager.wait_closed(shell.shell_id)
            #   前台:等命令结束(带超时)。
    except TimeoutError:
        await shell_manager.terminate(shell.shell_id)
        return f"command timed out after {timeout_seconds} seconds and was terminated"
        #   超时:终止并返回提示。
    _raise_for_failed_shell(shell.returncode, shell.output)
    #   非零退出 → 抛错。
    return shell.output.strip() or "(no output)"
    #   返回输出。
```

> **整块作用(bash.output)**:读后台 shell 的缓冲输出,支持 offset/limit 增量轮询。

```python
@tool(name="bash.output")
async def bash_output(shell_id, offset=0, limit=None) -> str:
    """Read buffered output from a background shell, with optional offset/limit for incremental polling."""
    shell = shell_manager.get(shell_id)
    if shell.returncode is not None:
        await shell_manager.wait_closed(shell_id)
        #   已退出 → 收尾(确保读全)。
    output = shell.output
    start = max(0, min(offset, len(output)))
    end = len(output) if limit is None else min(len(output), start + max(0, limit))
    chunk = output[start:end].rstrip()
    #   按 offset/limit 切片(增量轮询用)。
    exit_code = "null" if shell.returncode is None else str(shell.returncode)
    body = chunk or "(no output)"
    return f"id: {shell.shell_id}\nstatus: {shell.status}\nexit_code: {exit_code}\nnext_offset: {end}\noutput:\n{body}"
    #   返回带 next_offset 的结构(模型可据它下次接着读)。
```

> **整块作用(bash.kill)**:终止后台 shell。

```python
@tool(name="bash.kill")
async def kill_bash(shell_id) -> str:
    """Terminate a background shell process."""
    shell = shell_manager.get(shell_id)
    if shell.returncode is None:
        shell = await shell_manager.terminate(shell_id)   # 还在跑 → 终止
    else:
        await shell_manager.wait_closed(shell_id)         # 已退出 → 收尾
    return f"id: {shell.shell_id}\nstatus: {shell.status}\nexit_code: {shell.returncode}"
```

---

## 文件工具:fs.read / fs.write / fs.edit

> **整块作用**:读(支持分页)、写、按"找旧串换新串"编辑。路径经 `_resolve_path` 限定在工作区内。

```python
@tool(context=True, name="fs.read")
def fs_read(path, offset=0, limit=None, *, context: ToolContext) -> str:
    """Read a text file ... Supports optional pagination with offset and limit."""
    resolved_path = _resolve_path(context, path)
    text = resolved_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    start = max(0, min(offset, len(lines)))
    end = len(lines) if limit is None else min(len(lines), start + max(0, limit))
    return "\n".join(lines[start:end])
    #   按行分页返回。

@tool(context=True, name="fs.write")
def fs_write(path, content, *, context: ToolContext) -> str:
    """Write content to a text file."""
    resolved_path = _resolve_path(context, path)
    resolved_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_path.write_text(content, encoding="utf-8")
    return f"wrote: {resolved_path}"

@tool(context=True, name="fs.edit")
def fs_edit(path, old, new, start=0, *, context: ToolContext) -> str:
    """Edit a text file by replacing old text with new text. You can specify the line number to start ..."""
    resolved_path = _resolve_path(context, path)
    text = resolved_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    prev, to_replace = "\n".join(lines[:start]), "\n".join(lines[start:])
    #   从 start 行起分成"前缀不动"与"待替换区"。
    if old not in to_replace:
        raise ValueError(f"'{old}' not found in {resolved_path} from line {start}")
        #   找不到旧串 → 报错(避免误改)。
    replaced = to_replace.replace(old, new)
    if prev:
        replaced = prev + "\n" + replaced
        #   拼回前缀。
    resolved_path.write_text(replaced, encoding="utf-8")
    return f"edited: {resolved_path}"
```

---

## 技能工具:skill

> **整块作用**:按名加载技能内容(受 allowed_skills 白名单限制),返回位置 + 正文。

```python
@tool(context=True, name="skill")
def skill_describe(name, *, context: ToolContext) -> str:
    """Load the skill content by name. Return the location and skill content."""
    from backend.utils.utils import workspace_from_state
    allowed_skills = context.state.get("allowed_skills")
    if allowed_skills is not None and name.casefold() not in allowed_skills:
        return f"(skill '{name}' is not allowed in this context)"
        #   不在白名单 → 拒绝。
    workspace = workspace_from_state(context.state)
    skill_index = {skill.name: skill for skill in discover_skills(workspace)}
    if name.casefold() not in skill_index:
        return "(no such skill)"
    skill = skill_index[name.casefold()]
    return f"Location: {skill.location}\n---\n{skill.body() or '(no content)'}"
    #   返回技能位置 + 正文(模型据此执行技能)。
```

---

## tape 工具:info / search / reset / handoff / anchors

> **整块作用**:暴露 tape 操作给模型——查看统计、搜索历史、重置、交接(压缩历史)、列锚点。全部经 agent.tapes。

```python
@tool(context=True, name="tape.info")
async def tape_info(context: ToolContext) -> str:
    """Get information about the current tape ..."""
    agent = _get_agent(context)
    info = await agent.tapes.info(context.tape or "")
    return (f"name: {info.name}\nentries: {info.entries}\nanchors: {info.anchors}\n"
            f"last_anchor: {info.last_anchor}\nentries_since_last_anchor: {info.entries_since_last_anchor}\n"
            f"last_token_usage: {info.last_token_usage}")
    #   返回 tape 统计(系统提示提到上下文过长时用它看 token)。

@tool(context=True, name="tape.search", model=SearchInput)
async def tape_search(param: SearchInput, *, context: ToolContext) -> str:
    """Search for entries in the current tape that match the query ..."""
    agent = _get_agent(context)
    query = (TapeQuery[AsyncTapeStore](tape=context.tape or "", store=agent.tapes._store)
             .query(param.query).kinds(*param.kinds).limit(param.limit))
    #   构造查询(关键词 + kind + 限量)。
    if param.start or param.end:
        query = query.between_dates(param.start or "", param.end or "")
        #   可选日期区间。
    entries = await agent.tapes.search(query)
    lines: list[str] = []
    for entry in entries:
        entry_str = json.dumps({"date": entry.date, "content": entry.payload})
        if "[tape.search]" in entry_str:
            continue
            #   过滤掉"搜索结果自身"产生的条目(避免递归噪声)。
        lines.append(entry_str)
    return f"[tape.search]: {len(lines)} matches ({len(entries) - len(lines)} filtered)" + "".join(f"\n{line}" for line in lines)

@tool(context=True, name="tape.reset")
async def tape_reset(archive=False, *, context: ToolContext) -> str:
    """Reset the current tape, optionally archiving it."""
    agent = _get_agent(context)
    return await agent.tapes.reset(context.tape or "", archive=archive)
    #   清空 tape(可先归档)。

@tool(context=True, name="tape.handoff")
async def tape_handoff(name="handoff", summary="", *, context: ToolContext) -> str:
    """Add a handoff anchor to the current tape."""
    agent = _get_agent(context)
    await agent.tapes.handoff(context.tape or "", name=name, state={"summary": summary})
    return f"anchor added: {name}"
    #   ⭐ 模型可主动 handoff 压缩历史(系统提示鼓励上下文过长时用它)。

@tool(context=True, name="tape.anchors")
async def tape_anchors(*, context: ToolContext) -> str:
    """List anchors in the current tape."""
    agent = _get_agent(context)
    anchors = await agent.tapes.anchors(context.tape or "")
    if not anchors:
        return "(no anchors)"
    return "\n".join(f"- {anchor.name}" for anchor in anchors)
```

---

## web.fetch:抓网页

> **整块作用**:GET 一个 URL,优先返回 markdown。

```python
@tool(name="web.fetch")
async def web_fetch(url, headers=None, timeout=None) -> str:
    """Fetch(GET) the content of a web page, returning markdown if possible."""
    import aiohttp
    headers = {**DEFAULT_HEADERS, **(headers or {})}   # 默认偏好 markdown,可覆盖
    timeout = timeout or DEFAULT_REQUEST_TIMEOUT_SECONDS
    async with (
        aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=timeout)) as session,
        session.get(url) as response,
    ):
        response.raise_for_status()
        return await response.text()
        #   返回响应文本。
```

---

## 库存业务工具:query.inventory / send.report

> **整块作用(query.inventory)**:查全部零件库存,写 Excel,并把结果存进 state(供 send.report 用)。

```python
@tool(context=True, name="query.inventory")
async def query_inventory(*, context: ToolContext) -> str:
    """Query the inventory of all parts in the database and write inventory.xlsx under cwd."""
    try:
        inventory_query = InventoryQuery()
        results = await asyncio.to_thread(inventory_query.query)  # 防止查库阻塞(同步查询丢线程池)
        resolved_path = _resolve_cwd_path(f"inventory_{datetime.now().strftime('%Y_%m_%d_%H_%M')}.xlsx")
        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        expansion_write_excel(results, str(resolved_path))   # 写带格式的 Excel(见 filetool)
        context.state["inventory_data"] = results            # 结果存 state
        context.state["inventory_count"] = len(results)
        context.state["excel_path"] = str(resolved_path)     # Excel 路径(send.report 用)
    except Exception:
        return "Failed to parse the results."
    return json.dumps(results, ensure_ascii=False)
    #   返回 JSON 结果(给模型/后处理)。
```

> **整块作用(send.report)**:把上一步生成的 Excel 上传飞书并发到指定群(每日盘点报告)。

```python
@tool(context=True, name="send.report")
async def send_report(message, *, context: ToolContext) -> str:
    """Send files and messages to the designated Feishu chat."""
    try:
        feishu_settings = FeishuSettings()
        access_token = get_feishu_tenant_access_token(feishu_settings)   # 取 tenant token
        file_path = context.state.get("excel_path")
        resolved_file = _resolve_cwd_path(str(file_path))
        if not resolved_file.is_file():
            return f"❌ 飞书发送失败：文件不存在 {resolved_file}"
        session_id = str(context.state.get("session_id", ""))
        chat_id = resolve_feishu_chat_id(feishu_settings, session_id)    # 据 session/配置解析 chat_id
        base = feishu_settings.base_url.rstrip("/")
        auth_headers = {"Authorization": f"Bearer {access_token}"}
        file_type = "stream"   # xlsx 不在官方枚举里,用 stream
        with resolved_file.open("rb") as f:
            upload_res = requests.post(
                f"{base}/open-apis/im/v1/files",
                headers=auth_headers,
                data={"file_type": file_type, "file_name": resolved_file.name},
                files={"file": (resolved_file.name, f)},
                timeout=60,
            ).json()
            #   先上传文件,拿 file_key。
        if int(upload_res.get("code", -1)) != 0:
            return f"❌ 飞书上传失败：{upload_res.get('msg', upload_res)}"
        file_key = upload_res["data"]["file_key"]
        send_feishu_message(base=base, auth_headers=auth_headers, chat_id=chat_id, msg_type="text",
            content={"text": f"每日零件盘点报告 - {datetime.now().strftime('%Y-%m-%d-%H:%M:%S')}\n 详细数据见附件表格文件：{resolved_file.name}"})
        #   先发文字说明。
        send_feishu_message(base=base, auth_headers=auth_headers, chat_id=chat_id, msg_type="file",
            content={"file_key": file_key})
        #   再发文件。
        return f"✅ 飞书消息已发送至 {chat_id}，附件：{resolved_file.name}（file_key={file_key}）"  # noqa: TRY300
    except Exception as e:
        return f"❌ 飞书发送失败：{e}"
```

---

## subagent:子 agent

> **整块作用**:用指定模型/会话/白名单跑一个子 agent,把它的流式输出拼成文本返回。

```python
@tool(name="subagent", context=True, model=SubAgentInput)
async def run_subagent(param: SubAgentInput, *, context: ToolContext) -> str:
    """Run a task with sub-agent using specific model and session."""
    agent = _get_agent(context)
    session_id = context.state.get("session_id", "temp/unknown")
    if param.session == "inherit":
        subagent_session = session_id          # 继承当前会话(共享历史)
    elif param.session == "temp":
        subagent_session = f"temp/{uuid.uuid4().hex[:8]}"   # 临时会话(用完即弃,merge_back=False)
    else:
        subagent_session = param.session
    state = {**context.state, "session_id": subagent_session}
    allowed_tools = resolve_tool_names(param.allowed_tools or None, exclude={"subagent"})
    #   解析子 agent 可用工具(默认全部,但排除 subagent 自身——防无限递归)。
    output = ""
    async for event in await agent.run_stream(
        session_id=subagent_session, prompt=param.prompt, state=state,
        model=param.model, allowed_tools=allowed_tools, allowed_skills=param.allowed_skills,
    ):
        #   跑子 agent(流式),把事件拼成文本。
        if event.kind == "error":
            output += f"[Error: {event.data.get('message', 'unknown error')}]"
        elif event.kind == "text":
            output += str(event.data.get("delta", ""))
    return output
    #   返回子 agent 的完整输出。
```

---

## help / quit

> **整块作用**:help 列出内部命令;quit 停止当前会话的所有 turn 任务。

```python
@tool(name="help")
def show_help() -> str:
    """Show a help message."""
    return (...内部命令清单...)   # /help /skill /tape.* /fs.* /bash* /quit 等

@tool(name="quit", context=True)
async def quit_tool(*, context: ToolContext) -> str:
    """Quit the tasks of the current session."""
    agent = _get_agent(context)
    session_id = context.state.get("session_id", "temp/unknown")
    await agent.framework.quit_via_router(session_id)   # 经路由取消该会话在途任务(见 manager.quit)
    return "Session tasks stopped."
```

---

## 路径解析 helper

> **整块作用**:`_resolve_cwd_path` 相对 cwd 解析;`_resolve_path` 把相对路径限定在工作区内(安全)。

```python
def _resolve_cwd_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (Path.cwd() / path).resolve()
    #   相对 → 基于 cwd。

def _resolve_path(context: ToolContext, raw_path: str) -> Path:
    workspace = context.state.get("_runtime_workspace")
    path = Path(raw_path).expanduser()
    if path.is_absolute():
        return path
        #   绝对路径直接用。
    if workspace is None:
        raise ValueError(f"relative path '{raw_path}' is not allowed without a workspace")
        #   没有工作区却给相对路径 → 拒绝(安全)。
    if not isinstance(workspace, str | Path):
        raise TypeError("runtime workspace must be a filesystem path")
    workspace_path = Path(workspace)
    return (workspace_path / path).resolve()
    #   相对路径 → 基于工作区解析(把文件操作限定在工作区内)。
```

---

## 怎么和别的文件连起来

- `tools/tools.py`:`@tool` 注册、`resolve_tool_names`。
- `tools/shelltool/shell_manager.py`:bash 系列;`tools/filetool/file_impl.py`:Excel;`tools/channeltool/tool_feishu.py`:飞书发送。
- `inventory/inventory_query.py`:query.inventory。
- `agent/agent.py`:`_get_agent` 取的 agent(tape/subagent/quit 用);`ToolContext.state` 由 load_state 填。
- `hook_impl.__init__`:`import toolimpl` 触发本文件全部 `@tool` 注册。

---

## 一句话总结

`toolimpl.py` 是 agent 的"能力库":shell/文件/技能/tape/web/库存/飞书/子agent/help/quit 一应俱全,全部经
`@tool` 注册进 REGISTRY,context 感知工具能拿到运行时 agent 与 state。换业务时增删这里的工具即可。
