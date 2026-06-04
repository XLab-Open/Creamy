"""Compatibility parsing for providers that embed tool calls in message text."""

from __future__ import annotations

import json
import re
from typing import Any

from republic.clients.parsing.common import expand_tool_calls, field
from republic.clients.parsing.completion import CompletionTransportParser

_TOOL_CALL_BLOCK_RE = re.compile(
    r"<tool_call>\s*(.*?)\s*</tool_call>",
    re.DOTALL | re.IGNORECASE,
)

_COMPAT_INSTALLED = False


def parse_embedded_tool_calls(text: str) -> list[dict[str, Any]]:
    """Parse ``<tool_call>{...}</tool_call>`` blocks into OpenAI-style tool call dicts."""
    if not text:
        return []

    calls: list[dict[str, Any]] = []
    for index, match in enumerate(_TOOL_CALL_BLOCK_RE.finditer(text)):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue

        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            function = payload.get("function")
            if isinstance(function, dict):
                name = function.get("name")
        if not isinstance(name, str) or not name.strip():
            continue

        arguments = payload.get("arguments")
        if arguments is None and isinstance(payload.get("function"), dict):
            arguments = payload["function"].get("arguments")
        if isinstance(arguments, dict):
            arguments_str = json.dumps(arguments, ensure_ascii=False)
        elif isinstance(arguments, str):
            arguments_str = arguments
        else:
            arguments_str = "{}"

        calls.append(
            {
                "id": f"embedded_call_{index}",
                "type": "function",
                "function": {
                    "name": name.strip(),
                    "arguments": arguments_str,
                },
            }
        )

    return expand_tool_calls(calls)


def strip_embedded_tool_calls(text: str) -> str:
    """Remove embedded tool-call markup from assistant-visible text."""
    if not text:
        return ""
    stripped = _TOOL_CALL_BLOCK_RE.sub("", text)
    return stripped.strip()


class CreamyCompletionTransportParser(CompletionTransportParser):
    """Completion parser with fallback for text-embedded tool calls (e.g. SiliconFlow Qwen)."""

    def extract_tool_calls(self, response: Any) -> list[dict[str, Any]]:
        calls = super().extract_tool_calls(response)
        if calls:
            return calls
        return parse_embedded_tool_calls(self._embedded_tool_call_text(response))

    def extract_text(self, response: Any) -> str:
        text = super().extract_text(response)
        if not text:
            return text
        if parse_embedded_tool_calls(text):
            return strip_embedded_tool_calls(text)
        return text

    @staticmethod
    def _embedded_tool_call_text(response: Any) -> str:
        choices = field(response, "choices")
        if not choices:
            return ""
        message = field(choices[0], "message")
        if message is None:
            return ""

        parts: list[str] = []
        content = field(message, "content", "") or ""
        if content:
            parts.append(content)

        reasoning_content = field(message, "reasoning_content", "") or ""
        if reasoning_content:
            parts.append(reasoning_content)

        reasoning = field(message, "reasoning")
        if reasoning is not None:
            reasoning_text = field(reasoning, "content", "") or ""
            if reasoning_text:
                parts.append(reasoning_text)

        return "\n".join(parts)


def install_completion_tool_call_compat() -> None:
    """Register Creamy's completion parser so Republic can execute embedded tool calls."""
    global _COMPAT_INSTALLED
    if _COMPAT_INSTALLED:
        return

    import republic.clients.parsing as parsing_module

    parser = CreamyCompletionTransportParser()
    parsing_module._PARSERS["completion"] = parser
    parsing_module._PARSERS["messages"] = parser
    _COMPAT_INSTALLED = True
