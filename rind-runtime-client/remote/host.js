import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowRemoteOnWindows } from "./firewall.js";
import { createManagementBridge } from "./management.js";
import { isRemoteRuntimeMethod } from "./policy.js";
import { RemoteServer } from "./server.js";
import {
  asObject,
  browseWorkspaceDirectories,
  canonicalDirectory,
  isInternalRindPath,
  listAvailableWorkspaces,
  readJsonObject,
  registerSharedWorkspace,
  samePath,
  writeJsonObject,
  writeSharedWorkspaces,
} from "./workspaces.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(currentDir, "../..");
const maxSettingLength = 4096;

export const VALID_REASONING_EFFORTS = new Set(["", "low", "medium", "high", "xhigh", "max"]);
export const VALID_PROVIDER_APIS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

const KNOWN_PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "PERPLEXITY_API_KEY",
  "COHERE_API_KEY",
  "NVIDIA_API_KEY",
  "SILICONFLOW_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "ZHIPU_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "ARK_API_KEY",
  "VOLCENGINE_API_KEY",
  "HUNYUAN_API_KEY",
  "BAICHUAN_API_KEY",
  "YI_API_KEY",
  "STEPFUN_API_KEY",
  "MIMO_API_KEY",
  "XIAOMI_API_KEY",
  "LONGCAT_API_KEY",
];

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveRindHome(envHome = process.env.RIND_HOME, fallbackHome = homedir()) {
  const clean = typeof envHome === "string" ? envHome.trim() : "";
  return clean || join(fallbackHome, ".rind");
}

export function resolveRindPaths(rindHomeOverride) {
  const rindHome = rindHomeOverride || resolveRindHome(process.env.RIND_HOME, homedir());
  return {
    rindHome,
    settingsPath: join(rindHome, "settings.json"),
    authPath: join(rindHome, "auth.json"),
    providersPath: join(rindHome, "providers.json"),
  };
}

export function maskSecretKey(raw) {
  const clean = String(raw || "").trim();
  if (!clean) return "";
  if (clean.length <= 8) return "••••••••";
  const prefix = clean.slice(0, Math.min(4, clean.indexOf("-") > 0 ? clean.indexOf("-") + 1 : 3));
  const suffix = clean.slice(-4);
  return `${prefix}••••${suffix}`;
}

export function slugifyProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function parseAuthDetails(authData) {
  const details = {};
  for (const [providerId, rawEntry] of Object.entries(authData || {})) {
    const id = providerId.trim();
    const entry = asObject(rawEntry);
    if (!id || !entry) continue;
    const type = asTrimmedString(entry.type);
    if (type === "oauth") {
      const access = asTrimmedString(entry.access);
      const refresh = asTrimmedString(entry.refresh);
      if (!access && !refresh) continue;
      const expiresAt =
        typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at)
          ? entry.expires_at
          : null;
      details[id] = { type: "oauth", expiresAt };
    } else if (type === "api_key" || !type) {
      const key = asTrimmedString(entry.key);
      if (!key) continue;
      details[id] = { type: "api_key", maskedKey: maskSecretKey(key) };
    }
  }
  return details;
}

export function parseCustomProviders(providersData) {
  const entries = asObject(providersData?.providers) || asObject(providersData) || {};
  const result = [];
  for (const [rawId, rawEntry] of Object.entries(entries)) {
    const id = rawId.trim();
    const entry = asObject(rawEntry);
    if (!id || !entry) continue;
    const baseUrl = asTrimmedString(entry.baseUrl).replace(/\/+$/, "");
    if (!baseUrl) continue;
    const name = asTrimmedString(entry.name) || id;
    const api = asTrimmedString(entry.api) || "openai-chat";
    const envKey = asTrimmedString(entry.envKey);
    const modelsObj = asObject(entry.models);
    const models = modelsObj ? Object.keys(modelsObj).map((m) => m.trim()).filter(Boolean) : [];
    result.push({
      id,
      name,
      api,
      baseUrl,
      ...(envKey ? { envKey } : {}),
      models,
    });
  }
  return result;
}

function hasAnyEnvKeyConfigured(customProviders) {
  for (const envName of KNOWN_PROVIDER_ENV_KEYS) {
    if (asTrimmedString(process.env[envName])) return true;
  }
  for (const custom of customProviders) {
    if (custom.envKey && asTrimmedString(process.env[custom.envKey])) return true;
  }
  return false;
}

export async function loadRuntimeSettings(rindHomeOverride) {
  const { settingsPath, authPath, providersPath } = resolveRindPaths(rindHomeOverride);
  const [settingsData, authData, providersData] = await Promise.all([
    readJsonObject(settingsPath),
    readJsonObject(authPath),
    readJsonObject(providersPath),
  ]);

  const provider = asTrimmedString(settingsData.provider) || "openai";
  const model = asTrimmedString(settingsData.model) || "gpt-4o-mini";
  const rawEffort = asTrimmedString(settingsData.reasoningEffort).toLowerCase();
  const reasoningEffort = VALID_REASONING_EFFORTS.has(rawEffort) ? rawEffort : "";

  const authDetails = parseAuthDetails(authData);
  const customProviders = parseCustomProviders(providersData);
  const matchingCustom = customProviders.find((item) => item.id === provider);
  const baseUrl = matchingCustom?.baseUrl || asTrimmedString(settingsData.baseUrl);

  const hasConfiguredSettings = Boolean(
    asTrimmedString(settingsData.provider) ||
      asTrimmedString(settingsData.model) ||
      asTrimmedString(settingsData.apiKey),
  );
  const hasApiKey = Boolean(
    hasConfiguredSettings ||
      Object.keys(authDetails).length > 0 ||
      customProviders.length > 0 ||
      hasAnyEnvKeyConfigured(customProviders),
  );

  return {
    provider,
    model,
    baseUrl,
    reasoningEffort,
    hasApiKey,
    authDetails,
    customProviders,
  };
}

export function validateSettingsPatch(value) {
  const input = asObject(value);
  if (!input) throw new Error("Settings must be an object.");
  const patch = {};
  const stringKeys = [
    "provider",
    "apiKey",
    "model",
    "baseUrl",
    "reasoningEffort",
    "deleteCustomProviderId",
    "removeProviderCredentialId",
  ];
  for (const key of stringKeys) {
    if (!Object.hasOwn(input, key) || input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
    const setting = input[key].trim();
    if (setting.length > maxSettingLength) throw new Error(`${key} is too long.`);
    patch[key] = setting;
  }

  if (patch.reasoningEffort !== undefined) {
    const normalizedEffort = patch.reasoningEffort.toLowerCase();
    if (!VALID_REASONING_EFFORTS.has(normalizedEffort)) {
      throw new Error(`Invalid reasoningEffort: ${patch.reasoningEffort}`);
    }
    patch.reasoningEffort = normalizedEffort;
  }

  if (patch.baseUrl && !isValidHttpUrl(patch.baseUrl)) {
    throw new Error("baseUrl must be a valid HTTP URL.");
  }

  if (Object.hasOwn(input, "providerCredential") && input.providerCredential !== undefined) {
    const cred = asObject(input.providerCredential);
    if (!cred) throw new Error("providerCredential must be an object.");
    const providerId = asTrimmedString(cred.providerId);
    const apiKey = asTrimmedString(cred.apiKey);
    if (!providerId) throw new Error("providerId is required.");
    if (!apiKey) throw new Error("API key is required.");
    if (apiKey.length > maxSettingLength) throw new Error("API key is too long.");
    patch.providerCredential = { providerId, apiKey };
  }

  if (Object.hasOwn(input, "customProvider") && input.customProvider !== undefined) {
    const custom = asObject(input.customProvider);
    if (!custom) throw new Error("customProvider must be an object.");
    const name = asTrimmedString(custom.name);
    if (!name) throw new Error("Connection name is required.");
    const rawId = asTrimmedString(custom.id) || name;
    const id = slugifyProviderId(rawId);
    if (!id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      throw new Error("Connection name needs at least one ASCII letter or digit.");
    }
    const api = asTrimmedString(custom.api) || "openai-chat";
    if (!VALID_PROVIDER_APIS.has(api)) {
      throw new Error(`Unsupported protocol: ${api}`);
    }
    const baseUrl = asTrimmedString(custom.baseUrl).replace(/\/+$/, "");
    if (!baseUrl || !isValidHttpUrl(baseUrl)) {
      throw new Error("Base URL must be a valid HTTP(S) URL.");
    }
    const defaultModel = asTrimmedString(custom.defaultModel);
    const apiKey = asTrimmedString(custom.apiKey);
    const envKey = asTrimmedString(custom.envKey);
    patch.customProvider = {
      id,
      name,
      api,
      baseUrl,
      ...(defaultModel ? { defaultModel } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(envKey ? { envKey } : {}),
    };
  }

  return patch;
}

export async function saveRuntimeSettings(value, rindHomeOverride) {
  const patch = validateSettingsPatch(value);
  const { settingsPath, authPath, providersPath } = resolveRindPaths(rindHomeOverride);

  const hasSettingsUpdate =
    patch.provider !== undefined ||
    patch.model !== undefined ||
    patch.reasoningEffort !== undefined ||
    patch.baseUrl !== undefined;

  if (hasSettingsUpdate) {
    const settingsData = await readJsonObject(settingsPath);
    if (patch.provider !== undefined && patch.provider) {
      settingsData.provider = patch.provider;
    } else if (typeof settingsData.provider !== "string" || !settingsData.provider.trim()) {
      settingsData.provider = "openai";
    }
    if (patch.model !== undefined && patch.model) {
      settingsData.model = patch.model;
    } else if (typeof settingsData.model !== "string" || !settingsData.model.trim()) {
      settingsData.model = "gpt-4o-mini";
    }
    if (patch.reasoningEffort !== undefined) {
      settingsData.reasoningEffort = patch.reasoningEffort;
    } else if (typeof settingsData.reasoningEffort !== "string") {
      settingsData.reasoningEffort = "";
    }
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl) settingsData.baseUrl = patch.baseUrl;
      else delete settingsData.baseUrl;
    }
    await writeJsonObject(settingsPath, settingsData, false);
  }

  if (patch.customProvider) {
    const custom = patch.customProvider;
    const providerId = custom.id;
    const root = await readJsonObject(providersPath);
    const providersMap = asObject(root.providers) ? { ...root.providers } : { ...root };
    delete providersMap.providers;

    const existing = asObject(providersMap[providerId]) || {};
    const entry = {
      name: custom.name,
      api: custom.api,
      baseUrl: custom.baseUrl,
    };
    const envKey = custom.envKey || asTrimmedString(existing.envKey);
    if (envKey) entry.envKey = envKey;

    const existingModels = asObject(existing.models) ? { ...existing.models } : {};
    if (custom.defaultModel) {
      existingModels[custom.defaultModel] = asObject(existingModels[custom.defaultModel]) || {};
    }
    if (Object.keys(existingModels).length > 0) {
      entry.models = existingModels;
    }

    providersMap[providerId] = entry;
    await writeJsonObject(providersPath, { providers: providersMap }, false);

    if (custom.apiKey) {
      const authData = await readJsonObject(authPath);
      authData[providerId] = { type: "api_key", key: custom.apiKey };
      await writeJsonObject(authPath, authData, true);
    }
  }

  if (patch.deleteCustomProviderId) {
    const targetId = patch.deleteCustomProviderId;
    const root = await readJsonObject(providersPath);
    const providersMap = asObject(root.providers) ? { ...root.providers } : { ...root };
    delete providersMap.providers;
    if (Object.hasOwn(providersMap, targetId)) {
      delete providersMap[targetId];
      await writeJsonObject(providersPath, { providers: providersMap }, false);
    }
    const authData = await readJsonObject(authPath);
    if (Object.hasOwn(authData, targetId)) {
      delete authData[targetId];
      await writeJsonObject(authPath, authData, true);
    }
  }

  const credentialTarget = patch.providerCredential
    ? patch.providerCredential
    : patch.apiKey
      ? {
          providerId:
            patch.provider ||
            asTrimmedString((await readJsonObject(settingsPath)).provider) ||
            "openai",
          apiKey: patch.apiKey,
        }
      : null;

  if (credentialTarget && credentialTarget.apiKey) {
    const authData = await readJsonObject(authPath);
    authData[credentialTarget.providerId] = {
      type: "api_key",
      key: credentialTarget.apiKey,
    };
    await writeJsonObject(authPath, authData, true);
  }

  if (patch.removeProviderCredentialId) {
    const authData = await readJsonObject(authPath);
    if (Object.hasOwn(authData, patch.removeProviderCredentialId)) {
      delete authData[patch.removeProviderCredentialId];
      await writeJsonObject(authPath, authData, true);
    }
  }

  return loadRuntimeSettings(rindHomeOverride);
}

export function resolveWebRoot(override = "", repoRoot = defaultRepoRoot) {
  if (override) return override;
  const candidates = [
    process.env.RIND_WEB_ROOT || "",
    resolve(repoRoot, "frontend-web/dist"),
    resolve(repoRoot, "desktop/out/web"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return resolve(repoRoot, "frontend-web/dist");
}

export function createRemoteBridge({
  getRindHome = () => resolveRindHome(),
  getFallbackConfigFile = () => "",
  initializeRuntime,
  requestRuntime,
  subscribeRuntime = () => () => {},
  management,
  settingsLoad,
  settingsSave,
}) {
  const isManaged = management
    ? (p) => management.isManagedWorkspacePath(p)
    : async () => false;
  const loadWorkspaces = (rindHome) =>
    listAvailableWorkspaces(rindHome, {
      fallbackConfigFile: getFallbackConfigFile(),
      isManagedWorkspacePath: isManaged,
    }).catch(() => ({
      availableProjects: [],
      registeredWorkspaces: [],
      activeProjectPath: "",
    }));

  return {
    initialize: async () => {
      const rindHome = getRindHome();
      const initialized = asObject(await initializeRuntime()) || {};
      const { availableProjects, registeredWorkspaces, activeProjectPath } =
        await loadWorkspaces(rindHome);
      const currentWs =
        typeof initialized.workspace_root === "string" ? initialized.workspace_root.trim() : "";
      const runtimeDir = join(rindHome, "runtime");
      const matchedProject = currentWs
        ? availableProjects.find((item) => samePath(item.path, currentWs))
        : undefined;
      const activeProject = activeProjectPath
        ? availableProjects.find((item) => samePath(item.path, activeProjectPath))
        : undefined;
      const preferredProject = activeProject || matchedProject || availableProjects[0];
      if (preferredProject) {
        const nextSessionId = samePath(preferredProject.path, currentWs)
          ? initialized.session_id
          : preferredProject.sessions[0]?.id || "";
        return {
          ...initialized,
          workspace_root: preferredProject.path,
          session_id: nextSessionId,
          workspaces: registeredWorkspaces,
        };
      }
      const isInternalOrManaged =
        !currentWs ||
        samePath(currentWs, runtimeDir) ||
        isInternalRindPath(rindHome, currentWs) ||
        (await isManaged(currentWs));
      return {
        ...initialized,
        ...(isInternalOrManaged ? { workspace_root: "", session_id: "" } : {}),
        workspaces: registeredWorkspaces,
      };
    },
    workspaceDirs: (params = {}) =>
      browseWorkspaceDirectories(
        getRindHome(),
        typeof params?.path === "string" ? params.path : "",
        {
          fallbackConfigFile: getFallbackConfigFile(),
          isManagedWorkspacePath: isManaged,
        },
      ),
    request: async (method, params = {}) => {
      if (method === "workspace/dirs") {
        return browseWorkspaceDirectories(
          getRindHome(),
          typeof params?.path === "string" ? params.path : "",
          {
            fallbackConfigFile: getFallbackConfigFile(),
            isManagedWorkspacePath: isManaged,
          },
        );
      }
      if (!isRemoteRuntimeMethod(method)) throw new Error("Unsupported remote method.");
      const nextParams =
        method === "session/replay" && management
          ? await management.enrichSessionReplayParams(String(params.session_id || ""), params)
          : params;
      try {
        if (method === "session/list") {
          const rindHome = getRindHome();
          let { availableProjects, registeredWorkspaces, activeProjectPath } =
            await loadWorkspaces(rindHome);
          const requestedWs =
            typeof params.workspace_root === "string" ? params.workspace_root.trim() : "";
          let matchedProject = requestedWs
            ? availableProjects.find((item) => samePath(item.path, requestedWs))
            : (activeProjectPath
                ? availableProjects.find((item) => samePath(item.path, activeProjectPath))
                : undefined) || availableProjects[0];
          if (requestedWs && !matchedProject) {
            const canonical = await canonicalDirectory(requestedWs);
            if (isInternalRindPath(rindHome, canonical) || (await isManaged(canonical))) {
              throw new Error("Cannot open an internal Rind directory as a workspace.");
            }
            await registerSharedWorkspace(rindHome, canonical, { setActive: true });
            ({ availableProjects, registeredWorkspaces, activeProjectPath } =
              await loadWorkspaces(rindHome));
            matchedProject = availableProjects.find((item) => samePath(item.path, canonical));
          } else if (requestedWs && matchedProject && !samePath(activeProjectPath, matchedProject.path)) {
            await writeSharedWorkspaces(rindHome, {
              projects: registeredWorkspaces,
              activeProjectPath: matchedProject.path,
            }).catch(() => {});
          }
          if (!matchedProject) {
            return { sessions: [], workspaces: registeredWorkspaces };
          }
          const result = await requestRuntime(method, {
            ...nextParams,
            workspace_root: matchedProject.path,
          });
          const rawSessions =
            result && typeof result === "object" && Array.isArray(result.sessions)
              ? result.sessions
              : [];
          const filteredSessions = rawSessions.filter((s) => {
            const ws = typeof s?.workspace_root === "string" ? s.workspace_root.trim() : "";
            return Boolean(ws && samePath(ws, matchedProject.path));
          });
          return {
            ...(asObject(result) || {}),
            workspace_root: matchedProject.path,
            sessions: filteredSessions,
            workspaces: registeredWorkspaces,
          };
        }
        if (
          (method === "session/new" || method === "session/create") &&
          typeof nextParams?.workspace_root === "string" &&
          nextParams.workspace_root.trim()
        ) {
          const rindHome = getRindHome();
          await registerSharedWorkspace(rindHome, nextParams.workspace_root.trim(), {
            setActive: true,
          }).catch(() => {});
        }
        return await requestRuntime(method, nextParams);
      } catch (error) {
        if (
          management &&
          (error?.name === "TurnNotActive" ||
            error?.code === "TurnNotActive" ||
            error?.name === "QuestionNotFound" ||
            error?.code === "QuestionNotFound")
        ) {
          const forwarded = await management.forwardControlToSharedRuntimeIfNeeded(method, nextParams);
          if (forwarded !== undefined) return forwarded;
        }
        throw error;
      }
    },
    subscribe: (listener) => {
      const offDirect = subscribeRuntime(listener);
      const offShared = management?.subscribeSharedRuntimeEvents
        ? management.subscribeSharedRuntimeEvents(listener)
        : () => {};
      return () => {
        offDirect?.();
        offShared?.();
      };
    },
    agentsRequest: management ? (method, params) => management.requestManagement(method, params) : undefined,
    subscribeAgents: management ? (listener) => management.subscribeManagement(listener) : undefined,
    settingsLoad: settingsLoad || (() => loadRuntimeSettings(getRindHome())),
    settingsSave: settingsSave || ((value) => saveRuntimeSettings(value, getRindHome())),
  };
}

export function createRemoteHost({
  getRindHome = () => resolveRindHome(),
  getFallbackConfigFile = () => "",
  repoRoot = defaultRepoRoot,
  getRuntimePath = () => process.env.RIND_RUNTIME_PATH || "",
  getPython,
  initializeRuntime,
  requestRuntime,
  subscribeRuntime = () => () => {},
  ensureRuntimeForWorkspace = async () => {},
  isSharedRuntime = () => true,
  allowSharedObserver = false,
  management: externalManagement,
  settingsLoad,
  settingsSave,
  webRoot = "",
  allowMissingWebRoot = false,
  onStateChange = () => {},
} = {}) {
  const ownsManagement = !externalManagement;
  const management =
    externalManagement ||
    createManagementBridge({
      getRindHome,
      repoRoot,
      getRuntimePath,
      getPython,
      requestRuntime,
      ensureRuntimeForWorkspace,
      isSharedRuntime,
      allowSharedObserver,
    });

  const bridge = createRemoteBridge({
    getRindHome,
    getFallbackConfigFile,
    initializeRuntime,
    requestRuntime,
    subscribeRuntime,
    management,
    settingsLoad,
    settingsSave,
  });

  const server = new RemoteServer(
    bridge,
    resolveWebRoot(webRoot, repoRoot),
    onStateChange,
    { allowMissingWebRoot },
  );

  async function start(options = {}) {
    const scope = options?.scope || "lan";
    const explicitPort = options?.port;
    const externalOrigin = options?.externalOrigin || undefined;
    const current = server.state();
    if (current.running) {
      const sameScope = current.scope === scope;
      const samePort = explicitPort === undefined || explicitPort === 0 || explicitPort === current.port;
      const sameOrigin = externalOrigin === (server.options?.externalOrigin || undefined);
      if (sameScope && samePort && sameOrigin) {
        return current;
      }
      await server.stop();
    }
    try {
      return await server.start({ scope, port: explicitPort ?? 8766, externalOrigin });
    } catch (error) {
      if (explicitPort === undefined && (error?.code === "EADDRINUSE" || error?.code === "EACCES")) {
        return server.start({ scope, port: 0, externalOrigin });
      }
      throw error;
    }
  }

  async function stop() {
    await server.stop();
    return server.state();
  }

  function rotate() {
    return server.rotate();
  }

  async function allowNetwork(execPath = process.execPath) {
    const current = server.state();
    if (!current.running || current.scope !== "lan") {
      throw new Error("Enable local-network access first.");
    }
    await allowRemoteOnWindows(execPath, current.port);
    return server.state();
  }

  function notifyWorkspacesChanged() {
    server.notifyWorkspacesChanged();
    return server.state();
  }

  async function close() {
    await server.stop();
    if (ownsManagement) {
      await management.closeManagement();
    }
  }

  return {
    state: () => server.state(),
    start,
    stop,
    rotate,
    allowNetwork,
    notifyWorkspacesChanged,
    close,
    management,
    server,
  };
}
