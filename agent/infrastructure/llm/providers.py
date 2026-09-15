"""Small built-in provider and model catalog."""

from __future__ import annotations

from agent.domain.models import ModelDefinition, ProviderDefinition


def default_reasoning_efforts(api: str) -> tuple[str, ...]:
    """Efforts an API dialect accepts; adapters without effort support declare none."""
    return () if api in ("anthropic-messages", "google-generative-ai") else ("low", "medium", "high", "xhigh")


def refreshable_models_api(api: str) -> bool:
    """Whether the provider exposes an OpenAI-style GET /models catalog endpoint."""
    return api in ("openai-chat", "openai-responses")


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
    "google": ProviderDefinition(
        "google", "Google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", environment_key="GEMINI_API_KEY",
        fallback_models=_models("google", "google-generative-ai", (("gemini-3.1-pro-preview", "Gemini 3.1 Pro"), ("gemini-3-flash", "Gemini 3 Flash"))),
    ),
    "deepseek": ProviderDefinition(
        "deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com/v1", environment_key="DEEPSEEK_API_KEY",
        fallback_models=_models("deepseek", "openai-chat", (("deepseek-chat", "DeepSeek Chat"), ("deepseek-reasoner", "DeepSeek Reasoner"))),
    ),
    "groq": ProviderDefinition(
        "groq", "Groq", "openai-chat", "https://api.groq.com/openai/v1", environment_key="GROQ_API_KEY",
        fallback_models=_models("groq", "openai-chat", (("llama-3.3-70b-versatile", "Llama 3.3 70B"), ("openai/gpt-oss-120b", "GPT-OSS 120B"))),
    ),
    "mistral": ProviderDefinition(
        "mistral", "Mistral", "openai-chat", "https://api.mistral.ai/v1", environment_key="MISTRAL_API_KEY",
        fallback_models=_models("mistral", "openai-chat", (("mistral-large-latest", "Mistral Large"), ("devstral-medium-latest", "Devstral Medium"))),
    ),
    "moonshot": ProviderDefinition(
        "moonshot", "Moonshot AI", "openai-chat", "https://api.moonshot.ai/v1", environment_key="MOONSHOT_API_KEY",
        fallback_models=_models("moonshot", "openai-chat", (("kimi-k3", "Kimi K3"), ("kimi-k2.6", "Kimi K2.6"))),
    ),
    "qwen": ProviderDefinition(
        "qwen", "Qwen", "openai-chat", "https://dashscope.aliyuncs.com/compatible-mode/v1", environment_key="DASHSCOPE_API_KEY",
        fallback_models=_models("qwen", "openai-chat", (("qwen3-coder-plus", "Qwen3 Coder Plus"), ("qwen-max", "Qwen Max"))),
    ),
    "xai": ProviderDefinition(
        "xai", "xAI", "openai-responses", "https://api.x.ai/v1", environment_key="XAI_API_KEY",
        fallback_models=_models("xai", "openai-responses", (("grok-4.5", "Grok 4.5"), ("grok-4.3", "Grok 4.3"))),
    ),
    "zai": ProviderDefinition(
        "zai", "Z.AI", "openai-chat", "https://api.z.ai/api/coding/paas/v4", environment_key="ZAI_API_KEY",
        fallback_models=_models("zai", "openai-chat", (("glm-5.3", "GLM-5.3"), ("glm-5.2", "GLM-5.2"))),
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
