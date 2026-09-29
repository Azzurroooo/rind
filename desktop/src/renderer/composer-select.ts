// Provider-aware model options for the composer model menu. The runtime's
// model/list returns one entry per usable model with provider_id,
// context_window and image_input; the settings fallback (main-process fetch
// of the configured OpenAI-compatible endpoint) yields plain ids.

export type ModelOption = {
  id: string
  providerId: string
  contextWindow?: number
  imageInput?: boolean
}

export type ModelOptionGroup = {
  providerId: string
  name: string
  models: ModelOption[]
}

/** Parses a model/list response; unknown shapes yield an empty catalog. */
export function normalizeModelList(value: unknown): { models: ModelOption[]; currentProviderId: string; currentModelId: string } {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const current = root.current && typeof root.current === "object" ? root.current as Record<string, unknown> : {}
  const seen = new Set<string>()
  const models = (Array.isArray(root.models) ? root.models : []).flatMap((row) => {
    if (typeof row === "string") {
      const id = row.trim()
      const key = `\u0000${id}`
      if (!id || seen.has(key)) return []
      seen.add(key)
      return [{ id, providerId: "" }]
    }
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {}
    const id = typeof record.id === "string" ? record.id.trim() : ""
    if (!id) return []
    const providerId = typeof record.provider_id === "string" ? record.provider_id.trim() : ""
    const key = `${providerId}\u0000${id}`
    if (seen.has(key)) return []
    seen.add(key)
    const contextWindow = typeof record.context_window === "number" && Number.isFinite(record.context_window) && record.context_window > 0 ? record.context_window : undefined
    const imageInput = typeof record.image_input === "boolean" ? record.image_input : undefined
    return [{ id, providerId, ...(contextWindow === undefined ? {} : { contextWindow }), ...(imageInput === undefined ? {} : { imageInput }) }]
  })
  return {
    models,
    currentProviderId: typeof current.provider_id === "string" ? current.provider_id.trim() : "",
    currentModelId: typeof current.model_id === "string" ? current.model_id.trim() : "",
  }
}

/** The settings-target list (window.api.models.list) has no provider metadata. */
export function stringModelOptions(models: string[]): ModelOption[] {
  const seen = new Set<string>()
  const options: ModelOption[] = []
  for (const value of models) {
    const id = typeof value === "string" ? value.trim() : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    options.push({ id, providerId: "" })
  }
  return options
}

/** Deduplicates by provider+id and keeps the current selection at the front. */
export function modelChoices(models: ModelOption[], currentModel: string, currentProvider = ""): ModelOption[] {
  const seen = new Set<string>()
  const unique = models.filter((option) => {
    if (!option.id) return false
    const key = `${option.providerId}\u0000${option.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const current = unique.find((option) => option.id === currentModel && (option.providerId || "") === (currentProvider || ""))
    ?? unique.find((option) => option.id === currentModel)
  return current ? [current, ...unique.filter((option) => option !== current)] : unique
}

/** Groups in first-seen order (the runtime lists signed-in providers first). */
export function groupModelOptions(models: ModelOption[], providerNames: Record<string, string> = {}): ModelOptionGroup[] {
  const groups = new Map<string, ModelOption[]>()
  for (const option of models) {
    const key = option.providerId || ""
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(option)
  }
  return [...groups.entries()].map(([providerId, list]) => ({
    providerId,
    name: (providerNames[providerId] || "").trim() || providerDisplayName(providerId),
    models: list,
  }))
}

export function providerDisplayName(providerId: string): string {
  if (!providerId) return "Provider"
  return providerId
    .split(/[-_]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export function formatContextWindow(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return ""
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M ctx`
  return `${Math.round(tokens / 1000)}K ctx`
}

/** `/model <name>` resolves against the loaded options so provider_id rides along. */
export function findModelOption(options: ModelOption[], name: string): ModelOption | undefined {
  const clean = name.trim().toLowerCase()
  if (!clean) return undefined
  return options.find((option) => option.id.toLowerCase() === clean)
    ?? options.find((option) => option.id.toLowerCase().includes(clean))
}

export function modelSelectionTarget(status: "starting" | "ready" | "stopping" | "error" | "stopped", turnActive: boolean) {
  if (status === "starting" || status === "stopping" || turnActive) return "unavailable" as const
  return status === "ready" ? "runtime" as const : "settings" as const
}
