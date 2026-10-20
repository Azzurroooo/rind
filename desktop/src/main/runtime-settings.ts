import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  DesktopCustomProvider,
  DesktopProviderAuthDetail,
  DesktopSettings,
  DesktopSettingsPatch,
} from "../preload/types.ts"

export function resolveRindHome(
  envHome: string | undefined = process.env.RIND_HOME,
  fallbackHome: string = homedir(),
): string {
  const clean = typeof envHome === "string" ? envHome.trim() : ""
  return clean || join(fallbackHome, ".rind")
}

const maxSettingLength = 4096

export const VALID_REASONING_EFFORTS = new Set(["", "low", "medium", "high", "xhigh", "max"])
export const VALID_PROVIDER_APIS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
])

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
]

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function maskSecretKey(raw: string): string {
  const clean = raw.trim()
  if (!clean) return ""
  if (clean.length <= 8) return "••••••••"
  const prefix = clean.slice(0, Math.min(4, clean.indexOf("-") > 0 ? clean.indexOf("-") + 1 : 3))
  const suffix = clean.slice(-4)
  return `${prefix}••••${suffix}`
}

export function slugifyProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host)
  } catch {
    return false
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    const record = asObject(parsed)
    return record || {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    return {}
  }
}

async function writeJsonObject(path: string, value: Record<string, unknown>, secret = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: secret ? 0o600 : 0o666,
    })
    if (secret && process.platform !== "win32") {
      await chmod(tempPath, 0o600).catch(() => {})
    }
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export function resolveRindPaths(rindHomeOverride?: string) {
  const rindHome = rindHomeOverride || resolveRindHome(process.env.RIND_HOME, homedir())
  return {
    rindHome,
    settingsPath: join(rindHome, "settings.json"),
    authPath: join(rindHome, "auth.json"),
    providersPath: join(rindHome, "providers.json"),
  }
}

export function parseAuthDetails(authData: Record<string, unknown>): Record<string, DesktopProviderAuthDetail> {
  const details: Record<string, DesktopProviderAuthDetail> = {}
  for (const [providerId, rawEntry] of Object.entries(authData)) {
    const id = providerId.trim()
    const entry = asObject(rawEntry)
    if (!id || !entry) continue
    const type = asTrimmedString(entry.type)
    if (type === "oauth") {
      const access = asTrimmedString(entry.access)
      const refresh = asTrimmedString(entry.refresh)
      if (!access && !refresh) continue
      const expiresAt = typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at)
        ? entry.expires_at
        : null
      details[id] = { type: "oauth", expiresAt }
    } else if (type === "api_key" || !type) {
      const key = asTrimmedString(entry.key)
      if (!key) continue
      details[id] = { type: "api_key", maskedKey: maskSecretKey(key) }
    }
  }
  return details
}

export function parseCustomProviders(providersData: Record<string, unknown>): DesktopCustomProvider[] {
  const entries = asObject(providersData.providers) || providersData
  const result: DesktopCustomProvider[] = []
  for (const [rawId, rawEntry] of Object.entries(entries)) {
    const id = rawId.trim()
    const entry = asObject(rawEntry)
    if (!id || !entry) continue
    const baseUrl = asTrimmedString(entry.baseUrl).replace(/\/+$/, "")
    if (!baseUrl) continue
    const name = asTrimmedString(entry.name) || id
    const api = asTrimmedString(entry.api) || "openai-chat"
    const envKey = asTrimmedString(entry.envKey)
    const modelsObj = asObject(entry.models)
    const models = modelsObj ? Object.keys(modelsObj).map((m) => m.trim()).filter(Boolean) : []
    result.push({
      id,
      name,
      api,
      baseUrl,
      ...(envKey ? { envKey } : {}),
      models,
    })
  }
  return result
}

function hasAnyEnvKeyConfigured(customProviders: DesktopCustomProvider[]): boolean {
  for (const envName of KNOWN_PROVIDER_ENV_KEYS) {
    if (asTrimmedString(process.env[envName])) return true
  }
  for (const custom of customProviders) {
    if (custom.envKey && asTrimmedString(process.env[custom.envKey])) return true
  }
  return false
}

export async function loadRuntimeSettings(rindHomeOverride?: string): Promise<DesktopSettings> {
  const { settingsPath, authPath, providersPath } = resolveRindPaths(rindHomeOverride)
  const [settingsData, authData, providersData] = await Promise.all([
    readJsonObject(settingsPath),
    readJsonObject(authPath),
    readJsonObject(providersPath),
  ])

  const provider = asTrimmedString(settingsData.provider) || "openai"
  const model = asTrimmedString(settingsData.model) || "gpt-4o-mini"
  const rawEffort = asTrimmedString(settingsData.reasoningEffort).toLowerCase()
  const reasoningEffort = VALID_REASONING_EFFORTS.has(rawEffort) ? rawEffort : ""

  const authDetails = parseAuthDetails(authData)
  const customProviders = parseCustomProviders(providersData)
  const matchingCustom = customProviders.find((item) => item.id === provider)
  const baseUrl = matchingCustom?.baseUrl || asTrimmedString(settingsData.baseUrl)

  const hasConfiguredSettings = Boolean(
    asTrimmedString(settingsData.provider) ||
    asTrimmedString(settingsData.model) ||
    asTrimmedString(settingsData.apiKey),
  )
  const hasApiKey = Boolean(
    hasConfiguredSettings ||
    Object.keys(authDetails).length > 0 ||
    customProviders.length > 0 ||
    hasAnyEnvKeyConfigured(customProviders),
  )

  return {
    provider,
    model,
    baseUrl,
    reasoningEffort,
    hasApiKey,
    authDetails,
    customProviders,
  }
}

export function validateSettingsPatch(value: unknown): DesktopSettingsPatch {
  const input = asObject(value)
  if (!input) throw new Error("Settings must be an object.")
  const patch: DesktopSettingsPatch = {}
  const stringKeys: Array<"provider" | "apiKey" | "model" | "baseUrl" | "reasoningEffort" | "deleteCustomProviderId" | "removeProviderCredentialId"> = [
    "provider",
    "apiKey",
    "model",
    "baseUrl",
    "reasoningEffort",
    "deleteCustomProviderId",
    "removeProviderCredentialId",
  ]
  for (const key of stringKeys) {
    if (!Object.hasOwn(input, key) || input[key] === undefined) continue
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`)
    const setting = (input[key] as string).trim()
    if (setting.length > maxSettingLength) throw new Error(`${key} is too long.`)
    patch[key] = setting
  }

  if (patch.reasoningEffort !== undefined) {
    const normalizedEffort = patch.reasoningEffort.toLowerCase()
    if (!VALID_REASONING_EFFORTS.has(normalizedEffort)) {
      throw new Error(`Invalid reasoningEffort: ${patch.reasoningEffort}`)
    }
    patch.reasoningEffort = normalizedEffort
  }

  if (patch.baseUrl) {
    if (!isValidHttpUrl(patch.baseUrl)) {
      throw new Error("baseUrl must be a valid HTTP URL.")
    }
  }

  if (Object.hasOwn(input, "providerCredential") && input.providerCredential !== undefined) {
    const cred = asObject(input.providerCredential)
    if (!cred) throw new Error("providerCredential must be an object.")
    const providerId = asTrimmedString(cred.providerId)
    const apiKey = asTrimmedString(cred.apiKey)
    if (!providerId) throw new Error("providerId is required.")
    if (!apiKey) throw new Error("API key is required.")
    if (apiKey.length > maxSettingLength) throw new Error("API key is too long.")
    patch.providerCredential = { providerId, apiKey }
  }

  if (Object.hasOwn(input, "customProvider") && input.customProvider !== undefined) {
    const custom = asObject(input.customProvider)
    if (!custom) throw new Error("customProvider must be an object.")
    const name = asTrimmedString(custom.name)
    if (!name) throw new Error("Connection name is required.")
    const rawId = asTrimmedString(custom.id) || name
    const id = slugifyProviderId(rawId)
    if (!id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      throw new Error("Connection name needs at least one ASCII letter or digit.")
    }
    const api = asTrimmedString(custom.api) || "openai-chat"
    if (!VALID_PROVIDER_APIS.has(api)) {
      throw new Error(`Unsupported protocol: ${api}`)
    }
    const baseUrl = asTrimmedString(custom.baseUrl).replace(/\/+$/, "")
    if (!baseUrl || !isValidHttpUrl(baseUrl)) {
      throw new Error("Base URL must be a valid HTTP(S) URL.")
    }
    const defaultModel = asTrimmedString(custom.defaultModel)
    const apiKey = asTrimmedString(custom.apiKey)
    const envKey = asTrimmedString(custom.envKey)
    patch.customProvider = {
      id,
      name,
      api,
      baseUrl,
      ...(defaultModel ? { defaultModel } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(envKey ? { envKey } : {}),
    }
  }

  return patch
}

export async function saveRuntimeSettings(value: unknown, rindHomeOverride?: string): Promise<DesktopSettings> {
  const patch = validateSettingsPatch(value)
  const { settingsPath, authPath, providersPath } = resolveRindPaths(rindHomeOverride)

  // 1. Handle settings.json updates (provider, model, reasoningEffort)
  const hasSettingsUpdate =
    patch.provider !== undefined ||
    patch.model !== undefined ||
    patch.reasoningEffort !== undefined ||
    patch.baseUrl !== undefined

  if (hasSettingsUpdate) {
    const settingsData = await readJsonObject(settingsPath)
    if (patch.provider !== undefined && patch.provider) {
      settingsData.provider = patch.provider
    } else if (typeof settingsData.provider !== "string" || !settingsData.provider.trim()) {
      settingsData.provider = "openai"
    }
    if (patch.model !== undefined && patch.model) {
      settingsData.model = patch.model
    } else if (typeof settingsData.model !== "string" || !settingsData.model.trim()) {
      settingsData.model = "gpt-4o-mini"
    }
    if (patch.reasoningEffort !== undefined) {
      settingsData.reasoningEffort = patch.reasoningEffort
    } else if (typeof settingsData.reasoningEffort !== "string") {
      settingsData.reasoningEffort = ""
    }
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl) settingsData.baseUrl = patch.baseUrl
      else delete settingsData.baseUrl
    }
    await writeJsonObject(settingsPath, settingsData, false)
  }

  // 2. Handle custom provider creation / update in providers.json
  if (patch.customProvider) {
    const custom = patch.customProvider
    const providerId = custom.id!
    const root = await readJsonObject(providersPath)
    const providersMap: Record<string, unknown> = asObject(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : { ...root }
    delete providersMap.providers

    const existing = asObject(providersMap[providerId]) || {}
    const entry: Record<string, unknown> = {
      name: custom.name,
      api: custom.api,
      baseUrl: custom.baseUrl,
    }
    const envKey = custom.envKey || asTrimmedString(existing.envKey)
    if (envKey) entry.envKey = envKey

    const existingModels = asObject(existing.models) ? { ...(existing.models as Record<string, unknown>) } : {}
    if (custom.defaultModel) {
      existingModels[custom.defaultModel] = asObject(existingModels[custom.defaultModel]) || {}
    }
    if (Object.keys(existingModels).length > 0) {
      entry.models = existingModels
    }

    providersMap[providerId] = entry
    await writeJsonObject(providersPath, { providers: providersMap }, false)

    if (custom.apiKey) {
      const authData = await readJsonObject(authPath)
      authData[providerId] = { type: "api_key", key: custom.apiKey }
      await writeJsonObject(authPath, authData, true)
    }
  }

  // 3. Handle custom provider deletion
  if (patch.deleteCustomProviderId) {
    const targetId = patch.deleteCustomProviderId
    const root = await readJsonObject(providersPath)
    const providersMap: Record<string, unknown> = asObject(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : { ...root }
    delete providersMap.providers
    if (Object.hasOwn(providersMap, targetId)) {
      delete providersMap[targetId]
      await writeJsonObject(providersPath, { providers: providersMap }, false)
    }
    const authData = await readJsonObject(authPath)
    if (Object.hasOwn(authData, targetId)) {
      delete authData[targetId]
      await writeJsonObject(authPath, authData, true)
    }
  }

  // 4. Handle direct provider credential save / legacy apiKey save
  const credentialTarget = patch.providerCredential
    ? patch.providerCredential
    : patch.apiKey
      ? {
          providerId: patch.provider || asTrimmedString((await readJsonObject(settingsPath)).provider) || "openai",
          apiKey: patch.apiKey,
        }
      : null

  if (credentialTarget && credentialTarget.apiKey) {
    const authData = await readJsonObject(authPath)
    authData[credentialTarget.providerId] = {
      type: "api_key",
      key: credentialTarget.apiKey,
    }
    await writeJsonObject(authPath, authData, true)
  }

  // 5. Handle provider credential removal
  if (patch.removeProviderCredentialId) {
    const authData = await readJsonObject(authPath)
    if (Object.hasOwn(authData, patch.removeProviderCredentialId)) {
      delete authData[patch.removeProviderCredentialId]
      await writeJsonObject(authPath, authData, true)
    }
  }

  return loadRuntimeSettings(rindHomeOverride)
}
