"""LangChain chat-model factory — project-owned.

Builds a ``ChatOpenAI`` for the configured ``provider:model``. OpenAI-compatible
providers (openai, openrouter, …) all route through ``ChatOpenAI`` with an
optional ``api_base``. When the OpenAI api key is actually a Codex OAuth token,
the client is pointed at the ChatGPT Codex Responses backend.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from langchain_openai import ChatOpenAI

from backend.architecture.agent.codex_oauth import (
    build_codex_headers,
    is_codex_token,
    resolve_codex_api_base,
)

if TYPE_CHECKING:
    from backend.architecture.agent.settings import AgentSettings


def _split_provider_model(value: str) -> tuple[str, str]:
    if ":" in value:
        provider, model = value.split(":", 1)
        return provider.strip().lower(), model.strip()
    return "openai", value.strip()


def _resolve_for_provider(value: str | dict[str, str] | None, provider: str) -> str | None:
    if isinstance(value, dict):
        return value.get(provider)
    return value


def build_chat_model(settings: AgentSettings, model: str | None = None) -> ChatOpenAI:
    """Build a LangChain ``ChatOpenAI`` from settings (+ optional model override)."""
    provider, model_name = _split_provider_model(model or settings.model)
    api_key = _resolve_for_provider(settings.api_key, provider)
    api_base = _resolve_for_provider(settings.api_base, provider)

    kwargs: dict[str, Any] = {
        "model": model_name,
        "max_tokens": settings.max_tokens,
    }
    if settings.model_timeout_seconds is not None:
        kwargs["timeout"] = settings.model_timeout_seconds

    if provider == "openai" and is_codex_token(api_key):
        assert api_key is not None
        return ChatOpenAI(
            openai_api_key=api_key,
            openai_api_base=resolve_codex_api_base(api_base),
            default_headers=build_codex_headers(api_key),
            use_responses_api=True,
            **kwargs,
        )

    return ChatOpenAI(
        openai_api_key=api_key or "none",
        openai_api_base=api_base,
        **kwargs,
    )


__all__ = ["build_chat_model"]
