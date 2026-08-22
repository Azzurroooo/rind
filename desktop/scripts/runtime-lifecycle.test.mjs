import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const originalRuntimePath = process.env.RIND_RUNTIME_PATH
const testDirectory = await mkdtemp(join(tmpdir(), "rind-runtime-test-"))
const workspace = join(testDirectory, "workspace")
const fakeRuntime = join(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs")

await mkdir(workspace, { recursive: true })
process.env.RIND_RUNTIME_PATH = fakeRuntime

const runtime = await import("../src/main/runtime.ts")

try {
  await writeFile(join(workspace, ".keep"), "", "utf8")

  runtime.startRuntime(workspace)
  await runtime.initializeRuntime()
  const command = await runtime.requestRuntime("rind/command/execute", { input: "/status" })
  assert.deepEqual(command, { input: "/status" }, "slash commands must resolve through the Runtime request path")
  assert.equal(runtime.getRuntimeSnapshot()?.status, "ready", "slash commands must leave the Runtime ready")
  await delay(180)
  assert.equal(runtime.getRuntimeSnapshot()?.status, "ready", "the worker remains available while idle")

  const readySnapshot = runtime.getRuntimeSnapshot()
  const secondSnapshot = runtime.startRuntime(workspace)
  assert.strictEqual(secondSnapshot, readySnapshot, "repeated start must reuse the application worker")
  await runtime.initializeRuntime()
  await runtime.shutdownRuntime()
  assert.equal(runtime.getRuntimeSnapshot(), undefined, "application shutdown must close the worker")
} finally {
  await runtime.shutdownRuntime()
  if (originalRuntimePath === undefined) delete process.env.RIND_RUNTIME_PATH
  else process.env.RIND_RUNTIME_PATH = originalRuntimePath
  await rm(testDirectory, { recursive: true, force: true })
}
