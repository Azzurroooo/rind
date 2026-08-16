import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("fake runtime handles protocol responses and exits on shutdown", async () => {
  const runtime = spawn(process.execPath, ["scripts/fake-runtime.mjs"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let output = ""
  runtime.stdout.setEncoding("utf8")
  runtime.stdout.on("data", (chunk) => {
    output += chunk
  })

  runtime.stdin.end(
    [
      "not-json",
      JSON.stringify({ kind: "request", request_id: "unknown", method: "unknown" }),
      JSON.stringify({ kind: "request", request_id: "initialize", method: "initialize" }),
      JSON.stringify({ kind: "request", request_id: "shutdown", method: "shutdown" }),
    ].join("\n") + "\n",
  )

  const [code] = await once(runtime, "close")
  const responses = output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))

  assert.equal(code, 0)
  assert.deepEqual(responses, [
    {
      kind: "response",
      request_id: "",
      error: { type: "InvalidJson", message: "Invalid JSON." },
    },
    {
      kind: "response",
      request_id: "unknown",
      error: { type: "MethodNotFound", message: "Unknown method: unknown" },
    },
    {
      kind: "response",
      request_id: "initialize",
      result: { protocol_version: "2", capabilities: ["sessions"], methods: ["session/prompt"] },
    },
    {
      kind: "response",
      request_id: "shutdown",
      result: { ok: true },
    },
  ])
})
