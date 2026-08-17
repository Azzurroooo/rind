import readline from "node:readline"

const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const input = readline.createInterface({ input: process.stdin })

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
