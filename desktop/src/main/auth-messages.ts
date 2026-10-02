import type { DesktopAuthPrompt, DesktopAuthPromptKind, DesktopAuthUpdate } from "../preload/types.ts"

// Pure parsing and validation for the worker's interactive auth channel.
// During rind/auth/login the worker writes a *request* to stdout
// (method rind/auth/prompt) and waits for the client to answer on stdin with
// a request carrying the same request_id. An empty value cancels the login.

export const authPromptMethod = "rind/auth/prompt"
export const authUpdateMethod = "rind/auth/update"
export const maxAuthReplyChars = 4096
const maxPromptTextChars = 2000
const maxPromptOptions = 200
const promptKinds: readonly DesktopAuthPromptKind[] = ["select", "secret", "text"]

type AuthReplyEnvelope = {
  kind: "request"
  request_id: string
  method: typeof authPromptMethod
  params: { value: string }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function clip(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : ""
}

function parseOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxPromptOptions)
    .map((option) => {
      const record = asRecord(option)
      if (record) return clip(record.value ?? record.id ?? record.label, maxPromptTextChars)
      return clip(option, maxPromptTextChars)
    })
    .filter((option) => option.length > 0)
}

export function parseAuthPrompt(message: unknown): DesktopAuthPrompt | undefined {
  const value = asRecord(message)
  if (value?.kind !== "request" || value.method !== authPromptMethod) return undefined
  const requestId = value.request_id
  if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200) return undefined
  const params = asRecord(value.params) ?? {}
  const kind = promptKinds.includes(params.kind as DesktopAuthPromptKind) ? params.kind as DesktopAuthPromptKind : "text"
  return {
    requestId,
    kind,
    message: clip(params.message, maxPromptTextChars),
    options: parseOptions(params.options),
  }
}

export function parseAuthUpdate(message: unknown): DesktopAuthUpdate | undefined {
  const value = asRecord(message)
  if (value?.kind !== "event" || value.method !== authUpdateMethod) return undefined
  const event = asRecord(value.event)
  if (!event) return undefined
  return { ...event, type: typeof event.type === "string" ? event.type : "" }
}

export function validateAuthReply(pending: ReadonlySet<string>, requestId: unknown, value: unknown): { requestId: string; value: string } {
  if (typeof requestId !== "string" || !pending.has(requestId)) throw new Error("Unknown auth prompt.")
  if (typeof value !== "string") throw new Error("Auth prompt reply must be text.")
  if (value.length > maxAuthReplyChars) throw new Error("Auth prompt reply is too long.")
  return { requestId, value }
}

export function buildAuthReply(requestId: string, value: string): AuthReplyEnvelope {
  return { kind: "request", request_id: requestId, method: authPromptMethod, params: { value } }
}
