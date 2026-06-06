"""Model turn execution — project-owned (LangChain).

``run_step`` runs a single non-streaming turn; ``stream_step`` runs a streaming
turn yielding :class:`StreamEvent`. Both: replay the tape into LangChain messages,
call the chat model (binding tools), promote native *and* embedded tool calls,
execute them, and persist the new entries back onto the tape.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from loguru import logger

from backend.architecture.core.errors import AgentError, ErrorKind
from backend.architecture.core.events import AsyncStreamEvents, StreamEvent, StreamState
from backend.architecture.core.tape_types import TapeEntry
from backend.architecture.core.tools import ToolAutoResult, ToolContext
from backend.architecture.llm.client import build_chat_model
from backend.architecture.llm.embedded_tools import extract_embedded_tool_calls
from backend.architecture.llm.messages import build_lc_tools, to_lc_messages

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langchain_core.tools import StructuredTool

    from backend.architecture.agent.settings import AgentSettings
    from backend.architecture.core.engine import Tape
    from backend.architecture.core.tools import Tool


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        return "".join(parts)
    return str(content) if content is not None else ""


def _user_payload(prompt: str | list[dict]) -> dict[str, Any]:
    return {"role": "user", "content": prompt}


def _openai_tool_call(name: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


async def _execute_tool_calls(
    tool_calls: list[dict[str, Any]],
    lc_tools: list[StructuredTool],
) -> tuple[list[dict[str, Any]], list[Any]]:
    by_name = {lc_tool.name: lc_tool for lc_tool in lc_tools}
    openai_calls: list[dict[str, Any]] = []
    results: list[Any] = []
    for index, call in enumerate(tool_calls):
        name = call.get("name", "")
        args = call.get("args") or {}
        call_id = call.get("id") or f"call_{index}"
        openai_calls.append(_openai_tool_call(name, args, call_id))
        lc_tool = by_name.get(name)
        if lc_tool is None:
            results.append(f"error: unknown tool '{name}'")
            continue
        results.append(await lc_tool.ainvoke(args))
    return openai_calls, results


def _collect_tool_calls(message: Any, text: str) -> list[dict[str, Any]]:
    native = list(getattr(message, "tool_calls", None) or [])
    if native:
        return [
            {"name": call.get("name", ""), "args": call.get("args") or {}, "id": call.get("id") or f"call_{i}"}
            for i, call in enumerate(native)
        ]
    return extract_embedded_tool_calls(text)


async def run_step(
    *,
    tape: Tape,
    prompt: str | list[dict],
    system_prompt: str | None,
    tools: list[Tool],
    model: str | None,
    settings: AgentSettings,
    chat_model: BaseChatModel | None = None,
) -> ToolAutoResult:
    """Run one non-streaming model turn and persist the resulting tape entries."""
    run_id = uuid.uuid4().hex
    chat_model = chat_model or build_chat_model(settings, model)
    context = ToolContext(tape=tape.name, run_id=run_id, state=dict(tape.context.state))
    lc_tools = build_lc_tools(tools, context)
    bound = chat_model.bind_tools(lc_tools) if lc_tools else chat_model

    history = await tape.read_messages_async(context=tape.context)
    lc_messages = to_lc_messages([*history, _user_payload(prompt)], system_prompt=system_prompt)
    await tape.append_async(TapeEntry.message(_user_payload(prompt), run_id=run_id))

    try:
        message = await bound.ainvoke(lc_messages)
    except Exception as exc:  # noqa: BLE001 - surfaced as an error result
        logger.exception("llm.run_step.error tape={} error={}", tape.name, str(exc))
        error = AgentError(ErrorKind.PROVIDER, str(exc))
        await tape.append_async(TapeEntry.error(error, run_id=run_id))
        return ToolAutoResult.error_result(error)

    text = _content_text(message.content)
    tool_calls = _collect_tool_calls(message, text)
    if tool_calls:
        openai_calls, results = await _execute_tool_calls(tool_calls, lc_tools)
        await tape.append_async(TapeEntry.tool_call(openai_calls, run_id=run_id))
        await tape.append_async(TapeEntry.tool_result(results, run_id=run_id))
        return ToolAutoResult.tools_result(openai_calls, results)

    await tape.append_async(TapeEntry.message({"role": "assistant", "content": text}, run_id=run_id))
    return ToolAutoResult.text_result(text)


async def stream_step(
    *,
    tape: Tape,
    prompt: str | list[dict],
    system_prompt: str | None,
    tools: list[Tool],
    model: str | None,
    settings: AgentSettings,
    chat_model: BaseChatModel | None = None,
) -> AsyncStreamEvents:
    """Run one streaming model turn, returning events plus terminal state."""
    run_id = uuid.uuid4().hex
    chat_model = chat_model or build_chat_model(settings, model)
    context = ToolContext(tape=tape.name, run_id=run_id, state=dict(tape.context.state))
    lc_tools = build_lc_tools(tools, context)
    bound = chat_model.bind_tools(lc_tools) if lc_tools else chat_model

    history = await tape.read_messages_async(context=tape.context)
    lc_messages = to_lc_messages([*history, _user_payload(prompt)], system_prompt=system_prompt)
    await tape.append_async(TapeEntry.message(_user_payload(prompt), run_id=run_id))

    state = StreamState()

    async def _generate() -> AsyncIterator[StreamEvent]:
        parts: list[str] = []
        aggregate: Any = None
        try:
            async for chunk in bound.astream(lc_messages):
                aggregate = chunk if aggregate is None else aggregate + chunk
                delta = _content_text(chunk.content)
                if delta:
                    parts.append(delta)
                    yield StreamEvent("text", {"delta": delta})
        except Exception as exc:  # noqa: BLE001 - surfaced as an error event
            logger.exception("llm.stream_step.error tape={} error={}", tape.name, str(exc))
            error = AgentError(ErrorKind.PROVIDER, str(exc))
            state.error = error
            await tape.append_async(TapeEntry.error(error, run_id=run_id))
            yield StreamEvent("error", {"message": str(exc)})
            yield StreamEvent("final", {"text": "", "ok": False})
            return

        text = "".join(parts)
        tool_calls = _collect_tool_calls(aggregate, text)
        if tool_calls:
            openai_calls, results = await _execute_tool_calls(tool_calls, lc_tools)
            await tape.append_async(TapeEntry.tool_call(openai_calls, run_id=run_id))
            await tape.append_async(TapeEntry.tool_result(results, run_id=run_id))
            yield StreamEvent("final", {"text": text, "tool_calls": openai_calls, "tool_results": results})
            return

        await tape.append_async(TapeEntry.message({"role": "assistant", "content": text}, run_id=run_id))
        yield StreamEvent("final", {"text": text, "ok": True})

    return AsyncStreamEvents(_generate(), state=state)


__all__ = ["run_step", "stream_step"]
