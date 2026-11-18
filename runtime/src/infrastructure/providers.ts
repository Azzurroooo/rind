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

import { PROVIDERS } from "../protocol/provider-catalog.js";
export { PROVIDERS };;

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

