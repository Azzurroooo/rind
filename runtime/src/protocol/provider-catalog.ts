export type ProviderApi =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type AuthMethod = "oauth" | "api_key";

export interface ModelDefinition {
  readonly provider_id: string;
  readonly id: string;
  readonly api: ProviderApi;
  readonly reasoning_efforts: readonly string[];
  readonly context_window: number | null;
  readonly image_input: boolean | null;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly default_base_url: string;
  readonly auth_methods: readonly AuthMethod[];
  readonly environment_key: string | null;
  readonly fallback_models: readonly ModelDefinition[];
}

export interface CatalogModel {
  readonly id: string;
  readonly efforts: readonly string[];
}

export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly methods: readonly AuthMethod[];
  readonly envKey: string;
  readonly models: readonly CatalogModel[];
}

type ModelSpecTuple = readonly [string, readonly string[], boolean | null, number | null];

function makeModels(
  providerId: string,
  api: ProviderApi,
  values: readonly ModelSpecTuple[],
): readonly ModelDefinition[] {
  return Object.freeze(
    values.map(([id, reasoning_efforts, image_input, context_window]) =>
      Object.freeze({
        provider_id: providerId,
        id,
        api,
        reasoning_efforts: Object.freeze([...reasoning_efforts]),
        context_window,
        image_input,
      }),
    ),
  );
}

function makeProvider(
  id: string,
  name: string,
  api: ProviderApi,
  defaultBaseUrl: string,
  fallbackModels: readonly ModelDefinition[],
  authMethods: readonly AuthMethod[] = ["api_key"],
  environmentKey?: string,
): ProviderDefinition {
  return Object.freeze({
    id,
    name,
    api,
    default_base_url: defaultBaseUrl,
    auth_methods: Object.freeze([...authMethods]),
    environment_key: environmentKey ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    fallback_models: fallbackModels,
  });
}

const GLM_MODELS: readonly ModelSpecTuple[] = [
  ["glm-5.3", ["low", "high", "max"], false, 1000000],
  ["glm-5.3-flash", ["low", "high", "max"], true, 1000000],
  ["glm-5.3-flashx", ["low", "high", "max"], true, 1000000],
  ["glm-5.2", ["high", "max"], false, 1000000],
  ["glm-5v-turbo", [], true, 200000],
  ["glm-4.7", [], false, 200000],
  ["glm-4.6v", [], true, 128000],
];

const GLM_CODING_MODELS: readonly ModelSpecTuple[] = [
  ["glm-5.3", ["low", "high", "max"], false, 1000000],
  ["glm-5.3-highspeed", ["low", "high", "max"], false, 1000000],
  ["glm-5.3-flash", ["low", "high", "max"], true, 1000000],
  ["glm-5.2", ["high", "max"], false, 1000000],
  ["glm-4.7", [], false, 200000],
  ["glm-4.6v", [], true, 128000],
];

const MOONSHOT_MODELS: readonly ModelSpecTuple[] = [
  ["kimi-k3.1-pro", ["low", "high", "max"], true, 1048576],
  ["kimi-k3.1-pro-highspeed", ["low", "high", "max"], true, 1048576],
  ["kimi-k3", ["low", "high", "max"], true, 1048576],
  ["kimi-k2.7-code", [], true, 262144],
  ["kimi-k2.7-code-highspeed", [], true, 262144],
  ["kimi-k2.6", [], true, 262144],
];

const XIAOMI_MODELS: readonly ModelSpecTuple[] = [
  ["mimo-v2.6-pro", [], true, 1048576],
  ["mimo-v2.6-pro-ultraspeed", [], true, 1048576],
  ["mimo-v2.6-flash", [], true, 1048576],
];

const TENCENT_HY_MODELS: readonly ModelSpecTuple[] = [
  ["hy4", [], true, 1000000],
  ["hy4-preview", [], false, 1000000],
  ["hy3", [], false, 256000],
];

const MINIMAX_MODELS: readonly ModelSpecTuple[] = [
  ["MiniMax-M3", [], true, 1000000],
  ["MiniMax-M3.1-Flash", [], true, 1000000],
];

export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> = Object.freeze({
  openai: makeProvider(
    "openai",
    "OpenAI",
    "openai-responses",
    "https://api.openai.com/v1",
    makeModels("openai", "openai-responses", [
      ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-6.1-terra", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-6-luna", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["gpt-5.5", ["low", "medium", "high", "xhigh"], true, 1050000],
      ["gpt-5.4", ["low", "medium", "high", "xhigh"], true, 1050000],
      ["gpt-5.4-mini", ["low", "medium", "high", "xhigh"], true, 400000],
      ["gpt-5.4-nano", ["low", "medium", "high", "xhigh"], true, 400000],
      ["gpt-4.1", [], true, 1047576],
      ["gpt-4.1-mini", [], true, 1047576],
      ["gpt-4o", [], true, 128000],
      ["gpt-4o-mini", [], true, 128000],
      ["o3", ["low", "medium", "high"], true, 200000],
      ["o4-mini", ["low", "medium", "high"], true, 200000],
      ["o3-mini", ["low", "medium", "high"], false, 200000],
    ]),
    ["api_key", "oauth"],
  ),
  anthropic: makeProvider(
    "anthropic",
    "Anthropic",
    "anthropic-messages",
    "https://api.anthropic.com",
    makeModels("anthropic", "anthropic-messages", [
      ["claude-fable-5-2", [], true, 1000000],
      ["claude-opus-5-5", [], true, 1000000],
      ["claude-sonnet-5-5", [], true, 1000000],
      ["claude-haiku-5-5", [], true, 1000000],
      ["claude-fable-5-1", [], true, 1000000],
      ["claude-opus-5", [], true, 1000000],
      ["claude-sonnet-5", [], true, 1000000],
      ["claude-opus-4-8", [], true, 1000000],
      ["claude-opus-4-6", [], true, 1000000],
      ["claude-sonnet-4-6", [], true, 1000000],
      ["claude-haiku-4-5", [], true, 200000],
    ]),
  ),
  google: makeProvider(
    "google",
    "Google",
    "google-generative-ai",
    "https://generativelanguage.googleapis.com/v1beta",
    makeModels("google", "google-generative-ai", [
      ["gemini-4-carbon", [], true, 1048576],
      ["gemini-4-argon", [], true, 1048576],
      ["gemini-3.8-flash", [], true, 1048576],
      ["gemini-3.7-flash", [], true, 1048576],
      ["gemini-3.6-flash", [], true, 1048576],
      ["gemini-3.5-flash", [], true, 1048576],
      ["gemini-3.5-flash-lite", [], true, 1048576],
      ["gemini-3.1-pro-preview", [], true, 1048576],
      ["gemini-3.1-flash-lite", [], true, 1048576],
      ["gemini-2.5-pro", [], true, 1048576],
      ["gemini-2.5-flash", [], true, 1048576],
    ]),
  ),
  deepseek: makeProvider(
    "deepseek",
    "DeepSeek",
    "openai-chat",
    "https://api.deepseek.com/v1",
    makeModels("deepseek", "openai-chat", [
      ["deepseek-flash", ["low", "high", "max"], true, 1000000],
      ["deepseek-v4-pro", ["low", "high", "max"], false, 1000000],
      ["deepseek-v4-flash", ["low", "high", "max"], true, 1000000],
    ]),
  ),
  groq: makeProvider(
    "groq",
    "Groq",
    "openai-chat",
    "https://api.groq.com/openai/v1",
    makeModels("groq", "openai-chat", [
      ["openai/gpt-oss-120b", ["low", "medium", "high"], false, 131072],
      ["openai/gpt-oss-20b", ["low", "medium", "high"], false, 131072],
      ["qwen/qwen3.8-27b", ["low", "medium", "high"], true, 131072],
      ["llama-3.3-70b-versatile", [], false, 131072],
      ["llama-3.1-8b-instant", [], false, 131072],
    ]),
  ),
  mistral: makeProvider(
    "mistral",
    "Mistral",
    "openai-chat",
    "https://api.mistral.ai/v1",
    makeModels("mistral", "openai-chat", [
      ["mistral-large-latest", [], true, 1000000],
      ["mistral-medium-latest", ["high"], true, 262144],
      ["mistral-small-latest", ["low", "medium", "high"], true, 262144],
      ["codestral-latest", [], false, 131072],
    ]),
  ),
  zai: makeProvider("zai", "Z.AI", "openai-chat", "https://api.z.ai/api/paas/v4", makeModels("zai", "openai-chat", GLM_MODELS)),
  "zai-coding": makeProvider(
    "zai-coding",
    "Z.AI Coding",
    "openai-chat",
    "https://api.z.ai/api/coding/paas/v4",
    makeModels("zai-coding", "openai-chat", GLM_CODING_MODELS),
  ),
  zhipu: makeProvider("zhipu", "Zhipu", "openai-chat", "https://open.bigmodel.cn/api/paas/v4", makeModels("zhipu", "openai-chat", GLM_MODELS)),
  "zhipu-coding": makeProvider(
    "zhipu-coding",
    "Zhipu Coding",
    "openai-chat",
    "https://open.bigmodel.cn/api/coding/paas/v4",
    makeModels("zhipu-coding", "openai-chat", GLM_CODING_MODELS),
  ),
  "kimi-coding": makeProvider(
    "kimi-coding",
    "Kimi For Coding",
    "anthropic-messages",
    "https://api.kimi.com/coding",
    makeModels("kimi-coding", "anthropic-messages", [
      ["kimi-for-coding", [], true, 1048576],
      ["kimi-for-coding-highspeed", [], true, 1048576],
      ["k3.1-pro", [], true, 1048576],
      ["k3.1-pro-highspeed", [], true, 1048576],
      ["k3", [], true, 1048576],
    ]),
  ),
  moonshot: makeProvider("moonshot", "Moonshot AI", "openai-chat", "https://api.moonshot.ai/v1", makeModels("moonshot", "openai-chat", MOONSHOT_MODELS)),
  "moonshot-cn": makeProvider(
    "moonshot-cn",
    "Moonshot AI CN",
    "openai-chat",
    "https://api.moonshot.cn/v1",
    makeModels("moonshot-cn", "openai-chat", MOONSHOT_MODELS),
  ),
  xiaomi: makeProvider("xiaomi", "Xiaomi MiMo", "openai-chat", "https://api.xiaomimimo.com/v1", makeModels("xiaomi", "openai-chat", XIAOMI_MODELS)),
  "xiaomi-token-plan-cn": makeProvider(
    "xiaomi-token-plan-cn",
    "Xiaomi MiMo Token Plan (China)",
    "openai-chat",
    "https://token-plan-cn.xiaomimimo.com/v1",
    makeModels("xiaomi-token-plan-cn", "openai-chat", XIAOMI_MODELS),
  ),
  "xiaomi-token-plan-ams": makeProvider(
    "xiaomi-token-plan-ams",
    "Xiaomi MiMo Token Plan (Europe)",
    "openai-chat",
    "https://token-plan-ams.xiaomimimo.com/v1",
    makeModels("xiaomi-token-plan-ams", "openai-chat", XIAOMI_MODELS),
  ),
  "xiaomi-token-plan-sgp": makeProvider(
    "xiaomi-token-plan-sgp",
    "Xiaomi MiMo Token Plan (Singapore)",
    "openai-chat",
    "https://token-plan-sgp.xiaomimimo.com/v1",
    makeModels("xiaomi-token-plan-sgp", "openai-chat", XIAOMI_MODELS),
  ),
  hunyuan: makeProvider(
    "hunyuan",
    "Tencent Hunyuan",
    "openai-chat",
    "https://api.hunyuan.cloud.tencent.com/v1",
    makeModels("hunyuan", "openai-chat", [
      ["hunyuan-turbos-latest", [], false, 256000],
      ["hunyuan-t1-latest", [], false, 256000],
      ["hunyuan-2.0-thinking", [], false, 131072],
      ["hunyuan-2.0-instruct", [], false, 131072],
    ]),
  ),
  "tencent-coding-plan": makeProvider(
    "tencent-coding-plan",
    "Tencent Coding Plan",
    "openai-chat",
    "https://api.lkeap.cloud.tencent.com/coding/v3",
    makeModels("tencent-coding-plan", "openai-chat", [
      ["tc-code-latest", [], false, 131072],
      ["hunyuan-2.0-thinking", [], false, 131072],
      ["hunyuan-2.0-instruct", [], false, 131072],
      ["hunyuan-turbos", [], false, 131072],
      ["hunyuan-t1", [], false, 131072],
      ["glm-5", [], false, 202752],
      ["kimi-k2.5", [], true, 262144],
      ["minimax-m2.5", [], false, 204800],
    ]),
  ),
  "tencent-tokenhub": makeProvider(
    "tencent-tokenhub",
    "Tencent TokenHub (Hunyuan)",
    "openai-chat",
    "https://tokenhub.tencentmaas.com/v1",
    makeModels("tencent-tokenhub", "openai-chat", TENCENT_HY_MODELS),
  ),
  "tencent-token-plan": makeProvider(
    "tencent-token-plan",
    "Tencent Token Plan",
    "openai-chat",
    "https://api.lkeap.cloud.tencent.com/plan/v3",
    makeModels("tencent-token-plan", "openai-chat", TENCENT_HY_MODELS),
  ),
  volcengine: makeProvider(
    "volcengine",
    "Volcengine Ark (Doubao)",
    "openai-chat",
    "https://ark.cn-beijing.volces.com/api/v3",
    makeModels("volcengine", "openai-chat", [
      ["doubao-seed-evolving", [], true, 1024000],
      ["doubao-seed-2-1-pro-260915", [], true, 1024000],
      ["doubao-seed-2-1-lite-260915", [], true, 1024000],
      ["doubao-seed-2-1-turbo-260628", [], true, 256000],
    ]),
  ),
  "volcengine-coding-plan": makeProvider(
    "volcengine-coding-plan",
    "Volcengine Ark Coding Plan",
    "openai-chat",
    "https://ark.cn-beijing.volces.com/api/coding/v3",
    makeModels("volcengine-coding-plan", "openai-chat", [
      ["ark-code-latest", [], null, null],
      ["doubao-seed-evolving", [], true, 1024000],
      ["doubao-seed-2.1-pro", [], true, 1024000],
      ["doubao-seed-2.1-lite", [], true, 1024000],
      ["doubao-seed-2.1-turbo", [], true, 256000],
      ["glm-5.3", ["low", "high", "max"], false, 1000000],
      ["glm-5.3-flash", ["low", "high", "max"], true, 1000000],
      ["deepseek-v4-pro", ["low", "high", "max"], false, 1000000],
      ["deepseek-v4.1-flash", ["low", "high", "max"], true, 1000000],
      ["kimi-k3.1-pro", ["low", "high", "max"], true, 1048576],
      ["minimax-m3", [], true, 1000000],
    ]),
  ),
  minimax: makeProvider("minimax", "MiniMax (minimax.io)", "anthropic-messages", "https://api.minimax.io/anthropic", makeModels("minimax", "anthropic-messages", MINIMAX_MODELS)),
  "minimax-cn": makeProvider(
    "minimax-cn",
    "MiniMax (China)",
    "anthropic-messages",
    "https://api.minimax.cn/anthropic",
    makeModels("minimax-cn", "anthropic-messages", MINIMAX_MODELS),
  ),
  "minimax-coding-plan": makeProvider(
    "minimax-coding-plan",
    "MiniMax Token Plan (Global)",
    "anthropic-messages",
    "https://api.minimax.io/anthropic",
    makeModels("minimax-coding-plan", "anthropic-messages", MINIMAX_MODELS),
  ),
  "minimax-cn-coding-plan": makeProvider(
    "minimax-cn-coding-plan",
    "MiniMax Token Plan (China)",
    "anthropic-messages",
    "https://api.minimax.cn/anthropic",
    makeModels("minimax-cn-coding-plan", "anthropic-messages", MINIMAX_MODELS),
  ),
  qwen: makeProvider(
    "qwen",
    "Qwen",
    "openai-chat",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    makeModels("qwen", "openai-chat", [
      ["qwen4-max-preview", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.8-max", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.8-flash", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.7-max", [], false, 1000000],
      ["qwen3.7-plus", [], true, 1000000],
      ["qwen3.6-plus", [], true, 1000000],
      ["qwen3.5-plus", [], true, 1000000],
      ["qwen3-coder-plus", [], false, 1048576],
      ["qwen3-vl-plus", [], true, 262144],
      ["qwen-plus", [], false, 1000000],
      ["qwen-flash", [], false, 1000000],
      ["qwen-max", [], false, 131072],
    ]),
  ),
  "qwen-coding": makeProvider(
    "qwen-coding",
    "Qwen Coding",
    "openai-chat",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    makeModels("qwen-coding", "openai-chat", [
      ["qwen4-max-preview", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.8-max", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.8-flash", ["low", "medium", "xhigh"], true, 1000000],
      ["qwen3.7-max", [], false, 1000000],
      ["qwen3.7-plus", [], true, 1000000],
      ["qwen3.6-plus", [], true, 1000000],
      ["qwen3.6-flash", [], true, 1000000],
      ["deepseek-v4.1-flash", ["low", "high", "max"], true, 1000000],
      ["deepseek-v4-pro", ["high", "max"], false, 1000000],
      ["glm-5.3", ["low", "high", "max"], false, 1000000],
      ["kimi-k3.1-pro", ["low", "high", "max"], true, 1048576],
      ["kimi-k2.7-code", [], true, 262144],
    ]),
  ),
  xai: makeProvider(
    "xai",
    "xAI",
    "openai-responses",
    "https://api.x.ai/v1",
    makeModels("xai", "openai-responses", [
      ["grok-4.7", ["low", "medium", "high", "xhigh"], true, 500000],
      ["grok-4.6", ["low", "medium", "high", "xhigh"], true, 500000],
      ["grok-4.5", ["low", "medium", "high"], true, 500000],
      ["grok-4.3", ["low", "medium", "high"], true, 1000000],
      ["grok-4.20-0309-reasoning", [], true, 1000000],
      ["grok-4.20-0309-non-reasoning", [], true, 1000000],
      ["grok-build-0.1", [], true, 256000],
    ]),
  ),
  openrouter: makeProvider(
    "openrouter",
    "OpenRouter",
    "openai-chat",
    "https://openrouter.ai/api/v1",
    makeModels("openrouter", "openai-chat", [
      ["openai/gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["openai/gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["openai/gpt-6-luna", ["low", "medium", "high", "xhigh", "max"], true, 1050000],
      ["anthropic/claude-fable-5.2", [], true, 1000000],
      ["anthropic/claude-opus-5.5", [], true, 1000000],
      ["anthropic/claude-sonnet-5.5", [], true, 1000000],
      ["google/gemini-4-carbon", [], true, 1048576],
      ["google/gemini-4-argon", [], true, 1048576],
      ["google/gemini-3.8-flash", [], true, 1048576],
      ["x-ai/grok-4.7", ["low", "medium", "high", "xhigh"], true, 500000],
      ["deepseek/deepseek-v4.1-flash", [], true, 1000000],
      ["deepseek/deepseek-v4-pro", [], false, 1000000],
      ["moonshotai/kimi-k3.1-pro", [], true, 1048576],
      ["z-ai/glm-5.3", ["low", "high", "max"], false, 1000000],
      ["minimax/minimax-m3", [], true, 1000000],
      ["minimax/minimax-m3.1-flash", [], true, 1000000],
      ["qwen/qwen3.8-max", ["low", "medium", "xhigh"], true, 1000000],
    ]),
  ),
  longcat: makeProvider(
    "longcat",
    "LongCat",
    "openai-chat",
    "https://api.longcat.chat/openai/v1",
    makeModels("longcat", "openai-chat", [
      ["LongCat-2.5", [], true, 1048576],
      ["LongCat-2.5-Preview", [], true, 1048576],
    ]),
  ),
});

export const BUILTIN_PROVIDER_CATALOG: readonly CatalogProvider[] = Object.freeze(
  Object.values(PROVIDERS).map((def) =>
    Object.freeze({
      id: def.id,
      name: def.name,
      api: def.api,
      methods: def.auth_methods,
      envKey: def.environment_key ?? `${def.id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      models: Object.freeze(
        def.fallback_models.map((m) =>
          Object.freeze({ id: m.id, efforts: m.reasoning_efforts }),
        ),
      ),
    }),
  ),
);
