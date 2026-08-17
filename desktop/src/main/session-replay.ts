import { readFile } from "node:fs/promises"
import { join } from "node:path"

type JsonObject = Record<string, unknown>

export async function replaySession(rindHome: string, sessionId: string, projectPath: string) {
  const cleanId = validateSessionId(sessionId)
  const base = join(rindHome, "sessions", cleanId)
  const meta = await readJson(join(base, "meta.json"))
  if (meta.session_id !== cleanId) throw new Error("Session data is corrupted: meta.json id does not match the requested session.")
  if (typeof meta.workspace_root !== "string" || !samePath(meta.workspace_root, projectPath)) {
    throw new Error("Session does not belong to the selected project.")
  }
  const messages = await readJsonLines(join(base, "messages.jsonl"))
  const tools = await readJsonLines(join(base, "tool_calls.jsonl"))
  return { sessionId: cleanId, model: stringValue(meta.model), messages: projectMessages(messages, tools) }
}

async function readJson(path: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session metadata is invalid.")
  return value as JsonObject
}

async function readJsonLines(path: string): Promise<JsonObject[]> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return content.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === "object" && !Array.isArray(value) ? [value as JsonObject] : []
    } catch {
      return []
    }
  })
}

function projectMessages(messages: JsonObject[], tools: JsonObject[]) {
  const toolMap = new Map(tools.map((item) => [String(item.id || ""), item]))
  const projected: JsonObject[] = []
  for (const message of messages) {
    // Compaction boundaries alter the model's continuation context, not the user's transcript.
    if (asObject(message.meta)?.kind === "compact_boundary") continue
    const role = message.role
    if (role === "tool") {
      const tool = toolMap.get(String(message.tool_call_id || ""))
      projected.push({ role: "tool", tool_call_id: message.tool_call_id, content: String(tool?.model_content || message.content || "") })
      continue
    }
    if (role === "assistant") {
      const meta = asObject(message.meta)
      const calls = Array.isArray(meta?.tool_calls)
        ? meta.tool_calls.flatMap((item) => {
          const call = asObject(item)
          const id = String(call?.id || "")
          const tool = toolMap.get(id)
          if (!id || !tool) return []
          return [{ id, type: "function", function: { name: String(call?.name || tool.name || "Tool"), arguments: String(tool.raw_args || "{}") } }]
        })
        : []
      if (calls.length) projected.push({ role: "assistant", tool_calls: calls })
      if (typeof message.content === "string" && message.content) projected.push({ role: "assistant", content: message.content })
      continue
    }
    if (role === "system" || role === "user") projected.push({ role, content: String(message.content || "") })
  }
  return projected
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right
}

function validateSessionId(value: string) {
  const clean = value.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(clean) || clean.length > 160) throw new Error("Invalid session id.")
  return clean
}
