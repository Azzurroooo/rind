"""Small built-in provider and model catalog."""

from __future__ import annotations

from agent.domain.models import ModelDefinition, ProviderDefinition
from agent.infrastructure.settings import REASONING_EFFORTS


def default_reasoning_efforts(api: str) -> tuple[str, ...]:
    """Efforts an API dialect accepts; adapters without effort support declare none."""
    return () if api in ("anthropic-messages", "google-generative-ai") else REASONING_EFFORTS


def resolve_reasoning_effort(configured: str | None, requested: str | None, supported: tuple[str, ...]) -> str | None:
    if requested not in supported or (requested == "low" and configured in {"none", "off", "minimal"}):
        return configured
    return requested


def refreshable_models_api(api: str) -> bool:
    """Whether the provider exposes an OpenAI-style GET /models catalog endpoint."""
    return api in ("openai-chat", "openai-responses")


def _models(provider_id: str, api: str, values: tuple[tuple[str, str, tuple[str, ...], bool | None], ...]) -> tuple[ModelDefinition, ...]:
    return tuple(
        ModelDefinition(provider_id, model_id, name, api, efforts, image_input=image_input)
        for model_id, name, efforts, image_input in values
    )


PROVIDERS: dict[str, ProviderDefinition] = {
    "openai": ProviderDefinition(
        "openai", "OpenAI", "openai-responses", "https://api.openai.com/v1", environment_key="OPENAI_API_KEY",
        fallback_models=_models("openai", "openai-responses", (
            ("gpt-5.5", "GPT-5.5", ("low", "medium", "high", "xhigh"), True),
            ("gpt-4o-mini", "GPT-4o mini", (), True),
            ("gpt-6-astra", "GPT-6 Astra", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-sol", "GPT-5.6 Sol", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-terra", "GPT-5.6 Terra", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-luna", "GPT-5.6 Luna", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.4", "GPT-5.4", ("low", "medium", "high", "xhigh"), True),
            ("gpt-5.4-mini", "GPT-5.4 mini", ("low", "medium", "high", "xhigh"), True),
            ("gpt-5.4-nano", "GPT-5.4 nano", ("low", "medium", "high", "xhigh"), True),
            ("gpt-4.1", "GPT-4.1", (), True),
            ("gpt-4.1-mini", "GPT-4.1 mini", (), True),
            ("gpt-4o", "GPT-4o", (), True),
            ("o3", "o3", ("low", "medium", "high"), True),
            ("o4-mini", "o4-mini", ("low", "medium", "high"), True),
            ("o3-mini", "o3-mini", ("low", "medium", "high"), False),
        )),
    ),
    "anthropic": ProviderDefinition(
        "anthropic", "Anthropic", "anthropic-messages", "https://api.anthropic.com", environment_key="ANTHROPIC_API_KEY",
        fallback_models=_models("anthropic", "anthropic-messages", (
            ("claude-sonnet-4-6", "Claude Sonnet 4.6", default_reasoning_efforts("anthropic-messages"), True),
            ("claude-3-5-haiku-latest", "Claude 3.5 Haiku", default_reasoning_efforts("anthropic-messages"), None),
            ("claude-fable-5-1", "Claude Fable 5.1", (), True),
            ("claude-opus-5", "Claude Opus 5", (), True),
            ("claude-sonnet-5", "Claude Sonnet 5", (), True),
            ("claude-opus-4-8", "Claude Opus 4.8", (), True),
            ("claude-opus-4-6", "Claude Opus 4.6", (), True),
            ("claude-haiku-4-5", "Claude Haiku 4.5 (latest)", (), True),
        )),
    ),
    "google": ProviderDefinition(
        "google", "Google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", environment_key="GEMINI_API_KEY",
        fallback_models=_models("google", "google-generative-ai", (
            ("gemini-3.1-pro-preview", "Gemini 3.1 Pro", default_reasoning_efforts("google-generative-ai"), True),
            ("gemini-3-flash", "Gemini 3 Flash", default_reasoning_efforts("google-generative-ai"), None),
            ("gemini-3.8-flash", "Gemini 3.8 Flash", (), True),
            ("gemini-3.5-flash", "Gemini 3.5 Flash", (), True),
            ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", (), True),
            ("gemini-3-flash-preview", "Gemini 3 Flash Preview", (), True),
            ("gemini-2.5-pro", "Gemini 2.5 Pro", (), True),
            ("gemini-2.5-flash", "Gemini 2.5 Flash", (), True),
        )),
    ),
    "deepseek": ProviderDefinition(
        "deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com/v1", environment_key="DEEPSEEK_API_KEY",
        fallback_models=_models("deepseek", "openai-chat", (
            ("deepseek-flash", "DeepSeek V4.1 Flash", ("low", "high", "max"), True),
            ("deepseek-v4-pro", "DeepSeek V4 Pro", ("high", "max"), False),
            ("deepseek-v4-flash", "DeepSeek V4 Flash", ("low", "high", "max"), True),
            ("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", ("low", "high", "max"), True),
            ("deepseek-chat", "DeepSeek Chat", default_reasoning_efforts("openai-chat"), None),
            ("deepseek-reasoner", "DeepSeek Reasoner", default_reasoning_efforts("openai-chat"), None),
        )),
    ),
    "groq": ProviderDefinition(
        "groq", "Groq", "openai-chat", "https://api.groq.com/openai/v1", environment_key="GROQ_API_KEY",
        fallback_models=_models("groq", "openai-chat", (
            ("llama-3.3-70b-versatile", "Llama 3.3 70B", (), False),
            ("openai/gpt-oss-120b", "GPT-OSS 120B", ("low", "medium", "high"), False),
            ("llama-3.1-8b-instant", "Llama 3.1 8B", (), False),
            ("openai/gpt-oss-20b", "GPT OSS 20B", ("low", "medium", "high"), False),
            ("qwen/qwen3.8-27b", "Qwen3.8 27B", ("low", "medium", "high"), True),
        )),
    ),
    "mistral": ProviderDefinition(
        "mistral", "Mistral", "openai-chat", "https://api.mistral.ai/v1", environment_key="MISTRAL_API_KEY",
        fallback_models=_models("mistral", "openai-chat", (
            ("mistral-large-latest", "Mistral Large", (), True),
            ("devstral-medium-latest", "Devstral Medium", (), False),
            ("mistral-medium-latest", "Mistral Medium (latest)", ("high",), True),
            ("mistral-small-latest", "Mistral Small (latest)", ("high",), True),
            ("pixtral-large-latest", "Pixtral Large (latest)", (), True),
            ("codestral-latest", "Codestral (latest)", (), False),
            ("devstral-latest", "Devstral 2", (), False),
        )),
    ),
    "zai": ProviderDefinition(
        "zai", "Z.AI", "openai-chat", "https://api.z.ai/api/paas/v4", environment_key="ZAI_API_KEY",
        fallback_models=_models("zai", "openai-chat", (
            ("glm-5.3", "GLM-5.3", ("low", "high", "max"), False),
            ("glm-5.2", "GLM-5.2", ("high", "max"), False),
            ("glm-5.3-flash", "GLM-5.3-Flash", ("low", "high", "max"), True),
            ("glm-5.3-flashx", "GLM-5.3-FlashX", ("low", "high", "max"), True),
            ("glm-5v-turbo", "GLM-5V-Turbo", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.6v", "GLM-4.6V", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.7", "GLM-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zai-coding": ProviderDefinition(
        "zai-coding", "Z.AI Coding", "openai-chat", "https://api.z.ai/api/coding/paas/v4", environment_key="ZAI_CODING_API_KEY",
        fallback_models=_models("zai-coding", "openai-chat", (
            ("glm-5.3", "GLM-5.3", ("low", "high", "max"), False),
            ("glm-5.3-flash", "GLM-5.3 Flash", ("low", "high", "max"), True),
            ("glm-5.2", "GLM-5.2", ("high", "max"), False),
            ("glm-5.3-highspeed", "GLM-5.3 Highspeed", ("low", "high", "max"), False),
            ("glm-4.7", "GLM-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zhipu": ProviderDefinition(
        "zhipu", "Zhipu", "openai-chat", "https://open.bigmodel.cn/api/paas/v4", environment_key="ZHIPU_API_KEY",
        fallback_models=_models("zhipu", "openai-chat", (
            ("glm-5.3", "GLM-5.3", ("low", "high", "max"), False),
            ("glm-5.2", "GLM-5.2", ("high", "max"), False),
            ("glm-5.3-flash", "GLM-5.3-Flash", ("low", "high", "max"), True),
            ("glm-5.3-flashx", "GLM-5.3-FlashX", ("low", "high", "max"), True),
            ("glm-5v-turbo", "GLM-5V-Turbo", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.6v", "GLM-4.6V", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.7", "GLM-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zhipu-coding": ProviderDefinition(
        "zhipu-coding", "Zhipu Coding", "openai-chat", "https://open.bigmodel.cn/api/coding/paas/v4", environment_key="ZHIPU_CODING_API_KEY",
        fallback_models=_models("zhipu-coding", "openai-chat", (
            ("glm-5.3", "GLM-5.3", ("low", "high", "max"), False),
            ("glm-5.3-flash", "GLM-5.3 Flash", ("low", "high", "max"), True),
            ("glm-5.3-highspeed", "GLM-5.3 Highspeed", ("low", "high", "max"), False),
            ("glm-4.6v", "GLM-4.6V", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "kimi-coding": ProviderDefinition(
        "kimi-coding", "Kimi For Coding", "anthropic-messages", "https://api.kimi.com/coding", environment_key="KIMI_API_KEY",
        fallback_models=_models("kimi-coding", "anthropic-messages", (
            ("kimi-for-coding", "Kimi For Coding", default_reasoning_efforts("anthropic-messages"), True),
            ("k3", "Kimi K3", default_reasoning_efforts("anthropic-messages"), True),
            ("kimi-for-coding-highspeed", "Kimi For Coding HighSpeed", (), True),
            ("k3-256k", "Kimi K3-256K", (), True),
        )),
    ),
    "moonshot": ProviderDefinition(
        "moonshot", "Moonshot AI", "openai-chat", "https://api.moonshot.ai/v1", environment_key="MOONSHOT_API_KEY",
        fallback_models=_models("moonshot", "openai-chat", (
            ("kimi-k3", "Kimi K3", ("low", "high", "max"), True),
            ("kimi-k2.6", "Kimi K2.6", (), True),
            ("kimi-k2.7-code", "Kimi K2.7 Code", ("low", "medium", "high", "xhigh", "max"), True),
            ("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "moonshot-cn": ProviderDefinition(
        "moonshot-cn", "Moonshot AI CN", "openai-chat", "https://api.moonshot.cn/v1", environment_key="MOONSHOT_CN_API_KEY",
        fallback_models=_models("moonshot-cn", "openai-chat", (
            ("kimi-k3", "Kimi K3", ("low", "high", "max"), True),
            ("kimi-k2.6", "Kimi K2.6", (), True),
            ("kimi-k2.7-code", "Kimi K2.7 Code", ("low", "medium", "high", "xhigh", "max"), True),
            ("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "qwen": ProviderDefinition(
        "qwen", "Qwen", "openai-chat", "https://dashscope.aliyuncs.com/compatible-mode/v1", environment_key="DASHSCOPE_API_KEY",
        fallback_models=_models("qwen", "openai-chat", (
            ("qwen3-coder-plus", "Qwen3 Coder Plus", (), False),
            ("qwen-max", "Qwen Max", (), False),
            ("qwen3.8-max", "Qwen3.8 Max", ("low", "medium", "xhigh"), True),
            ("qwen3.8-flash", "Qwen3.8 Flash", ("low", "medium", "xhigh"), True),
            ("qwen3.7-plus", "Qwen3.7 Plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3.7-max", "Qwen3.7 Max", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen3.5-plus", "Qwen3.5 Plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3-vl-plus", "Qwen3-VL Plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen-vl-max", "Qwen-VL Max", (), True),
            ("qwen-plus", "Qwen Plus", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen-flash", "Qwen Flash", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "qwen-coding": ProviderDefinition(
        "qwen-coding", "Qwen Coding", "openai-chat", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", environment_key="QWEN_CODING_API_KEY",
        fallback_models=_models("qwen-coding", "openai-chat", (
            ("qwen3-coder-plus", "Qwen3 Coder Plus", (), None),
            ("qwen3-coder-flash", "Qwen3 Coder Flash", (), None),
            ("qwen3.8-max", "Qwen3.8 Max", ("low", "medium", "xhigh"), True),
            ("qwen3.8-flash", "Qwen3.8 Flash", ("low", "medium", "xhigh"), True),
            ("qwen3.7-plus", "Qwen3.7 Plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3.7-max", "Qwen3.7 Max", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen3.6-plus", "Qwen3.6 Plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", ("low", "high", "max"), True),
            ("deepseek-v4-flash", "DeepSeek V4 Flash", ("high", "max"), False),
            ("deepseek-v4-pro", "DeepSeek V4 Pro", ("high", "max"), False),
            ("kimi-k2.7-code", "Kimi K2.7 Code", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-5.3", "GLM-5.3", ("low", "high", "max"), False),
        )),
    ),
    "xai": ProviderDefinition(
        "xai", "xAI", "openai-responses", "https://api.x.ai/v1", environment_key="XAI_API_KEY",
        fallback_models=_models("xai", "openai-responses", (
            ("grok-4.5", "Grok 4.5", ("low", "medium", "high"), True),
            ("grok-4.3", "Grok 4.3", ("low", "medium", "high"), True),
            ("grok-4.6", "Grok 4.6", ("low", "medium", "high", "xhigh"), True),
            ("grok-build-0.1", "Grok Build 0.1", ("low", "medium", "high", "xhigh", "max"), True),
            ("grok-4.20-0309-reasoning", "Grok 4.20 (Reasoning)", ("low", "medium", "high", "xhigh", "max"), True),
            ("grok-4.20-0309-non-reasoning", "Grok 4.20 (Non-Reasoning)", (), True),
        )),
    ),
    "openrouter": ProviderDefinition(
        "openrouter", "OpenRouter", "openai-chat", "https://openrouter.ai/api/v1", environment_key="OPENROUTER_API_KEY",
        fallback_models=_models("openrouter", "openai-chat", (
            ("openai/gpt-5.5", "OpenAI: GPT-5.5", ("low", "medium", "high", "xhigh", "max"), True),
            ("anthropic/claude-sonnet-4.6", "Anthropic: Claude Sonnet 4.6", ("low", "medium", "high", "xhigh", "max"), True),
            ("anthropic/claude-opus-4.6", "Anthropic: Claude Opus 4.6", ("low", "medium", "high", "xhigh", "max"), True),
            ("google/gemini-3.1-pro-preview", "Google: Gemini 3.1 Pro Preview", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek/deepseek-v4-flash", "DeepSeek: DeepSeek V4 Flash 0423", ("low", "medium", "high", "xhigh", "max"), False),
            ("deepseek/deepseek-v4-pro", "DeepSeek: DeepSeek V4 Pro 0423", ("low", "medium", "high", "xhigh", "max"), False),
            ("moonshotai/kimi-k3", "MoonshotAI: Kimi K3", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen/qwen3.6-plus", "Qwen: Qwen3.6 Plus", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "openai-compatible": ProviderDefinition(
        "openai-compatible", "OpenAI compatible (chat completions)", "openai-chat", "", environment_key="OPENAI_API_KEY", fallback_models=(),
    ),
}


def provider(provider_id: str) -> ProviderDefinition:
    try:
        return PROVIDERS[provider_id]
    except KeyError as exc:
        raise ValueError(f"Unknown provider: {provider_id}") from exc
