// Browser-safe built-in provider & fallback model catalog shared across Desktop and Web UIs.
// Kept in 1:1 parity with runtime/src/infrastructure/providers.ts (verified in providers-and-auth.test.js).

function models(entries) {
  return Object.freeze(
    entries.map(([id, efforts = []]) =>
      Object.freeze({ id, efforts: Object.freeze([...efforts]) }),
    ),
  );
}

function provider(id, name, api, modelList, methods = ["api_key"], envKey) {
  return Object.freeze({
    id,
    name,
    api,
    methods: Object.freeze([...methods]),
    envKey: envKey ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    models: modelList,
  });
}

const GLM_MODELS = models([
  ["glm-5.3", ["low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5.3-flashx", ["low", "high", "max"]],
  ["glm-5.2", ["high", "max"]],
  ["glm-5v-turbo"],
  ["glm-4.7"],
  ["glm-4.6v"],
]);

const GLM_CODING_MODELS = models([
  ["glm-5.3", ["low", "high", "max"]],
  ["glm-5.3-highspeed", ["low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5.2", ["high", "max"]],
  ["glm-4.7"],
  ["glm-4.6v"],
]);

const MOONSHOT_MODELS = models([
  ["kimi-k3.1-pro", ["low", "high", "max"]],
  ["kimi-k3.1-pro-highspeed", ["low", "high", "max"]],
  ["kimi-k3", ["low", "high", "max"]],
  ["kimi-k2.7-code"],
  ["kimi-k2.7-code-highspeed"],
  ["kimi-k2.6"],
]);

const XIAOMI_MODELS = models([
  ["mimo-v2.6-pro"],
  ["mimo-v2.6-pro-ultraspeed"],
  ["mimo-v2.6-flash"],
]);

const TENCENT_HY_MODELS = models([
  ["hy4"],
  ["hy4-preview"],
  ["hy3"],
]);

const MINIMAX_MODELS = models([
  ["MiniMax-M3"],
  ["MiniMax-M3.1-Flash"],
]);

export const BUILTIN_PROVIDER_CATALOG = Object.freeze([
  provider(
    "openai",
    "OpenAI",
    "openai-responses",
    models([
      ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-6.1-terra", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.4-mini", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.4-nano", ["low", "medium", "high", "xhigh"]],
      ["gpt-4.1"],
      ["gpt-4.1-mini"],
      ["gpt-4o"],
      ["gpt-4o-mini"],
      ["o3", ["low", "medium", "high"]],
      ["o4-mini", ["low", "medium", "high"]],
      ["o3-mini", ["low", "medium", "high"]],
    ]),
    ["api_key", "oauth"],
  ),
  provider(
    "anthropic",
    "Anthropic",
    "anthropic-messages",
    models([
      ["claude-fable-5-2"],
      ["claude-opus-5-5"],
      ["claude-sonnet-5-5"],
      ["claude-haiku-5-5"],
      ["claude-fable-5-1"],
      ["claude-opus-5"],
      ["claude-sonnet-5"],
      ["claude-opus-4-8"],
      ["claude-opus-4-6"],
      ["claude-sonnet-4-6"],
      ["claude-haiku-4-5"],
    ]),
  ),
  provider(
    "google",
    "Google",
    "google-generative-ai",
    models([
      ["gemini-4-carbon"],
      ["gemini-4-argon"],
      ["gemini-3.8-flash"],
      ["gemini-3.7-flash"],
      ["gemini-3.6-flash"],
      ["gemini-3.5-flash"],
      ["gemini-3.5-flash-lite"],
      ["gemini-3.1-pro-preview"],
      ["gemini-3.1-flash-lite"],
      ["gemini-2.5-pro"],
      ["gemini-2.5-flash"],
    ]),
  ),
  provider(
    "deepseek",
    "DeepSeek",
    "openai-chat",
    models([
      ["deepseek-flash", ["low", "high", "max"]],
      ["deepseek-v4-pro", ["low", "high", "max"]],
      ["deepseek-v4-flash", ["low", "high", "max"]],
    ]),
  ),
  provider(
    "groq",
    "Groq",
    "openai-chat",
    models([
      ["openai/gpt-oss-120b", ["low", "medium", "high"]],
      ["openai/gpt-oss-20b", ["low", "medium", "high"]],
      ["qwen/qwen3.8-27b", ["low", "medium", "high"]],
      ["llama-3.3-70b-versatile"],
      ["llama-3.1-8b-instant"],
    ]),
  ),
  provider(
    "mistral",
    "Mistral",
    "openai-chat",
    models([
      ["mistral-large-latest"],
      ["mistral-medium-latest", ["high"]],
      ["mistral-small-latest", ["low", "medium", "high"]],
      ["codestral-latest"],
    ]),
  ),
  provider("zai", "Z.AI", "openai-chat", GLM_MODELS),
  provider("zai-coding", "Z.AI Coding", "openai-chat", GLM_CODING_MODELS),
  provider("zhipu", "Zhipu", "openai-chat", GLM_MODELS),
  provider("zhipu-coding", "Zhipu Coding", "openai-chat", GLM_CODING_MODELS),
  provider(
    "kimi-coding",
    "Kimi For Coding",
    "anthropic-messages",
    models([
      ["kimi-for-coding"],
      ["kimi-for-coding-highspeed"],
      ["k3.1-pro"],
      ["k3.1-pro-highspeed"],
      ["k3"],
    ]),
  ),
  provider("moonshot", "Moonshot AI", "openai-chat", MOONSHOT_MODELS),
  provider("moonshot-cn", "Moonshot AI CN", "openai-chat", MOONSHOT_MODELS),
  provider("xiaomi", "Xiaomi MiMo", "openai-chat", XIAOMI_MODELS),
  provider("xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)", "openai-chat", XIAOMI_MODELS),
  provider("xiaomi-token-plan-ams", "Xiaomi MiMo Token Plan (Europe)", "openai-chat", XIAOMI_MODELS),
  provider("xiaomi-token-plan-sgp", "Xiaomi MiMo Token Plan (Singapore)", "openai-chat", XIAOMI_MODELS),
  provider(
    "hunyuan",
    "Tencent Hunyuan",
    "openai-chat",
    models([
      ["hunyuan-turbos-latest"],
      ["hunyuan-t1-latest"],
      ["hunyuan-2.0-thinking"],
      ["hunyuan-2.0-instruct"],
    ]),
  ),
  provider(
    "tencent-coding-plan",
    "Tencent Coding Plan",
    "openai-chat",
    models([
      ["tc-code-latest"],
      ["hunyuan-2.0-thinking"],
      ["hunyuan-2.0-instruct"],
      ["hunyuan-turbos"],
      ["hunyuan-t1"],
      ["glm-5"],
      ["kimi-k2.5"],
      ["minimax-m2.5"],
    ]),
  ),
  provider("tencent-tokenhub", "Tencent TokenHub (Hunyuan)", "openai-chat", TENCENT_HY_MODELS),
  provider("tencent-token-plan", "Tencent Token Plan", "openai-chat", TENCENT_HY_MODELS),
  provider(
    "volcengine",
    "Volcengine Ark (Doubao)",
    "openai-chat",
    models([
      ["doubao-seed-evolving"],
      ["doubao-seed-2-1-pro-260915"],
      ["doubao-seed-2-1-lite-260915"],
      ["doubao-seed-2-1-turbo-260628"],
    ]),
  ),
  provider(
    "volcengine-coding-plan",
    "Volcengine Ark Coding Plan",
    "openai-chat",
    models([
      ["ark-code-latest"],
      ["doubao-seed-evolving"],
      ["doubao-seed-2.1-pro"],
      ["doubao-seed-2.1-lite"],
      ["doubao-seed-2.1-turbo"],
      ["glm-5.3", ["low", "high", "max"]],
      ["glm-5.3-flash", ["low", "high", "max"]],
      ["deepseek-v4-pro", ["low", "high", "max"]],
      ["deepseek-v4.1-flash", ["low", "high", "max"]],
      ["kimi-k3.1-pro", ["low", "high", "max"]],
      ["minimax-m3"],
    ]),
  ),
  provider("minimax", "MiniMax (minimax.io)", "anthropic-messages", MINIMAX_MODELS),
  provider("minimax-cn", "MiniMax (China)", "anthropic-messages", MINIMAX_MODELS),
  provider("minimax-coding-plan", "MiniMax Token Plan (Global)", "anthropic-messages", MINIMAX_MODELS),
  provider("minimax-cn-coding-plan", "MiniMax Token Plan (China)", "anthropic-messages", MINIMAX_MODELS),
  provider(
    "qwen",
    "Qwen",
    "openai-chat",
    models([
      ["qwen4-max-preview", ["low", "medium", "xhigh"]],
      ["qwen3.8-max", ["low", "medium", "xhigh"]],
      ["qwen3.8-flash", ["low", "medium", "xhigh"]],
      ["qwen3.7-max"],
      ["qwen3.7-plus"],
      ["qwen3.6-plus"],
      ["qwen3.5-plus"],
      ["qwen3-coder-plus"],
      ["qwen3-vl-plus"],
      ["qwen-plus"],
      ["qwen-flash"],
      ["qwen-max"],
    ]),
  ),
  provider(
    "qwen-coding",
    "Qwen Coding",
    "openai-chat",
    models([
      ["qwen4-max-preview", ["low", "medium", "xhigh"]],
      ["qwen3.8-max", ["low", "medium", "xhigh"]],
      ["qwen3.8-flash", ["low", "medium", "xhigh"]],
      ["qwen3.7-max"],
      ["qwen3.7-plus"],
      ["qwen3.6-plus"],
      ["qwen3.6-flash"],
      ["deepseek-v4.1-flash", ["low", "high", "max"]],
      ["deepseek-v4-pro", ["high", "max"]],
      ["glm-5.3", ["low", "high", "max"]],
      ["kimi-k3.1-pro", ["low", "high", "max"]],
      ["kimi-k2.7-code"],
    ]),
  ),
  provider(
    "xai",
    "xAI",
    "openai-responses",
    models([
      ["grok-4.7", ["low", "medium", "high", "xhigh"]],
      ["grok-4.6", ["low", "medium", "high", "xhigh"]],
      ["grok-4.5", ["low", "medium", "high"]],
      ["grok-4.3", ["low", "medium", "high"]],
      ["grok-4.20-0309-reasoning"],
      ["grok-4.20-0309-non-reasoning"],
      ["grok-build-0.1"],
    ]),
  ),
  provider(
    "openrouter",
    "OpenRouter",
    "openai-chat",
    models([
      ["openai/gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
      ["openai/gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
      ["openai/gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]],
      ["anthropic/claude-fable-5.2"],
      ["anthropic/claude-opus-5.5"],
      ["anthropic/claude-sonnet-5.5"],
      ["google/gemini-4-carbon"],
      ["google/gemini-4-argon"],
      ["google/gemini-3.8-flash"],
      ["x-ai/grok-4.7", ["low", "medium", "high", "xhigh"]],
      ["deepseek/deepseek-v4.1-flash"],
      ["deepseek/deepseek-v4-pro"],
      ["moonshotai/kimi-k3.1-pro"],
      ["z-ai/glm-5.3", ["low", "high", "max"]],
      ["minimax/minimax-m3"],
      ["minimax/minimax-m3.1-flash"],
      ["qwen/qwen3.8-max", ["low", "medium", "xhigh"]],
    ]),
  ),
  provider(
    "longcat",
    "LongCat",
    "openai-chat",
    models([
      ["LongCat-2.5"],
      ["LongCat-2.5-Preview"],
    ]),
  ),
]);
