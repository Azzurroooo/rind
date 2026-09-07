import readline from "node:readline"

const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const input = readline.createInterface({ input: process.stdin })

// In-memory state so lifecycle tests can exercise effort, goals, uploads and
// background task polling through the public request path.
let reasoningEffort = "high"
let goal = null
const writtenFiles = new Map()
const backgroundTasks = new Map([
  ["bg-1", { bg_id: "bg-1", status: "running", exit_code: -1, cwd: "/workspace", stdout: "working\n", stderr: "" }],
  ["bg-0", { bg_id: "bg-0", status: "completed", exit_code: 0, cwd: "/workspace", stdout: "done\n", stderr: "" }],
])

function requireParams(request) {
  return request.params && typeof request.params === "object" ? request.params : {}
}

function respondError(request, type, message) {
  output({ kind: "response", request_id: request.request_id, error: { type, message } })
}

function respond(request, result) {
  output({ kind: "response", request_id: request.request_id, result })
}

input.on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    output({ kind: "response", request_id: "", error: { type: "InvalidJson", message: "Invalid JSON." } })
    return
  }

  if (request.method === "initialize") {
    output({
      kind: "response",
      request_id: request.request_id,
      result: { protocol_version: "2", capabilities: ["sessions"], methods: ["session/prompt"] },
    })
    return
  }
  if (request.method === "shutdown") {
    output({ kind: "response", request_id: request.request_id, result: { ok: true } })
    input.close()
    process.exit(0)
    return
  }
  if (request.method === "rind/command/execute") {
    output({ kind: "response", request_id: request.request_id, result: { input: request.params?.input ?? "" } })
    return
  }
  if (request.method === "session/new") {
    respond(request, { session_id: "fake-session", model: "fake-model", reasoning_effort: reasoningEffort })
    return
  }
  if (request.method === "session/prompt") {
    const params = requireParams(request)
    for (const type of ["turn_started", "assistant_message_completed", "turn_completed"]) {
      output({
        kind: "event",
        method: "session/update",
        event: { type },
        sequence: 1,
        durability: "incremental",
        session_id: "fake-session",
        turn_id: "fake-turn",
      })
    }
    respond(request, { session_id: "fake-session", turn_id: "fake-turn", input: String(params.input ?? "") })
    return
  }
  if (request.method === "model/effort") {
    const effort = String(requireParams(request).reasoning_effort || "").trim().toLowerCase()
    if (!effort) {
      respondError(request, "InvalidRequest", "model/effort requires reasoning_effort.")
      return
    }
    reasoningEffort = effort
    respond(request, { reasoning_effort: reasoningEffort })
    return
  }
  if (request.method === "session/delete") {
    const sessionId = String(requireParams(request).session_id || "").trim()
    if (!sessionId) {
      respondError(request, "InvalidRequest", "session/delete requires session_id.")
      return
    }
    if (sessionId === "fake-session") {
      respondError(request, "InvalidRequest", "Cannot delete the current session. Switch to another session first.")
      return
    }
    respond(request, { ok: true, deleted: sessionId })
    return
  }
  if (request.method === "file/list") {
    const path = String(requireParams(request).path || "")
    const entries = path === "uploads/desktop" ? [...writtenFiles.keys()].map((name) => ({ name, type: "file", size: writtenFiles.get(name).length })) : []
    respond(request, { entries })
    return
  }
  if (request.method === "file/read") {
    const file = writtenFiles.get(String(requireParams(request).path || ""))
    if (!file) {
      respondError(request, "NotFound", "File not found.")
      return
    }
    respond(request, { content_base64: file.toString("base64"), mime: "application/octet-stream", size: file.length })
    return
  }
  if (request.method === "file/write") {
    const params = requireParams(request)
    const path = String(params.path || "")
    if (!path.startsWith("uploads/")) {
      respondError(request, "InvalidRequest", "file/write is restricted to the uploads/ directory.")
      return
    }
    const data = Buffer.from(String(params.content_base64 || ""), "base64")
    writtenFiles.set(path, data)
    respond(request, { path, size: data.length })
    return
  }
  if (request.method === "rind/background/list") {
    respond(request, { tasks: [...backgroundTasks.values()] })
    return
  }
  if (request.method === "rind/background/output") {
    const bgId = String(requireParams(request).bg_id || "").trim()
    if (!bgId) {
      respondError(request, "InvalidRequest", "rind/background/output requires bg_id.")
      return
    }
    const task = backgroundTasks.get(bgId)
    if (!task) {
      respondError(request, "NotFound", `Unknown background task: ${bgId}`)
      return
    }
    respond(request, { task })
    return
  }
  if (request.method === "rind/goal/get") {
    respond(request, { goal })
    return
  }
  if (request.method === "rind/goal/set") {
    const objective = requireParams(request).objective
    if (typeof objective !== "string" || !objective.trim()) {
      respondError(request, "InvalidRequest", "rind/goal/set requires objective.")
      return
    }
    goal = { objective: objective.trim(), status: "active" }
    respond(request, { goal })
    return
  }
  if (request.method === "rind/goal/status") {
    const status = requireParams(request).status
    if (status !== "active" && status !== "paused") {
      respondError(request, "InvalidRequest", "rind/goal/status requires active or paused.")
      return
    }
    if (goal) goal = { ...goal, status }
    respond(request, { goal })
    return
  }
  if (request.method === "rind/goal/clear") {
    goal = null
    respond(request, { goal: null })
    return
  }
  if (request.method === "emit") {
    const type = String(request.params?.type ?? "")
    output({
      kind: "event",
      method: "session/update",
      event: { type },
      sequence: 1,
      durability: "incremental",
      session_id: "fake-session",
      turn_id: "fake-turn",
    })
    output({ kind: "response", request_id: request.request_id, result: { ok: true } })
    return
  }
  output({
    kind: "response",
    request_id: request.request_id,
    error: { type: "MethodNotFound", message: `Unknown method: ${request.method ?? ""}` },
  })
})
