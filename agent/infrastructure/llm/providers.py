"""Small built-in provider and model catalog."""

from __future__ import annotations

from agent.domain.models import ModelDefinition, ProviderDefinition


def default_reasoning_efforts(api: str) -> tuple[str, ...]:
    """Efforts an API dialect accepts; adapters without effort support declare none."""
    return () if api == "anthropic-messages" else ("low", "medium", "high", "xhigh")


def refreshable_models_api(api: str) -> bool:
    """Whether the provider exposes an OpenAI-style GET /models catalog endpoint."""
    return api != "anthropic-messages"


def _models(provider_id: str, api: str, values: tuple[tuple[str, str], ...]) -> tuple[ModelDefinition, ...]:
    return tuple(
        ModelDefinition(provider_id, model_id, name, api, default_reasoning_efforts(api))
        for model_id, name in values
    )


PROVIDERS: dict[str, ProviderDefinition] = {
    "openai": ProviderDefinition(
        "openai", "OpenAI", "openai-responses", "https://api.openai.com/v1", environment_key="OPENAI_API_KEY",
        fallback_models=_models("openai", "openai-responses", (("gpt-5.5", "GPT-5.5"), ("gpt-4o-mini", "GPT-4o mini"))),
    ),
    "anthropic": ProviderDefinition(
        "anthropic", "Anthropic", "anthropic-messages", "https://api.anthropic.com", environment_key="ANTHROPIC_API_KEY",
        fallback_models=_models("anthropic", "anthropic-messages", (("claude-sonnet-4-6", "Claude Sonnet 4.6"), ("claude-3-5-haiku-latest", "Claude 3.5 Haiku"))),
    ),
    "deepseek": ProviderDefinition(
        "deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com/v1", environment_key="DEEPSEEK_API_KEY",
        fallback_models=_models("deepseek", "openai-chat", (("deepseek-chat", "DeepSeek Chat"), ("deepseek-reasoner", "DeepSeek Reasoner"))),
    ),
    "openrouter": ProviderDefinition(
        "openrouter", "OpenRouter", "openai-chat", "https://openrouter.ai/api/v1", environment_key="OPENROUTER_API_KEY",
        fallback_models=(),
    ),
    "openai-compatible": ProviderDefinition(
        "openai-compatible", "OpenAI compatible", "openai-chat", "", environment_key="OPENAI_API_KEY", fallback_models=(),
    ),
}


def provider(provider_id: str) -> ProviderDefinition:
    try:
        return PROVIDERS[provider_id]
    except KeyError as exc:
        raise ValueError(f"Unknown provider: {provider_id}") from exc
