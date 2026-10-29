import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "../../domain/errors.js";
import type {
  ChatClient,
  Credential,
  ModelCatalog,
  ModelCompletion,
  ModelDefinition,
  ModelSelection,
  ModelStreamEvent,
  ProviderDefinition,
  ProviderStatus,
} from "../../domain/models.js";
import * as chatgptOAuth from "../chatgpt-oauth.js";
import type { AuthInteraction } from "../chatgpt-oauth.js";
import {
  API_TYPES,
  CredentialStore,
  defaultReasoningEfforts,
  isValidHttpUrl,
  loadProviders,
  PROTOCOL_OPTIONS,
  PROVIDERS,
  refreshableModelsApi,
  saveCustomProvider,
  type UserModelConfig,
} from "../providers.js";
import { type AppSettings, DEFAULT_USER_AGENT, loadSettings } from "../settings.js";
import { AnthropicMessagesClient } from "./anthropic-messages.js";
import { GoogleGenerativeAIClient } from "./google-generative-ai.js";
import { type ApiKeyProvider, OpenAIChatCompletionsClient } from "./openai-chat.js";
import { OpenAIResponsesClient } from "./openai-responses.js";

const MODEL_CACHE_TTL = 24 * 60 * 60;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const OAUTH_FLOWS: Record<string, typeof chatgptOAuth> = {
  openai: chatgptOAuth,
};

export type RemoteModelsListFn = (
  baseUrl: string,
  apiKey: ApiKeyProvider,
  timeoutMs: number,
) => Promise<unknown[]>;

export class ProviderServiceImpl {
  readonly credentials: CredentialStore;
  readonly providers: Record<string, ProviderDefinition>;
  readonly cachePath: string;
  readonly providersPath: string;
  private readonly remoteModelsFetcher: RemoteModelsListFn;

  constructor(
    credentialStore?: CredentialStore | null,
    providers?: Readonly<Record<string, ProviderDefinition>> | null,
    remoteModelsFetcher?: RemoteModelsListFn,
  ) {
    this.credentials = credentialStore ?? new CredentialStore();
    this.providers = { ...(providers ?? PROVIDERS) };
    const dir = path.dirname(this.credentials.path);
    this.cachePath = path.join(dir, "model-cache.json");
    this.providersPath = path.join(dir, "providers.json");
    this.remoteModelsFetcher = remoteModelsFetcher ?? fetchRemoteModels;
  }

  defaultSelection(): ModelSelection {
    const settings = loadSettings();
    return {
      provider_id: settings.provider,
      model_id: settings.model,
      reasoning_effort: settings.reasoning_effort,
    };
  }

  resolveSelection(selection: ModelSelection): ModelDefinition {
    const [connections, userModels] = this.loadedProviders();
    const definition = ProviderServiceImpl.providerFrom(connections, selection.provider_id);
    return this.resolveModel(
      definition,
      userModels[definition.id] ?? {},
      selection.model_id,
      this.readCache()[definition.id],
    );
  }

  describeConnection(providerId: string, modelId = ""): Record<string, string | null> | null {
    let definition: ProviderDefinition;
    try {
      definition = this.provider(providerId);
    } catch (err) {
      if (err instanceof ProviderError) {
        return null;
      }
      throw err;
    }
    const builtin = this.providers[definition.id];
    let kind: string;
    if (!builtin) {
      kind = "custom";
    } else if (builtin.default_base_url !== definition.default_base_url) {
      kind = "overridden";
    } else {
      kind = "builtin";
    }
    const [credential, source] = this.credentialWithSource(definition);
    const auth = credential ? credential.type : "none";
    const knownModel = definition.fallback_models.find(m => m.id === modelId);
    const flow = OAUTH_FLOWS[definition.id];
    return {
      name: definition.name,
      endpoint: definition.default_base_url,
      api: knownModel ? knownModel.api : definition.api,
      kind,
      auth,
      credential: source,
      env_key: definition.environment_key,
      account: auth === "oauth" && flow ? flow.ACCOUNT_NAME : "",
    };
  }

  listProviders(): ProviderStatus[] {
    let connections: Record<string, ProviderDefinition>;
    try {
      connections = this.connections();
    } catch {
      connections = { ...this.providers };
    }
    const result: ProviderStatus[] = [];
    for (const definition of Object.values(connections)) {
      const source = this.credentialSource(definition);
      result.push({
        id: definition.id,
        name: definition.name,
        methods: definition.auth_methods,
        configured: source !== "none",
        source,
      });
    }
    return result;
  }

  async listModels(options?: { refresh?: boolean }): Promise<ModelCatalog> {
    const refresh = Boolean(options?.refresh);
    const settings = loadSettings();
    const [connections, userModels] = this.loadedProviders();
    const failures: string[] = [];
    for (const definition of Object.values(connections)) {
      if (this.credentialSource(definition) === "none") {
        continue;
      }
      if (refresh && !(await this.fetchModels(definition))) {
        failures.push(`failed to refresh ${definition.name} models, showing saved models`);
      }
    }
    const models = this.buildCatalog(settings, connections, userModels);
    return {
      models,
      warning: failures.length > 0 ? failures.join("; ") : null,
    };
  }

  async login(providerId: string, method: string, interaction: AuthInteraction): Promise<string> {
    if (method === "connection") {
      return await this.addConnection(interaction);
    }
    const definition = this.provider(providerId);
    if (!(definition.auth_methods as readonly string[]).includes(method)) {
      throw new Error(`${definition.name} does not support ${method} login.`);
    }
    let credential: Credential;
    if (method === "oauth") {
      const flow = OAUTH_FLOWS[providerId];
      if (!flow) {
        throw new Error(`${definition.name} does not support oauth login.`);
      }
      credential = await flow.login(interaction);
    } else {
      const key = (await interaction.prompt("secret", `${definition.name} API key`)).trim();
      if (!key) {
        throw new Error("Login canceled.");
      }
      credential = { type: "api_key", key };
    }
    this.credentials.set(providerId, credential);
    await this.fetchModels(definition);
    return providerId;
  }

  private async addConnection(interaction: AuthInteraction): Promise<string> {
    const name = (await interaction.prompt("text", "Connection name")).trim();
    if (!name) {
      throw new Error("Login canceled.");
    }
    const connectionId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (!CONNECTION_ID_PATTERN.test(connectionId)) {
      throw new Error("A connection name needs at least one letter or digit.");
    }
    if (connectionId in this.providers) {
      throw new Error(
        `${connectionId} is a built-in provider; log in to it directly or choose another name.`,
      );
    }
    const chosenApi = (
      await interaction.prompt("select", `API protocol for ${name}`, PROTOCOL_OPTIONS)
    ).trim();
    if (!chosenApi) {
      throw new Error("Login canceled.");
    }
    const api = chosenApi.split("·", 1)[0].trim();
    if (!API_TYPES.has(api as never)) {
      throw new Error(`Unsupported API protocol: ${api}`);
    }
    const baseUrl = (await interaction.prompt("text", "Base URL (e.g. https://host/v1)")).trim();
    if (!isValidHttpUrl(baseUrl)) {
      throw new Error("Base URL must be an http(s) URL.");
    }
    const model = (
      await interaction.prompt("text", "Model id (empty: use the endpoint model list)")
    ).trim();
    const key = (await interaction.prompt("secret", `${name} API key`)).trim();
    if (!key) {
      throw new Error("Login canceled.");
    }
    saveCustomProvider(connectionId, {
      name,
      api,
      baseUrl,
      model,
      path: this.providersPath,
    });
    this.credentials.set(connectionId, { type: "api_key", key });
    await this.fetchModels(this.provider(connectionId));
    return connectionId;
  }

  async refreshStaleModels(): Promise<void> {
    try {
      const cache = this.readCache();
      for (const definition of Object.values(this.connections())) {
        if (!refreshableModelsApi(definition.api)) {
          continue;
        }
        if (this.resolveCredential(definition) === null) {
          continue;
        }
        const entry = cache[definition.id];
        if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).base_url === definition.default_base_url
        ) {
          const refreshedAt = (entry as Record<string, unknown>).refreshed_at;
          if (
            this.cachedModels(entry, definition).length > 0 &&
            typeof refreshedAt === "number" &&
            Number.isFinite(refreshedAt) &&
            Date.now() / 1000 - refreshedAt >= 0 &&
            Date.now() / 1000 - refreshedAt < MODEL_CACHE_TTL
          ) {
            continue;
          }
        }
        await this.fetchModels(definition);
      }
    } catch {
      // Background model refresh is best-effort.
    }
  }

  logout(providerId: string): boolean {
    return this.credentials.delete(providerId);
  }

  async createChatClient(_settings: AppSettings, selection: ModelSelection): Promise<ChatClient> {
    const definition = this.provider(selection.provider_id);
    const credential = this.resolveCredential(definition);
    if (credential === null) {
      const hint = definition.environment_key ? ` or set ${definition.environment_key}` : "";
      throw new ProviderError(`${definition.name} is not configured. Run /login${hint}.`, {
        status: "rejected",
        code: "provider_not_configured",
      });
    }
    const endpoint = definition.default_base_url;
    const key = this.apiKey(definition, credential);
    const knownModel = definition.fallback_models.find(m => m.id === selection.model_id);
    const api = knownModel ? knownModel.api : definition.api;
    const efforts = knownModel ? knownModel.reasoning_efforts : [];
    const reasoningEffort = definition.id === "longcat" ? "" : selection.reasoning_effort;

    if (api === "openai-chat") {
      return new OpenAIChatCompletionsClient({
        apiKey: key,
        model: selection.model_id,
        baseUrl: endpoint,
        reasoningEffort,
        reasoningEfforts: efforts,
      });
    }
    if (api === "openai-responses") {
      return new OpenAIResponsesClient({
        apiKey: key,
        model: selection.model_id,
        baseUrl: endpoint,
        reasoningEffort: selection.reasoning_effort,
        reasoningEfforts: efforts,
        subscription: credential.type === "oauth",
      });
    }
    if (api === "anthropic-messages") {
      return new AnthropicMessagesClient({
        apiKey: credential.key || "",
        model: selection.model_id,
        baseUrl: endpoint,
      });
    }
    if (api === "google-generative-ai") {
      return new GoogleGenerativeAIClient({
        apiKey: credential.key || "",
        model: selection.model_id,
        baseUrl: endpoint,
      });
    }
    throw new ProviderError(`Unsupported provider API: ${api}`, {
      status: "rejected",
      code: "unsupported_api",
    });
  }

  unavailableClient(selection: ModelSelection, error: ProviderError): ChatClient {
    return new UnavailableChatClient(selection.model_id, error);
  }

  private buildCatalog(
    settings: AppSettings,
    connections: Record<string, ProviderDefinition>,
    userModels: Record<string, Record<string, UserModelConfig>>,
  ): ModelDefinition[] {
    const cache = this.readCache();
    const result: ModelDefinition[] = [];
    for (const definition of Object.values(connections)) {
      if (this.credentialSource(definition) === "none") {
        continue;
      }
      const entry = cache[definition.id];
      const providerUserModels = userModels[definition.id] ?? {};
      const items = this.cachedModels(entry, definition);
      let models = items.map(item =>
        this.resolveModel(definition, providerUserModels, itemId(item), entry, item),
      );
      if (models.length === 0) {
        models = definition.fallback_models.map(m =>
          this.resolveModel(definition, providerUserModels, m.id, entry),
        );
      } else {
        const listedIds = new Set(models.map(m => m.id));
        for (const modelId of Object.keys(providerUserModels)) {
          if (!listedIds.has(modelId)) {
            models.push(this.resolveModel(definition, providerUserModels, modelId, entry));
          }
        }
      }
      result.push(...models);
    }
    const current: ModelSelection = {
      provider_id: settings.provider,
      model_id: settings.model,
      reasoning_effort: settings.reasoning_effort,
    };
    const definition = connections[current.provider_id];
    if (
      definition &&
      this.credentialSource(definition) !== "none" &&
      !result.some(m => m.provider_id === current.provider_id && m.id === current.model_id)
    ) {
      result.push(
        this.resolveModel(
          definition,
          userModels[definition.id] ?? {},
          current.model_id,
          cache[definition.id],
        ),
      );
    }
    return result;
  }

  private resolveModel(
    definition: ProviderDefinition,
    userModels: Record<string, UserModelConfig>,
    modelId: string,
    entry: unknown,
    cached?: unknown,
  ): ModelDefinition {
    const base = selectionModel(definition, {
      provider_id: definition.id,
      model_id: modelId,
      reasoning_effort: "",
    });
    const resolvedCached =
      cached !== undefined
        ? cached
        : this.cachedModels(entry, definition).find(item => itemId(item) === modelId) ?? {};
    let capability: boolean | null = null;
    let contextWindow: number | null = null;
    const endpoint = definition.default_base_url;
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).base_url === endpoint
    ) {
      if (resolvedCached && typeof resolvedCached === "object" && !Array.isArray(resolvedCached)) {
        const cObj = resolvedCached as Record<string, unknown>;
        if (typeof cObj.image_input === "boolean") {
          capability = cObj.image_input;
        }
        contextWindow = positiveInteger(cObj.context_window);
      }
    }
    if (capability === null || contextWindow === null) {
      let catalogEndpoint = endpoint.replace(/\/+$/, "");
      if (catalogEndpoint === "https://api.deepseek.com") {
        catalogEndpoint += "/v1";
      }
      const builtin = this.providers[definition.id];
      const candidates =
        builtin && builtin.fallback_models.length > 0 ? [builtin] : Object.values(this.providers);
      for (const candidate of candidates) {
        if (
          candidate &&
          catalogEndpoint &&
          catalogEndpoint === candidate.default_base_url.replace(/\/+$/, "")
        ) {
          const known = candidate.fallback_models.find(m => m.id === modelId);
          if (known) {
            if (capability === null) capability = known.image_input;
            if (contextWindow === null) contextWindow = known.context_window;
          }
          break;
        }
      }
    }
    const userCfg = userModels[modelId];
    if (userCfg) {
      if (userCfg.image_input !== null) capability = userCfg.image_input;
      if (userCfg.context_window !== null) contextWindow = userCfg.context_window;
    }
    return {
      ...base,
      image_input: capability,
      context_window: contextWindow,
    };
  }

  private async fetchModels(definition: ProviderDefinition): Promise<boolean> {
    if (!refreshableModelsApi(definition.api)) {
      return true;
    }
    const credential = this.resolveCredential(definition);
    if (credential === null) {
      return false;
    }
    try {
      const endpoint = definition.default_base_url;
      const data = await this.remoteModelsFetcher(
        endpoint,
        this.apiKey(definition, credential),
        MODEL_LIST_TIMEOUT_MS,
      );
      if (!Array.isArray(data)) {
        return false;
      }
      if (
        data.some(item => {
          const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
          return typeof id !== "string" || !id.trim();
        })
      ) {
        return false;
      }
      const models: Record<string, unknown>[] = data.map(item => ({ id: itemId(item) }));
      if (models.length === 0) {
        return false;
      }
      const cache = this.readCache();
      const previous = cache[definition.id];
      const oldMap = new Map<string, Record<string, unknown>>();
      if (previous && typeof previous === "object" && !Array.isArray(previous)) {
        for (const item of this.cachedModels(previous, definition)) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            oldMap.set(itemId(item), item as Record<string, unknown>);
          }
        }
      }
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const raw = data[i];
        const id = String(model.id);
        let capability = remoteImageInput(raw, definition.id);
        if (capability === null) {
          const oldVal = oldMap.get(id)?.image_input;
          capability = typeof oldVal === "boolean" ? oldVal : null;
        }
        if (capability !== null) {
          model.image_input = capability;
        }
        let contextWindow = remoteContextWindow(raw, definition.id);
        if (contextWindow === null) {
          contextWindow = positiveInteger(oldMap.get(id)?.context_window);
        }
        if (contextWindow !== null) {
          model.context_window = contextWindow;
        }
      }
      this.writeCache({
        ...cache,
        [definition.id]: {
          models,
          refreshed_at: Date.now() / 1000,
          base_url: endpoint,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private cachedModels(entry: unknown, definition: ProviderDefinition): unknown[] {
    let items: unknown = entry;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (obj.base_url !== definition.default_base_url) {
        return [];
      }
      items = obj.models;
    }
    return Array.isArray(items) ? items.filter(item => Boolean(itemId(item))) : [];
  }

  private apiKey(definition: ProviderDefinition, credential: Credential): ApiKeyProvider {
    if (credential.type !== "oauth") {
      return credential.key || "";
    }
    const flow = OAUTH_FLOWS[definition.id];
    let current = credential;
    return async () => {
      if (flow.expiring(current)) {
        const renewed = await this.credentials.renew(definition.id, c => flow.fresh(c));
        if (!renewed) {
          throw new ProviderError(`Signed out of ${definition.name}. Run /login.`, {
            status: "rejected",
            code: "provider_not_configured",
          });
        }
        current = renewed;
      }
      return current.access || "";
    };
  }

  private loadedProviders(): [
    Record<string, ProviderDefinition>,
    Record<string, Record<string, UserModelConfig>>,
  ] {
    return loadProviders(this.providersPath, this.providers);
  }

  private connections(): Record<string, ProviderDefinition> {
    return this.loadedProviders()[0];
  }

  private provider(providerId: string): ProviderDefinition {
    return ProviderServiceImpl.providerFrom(this.connections(), providerId);
  }

  private static providerFrom(
    connections: Record<string, ProviderDefinition>,
    providerId: string,
  ): ProviderDefinition {
    const definition = connections[providerId];
    if (!definition) {
      throw new ProviderError(
        `Connection ${providerId || "(none)"} is not configured. Run /login, or choose another model with /model.`,
        { status: "rejected", code: "connection_missing" },
      );
    }
    return definition;
  }

  private credentialWithSource(
    definition: ProviderDefinition,
  ): [Credential | null, "stored" | "environment" | "none"] {
    const stored = this.credentials.get(definition.id);
    if (stored !== null) {
      return [stored, "stored"];
    }
    const envName = definition.environment_key;
    const value = envName ? (process.env[envName] || "").trim() : "";
    return value ? [{ type: "api_key", key: value }, "environment"] : [null, "none"];
  }

  private credentialSource(definition: ProviderDefinition): "stored" | "environment" | "none" {
    return this.credentialWithSource(definition)[1];
  }

  private resolveCredential(definition: ProviderDefinition): Credential | null {
    return this.credentialWithSource(definition)[0];
  }

  private readCache(): Record<string, unknown> {
    if (!fs.existsSync(this.cachePath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private writeCache(data: Record<string, unknown>): void {
    const dir = path.dirname(this.cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(this.cachePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      fs.renameSync(tempPath, this.cachePath);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }
}

class UnavailableChatClient implements ChatClient {
  readonly model: string;
  readonly error: ProviderError;

  constructor(model: string, error: ProviderError) {
    this.model = model;
    this.error = error;
  }

  async create(): Promise<ModelCompletion> {
    throw new ProviderError(this.error.message, {
      status: "rejected",
      code: this.error.code,
    });
  }

  async *stream(): AsyncGenerator<ModelStreamEvent> {
    throw new ProviderError(this.error.message, {
      status: "rejected",
      code: this.error.code,
    });
  }

  async close(): Promise<void> {
    // no-op
  }
}

function selectionModel(definition: ProviderDefinition, selection: ModelSelection): ModelDefinition {
  for (const model of definition.fallback_models) {
    if (model.id === selection.model_id) {
      return model;
    }
  }
  return {
    provider_id: definition.id,
    id: selection.model_id,
    api: definition.api,
    reasoning_efforts: defaultReasoningEfforts(definition.api),
    context_window: null,
    image_input: null,
  };
}

function itemId(item: unknown): string {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return String((item as Record<string, unknown>).id ?? "").trim();
  }
  return "";
}

function remoteImageInput(item: unknown, providerId: string): boolean | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const data = item as Record<string, unknown>;
  if (providerId === "openrouter") {
    const arch = data.architecture;
    const values =
      arch && typeof arch === "object" && !Array.isArray(arch)
        ? (arch as Record<string, unknown>).input_modalities
        : null;
    if (Array.isArray(values) && values.length > 0 && values.every(v => typeof v === "string")) {
      return values.includes("image");
    }
  }
  if (providerId === "mistral") {
    const caps = data.capabilities;
    const vision =
      caps && typeof caps === "object" && !Array.isArray(caps)
        ? (caps as Record<string, unknown>).vision
        : null;
    if (typeof vision === "boolean") {
      return vision;
    }
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function remoteContextWindow(item: unknown, providerId: string): number | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const data = item as Record<string, unknown>;
  const fieldMap: Record<string, string> = {
    openrouter: "context_length",
    mistral: "max_context_length",
    groq: "context_window",
  };
  const field = fieldMap[providerId];
  return field ? positiveInteger(data[field]) : null;
}

async function fetchRemoteModels(
  baseUrl: string,
  apiKey: ApiKeyProvider,
  timeoutMs: number,
): Promise<unknown[]> {
  const token = typeof apiKey === "function" ? await apiKey() : apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)) {
      return (payload as Record<string, unknown>).data as unknown[];
    }
    throw new Error("Invalid model list");
  } finally {
    clearTimeout(timer);
  }
}
