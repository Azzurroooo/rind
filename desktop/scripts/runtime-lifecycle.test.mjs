import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state.")
    await delay(20)
  }
}

const originalRuntimePath = process.env.RIND_RUNTIME_PATH
const originalIdleTimeout = process.env.RIND_RUNTIME_IDLE_TIMEOUT_MS
const testDirectory = await mkdtemp(join(tmpdir(), "rind-runtime-test-"))
const workspace = join(testDirectory, "workspace")
const fakeRuntime = join(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs")
const launcher = join(testDirectory, "runtime.cmd")

await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fakeRuntime}" %*\r\n`, "utf8")
await mkdir(workspace, { recursive: true })
process.env.RIND_RUNTIME_PATH = launcher
process.env.RIND_RUNTIME_IDLE_TIMEOUT_MS = "120"

const runtime = await import("../src/main/runtime.ts")

try {
  await writeFile(join(workspace, ".keep"), "", "utf8")

  runtime.startRuntime("lifecycle", workspace)
  await runtime.initializeRuntime("lifecycle")
  await runtime.requestRuntime("lifecycle", "emit", { type: "turn_started" })
  await delay(180)
  assert.equal(runtime.getRuntimeSnapshots()[0]?.status, "ready", "active turns must not be auto-shutdown")

  await runtime.requestRuntime("lifecycle", "emit", { type: "turn_completed" })
  await delay(50)
  await runtime.requestRuntime("lifecycle", "emit", { type: "ordinary_request" })
  await delay(80)
  assert.equal(runtime.getRuntimeSnapshots()[0]?.status, "ready", "ordinary requests must refresh an idle worker")
  await waitFor(() => runtime.getRuntimeSnapshots().length === 0)

  runtime.startRuntime("first", workspace)
  runtime.startRuntime("second", workspace)
  await Promise.all([runtime.initializeRuntime("first"), runtime.initializeRuntime("second")])
  await runtime.shutdownAllRuntimes()
  assert.deepEqual(runtime.getRuntimeSnapshots(), [], "application shutdown must close every runtime")
} finally {
  await runtime.shutdownAllRuntimes()
  if (originalRuntimePath === undefined) delete process.env.RIND_RUNTIME_PATH
  else process.env.RIND_RUNTIME_PATH = originalRuntimePath
  if (originalIdleTimeout === undefined) delete process.env.RIND_RUNTIME_IDLE_TIMEOUT_MS
  else process.env.RIND_RUNTIME_IDLE_TIMEOUT_MS = originalIdleTimeout
  await rm(testDirectory, { recursive: true, force: true })
}
