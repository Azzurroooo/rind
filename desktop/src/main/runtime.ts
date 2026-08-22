import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import log from "electron-log/main"

import {
  runtimeMethods,
  runtimeProtocolVersion,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeServerMethod,
  type RuntimeSnapshot,
} from "../preload/types.ts"

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

type RuntimeWorker = {
  child?: ChildProcessWithoutNullStreams
  pending: Map<string, PendingRequest>
  requestSequence: number
  snapshot: RuntimeSnapshot
  initializing?: Promise<unknown>
  shutdownPromise?: Promise<{ ok: true }>
}

const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const eventListeners = new Set<(event: RuntimeEvent) => void>()
const maxStderrChars = 4096
const worker: RuntimeWorker = {
  pending: new Map(),
  requestSequence: 0,
  snapshot: { status: "stopped" },
}

function setSnapshot(next: RuntimeSnapshot) {
  worker.snapshot = next
  for (const listener of listeners) listener(worker.snapshot)
}

function rejectPending(error: Error) {
  for (const [requestId, request] of worker.pending) {
    clearTimeout(request.timer)
    request.reject(error)
    worker.pending.delete(requestId)
  }
}

function appendStderr(current: string, chunk: unknown) {
  return `${current}${String(chunk)}`.slice(-maxStderrChars)
}

function runtimeExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return new Error(detail ? `Runtime exited unexpectedly (${status}): ${detail}` : `Runtime exited unexpectedly (${status}).`)
}

function handleLine(source: ChildProcessWithoutNullStreams, line: string) {
  if (worker.child !== source) return
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    log.warn("runtime emitted invalid JSON", line)
    return
  }

  if (isRuntimeEventEnvelope(message)) {
    const type = String(message.event.type || "")
    for (const listener of eventListeners) listener({
      type,
      sequence: message.sequence,
      durability: message.durability,
      sessionId: message.session_id,
      turnId: message.turn_id,
      event: message.event,
    })
    return
  }
  if (!isRuntimeResponseEnvelope(message)) return
  const requestId = String(message.request_id)
  const request = worker.pending.get(requestId)
  if (!request) return
  worker.pending.delete(requestId)
  clearTimeout(request.timer)
  if (message.error) {
    const error = new Error(message.error.message || "Runtime request failed.")
    error.name = message.error.type || "RuntimeError"
    request.reject(error)
    return
  }
  request.resolve(message.result)
}

function runtimeLaunch() {
  const configuredPath = process.env.RIND_RUNTIME_PATH
  if (configuredPath) {
    if (/\.(?:c|m)?js$/i.test(configuredPath)) return { command: process.execPath, args: [configuredPath] }
    return { command: configuredPath, args: [] }
  }
  if (!process.env.ELECTRON_RENDERER_URL) {
    const executable = process.platform === "win32" ? "rind-runtime.exe" : "rind-runtime"
    return { command: join(process.resourcesPath, "runtime", executable), args: [] }
  }
  const python = process.env.RIND_PYTHON || (process.platform === "win32" ? "python" : "python3")
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  return { command: python, args: [join(repoRoot, "main.py")] }
}

export function startRuntime(workspace: string) {
  if (worker.snapshot.status === "stopping") throw new Error("Runtime is shutting down.")
  if (worker.child && !worker.child.killed && worker.child.exitCode === null) return worker.snapshot
  if (!workspace) throw new Error("Workspace is required to start the runtime worker.")
  setSnapshot({ status: "starting" })
  const launch = runtimeLaunch()
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const python = process.env.RIND_PYTHON || (process.platform === "win32" ? "python" : "python3")
  const environment: NodeJS.ProcessEnv = launch.command === python
    ? {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${delimiter}${process.env.PYTHONPATH}` : repoRoot,
        PYTHONUTF8: "1",
      }
    : process.env
  const current = spawn(
    launch.command,
    [...launch.args, "app-server", "--stdio", "--cwd", workspace],
    {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(launch.command),
    },
  )
  worker.child = current
  worker.shutdownPromise = undefined
  let stderr = ""
  createInterface({ input: current.stdout }).on("line", (line) => handleLine(current, line))
  current.stderr.on("data", (chunk) => {
    stderr = appendStderr(stderr, chunk)
    log.warn("runtime stderr", String(chunk).trimEnd())
  })
  current.once("error", (error) => {
    if (worker.child !== current) return
    worker.child = undefined
    const runtimeError = new Error(`Runtime could not start: ${error.message}`)
    setSnapshot({ status: "error", message: runtimeError.message })
    rejectPending(runtimeError)
  })
  current.once("exit", (code, signal) => {
    if (worker.child !== current) return
    worker.child = undefined
    const error = runtimeExitError(code, signal, stderr)
    rejectPending(error)
    setSnapshot(code === 0 ? { status: "stopped" } : { status: "error", message: error.message })
  })
  return worker.snapshot
}

function request(method: RuntimeServerMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
  if (!worker.child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  const requestId = `desktop-${++worker.requestSequence}`
  const message: RuntimeRequestEnvelope = { kind: "request", request_id: requestId, method, params }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(requestId)
      reject(new Error(`Runtime request timed out: ${method}.`))
    }, timeoutMs)
    worker.pending.set(requestId, { resolve, reject, timer })
    worker.child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) return
      clearTimeout(timer)
      worker.pending.delete(requestId)
      reject(error)
    })
  })
}

export async function initializeRuntime() {
  if (worker.initializing) return worker.initializing
  worker.initializing = initializeWorker()
  try {
    return await worker.initializing
  } finally {
    worker.initializing = undefined
  }
}

async function initializeWorker() {
  try {
    const initialized = requireRuntimeInitialization(await request("initialize"))
    setSnapshot({ status: "ready" })
    return initialized
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (worker.snapshot.status !== "error") setSnapshot({ status: "error", message })
    throw error
  }
}

export function requestRuntime(method: RuntimeMethod, params: Record<string, unknown> = {}) {
  const longRunning = method === runtimeMethods.sessionPrompt || method === runtimeMethods.sessionFollowUp
  return request(method, params, longRunning ? 15 * 60_000 : 30_000)
}

export function shutdownRuntime() {
  if (worker.shutdownPromise) return worker.shutdownPromise
  worker.shutdownPromise = shutdownWorker()
  return worker.shutdownPromise
}

async function shutdownWorker(): Promise<{ ok: true }> {
  const current = worker.child
  if (!current) {
    setSnapshot({ status: "stopped" })
    return { ok: true }
  }
  setSnapshot({ status: "stopping" })
  try {
    await request("shutdown", {}, 5_000)
  } catch (error) {
    log.warn("runtime shutdown request failed", error)
  } finally {
    if (worker.child === current) current.kill()
    await waitForChildExit(current)
    worker.child = undefined
    rejectPending(new Error("Runtime stopped."))
    setSnapshot({ status: "stopped" })
  }
  return { ok: true }
}

export function subscribeRuntime(listener: (snapshot: RuntimeSnapshot) => void) {
  listeners.add(listener)
  listener(worker.snapshot)
  return () => listeners.delete(listener)
}

export function subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void) {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function getRuntimeSnapshot() {
  return worker.child || worker.snapshot.status !== "stopped" ? worker.snapshot : undefined
}

function waitForChildExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 5_000)
    child.once("close", finish)
  })
}

function isRuntimeResponseEnvelope(message: unknown): message is RuntimeResponseEnvelope {
  const value = asRecord(message)
  return value?.kind === "response"
    && isRequestId(value.request_id)
    && (Object.hasOwn(value, "result") || isRuntimeError(value.error))
}

function isRuntimeEventEnvelope(message: unknown): message is RuntimeEventEnvelope {
  const value = asRecord(message)
  return value?.kind === "event"
    && value.method === "session/update"
    && Number.isInteger(value.sequence)
    && (value.durability === "durable" || value.durability === "incremental")
    && typeof value.session_id === "string"
    && typeof value.turn_id === "string"
    && asRecord(value.event) !== undefined
}

function requireRuntimeInitialization(result: unknown): Record<string, unknown> {
  const value = asRecord(result)
  if (!value || value.protocol_version !== runtimeProtocolVersion) {
    const received = value ? String(value.protocol_version || "missing") : "invalid"
    throw new Error(`Unsupported Runtime protocol version: ${received}.`)
  }
  if (!Array.isArray(value.capabilities) || !Array.isArray(value.methods)) {
    throw new Error("Runtime initialization response is missing capabilities or methods.")
  }
  return value
}

function isRequestId(value: unknown): value is string | number {
  return (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isFinite(value))
}

function isRuntimeError(value: unknown): value is { type: string; message: string } {
  const error = asRecord(value)
  return error !== undefined && typeof error.type === "string" && typeof error.message === "string"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
