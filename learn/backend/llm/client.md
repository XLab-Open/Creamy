# `backend/llm/client.py` 精读(C 档·极详)

## 这个文件在干嘛

**LangChain 聊天模型工厂**:据配置的 `provider:model` 造出对应的 LangChain 聊天模型——`anthropic` →
`ChatAnthropic`,其它(openai/openrouter/deepseek/siliconflow… 都是 OpenAI 兼容)→ `ChatOpenAI`(可带
自定义 `api_base`)。特殊:当 OpenAI 的 api_key 其实是 Codex OAuth token 时,把客户端指向 ChatGPT Codex
Responses 后端。

> `agent` 经 `graph.py` 调 `build_chat_model` 得到一个模型对象,再 `bind_tools` 后跑。这里是"配置 → 具体
> 模型客户端"的唯一出口。Codex 那条分支正是 `creamy login openai` 登录后"不配 API key 也能用"的实现。

---

## 顶部导入与小工具

> **整块作用**:导入 LangChain 两家模型类与 Codex 塑形工具;`_split_provider_model` 拆 "provider:model";
> `_resolve_for_provider` 支持"按提供商取配置"。

```python
"""LangChain chat-model factory — project-owned. ...(见上)..."""
from __future__ import annotations
from typing import TYPE_CHECKING, Any

from langchain_anthropic import ChatAnthropic   # Anthropic 模型
from langchain_openai import ChatOpenAI         # OpenAI 兼容模型
from pydantic import SecretStr                  # 包装 api_key(避免日志泄露明文)

from backend.agent.codex_oauth import (
    build_codex_headers,      # 造 Codex 请求头
    is_codex_token,           # 判断 key 是不是 Codex OAuth token
    resolve_codex_api_base,   # 规整 Codex 后端 base URL
)

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel  # 返回类型(仅类型用)
    from backend.agent.settings import AgentSettings


def _split_provider_model(value: str) -> tuple[str, str]:
    if ":" in value:
        provider, model = value.split(":", 1)
        return provider.strip().lower(), model.strip()
        #   "openai:gpt-4o" → ("openai", "gpt-4o")。provider 转小写。
    return "openai", value.strip()
    #   没有 ":" → 默认 provider 为 openai。


def _resolve_for_provider(value: str | dict[str, str] | None, provider: str) -> str | None:
    if isinstance(value, dict):
        return value.get(provider)
        #   配置是 {provider: 值} 字典 → 取对应提供商的值。
    return value
    #   是单值 → 直接用(全局通用)。
```

- 呼应 `settings.provider_specific`:api_key/api_base 既可全局单值,也可按提供商字典。

---

## `build_chat_model`:核心工厂

> **整块作用**:据 provider 选模型类;组装通用参数;anthropic / codex / 普通 OpenAI 三条分支各自构造。

```python
def build_chat_model(settings: AgentSettings, model: str | None = None) -> BaseChatModel:
    """Build a LangChain chat model from settings (+ optional ``provider:model`` override)."""
    provider, model_name = _split_provider_model(model or settings.model)
    #   解析 provider 与 model(允许临时 model 覆盖配置)。
    api_key = _resolve_for_provider(settings.api_key, provider)
    #   取该 provider 的 api_key。
    api_base = _resolve_for_provider(settings.api_base, provider)
    #   取该 provider 的 api_base(可空)。

    common: dict[str, Any] = {"model": model_name, "max_tokens": settings.max_tokens}
    #   通用参数:模型名 + 最大生成 token。
    if settings.model_timeout_seconds is not None:
        common["timeout"] = settings.model_timeout_seconds
        #   配了超时就带上。

    if provider == "anthropic":
        anthropic_kwargs: dict[str, Any] = {"api_key": api_key or "none", **common}
        #   Anthropic 分支:key 缺省 "none"(占位,真用会报鉴权错)。
        if api_base:
            anthropic_kwargs["base_url"] = api_base
            #   有自定义 base 就设。
        return ChatAnthropic(**anthropic_kwargs)
        #   返回 Anthropic 模型。

    if provider == "openai" and is_codex_token(api_key):
        #   ⭐ OpenAI 但 key 实为 Codex OAuth token:走 ChatGPT Codex 后端。
        token = api_key or ""
        return ChatOpenAI(
            api_key=SecretStr(token),
            base_url=resolve_codex_api_base(api_base),   # 规整成 .../backend-api/codex
            default_headers=build_codex_headers(token),  # 注入 chatgpt-account-id 等头
            use_responses_api=True,                      # 用 Responses API(Codex 后端要求)
            **common,
        )

    return ChatOpenAI(
        api_key=SecretStr(api_key or "none"),
        base_url=api_base,
        **common,
    )
    #   默认:普通 OpenAI 兼容模型(openrouter/deepseek/siliconflow 等都走这条,差别只在 base/key)。


__all__ = ["build_chat_model"]
```

---

## 怎么和别的文件连起来

- `llm/graph.py`:`_prepare` 调 `build_chat_model` 得模型,再 `bind_tools` 跑图。
- `agent/codex_oauth.py`:Codex 分支用 `is_codex_token`/`resolve_codex_api_base`/`build_codex_headers`。
- `agent/settings.py`:`AgentSettings` 提供 model/api_key/api_base/max_tokens/timeout(支持按提供商)。

---

## 一句话总结

`client.py` 把"配置的 provider:model"翻译成具体 LangChain 模型:Anthropic 用 ChatAnthropic,其余 OpenAI
兼容用 ChatOpenAI;并支持"Codex OAuth token → ChatGPT Codex Responses 后端"的特殊接法。
