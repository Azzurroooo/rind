const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const REQUEST_TIMEOUT_MS = 10_000

type ModelListResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type ModelListFetcher = (input: string, init: RequestInit) => Promise<ModelListResponse>

export function modelListUrl(baseUrl: string) {
  let url: URL
  try {
    url = new URL(baseUrl.trim() || DEFAULT_BASE_URL)
  } catch {
    throw new Error("Base URL must be a valid HTTP URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be a valid HTTP URL.")
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
  url.search = ""
  url.hash = ""
  return url.toString()
}

export async function listAvailableModels(
  settings: Record<string, unknown>,
  fetcher: ModelListFetcher = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const apiKey = stringSetting(settings.apiKey)
  if (!apiKey) throw new Error("Configure an API key before loading models.")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response: ModelListResponse
  try {
    response = await fetcher(modelListUrl(stringSetting(settings.baseUrl)), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
  } catch {
    if (controller.signal.aborted) throw new Error("Model list request timed out.")
    throw new Error("Unable to load models from the configured Base URL.")
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Model list request failed (HTTP ${response.status}).`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("Model list response was invalid.")
  }
  const data = asRecord(payload).data
  if (!Array.isArray(data)) throw new Error("Model list response did not include models.")
  return [...new Set(data.map(modelId).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function modelId(value: unknown) {
  return stringSetting(asRecord(value).id)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}
