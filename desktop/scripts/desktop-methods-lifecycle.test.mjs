import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Lifecycle test: effort set + background task polling + goal + uploads flow
// through the public runtime request path against the extended fake runtime.
const originalRuntimePath = process.env.RIND_RUNTIME_PATH
const testDirectory = await mkdtemp(join(tmpdir(), "rind-desktop-methods-"))
const workspace = join(testDirectory, "workspace")
const fakeRuntime = join(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs")

await mkdir(workspace, { recursive: true })
process.env.RIND_RUNTIME_PATH = fakeRuntime

const runtime = await import("../src/main/runtime.ts")

try {
  await writeFile(join(workspace, ".keep"), "", "utf8")
  runtime.startRuntime(workspace)
  await runtime.initializeRuntime()

  // model/effort: set and read back through the public API.
  const effort = await runtime.requestRuntime("model/effort", { session_id: "fake-session", reasoning_effort: "low" })
  assert.deepEqual(effort, { reasoning_effort: "low" }, "model/effort must echo the new reasoning effort")
  await assert.rejects(
    () => runtime.requestRuntime("model/effort", { session_id: "fake-session" }),
    /requires reasoning_effort/,
    "model/effort without a payload must fail like the kernel does",
  )

  // rind/background/list + rind/background/output: monitor polling data.
  const listed = await runtime.requestRuntime("rind/background/list", { session_id: "fake-session" })
  assert.ok(Array.isArray(listed.tasks), "background list must return a tasks array")
  assert.deepEqual(listed.tasks.map((task) => task.bg_id).sort(), ["bg-0", "bg-1"])
  const output = await runtime.requestRuntime("rind/background/output", { session_id: "fake-session", bg_id: "bg-1" })
  assert.equal(output.task.status, "running")
  assert.equal(output.task.stdout, "working\n")
  await assert.rejects(
    () => runtime.requestRuntime("rind/background/output", { session_id: "fake-session" }),
    /requires bg_id/,
  )

  // file/write + file/read: the desktop attachment upload path.
  const base64 = Buffer.from("attachment-bytes").toString("base64")
  const written = await runtime.requestRuntime("file/write", { path: "uploads/desktop/20260907-000000-note.txt", content_base64: base64 })
  assert.equal(written.path, "uploads/desktop/20260907-000000-note.txt")
  assert.equal(written.size, "attachment-bytes".length)
  await assert.rejects(
    () => runtime.requestRuntime("file/write", { path: "src/evil.txt", content_base64: base64 }),
    /uploads/,
    "file/write must stay restricted to uploads/",
  )

  // session/delete: refuses the current session, accepts others.
  await assert.rejects(
    () => runtime.requestRuntime("session/delete", { session_id: "fake-session" }),
    /Cannot delete the current session/,
  )
  const deleted = await runtime.requestRuntime("session/delete", { session_id: "other-session" })
  assert.deepEqual(deleted, { ok: true, deleted: "other-session" })

  // Goal lifecycle: set, pause, get, clear.
  const set = await runtime.requestRuntime("rind/goal/set", { session_id: "fake-session", objective: "Ship the desktop upgrade" })
  assert.deepEqual(set.goal, { objective: "Ship the desktop upgrade", status: "active" })
  const paused = await runtime.requestRuntime("rind/goal/status", { session_id: "fake-session", status: "paused" })
  assert.equal(paused.goal.status, "paused")
  const fetched = await runtime.requestRuntime("rind/goal/get", { session_id: "fake-session" })
  assert.equal(fetched.goal.objective, "Ship the desktop upgrade")
  const cleared = await runtime.requestRuntime("rind/goal/clear", { session_id: "fake-session" })
  assert.equal(cleared.goal, null)

  // session/prompt now drives a full turn through the fake runtime.
  const turn = await runtime.requestRuntime("session/prompt", { session_id: "fake-session", input: "hello" })
  assert.equal(turn.session_id, "fake-session")

  // The unknown-method contract still holds.
  await assert.rejects(() => runtime.requestRuntime("nope", {}), /Unknown method/)

  assert.equal(runtime.getRuntimeSnapshot()?.status, "ready")
} finally {
  await runtime.shutdownRuntime()
  if (originalRuntimePath === undefined) delete process.env.RIND_RUNTIME_PATH
  else process.env.RIND_RUNTIME_PATH = originalRuntimePath
  await rm(testDirectory, { recursive: true, force: true })
}
