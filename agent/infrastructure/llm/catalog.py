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


def _models(provider_id: str, api: str, values: tuple[tuple[str, tuple[str, ...], bool | None], ...]) -> tuple[ModelDefinition, ...]:
    return tuple(
        ModelDefinition(provider_id, model_id, api, efforts, image_input=image_input)
        for model_id, efforts, image_input in values
    )


_XIAOMI_MODELS = (
    ("mimo-v2.6-pro", (), True),
    ("mimo-v2.6-flash", (), True),
)

_TENCENT_HY_MODELS = (
    ("hy3", (), False),
    ("hy4-preview", (), False),
)

_MINIMAX_MODELS = (
    ("MiniMax-M3", (), True),
)


PROVIDERS: dict[str, ProviderDefinition] = {
    "openai": ProviderDefinition(
        "openai", "OpenAI", "openai-responses", "https://api.openai.com/v1", environment_key="OPENAI_API_KEY",
        fallback_models=_models("openai", "openai-responses", (
            ("gpt-5.5", ("low", "medium", "high", "xhigh"), True),
            ("gpt-4o-mini", (), True),
            ("gpt-6-astra", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-sol", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-terra", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.6-luna", ("low", "medium", "high", "xhigh", "max"), True),
            ("gpt-5.4", ("low", "medium", "high", "xhigh"), True),
            ("gpt-5.4-mini", ("low", "medium", "high", "xhigh"), True),
            ("gpt-5.4-nano", ("low", "medium", "high", "xhigh"), True),
            ("gpt-4.1", (), True),
            ("gpt-4.1-mini", (), True),
            ("gpt-4o", (), True),
            ("o3", ("low", "medium", "high"), True),
            ("o4-mini", ("low", "medium", "high"), True),
            ("o3-mini", ("low", "medium", "high"), False),
        )),
    ),
    "anthropic": ProviderDefinition(
        "anthropic", "Anthropic", "anthropic-messages", "https://api.anthropic.com", environment_key="ANTHROPIC_API_KEY",
        fallback_models=_models("anthropic", "anthropic-messages", (
            ("claude-sonnet-4-6", default_reasoning_efforts("anthropic-messages"), True),
            ("claude-3-5-haiku-latest", default_reasoning_efforts("anthropic-messages"), None),
            ("claude-fable-5-1", (), True),
            ("claude-opus-5", (), True),
            ("claude-sonnet-5", (), True),
            ("claude-opus-4-8", (), True),
            ("claude-opus-4-6", (), True),
            ("claude-haiku-4-5", (), True),
        )),
    ),
    "google": ProviderDefinition(
        "google", "Google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", environment_key="GEMINI_API_KEY",
        fallback_models=_models("google", "google-generative-ai", (
            ("gemini-3.1-pro-preview", default_reasoning_efforts("google-generative-ai"), True),
            ("gemini-3-flash", default_reasoning_efforts("google-generative-ai"), None),
            ("gemini-3.8-flash", (), True),
            ("gemini-3.5-flash", (), True),
            ("gemini-3.1-flash-lite", (), True),
            ("gemini-3-flash-preview", (), True),
            ("gemini-2.5-pro", (), True),
            ("gemini-2.5-flash", (), True),
        )),
    ),
    "deepseek": ProviderDefinition(
        "deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com/v1", environment_key="DEEPSEEK_API_KEY",
        fallback_models=_models("deepseek", "openai-chat", (
            ("deepseek-flash", ("low", "high", "max"), True),
            ("deepseek-v4-pro", ("high", "max"), False),
            ("deepseek-v4-flash", ("low", "high", "max"), True),
            ("deepseek-v4-flash-vision-exp", ("low", "high", "max"), True),
            ("deepseek-chat", default_reasoning_efforts("openai-chat"), None),
            ("deepseek-reasoner", default_reasoning_efforts("openai-chat"), None),
        )),
    ),
    "groq": ProviderDefinition(
        "groq", "Groq", "openai-chat", "https://api.groq.com/openai/v1", environment_key="GROQ_API_KEY",
        fallback_models=_models("groq", "openai-chat", (
            ("llama-3.3-70b-versatile", (), False),
            ("openai/gpt-oss-120b", ("low", "medium", "high"), False),
            ("llama-3.1-8b-instant", (), False),
            ("openai/gpt-oss-20b", ("low", "medium", "high"), False),
            ("qwen/qwen3.8-27b", ("low", "medium", "high"), True),
        )),
    ),
    "mistral": ProviderDefinition(
        "mistral", "Mistral", "openai-chat", "https://api.mistral.ai/v1", environment_key="MISTRAL_API_KEY",
        fallback_models=_models("mistral", "openai-chat", (
            ("mistral-large-latest", (), True),
            ("devstral-medium-latest", (), False),
            ("mistral-medium-latest", ("high",), True),
            ("mistral-small-latest", ("high",), True),
            ("pixtral-large-latest", (), True),
            ("codestral-latest", (), False),
            ("devstral-latest", (), False),
        )),
    ),
    "zai": ProviderDefinition(
        "zai", "Z.AI", "openai-chat", "https://api.z.ai/api/paas/v4", environment_key="ZAI_API_KEY",
        fallback_models=_models("zai", "openai-chat", (
            ("glm-5.3", ("low", "high", "max"), False),
            ("glm-5.2", ("high", "max"), False),
            ("glm-5.3-flash", ("low", "high", "max"), True),
            ("glm-5.3-flashx", ("low", "high", "max"), True),
            ("glm-5v-turbo", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.6v", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zai-coding": ProviderDefinition(
        "zai-coding", "Z.AI Coding", "openai-chat", "https://api.z.ai/api/coding/paas/v4", environment_key="ZAI_CODING_API_KEY",
        fallback_models=_models("zai-coding", "openai-chat", (
            ("glm-5.3", ("low", "high", "max"), False),
            ("glm-5.3-flash", ("low", "high", "max"), True),
            ("glm-5.2", ("high", "max"), False),
            ("glm-5.3-highspeed", ("low", "high", "max"), False),
            ("glm-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zhipu": ProviderDefinition(
        "zhipu", "Zhipu", "openai-chat", "https://open.bigmodel.cn/api/paas/v4", environment_key="ZHIPU_API_KEY",
        fallback_models=_models("zhipu", "openai-chat", (
            ("glm-5.3", ("low", "high", "max"), False),
            ("glm-5.2", ("high", "max"), False),
            ("glm-5.3-flash", ("low", "high", "max"), True),
            ("glm-5.3-flashx", ("low", "high", "max"), True),
            ("glm-5v-turbo", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.6v", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-4.7", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "zhipu-coding": ProviderDefinition(
        "zhipu-coding", "Zhipu Coding", "openai-chat", "https://open.bigmodel.cn/api/coding/paas/v4", environment_key="ZHIPU_CODING_API_KEY",
        fallback_models=_models("zhipu-coding", "openai-chat", (
            ("glm-5.3", ("low", "high", "max"), False),
            ("glm-5.3-flash", ("low", "high", "max"), True),
            ("glm-5.3-highspeed", ("low", "high", "max"), False),
            ("glm-4.6v", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "kimi-coding": ProviderDefinition(
        "kimi-coding", "Kimi For Coding", "anthropic-messages", "https://api.kimi.com/coding", environment_key="KIMI_API_KEY",
        fallback_models=_models("kimi-coding", "anthropic-messages", (
            ("kimi-for-coding", default_reasoning_efforts("anthropic-messages"), True),
            ("k3", default_reasoning_efforts("anthropic-messages"), True),
            ("kimi-for-coding-highspeed", (), True),
            ("k3-256k", (), True),
        )),
    ),
    "moonshot": ProviderDefinition(
        "moonshot", "Moonshot AI", "openai-chat", "https://api.moonshot.ai/v1", environment_key="MOONSHOT_API_KEY",
        fallback_models=_models("moonshot", "openai-chat", (
            ("kimi-k3", ("low", "high", "max"), True),
            ("kimi-k2.6", (), True),
            ("kimi-k2.7-code", ("low", "medium", "high", "xhigh", "max"), True),
            ("kimi-k2.7-code-highspeed", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "moonshot-cn": ProviderDefinition(
        "moonshot-cn", "Moonshot AI CN", "openai-chat", "https://api.moonshot.cn/v1", environment_key="MOONSHOT_CN_API_KEY",
        fallback_models=_models("moonshot-cn", "openai-chat", (
            ("kimi-k3", ("low", "high", "max"), True),
            ("kimi-k2.6", (), True),
            ("kimi-k2.7-code", ("low", "medium", "high", "xhigh", "max"), True),
            ("kimi-k2.7-code-highspeed", ("low", "medium", "high", "xhigh", "max"), True),
        )),
    ),
    "xiaomi": ProviderDefinition(
        "xiaomi", "Xiaomi MiMo", "openai-chat", "https://api.xiaomimimo.com/v1", environment_key="XIAOMI_API_KEY",
        fallback_models=_models("xiaomi", "openai-chat", _XIAOMI_MODELS),
    ),
    "xiaomi-token-plan-cn": ProviderDefinition(
        "xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)", "openai-chat", "https://token-plan-cn.xiaomimimo.com/v1", environment_key="XIAOMI_TOKEN_PLAN_CN_API_KEY",
        fallback_models=_models("xiaomi-token-plan-cn", "openai-chat", _XIAOMI_MODELS),
    ),
    "xiaomi-token-plan-ams": ProviderDefinition(
        "xiaomi-token-plan-ams", "Xiaomi MiMo Token Plan (Europe)", "openai-chat", "https://token-plan-ams.xiaomimimo.com/v1", environment_key="XIAOMI_TOKEN_PLAN_AMS_API_KEY",
        fallback_models=_models("xiaomi-token-plan-ams", "openai-chat", _XIAOMI_MODELS),
    ),
    "xiaomi-token-plan-sgp": ProviderDefinition(
        "xiaomi-token-plan-sgp", "Xiaomi MiMo Token Plan (Singapore)", "openai-chat", "https://token-plan-sgp.xiaomimimo.com/v1", environment_key="XIAOMI_TOKEN_PLAN_SGP_API_KEY",
        fallback_models=_models("xiaomi-token-plan-sgp", "openai-chat", _XIAOMI_MODELS),
    ),
    "hunyuan": ProviderDefinition(
        "hunyuan", "Tencent Hunyuan", "openai-chat", "https://api.hunyuan.cloud.tencent.com/v1", environment_key="HUNYUAN_API_KEY",
        fallback_models=_models("hunyuan", "openai-chat", (
            ("hunyuan-turbos-latest", (), False),
        )),
    ),
    "tencent-coding-plan": ProviderDefinition(
        "tencent-coding-plan", "Tencent Coding Plan", "openai-chat", "https://api.lkeap.cloud.tencent.com/coding/v3", environment_key="TENCENT_CODING_PLAN_API_KEY",
        fallback_models=_models("tencent-coding-plan", "openai-chat", (
            ("tc-code-latest", (), False),
            ("glm-5", (), False),
        )),
    ),
    "tencent-tokenhub": ProviderDefinition(
        "tencent-tokenhub", "Tencent TokenHub (Hunyuan)", "openai-chat", "https://tokenhub.tencentmaas.com/v1", environment_key="TENCENT_TOKENHUB_API_KEY",
        fallback_models=_models("tencent-tokenhub", "openai-chat", _TENCENT_HY_MODELS),
    ),
    "tencent-token-plan": ProviderDefinition(
        "tencent-token-plan", "Tencent Token Plan", "openai-chat", "https://api.lkeap.cloud.tencent.com/plan/v3", environment_key="TENCENT_TOKEN_PLAN_API_KEY",
        fallback_models=_models("tencent-token-plan", "openai-chat", _TENCENT_HY_MODELS),
    ),
    "volcengine": ProviderDefinition(
        "volcengine", "Volcengine Ark (Doubao)", "openai-chat", "https://ark.cn-beijing.volces.com/api/v3", environment_key="ARK_API_KEY",
        fallback_models=_models("volcengine", "openai-chat", (
            ("doubao-seed-2-1-pro-260628", (), True),
        )),
    ),
    "volcengine-coding-plan": ProviderDefinition(
        "volcengine-coding-plan", "Volcengine Ark Coding Plan", "openai-chat", "https://ark.cn-beijing.volces.com/api/coding/v3", environment_key="ARK_CODING_PLAN_API_KEY",
        fallback_models=_models("volcengine-coding-plan", "openai-chat", (
            ("ark-code-latest", (), None),
            ("doubao-seed-2.1-pro", (), True),
        )),
    ),
    "minimax": ProviderDefinition(
        "minimax", "MiniMax (minimax.io)", "anthropic-messages", "https://api.minimax.io/anthropic", environment_key="MINIMAX_API_KEY",
        fallback_models=_models("minimax", "anthropic-messages", _MINIMAX_MODELS),
    ),
    "minimax-cn": ProviderDefinition(
        "minimax-cn", "MiniMax (China)", "anthropic-messages", "https://api.minimax.cn/anthropic", environment_key="MINIMAX_CN_API_KEY",
        fallback_models=_models("minimax-cn", "anthropic-messages", _MINIMAX_MODELS),
    ),
    "minimax-coding-plan": ProviderDefinition(
        "minimax-coding-plan", "MiniMax Token Plan (Global)", "anthropic-messages", "https://api.minimax.io/anthropic", environment_key="MINIMAX_CODING_PLAN_API_KEY",
        fallback_models=_models("minimax-coding-plan", "anthropic-messages", _MINIMAX_MODELS),
    ),
    "minimax-cn-coding-plan": ProviderDefinition(
        "minimax-cn-coding-plan", "MiniMax Token Plan (China)", "anthropic-messages", "https://api.minimax.cn/anthropic", environment_key="MINIMAX_CN_CODING_PLAN_API_KEY",
        fallback_models=_models("minimax-cn-coding-plan", "anthropic-messages", _MINIMAX_MODELS),
    ),
    "qwen": ProviderDefinition(
        "qwen", "Qwen", "openai-chat", "https://dashscope.aliyuncs.com/compatible-mode/v1", environment_key="DASHSCOPE_API_KEY",
        fallback_models=_models("qwen", "openai-chat", (
            ("qwen3-coder-plus", (), False),
            ("qwen-max", (), False),
            ("qwen3.8-max", ("low", "medium", "xhigh"), True),
            ("qwen3.8-flash", ("low", "medium", "xhigh"), True),
            ("qwen3.7-plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3.7-max", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen3.5-plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3-vl-plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen-vl-max", (), True),
            ("qwen-plus", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen-flash", ("low", "medium", "high", "xhigh", "max"), False),
        )),
    ),
    "qwen-coding": ProviderDefinition(
        "qwen-coding", "Qwen Coding", "openai-chat", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", environment_key="QWEN_CODING_API_KEY",
        fallback_models=_models("qwen-coding", "openai-chat", (
            ("qwen3-coder-plus", (), None),
            ("qwen3-coder-flash", (), None),
            ("qwen3.8-max", ("low", "medium", "xhigh"), True),
            ("qwen3.8-flash", ("low", "medium", "xhigh"), True),
            ("qwen3.7-plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen3.7-max", ("low", "medium", "high", "xhigh", "max"), False),
            ("qwen3.6-plus", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek-v4.1-flash", ("low", "high", "max"), True),
            ("deepseek-v4-flash", ("high", "max"), False),
            ("deepseek-v4-pro", ("high", "max"), False),
            ("kimi-k2.7-code", ("low", "medium", "high", "xhigh", "max"), True),
            ("glm-5.3", ("low", "high", "max"), False),
        )),
    ),
    "xai": ProviderDefinition(
        "xai", "xAI", "openai-responses", "https://api.x.ai/v1", environment_key="XAI_API_KEY",
        fallback_models=_models("xai", "openai-responses", (
            ("grok-4.5", ("low", "medium", "high"), True),
            ("grok-4.3", ("low", "medium", "high"), True),
            ("grok-4.6", ("low", "medium", "high", "xhigh"), True),
            ("grok-build-0.1", ("low", "medium", "high", "xhigh", "max"), True),
            ("grok-4.20-0309-reasoning", ("low", "medium", "high", "xhigh", "max"), True),
            ("grok-4.20-0309-non-reasoning", (), True),
        )),
    ),
    "openrouter": ProviderDefinition(
        "openrouter", "OpenRouter", "openai-chat", "https://openrouter.ai/api/v1", environment_key="OPENROUTER_API_KEY",
        fallback_models=_models("openrouter", "openai-chat", (
            ("openai/gpt-5.5", ("low", "medium", "high", "xhigh", "max"), True),
            ("anthropic/claude-sonnet-4.6", ("low", "medium", "high", "xhigh", "max"), True),
            ("anthropic/claude-opus-4.6", ("low", "medium", "high", "xhigh", "max"), True),
            ("google/gemini-3.1-pro-preview", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek/deepseek-v4.1-flash", ("low", "medium", "high", "xhigh", "max"), True),
            ("deepseek/deepseek-v4-flash", ("low", "medium", "high", "xhigh", "max"), False),
            ("deepseek/deepseek-v4-pro", ("low", "medium", "high", "xhigh", "max"), False),
            ("moonshotai/kimi-k3", ("low", "medium", "high", "xhigh", "max"), True),
            ("qwen/qwen3.6-plus", ("low", "medium", "high", "xhigh", "max"), True),
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
