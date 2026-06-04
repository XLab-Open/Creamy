"""Republic-driven runtime engine to process prompts."""

from __future__ import annotations

import asyncio
import inspect
import re
import shlex
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Collection, Coroutine, Iterable
from contextlib import AsyncExitStack
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from functools import cached_property
from pathlib import Path
from typing import Any, Literal, overload

from loguru import logger
from republic import (
    LLM,
    AsyncStreamEvents,
    AsyncTapeStore,
    RepublicError,
    StreamEvent,
    StreamState,
    TapeContext,
    ToolAutoResult,
    ToolContext,
)
from republic.tape import InMemoryTapeStore, Tape

from backend.app.framework import CreamyFramework
from backend.architecture.agent.settings import AgentSettings, load_settings
from backend.architecture.memory.store import ForkTapeStore
from backend.architecture.memory.tape import TapeService
from backend.architecture.llm.llm_parsing import install_completion_tool_call_compat
from backend.architecture.skills.skills import discover_skills, render_skills_prompt
from backend.architecture.tool.tools import REGISTRY, model_tools, render_tools_prompt
from backend.architecture.utils.types import State
from backend.architecture.utils.utils import workspace_from_state

CONTINUE_PROMPT = "Continue the task."
HINT_RE = re.compile(r"\$([A-Za-z0-9_.-]+)")
_CONTEXT_LENGTH_PATTERNS = re.compile(
    r"context.{0,20}length|maximum.{0,20}context|token.{0,10}limit|prompt.{0,10}too long|tokens? > \d+ maximum",
    re.IGNORECASE,
)
MAX_AUTO_HANDOFF_RETRIES = 1


class Agent:
    """Agent that processes prompts using hooks and tools. Backed by republic."""

    def __init__(self, framework: CreamyFramework) -> None:
        self.settings = load_settings()
        self.framework = framework

    @cached_property
    def tapes(self) -> TapeService:
        tape_store = self.framework.get_tape_store()
        if tape_store is None:
            tape_store = InMemoryTapeStore()
        tape_store = ForkTapeStore(tape_store)
        llm = _build_llm(self.settings, tape_store, self.framework.build_tape_context())
        return TapeService(llm, self.settings.home / "tapes", tape_store)

    @staticmethod
    def _events_from_iterable(iterable: Iterable) -> AsyncStreamEvents:
        async def generator() -> AsyncIterator:
            for item in iterable:
                yield item

        return AsyncStreamEvents(generator())

    @staticmethod
    def _events_with_callback(
        events: AsyncStreamEvents, callback: Callable[[], Coroutine[Any, Any, Any]]
    ) -> AsyncStreamEvents:
        async def generator() -> AsyncIterator[StreamEvent]:
            async for event in events:
                yield event
            await callback()

        return AsyncStreamEvents(generator(), state=events._state)

    async def run(
        self,
        *,
        session_id: str,
        prompt: str | list[dict],
        state: State,
        model: str | None = None,
        allowed_skills: Collection[str] | None = None,
        allowed_tools: Collection[str] | None = None,
    ) -> str:
        if not prompt:
            return "error: empty prompt"
        tape = self.tapes.session_tape(session_id, workspace_from_state(state))
        tape.context = replace(tape.context, state=state)
        merge_back = not session_id.startswith("temp/")
        async with self.tapes.fork_tape(tape.name, merge_back=merge_back):
            await self.tapes.ensure_bootstrap_anchor(tape.name)
            if isinstance(prompt, str) and prompt.strip().startswith(","):
                return await self._run_command(tape=tape, line=prompt.strip())
            return await self._agent_loop(
                tape=tape, prompt=prompt, model=model, allowed_skills=allowed_skills, allowed_tools=allowed_tools
            )

    async def run_stream(
        self,
        *,
        session_id: str,
        prompt: str | list[dict],
        state: State,
        model: str | None = None,
        allowed_skills: Collection[str] | None = None,
        allowed_tools: Collection[str] | None = None,
    ) -> AsyncStreamEvents:
        if not prompt:
            events = [
                StreamEvent("text", {"delta": "error: empty prompt"}),
                StreamEvent("final", {"text": "error: empty prompt", "ok": False}),
            ]
            return self._events_from_iterable(events)

        tape = self.tapes.session_tape(session_id, workspace_from_state(state))
        tape.context = replace(tape.context, state=state)
        merge_back = not session_id.startswith("temp/")
        stack = AsyncExitStack()
        # the fork_tape context manager must not be exited until the last chunk of the stream is consumed.
        # So we use an AsyncExitStack and inject a callback to the iterator.
        await stack.enter_async_context(self.tapes.fork_tape(tape.name, merge_back=merge_back))
        await self.tapes.ensure_bootstrap_anchor(tape.name)
        if isinstance(prompt, str) and prompt.strip().startswith(","):
            result = await self._run_command(tape=tape, line=prompt.strip())
            events = self._events_from_iterable([
                StreamEvent("text", {"delta": result}),
                StreamEvent("final", {"text": result, "ok": True}),
            ])
        else:
            events = await self._agent_loop(
                tape=tape,
                prompt=prompt,
                model=model,
                allowed_skills=allowed_skills,
                allowed_tools=allowed_tools,
                stream_output=True,
            )
        return self._events_with_callback(events, callback=stack.aclose)

    async def _run_command(self, tape: Tape, *, line: str) -> str:
        line = line[1:].strip()
        if not line:
            raise ValueError("empty command")

        name, arg_tokens = _parse_internal_command(line)
        start = time.monotonic()
        context = ToolContext(tape=tape.name, run_id="run_command", state=tape.context.state)
        output = ""
        status = "ok"
        try:
            if name not in REGISTRY:
                output = await REGISTRY["bash"].run(context=context, cmd=line)
            else:
                args = _parse_args(arg_tokens)
                if REGISTRY[name].context:
                    args.kwargs["context"] = context
                output = REGISTRY[name].run(*args.positional, **args.kwargs)
                if inspect.isawaitable(output):
                    output = await output
        except Exception as exc:
            status = "error"
            output = f"{exc!s}"
            raise
        else:
            return output if isinstance(output, str) else str(output)
        finally:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            output_text = output if isinstance(output, str) else str(output)

            event_payload = {
                "raw": line,
                "name": name,
                "status": status,
                "elapsed_ms": elapsed_ms,
                "output": output_text,
                "date": datetime.now(UTC).isoformat(),
            }
            await self.tapes.append_event(tape.name, "command", event_payload)

    @overload
    async def _agent_loop(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = ...,
        allowed_skills: Collection[str] | None = ...,
        allowed_tools: Collection[str] | None = ...,
        stream_output: Literal[False] = ...,
    ) -> str: ...

    @overload
    async def _agent_loop(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = ...,
        allowed_skills: Collection[str] | None = ...,
        allowed_tools: Collection[str] | None = ...,
        stream_output: Literal[True] = ...,
    ) -> AsyncStreamEvents: ...

    async def _agent_loop(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = None,
        allowed_skills: Collection[str] | None = None,
        allowed_tools: Collection[str] | None = None,
        stream_output: bool = False,
    ) -> AsyncStreamEvents | str:
        next_prompt: str | list[dict] = prompt
        display_model = model or self.settings.model
        await self.tapes.append_event(
            tape.name,
            "loop.start",
            {
                "model": display_model,
                "prompt": prompt,
                "allowed_skills": list(allowed_skills) if allowed_skills else None,
                "allowed_tools": list(allowed_tools) if allowed_tools else None,
            },
        )
        if stream_output:
            state = StreamState()
            iterator = self._stream_events_with_auto_handoff(
                tape=tape,
                prompt=next_prompt,
                state=state,
                model=model,
                allowed_skills=allowed_skills,
                allowed_tools=allowed_tools,
            )
            return AsyncStreamEvents(iterator, state=state)
        else:
            return await self._run_tools_with_auto_handoff(
                tape=tape,
                prompt=next_prompt,
                model=model,
                allowed_skills=allowed_skills,
                allowed_tools=allowed_tools,
            )

    async def _run_tools_with_auto_handoff(
        self,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = None,
        allowed_skills: Collection[str] | None = None,
        allowed_tools: Collection[str] | None = None,
    ) -> str:
        auto_handoff_remaining = MAX_AUTO_HANDOFF_RETRIES
        display_model = model or self.settings.model
        next_prompt = prompt
        for step in range(1, self.settings.max_steps + 1):
            start = time.monotonic()
            logger.info("loop.step step={} tape={} model={}", step, tape.name, display_model)
            await self.tapes.append_event(tape.name, "loop.step.start", {"step": step, "prompt": next_prompt})
            try:
                output = await self._run_once(
                    tape=tape,
                    prompt=next_prompt,
                    model=model,
                    allowed_skills=allowed_skills,
                    allowed_tools=allowed_tools,
                )
            except Exception as exc:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                logger.exception(
                    "llm.call.exception tape={} step={} model={} elapsed_ms={} prompt_chars={} error={}",
                    tape.name,
                    step,
                    display_model,
                    elapsed_ms,
                    len(next_prompt) if isinstance(next_prompt, str) else len(_extract_text_from_parts(next_prompt)),
                    str(exc),
                )
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "error",
                        "error": f"{exc!s}",
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                raise

            outcome = _resolve_tool_auto_result(output)
            elapsed_ms = int((time.monotonic() - start) * 1000)
            if outcome.kind == "text":
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "ok",
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                return outcome.text
            if outcome.kind == "continue":
                if "context" in tape.context.state:
                    next_prompt = f"{CONTINUE_PROMPT} [context: {tape.context.state['context']}]"
                else:
                    next_prompt = CONTINUE_PROMPT
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "continue",
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                continue

            # Check if this is a context-length error that can be recovered via auto-handoff
            if auto_handoff_remaining > 0 and _is_context_length_error(outcome.error):
                auto_handoff_remaining -= 1
                logger.warning(
                    "auto_handoff: context length exceeded, performing automatic handoff. tape={} step={}",
                    tape.name,
                    step,
                )
                await self.tapes.handoff(
                    tape.name,
                    name="auto_handoff/context_overflow",
                    state={"reason": "context_length_exceeded", "error": outcome.error},
                )
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "auto_handoff",
                        "error": outcome.error,
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                # Retry with original prompt — the handoff anchor will truncate history
                next_prompt = prompt
                continue

            await self.tapes.append_event(
                tape.name,
                "loop.step",
                {
                    "step": step,
                    "elapsed_ms": elapsed_ms,
                    "status": "error",
                    "error": outcome.error,
                    "date": datetime.now(UTC).isoformat(),
                },
            )
            raise RuntimeError(outcome.error)

        raise RuntimeError(f"max_steps_reached={self.settings.max_steps}")

    async def _stream_events_with_auto_handoff(
        self,
        tape: Tape,
        prompt: str | list[dict],
        state: StreamState,
        model: str | None = None,
        allowed_skills: Collection[str] | None = None,
        allowed_tools: Collection[str] | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        auto_handoff_remaining = MAX_AUTO_HANDOFF_RETRIES
        display_model = model or self.settings.model
        next_prompt = prompt
        for step in range(1, self.settings.max_steps + 1):
            start = time.monotonic()
            outcome = _ToolAutoOutcome(kind="text", text="", error="")
            logger.info("loop.step step={} tape={} model={}", step, tape.name, display_model)
            await self.tapes.append_event(tape.name, "loop.step.start", {"step": step, "prompt": next_prompt})
            output = await self._run_once(
                tape=tape,
                prompt=next_prompt,
                model=model,
                allowed_skills=allowed_skills,
                allowed_tools=allowed_tools,
                stream_output=True,
            )
            async for event in output:
                yield event
                if event.kind == "error":
                    elapsed_ms = int((time.monotonic() - start) * 1000)
                    await self.tapes.append_event(
                        tape.name,
                        "loop.step",
                        {
                            "step": step,
                            "elapsed_ms": elapsed_ms,
                            "status": "error",
                            "error": event.data.get("message", ""),
                            "date": datetime.now(UTC).isoformat(),
                        },
                    )
                elif event.kind == "final":
                    outcome = _resolve_final_data(event.data, output.error)

            state.error = output.error
            state.usage = output.usage
            elapsed_ms = int((time.monotonic() - start) * 1000)
            if outcome.kind == "text":
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "ok",
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                return
            if outcome.kind == "continue":
                if "context" in tape.context.state:
                    next_prompt = f"{CONTINUE_PROMPT} [context: {tape.context.state['context']}]"
                else:
                    next_prompt = CONTINUE_PROMPT
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "continue",
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                continue

            # Check if this is a context-length error that can be recovered via auto-handoff
            if auto_handoff_remaining > 0 and _is_context_length_error(outcome.error):
                auto_handoff_remaining -= 1
                logger.warning(
                    "auto_handoff: context length exceeded, performing automatic handoff. tape={} step={}",
                    tape.name,
                    step,
                )
                await self.tapes.handoff(
                    tape.name,
                    name="auto_handoff/context_overflow",
                    state={"reason": "context_length_exceeded", "error": outcome.error},
                )
                await self.tapes.append_event(
                    tape.name,
                    "loop.step",
                    {
                        "step": step,
                        "elapsed_ms": elapsed_ms,
                        "status": "auto_handoff",
                        "error": outcome.error,
                        "date": datetime.now(UTC).isoformat(),
                    },
                )
                # Retry with original prompt — the handoff anchor will truncate history
                next_prompt = prompt
                continue

            await self.tapes.append_event(
                tape.name,
                "loop.step",
                {
                    "step": step,
                    "elapsed_ms": elapsed_ms,
                    "status": "error",
                    "error": outcome.error,
                    "date": datetime.now(UTC).isoformat(),
                },
            )
            raise RuntimeError(outcome.error)

        raise RuntimeError(f"max_steps_reached={self.settings.max_steps}")

    def _load_skills_prompt(self, prompt: str, workspace: Path, allowed_skills: set[str] | None = None) -> str:
        skill_index = {
            skill.name.casefold(): skill
            for skill in discover_skills(workspace)
            if allowed_skills is None or skill.name.casefold() in allowed_skills
        }
        expanded_skills = set(HINT_RE.findall(prompt)) & set(skill_index.keys())
        return render_skills_prompt(list(skill_index.values()), expanded_skills=expanded_skills)

    @overload
    async def _run_once(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = ...,
        allowed_skills: Collection[str] | None = ...,
        allowed_tools: Collection[str] | None = ...,
        stream_output: Literal[False] = ...,
    ) -> ToolAutoResult: ...

    @overload
    async def _run_once(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = ...,
        allowed_skills: Collection[str] | None = ...,
        allowed_tools: Collection[str] | None = ...,
        stream_output: Literal[True] = ...,
    ) -> AsyncStreamEvents: ...

    async def _run_once(
        self,
        *,
        tape: Tape,
        prompt: str | list[dict],
        model: str | None = None,
        allowed_tools: Collection[str] | None = None,
        allowed_skills: Collection[str] | None = None,
        stream_output: bool = False,
    ) -> AsyncStreamEvents | ToolAutoResult:
        if allowed_tools is not None:
            allowed_tools = {name.casefold() for name in allowed_tools}
        if allowed_skills is not None:
            allowed_skills = {name.casefold() for name in allowed_skills}
            tape.context.state["allowed_skills"] = list(allowed_skills)
        if allowed_tools is not None:
            tools = [tool for tool in REGISTRY.values() if tool.name.casefold() in allowed_tools]
        else:
            tools = list(REGISTRY.values())
        system_prompt = self._system_prompt(prompt, state=tape.context.state, allowed_skills=allowed_skills)
        logger.info(
            "llm.call.start tape={} model={} stream_output={} system_prompt_chars={} tools={}",
            tape.name,
            self.settings.model,
            stream_output,
            len(system_prompt),
            len(tools),
        )
        async with asyncio.timeout(self.settings.model_timeout_seconds):
            if stream_output:
                return await tape.stream_events_async(
                    prompt=prompt,
                    system_prompt=system_prompt,
                    max_tokens=self.settings.max_tokens,
                    tools=model_tools(tools),
                    model=model,
                )
            else:
                return await tape.run_tools_async(
                    prompt=prompt,
                    system_prompt=system_prompt,
                    max_tokens=self.settings.max_tokens,
                    tools=model_tools(tools),
                    model=model,
                )

    def _system_prompt(self, prompt: str | list[dict], state: State, allowed_skills: set[str] | None = None) -> str:
        blocks: list[str] = []
        if result := self.framework.get_system_prompt(prompt=prompt, state=state):
            blocks.append(result)
        tools_prompt = render_tools_prompt(REGISTRY.values())
        if tools_prompt:
            blocks.append(tools_prompt)
        workspace = workspace_from_state(state)
        prompt_text = prompt if isinstance(prompt, str) else _extract_text_from_parts(prompt)
        if skills_prompt := self._load_skills_prompt(prompt_text, workspace, allowed_skills):
            blocks.append(skills_prompt)
        return "\n\n".join(blocks)


@dataclass(frozen=True)
class _ToolAutoOutcome:
    kind: str
    text: str = ""
    error: str = ""


def _resolve_final_data(final_data: dict[str, Any], error: RepublicError | None) -> _ToolAutoOutcome:
    if final_data.get("tool_calls") or final_data.get("tool_results"):
        return _ToolAutoOutcome(kind="continue")
    if (text := final_data.get("text")) is not None:
        return _ToolAutoOutcome(kind="text", text=text)
    error_message = error.message if error else ""
    return _ToolAutoOutcome(kind="error", error=error_message or "unknown error")


def _resolve_tool_auto_result(output: ToolAutoResult) -> _ToolAutoOutcome:
    if output.kind == "text":
        return _ToolAutoOutcome(kind="text", text=output.text or "")
    if output.kind == "tools" or output.tool_calls or output.tool_results:
        return _ToolAutoOutcome(kind="continue")
    if output.error is None:
        return _ToolAutoOutcome(kind="error", error="tool_auto_error: unknown")
    error_kind = getattr(output.error.kind, "value", str(output.error.kind))
    return _ToolAutoOutcome(kind="error", error=f"{error_kind}: {output.error.message}")

from typing import Optional
from datetime import datetime, timedelta
class DeepSeekKeyResolver:
    """
    DeepSeek API Key 解析器
    模拟 Republic 官方 OAuth Resolver 的行为模式
    """
    
    def __init__(self, api_key: Optional[str] = None):
        """
        初始化解析器
        
        Args:
            api_key: 可选的 API Key,如果不提供则从环境变量读取
        """
        # self._api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        # self._api_key = "sk-061b9c9c9f40428ab374680cd56ff05d"
        self._api_key = "sk-qtrdoedrxuzrprgmaboxhsvvrsoowdikzoaevwaejsukpkbv"
        if not self._api_key:
            raise RuntimeError(
                "请设置 DEEPSEEK_API_KEY 环境变量，或直接传入 api_key 参数"
            )
        
        # 模拟 token 信息（用于演示刷新机制）
        self._fetched_at: Optional[datetime] = None
        
    def __call__(self, provider: str | None = None) -> str:
        """
        当 LLM 需要 API Key 时会调用此方法
        Republic 会通过调用这个可调用对象来获取密钥
        
        Returns:
            有效的 API Key 字符串
        """
        # provider 参数由 republic 传入（例如 "deepseek"、"openrouter"）。
        # 本示例不区分 provider，统一返回当前 key。
        _ = provider

        # 这里可以添加刷新逻辑
        # 例如：检查 key 是否过期，如果过期则重新获取
        if self._needs_refresh():
            self._refresh()
        
        return self._api_key
    
    def _needs_refresh(self) -> bool:
        """检查是否需要刷新(演示用, DeepSeek API Key 通常不过期）"""
        if self._fetched_at is None:
            return True
        
        # 模拟：每 24 小时刷新一次（实际 DeepSeek Key 不需要）
        return datetime.now() - self._fetched_at > timedelta(hours=24)
    
    def _refresh(self) -> None:
        """刷新 Key(实际使用时可以在这里实现动态获取逻辑)"""
        # 实际使用时，可以在这里：
        # - 从远程服务获取新 Key
        # - 刷新 OAuth Token
        # - 从密钥管理服务读取
        self._fetched_at = datetime.now()
        print(f"[INFO] API Key 已刷新，获取时间: {self._fetched_at}")

def _build_llm(settings: AgentSettings, tape_store: AsyncTapeStore, tape_context: TapeContext) -> LLM:
    from republic.auth.openai_codex import openai_codex_oauth_resolver

    install_completion_tool_call_compat()
    key_resolver = DeepSeekKeyResolver()
    return LLM(
        model=settings.model,
        api_key=settings.api_key,
        api_base=settings.api_base,
        fallback_models=settings.fallback_models,
        # api_key_resolver=key_resolver,
        tape_store=tape_store,
        client_args=settings.client_args,
        api_format=settings.api_format,
        context=tape_context,
        verbose=settings.verbose,
    )

@dataclass(frozen=True)
class Args:
    positional: list[str]
    kwargs: dict[str, Any]


def _parse_internal_command(line: str) -> tuple[str, list[str]]:
    body = line.strip()
    words = shlex.split(body)
    if not words:
        return "", []
    return words[0], words[1:]


def _parse_args(args_tokens: list[str]) -> Args:
    positional: list[str] = []
    kwargs: dict[str, str] = {}
    first_kwarg = False
    for token in args_tokens:
        if "=" in token:
            key, value = token.split("=", 1)
            kwargs[key] = value
            first_kwarg = True
        elif first_kwarg:
            raise ValueError(f"positional argument '{token}' cannot appear after keyword arguments")
        else:
            positional.append(token)
    return Args(positional=positional, kwargs=kwargs)


def _is_context_length_error(error_msg: str) -> bool:
    """Check whether an error message indicates a context-length / prompt-too-long failure."""
    return bool(_CONTEXT_LENGTH_PATTERNS.search(error_msg))


def _extract_text_from_parts(parts: list[dict]) -> str:
    """Extract text content from multimodal content parts."""
    return "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
