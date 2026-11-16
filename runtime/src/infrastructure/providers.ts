import fs from "node:fs";
import path from "node:path";
import type { AuthMethod, Credential, ModelDefinition, ProviderApi, ProviderDefinition } from "../domain/models.js";
import { REASONING_EFFORTS } from "./settings.js";
import { resolveRindHome } from "./paths.js";
import { atomicWriteTextSync, fileStatSignature } from "./persistence/atomic-files.js";

export const API_TYPES = new Set<ProviderApi>([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const PROTOCOL_OPTIONS: readonly string[] = [
  "openai-chat · OpenAI Chat Completions",
  "openai-responses · OpenAI Responses",
  "anthropic-messages · Anthropic Messages",
  "google-generative-ai · Google Generative AI",
];

export interface UserModelConfig {
  readonly api: ProviderApi | null;
  readonly context_window: number | null;
  readonly image_input: boolean | null;
  readonly reasoning_efforts: readonly string[] | null;
}


export function defaultReasoningEfforts(api: ProviderApi | string): readonly string[] {
  return api === "anthropic-messages" || api === "google-generative-ai" ? [] : REASONING_EFFORTS;
}

export function resolveReasoningEffort(
  configured: string | null | undefined,
  requested: string | null | undefined,
  supported: readonly string[],
): string | null {
  if (!requested || !supported.includes(requested) || (requested === "low" && (configured === "none" || configured === "off" || configured === "minimal"))) {
    return configured ?? null;
  }
  return requested;
}

export function refreshableModelsApi(api: ProviderApi | string): boolean {
  return api === "openai-chat" || api === "openai-responses";
}

function makeModels(
  providerId: string,
  api: ProviderApi,
  values: readonly (readonly [string, readonly string[], boolean | null, number | null])[],
): readonly ModelDefinition[] {
  return values.map(([id, reasoning_efforts, image_input, context_window]) => ({
    provider_id: providerId,
    id,
    api,
    reasoning_efforts,
    context_window,
    image_input,
  }));
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
  return {
    id,
    name,
    api,
    default_base_url: defaultBaseUrl,
    auth_methods: authMethods,
    environment_key: environmentKey ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    fallback_models: fallbackModels,
  };
}

type ModelSpecTuple = readonly [string, readonly string[], boolean | null, number | null];

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

export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> = {
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
  zai: makeProvider(
    "zai",
    "Z.AI",
    "openai-chat",
    "https://api.z.ai/api/paas/v4",
    makeModels("zai", "openai-chat", GLM_MODELS),
  ),
  "zai-coding": makeProvider(
    "zai-coding",
    "Z.AI Coding",
    "openai-chat",
    "https://api.z.ai/api/coding/paas/v4",
    makeModels("zai-coding", "openai-chat", GLM_CODING_MODELS),
  ),
  zhipu: makeProvider(
    "zhipu",
    "Zhipu",
    "openai-chat",
    "https://open.bigmodel.cn/api/paas/v4",
    makeModels("zhipu", "openai-chat", GLM_MODELS),
  ),
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
  moonshot: makeProvider(
    "moonshot",
    "Moonshot AI",
    "openai-chat",
    "https://api.moonshot.ai/v1",
    makeModels("moonshot", "openai-chat", MOONSHOT_MODELS),
  ),
  "moonshot-cn": makeProvider(
    "moonshot-cn",
    "Moonshot AI CN",
    "openai-chat",
    "https://api.moonshot.cn/v1",
    makeModels("moonshot-cn", "openai-chat", MOONSHOT_MODELS),
  ),
  xiaomi: makeProvider(
    "xiaomi",
    "Xiaomi MiMo",
    "openai-chat",
    "https://api.xiaomimimo.com/v1",
    makeModels("xiaomi", "openai-chat", XIAOMI_MODELS),
  ),
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
  minimax: makeProvider(
    "minimax",
    "MiniMax (minimax.io)",
    "anthropic-messages",
    "https://api.minimax.io/anthropic",
    makeModels("minimax", "anthropic-messages", MINIMAX_MODELS),
  ),
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
};

export function provider(providerId: string): ProviderDefinition {
  const found = PROVIDERS[providerId];
  if (!found) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return found;
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

const PROVIDER_KEYS = new Set(["name", "api", "baseUrl", "envKey", "models"]);
const MODEL_KEYS = new Set(["api", "contextWindow", "imageInput", "reasoningEfforts"]);

function parseModelConfig(providerId: string, modelId: string, raw: unknown): UserModelConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid providers.json: model '${providerId}/${modelId}' must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => !MODEL_KEYS.has(k)).sort();
  if (unknown.length > 0) {
    throw new Error(`Invalid providers.json: model '${providerId}/${modelId}' has unknown field '${unknown[0]}'`);
  }
  const api = obj.api;
  if (api !== undefined && api !== null && (!API_TYPES.has(api as ProviderApi) || typeof api !== "string")) {
    throw new Error(`Invalid providers.json: model '${providerId}/${modelId}' has unsupported api '${String(api)}'`);
  }
  const contextWindow = obj.contextWindow;
  if (
    contextWindow !== undefined &&
    contextWindow !== null &&
    (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0)
  ) {
    throw new Error(`Invalid providers.json: model '${providerId}/${modelId}' contextWindow must be a positive integer`);
  }
  const imageInput = obj.imageInput;
  if (imageInput !== undefined && imageInput !== null && typeof imageInput !== "boolean") {
    throw new Error(`Invalid providers.json: model '${providerId}/${modelId}' imageInput must be a boolean`);
  }
  const reasoningEfforts = obj.reasoningEfforts;
  if (reasoningEfforts !== undefined && reasoningEfforts !== null) {
    if (
      !Array.isArray(reasoningEfforts) ||
      !reasoningEfforts.every(v => typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v))
    ) {
      throw new Error(
        `Invalid providers.json: model '${providerId}/${modelId}' reasoningEfforts must be a list of ${JSON.stringify(REASONING_EFFORTS)}`,
      );
    }
  }
  return {
    api: (api as ProviderApi | undefined) ?? null,
    context_window: (contextWindow as number | undefined) ?? null,
    image_input: (imageInput as boolean | undefined) ?? null,
    reasoning_efforts: Array.isArray(reasoningEfforts) ? [...(reasoningEfforts as string[])] : null,
  };
}

function mergeProvider(
  providerId: string,
  raw: unknown,
  existing: ProviderDefinition | undefined,
): [ProviderDefinition, Record<string, UserModelConfig>] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid providers.json: provider '${providerId}' must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => !PROVIDER_KEYS.has(k)).sort();
  if (unknown.length > 0) {
    throw new Error(`Invalid providers.json: provider '${providerId}' has unknown field '${unknown[0]}'`);
  }
  const api = (obj.api ?? (existing ? existing.api : null)) as ProviderApi | null;
  if (!api || typeof api !== "string" || !API_TYPES.has(api)) {
    throw new Error(`Invalid providers.json: provider '${providerId}' has unsupported api '${String(api)}'`);
  }
  const baseUrlRaw = obj.baseUrl ?? (existing ? existing.default_base_url : null);
  if (typeof baseUrlRaw !== "string" || !isValidHttpUrl(baseUrlRaw)) {
    throw new Error(`Invalid providers.json: provider '${providerId}' requires a valid http(s) baseUrl`);
  }
  const rawModels = obj.models !== undefined ? obj.models : {};
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    throw new Error(`Invalid providers.json: provider '${providerId}.models' must be an object`);
  }
  const modelsObj = rawModels as Record<string, unknown>;
  const userModels: Record<string, UserModelConfig> = {};
  for (const [rawModelId, modelValue] of Object.entries(modelsObj)) {
    const modelId = String(rawModelId).trim();
    if (!modelId) {
      throw new Error(`Invalid providers.json: provider '${providerId}' contains an empty model id`);
    }
    userModels[modelId] = parseModelConfig(providerId, modelId, modelValue);
  }

  const modelsById = new Map<string, ModelDefinition>();
  if (existing) {
    for (const model of existing.fallback_models) {
      modelsById.set(model.id, model);
    }
  }
  for (const [modelId, cfg] of Object.entries(userModels)) {
    const base = modelsById.get(modelId);
    const modelApi = cfg.api ?? (base ? base.api : api);
    let efforts: readonly string[];
    if (cfg.reasoning_efforts !== null) {
      efforts = cfg.reasoning_efforts;
    } else if (base && cfg.api === null) {
      efforts = base.reasoning_efforts;
    } else {
      efforts = defaultReasoningEfforts(modelApi);
    }
    modelsById.set(modelId, {
      provider_id: providerId,
      id: modelId,
      api: modelApi,
      reasoning_efforts: efforts,
      context_window: cfg.context_window !== null ? cfg.context_window : (base ? base.context_window : null),
      image_input: cfg.image_input !== null ? cfg.image_input : (base ? base.image_input : null),
    });
  }

  const nameRaw = obj.name ?? (existing ? existing.name : providerId);
  const envKeyRaw = obj.envKey ?? (existing ? existing.environment_key : null);
  return [
    {
      id: providerId,
      name: String(nameRaw).trim() || providerId,
      api,
      default_base_url: baseUrlRaw.trim().replace(/\/+$/, ""),
      auth_methods: existing ? existing.auth_methods : ["api_key"],
      environment_key: typeof envKeyRaw === "string" && envKeyRaw.trim() ? envKeyRaw.trim() : null,
      fallback_models: Array.from(modelsById.values()),
    },
    userModels,
  ];
}

const PROVIDERS_CACHE = new Map<
  string,
  [string, Record<string, ProviderDefinition>, Record<string, Record<string, UserModelConfig>>]
>();

function cloneUserModelsMap(
  source: Record<string, Record<string, UserModelConfig>>,
): Record<string, Record<string, UserModelConfig>> {
  const out: Record<string, Record<string, UserModelConfig>> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = { ...v };
  }
  return out;
}

export function loadProviders(
  providersPath?: string | null,
  builtin: Readonly<Record<string, ProviderDefinition>> = PROVIDERS,
): [Record<string, ProviderDefinition>, Record<string, Record<string, UserModelConfig>>] {
  const filePath = path.resolve(providersPath || path.join(resolveRindHome(), "providers.json"));
  const sig = fileStatSignature(filePath);
  if (!sig) {
    PROVIDERS_CACHE.delete(filePath);
    return [{ ...builtin }, {}];
  }
  if (builtin === PROVIDERS) {
    const cached = PROVIDERS_CACHE.get(filePath);
    if (cached && cached[0] === sig) {
      return [{ ...cached[1] }, cloneUserModelsMap(cached[2])];
    }
  }
  const merged: Record<string, ProviderDefinition> = { ...builtin };
  const userModels: Record<string, Record<string, UserModelConfig>> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid providers.json (${filePath}): ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid providers.json (${filePath}): root must be a JSON object`);
  }
  const rootObj = raw as Record<string, unknown>;
  const unknownRoot = Object.keys(rootObj).filter(k => k !== "providers");
  if (unknownRoot.length > 0) {
    throw new Error(`Invalid providers.json (${filePath}): root only supports 'providers'`);
  }
  const entries = rootObj.providers !== undefined ? rootObj.providers : {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`Invalid providers.json (${filePath}): 'providers' must be an object`);
  }
  for (const [rawId, value] of Object.entries(entries as Record<string, unknown>)) {
    const providerId = String(rawId).trim();
    if (!providerId) {
      throw new Error(`Invalid providers.json (${filePath}): provider id cannot be empty`);
    }
    const [definition, models] = mergeProvider(providerId, value, merged[providerId]);
    merged[providerId] = definition;
    userModels[providerId] = models;
  }
  if (builtin === PROVIDERS) {
    if (!PROVIDERS_CACHE.has(filePath) && PROVIDERS_CACHE.size >= 8) {
      const oldest = PROVIDERS_CACHE.keys().next().value;
      if (oldest !== undefined) PROVIDERS_CACHE.delete(oldest);
    }
    PROVIDERS_CACHE.set(filePath, [sig, { ...merged }, cloneUserModelsMap(userModels)]);
  }
  return [merged, userModels];
}

export function saveCustomProvider(
  providerId: string,
  options: {
    name?: string | null;
    api: string;
    baseUrl: string;
    model: string;
    path?: string | null;
  },
): string {
  const pid = providerId.trim();
  const model = options.model.trim();
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const api = options.api as ProviderApi;
  if (!pid) {
    throw new Error("Provider ID is required.");
  }
  if (!API_TYPES.has(api)) {
    throw new Error(`Unsupported API type: ${api}`);
  }
  if (!isValidHttpUrl(baseUrl)) {
    throw new Error("Base URL must be a valid http(s) URL.");
  }
  if (!model) {
    throw new Error("Default model ID is required.");
  }

  const target = path.resolve(options.path || path.join(resolveRindHome(), "providers.json"));
  loadProviders(target);
  let data: Record<string, unknown> = { providers: {} };
  if (fs.existsSync(target)) {
    data = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  }
  const providers = (data.providers ?? (data.providers = {})) as Record<string, unknown>;
  const entry = ((providers[pid] && typeof providers[pid] === "object" && !Array.isArray(providers[pid]))
    ? providers[pid]
    : (providers[pid] = {})) as Record<string, unknown>;
  entry.name = (options.name || "").trim() || (typeof entry.name === "string" && entry.name ? entry.name : pid);
  entry.api = api;
  entry.baseUrl = baseUrl;
  const models = ((entry.models && typeof entry.models === "object" && !Array.isArray(entry.models))
    ? entry.models
    : (entry.models = {})) as Record<string, unknown>;
  if (!(model in models)) {
    models[model] = {};
  }
  loadProvidersFromData(data);
  atomicWriteTextSync(target, JSON.stringify(data, null, 2) + "\n");
  PROVIDERS_CACHE.delete(target);
  return pid;
}

function loadProvidersFromData(data: Record<string, unknown>): void {
  const entries = (data.providers ?? {}) as Record<string, unknown>;
  for (const [providerId, value] of Object.entries(entries)) {
    mergeProvider(String(providerId).trim(), value, PROVIDERS[String(providerId).trim()]);
  }
}

const AUTH_CACHE = new Map<string, [string, Record<string, unknown>]>();

export class CredentialStore {
  readonly path: string;

  constructor(filePath?: string | null) {
    this.path = path.resolve(filePath || path.join(resolveRindHome(), "auth.json"));
  }

  get(providerId: string): Credential | null {
    const raw = this.readAll()[providerId];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    return parseCredential(raw as Record<string, unknown>);
  }

  list(): Array<{ provider_id: string; type: string }> {
    const all = this.readAll();
    return Object.keys(all)
      .sort()
      .flatMap(providerId => {
        const value = all[providerId];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const type = (value as Record<string, unknown>).type;
          if (type === "api_key" || type === "oauth") {
            return [{ provider_id: providerId, type }];
          }
        }
        return [];
      });
  }

  set(providerId: string, credential: Credential): void {
    if (!providerId.trim()) {
      throw new Error("Provider id is required.");
    }
    const all = this.readAll();
    all[providerId] = credentialToDict(credential);
    this.writeAll(all);
  }

  async renew(
    providerId: string,
    refresh: (current: Credential) => Credential | Promise<Credential>,
  ): Promise<Credential | null> {
    const current = this.get(providerId);
    if (!current) {
      return null;
    }
    const renewed = await refresh(current);
    if (
      renewed.type !== current.type ||
      renewed.key !== current.key ||
      renewed.access !== current.access ||
      renewed.refresh !== current.refresh ||
      renewed.expires_at !== current.expires_at ||
      renewed.client_id !== current.client_id
    ) {
      this.set(providerId, renewed);
    }
    return renewed;
  }

  delete(providerId: string): boolean {
    const all = this.readAll();
    if (!(providerId in all)) {
      return false;
    }
    delete all[providerId];
    this.writeAll(all);
    return true;
  }

  private readAll(): Record<string, unknown> {
    const sig = fileStatSignature(this.path);
    if (!sig) {
      AUTH_CACHE.delete(this.path);
      return {};
    }
    const cached = AUTH_CACHE.get(this.path);
    if (cached && cached[0] === sig) {
      return { ...cached[1] };
    }
    const value = JSON.parse(fs.readFileSync(this.path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid auth.json: ${this.path} must contain a JSON object`);
    }
    const record = value as Record<string, unknown>;
    if (!AUTH_CACHE.has(this.path) && AUTH_CACHE.size >= 8) {
      const oldest = AUTH_CACHE.keys().next().value;
      if (oldest !== undefined) AUTH_CACHE.delete(oldest);
    }
    AUTH_CACHE.set(this.path, [sig, record]);
    return { ...record };
  }

  private writeAll(payload: Record<string, unknown>): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    atomicWriteTextSync(this.path, JSON.stringify(payload, null, 2) + "\n", 0o600);
    AUTH_CACHE.delete(this.path);
  }
}

function parseCredential(value: Record<string, unknown>): Credential | null {
  const kind = value.type;
  if (kind === "api_key" && typeof value.key === "string" && value.key) {
    return { type: "api_key", key: value.key };
  }
  if (kind === "oauth" && typeof value.access === "string" && value.access) {
    const expires = value.expires_at;
    return {
      type: "oauth",
      access: value.access,
      refresh: String(value.refresh || ""),
      expires_at: typeof expires === "number" ? Math.trunc(expires) : null,
      client_id: String(value.client_id || ""),
    };
  }
  return null;
}

function credentialToDict(credential: Credential): Record<string, unknown> {
  if (credential.type === "api_key") {
    if (!credential.key) {
      throw new Error("API key is required.");
    }
    return { type: "api_key", key: credential.key };
  }
  if (!credential.access) {
    throw new Error("OAuth access token is required.");
  }
  const value: Record<string, unknown> = { type: "oauth", access: credential.access };
  if (credential.refresh) value.refresh = credential.refresh;
  if (credential.expires_at !== undefined && credential.expires_at !== null) value.expires_at = credential.expires_at;
  if (credential.client_id) value.client_id = credential.client_id;
  return value;
}

