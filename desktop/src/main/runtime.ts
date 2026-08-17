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
} from "../preload/types"

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

type RuntimeWorker = {
  id: string
  workspace: string
  sessionId?: string
  child?: ChildProcessWithoutNullStreams
  pending: Map<string, PendingRequest>
  requestSequence: number
  snapshot: RuntimeSnapshot
  initializing?: Promise<unknown>
  shutdownPromise?: Promise<{ ok: true }>
  idleTimer?: NodeJS.Timeout
  turnActive: boolean
  idleEligible: boolean
}

const workers = new Map<string, RuntimeWorker>()
const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const eventListeners = new Set<(event: RuntimeEvent) => void>()
const maxStderrChars = 4096
const configuredIdleShutdownDelayMs = Number(process.env.RIND_RUNTIME_IDLE_TIMEOUT_MS)
const idleShutdownDelayMs = configuredIdleShutdownDelayMs > 0 ? configuredIdleShutdownDelayMs : 10 * 60 * 1000

function workerSnapshot(worker: RuntimeWorker, snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return { ...snapshot, runtimeId: worker.id, workspace: worker.workspace, sessionId: worker.sessionId }
}

function setSnapshot(worker: RuntimeWorker, next: RuntimeSnapshot) {
  worker.snapshot = workerSnapshot(worker, next)
  for (const listener of listeners) listener(worker.snapshot)
}

function rejectPending(worker: RuntimeWorker, error: Error) {
  for (const [requestId, request] of worker.pending) {
    clearTimeout(request.timer)
    request.reject(error)
    worker.pending.delete(requestId)
  }
}

function clearIdleTimer(worker: RuntimeWorker) {
  if (!worker.idleTimer) return
  clearTimeout(worker.idleTimer)
  worker.idleTimer = undefined
}

function touchWorker(worker: RuntimeWorker) {
  clearIdleTimer(worker)
}

function activateWorker(worker: RuntimeWorker) {
  touchWorker(worker)
  worker.idleEligible = false
}

function scheduleIdleShutdown(worker: RuntimeWorker) {
  clearIdleTimer(worker)
  if (!worker.idleEligible || worker.turnActive || worker.pending.size || worker.snapshot.status !== "ready") return
  worker.idleTimer = setTimeout(() => {
    worker.idleTimer = undefined
    if (!worker.idleEligible || worker.turnActive || worker.pending.size || worker.snapshot.status !== "ready") return
    void shutdownRuntime(worker.id)
  }, idleShutdownDelayMs)
  worker.idleTimer.unref?.()
}

function appendStderr(current: string, chunk: unknown) {
  return `${current}${String(chunk)}`.slice(-maxStderrChars)
}

function runtimeExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return new Error(detail ? `Runtime exited unexpectedly (${status}): ${detail}` : `Runtime exited unexpectedly (${status}).`)
}

function handleLine(worker: RuntimeWorker, line: string) {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    log.warn("runtime emitted invalid JSON", line)
    return
  }

  if (isRuntimeEventEnvelope(message)) {
    const type = String(message.event.type || "")
    if (type === "turn_started") {
      worker.turnActive = true
      worker.idleEligible = false
    }
    if (type === "turn_completed" || type === "turn_failed" || type === "turn_cancelled") {
      worker.turnActive = false
      worker.idleEligible = true
    }
    for (const listener of eventListeners) listener({
      runtimeId: worker.id,
      type,
      sequence: message.sequence,
      durability: message.durability,
      sessionId: message.session_id || worker.sessionId || "",
      turnId: message.turn_id,
      event: message.event,
    })
    if (type === "turn_completed" || type === "turn_failed" || type === "turn_cancelled") scheduleIdleShutdown(worker)
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
  const result = message.result && typeof message.result === "object" ? message.result as Record<string, unknown> : undefined
  if (result && typeof result.session_id === "string" && result.session_id) worker.sessionId = result.session_id
  request.resolve(message.result)
  scheduleIdleShutdown(worker)
}

function runtimeLaunch() {
  const configuredPath = process.env.RIND_RUNTIME_PATH
  if (configuredPath) return { command: configuredPath, args: [] }
  if (!process.env.ELECTRON_RENDERER_URL) {
    const executable = process.platform === "win32" ? "rind-runtime.exe" : "rind-runtime"
    return { command: join(process.resourcesPath, "runtime", executable), args: [] }
  }
  const python = process.env.RIND_PYTHON || (process.platform === "win32" ? "python" : "python3")
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  return { command: python, args: [join(repoRoot, "main.py")] }
}

function createWorker(id: string, workspace: string, sessionId?: string): RuntimeWorker {
  return {
    id,
    workspace,
    sessionId,
    pending: new Map(),
    requestSequence: 0,
    snapshot: workerSnapshot({ id, workspace, sessionId } as RuntimeWorker, { status: "stopped" }),
    turnActive: false,
    idleEligible: false,
  }
}

export function startRuntime(id: string, workspace: string, sessionId?: string) {
  const existing = workers.get(id)
  if (existing?.child) return existing.snapshot
  const worker = existing || createWorker(id, workspace, sessionId)
  activateWorker(worker)
  worker.workspace = workspace
  worker.sessionId = sessionId
  workers.set(id, worker)
  setSnapshot(worker, { status: "starting" })
  const launch = runtimeLaunch()
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const environment: NodeJS.ProcessEnv = launch.command === (process.env.RIND_PYTHON || (process.platform === "win32" ? "python" : "python3"))
    ? {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${delimiter}${process.env.PYTHONPATH}` : repoRoot,
        PYTHONUTF8: "1",
      }
    : process.env
  const args = [...launch.args, "app-server", "--stdio", "--cwd", workspace]
  if (sessionId) args.push("--session", sessionId)
  const current = spawn(launch.command, args, {
    cwd: workspace,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(launch.command),
  })
  worker.child = current
  let stderr = ""
  createInterface({ input: current.stdout }).on("line", (line) => handleLine(worker, line))
  current.stderr.on("data", (chunk) => {
    stderr = appendStderr(stderr, chunk)
    log.warn("runtime stderr", String(chunk).trimEnd())
  })
  current.once("error", (error) => {
    if (worker.child !== current) return
    worker.child = undefined
    clearIdleTimer(worker)
    worker.turnActive = false
    worker.idleEligible = false
    const runtimeError = new Error(`Runtime could not start: ${error.message}`)
    setSnapshot(worker, { status: "error", message: runtimeError.message })
    rejectPending(worker, runtimeError)
  })
  current.once("exit", (code, signal) => {
    if (worker.child !== current) return
    worker.child = undefined
    clearIdleTimer(worker)
    worker.turnActive = false
    worker.idleEligible = false
    const error = runtimeExitError(code, signal, stderr)
    rejectPending(worker, error)
    setSnapshot(worker, code === 0 ? { status: "stopped" } : { status: "error", message: error.message })
  })
  return worker.snapshot
}

function request(worker: RuntimeWorker, method: RuntimeServerMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
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

export async function initializeRuntime(id: string) {
  const worker = workers.get(id)
  if (!worker) throw new Error(`Runtime worker does not exist: ${id}`)
  activateWorker(worker)
  if (worker.initializing) return worker.initializing
  worker.initializing = initializeWorker(worker)
  try {
    return await worker.initializing
  } finally {
    worker.initializing = undefined
  }
}

async function initializeWorker(worker: RuntimeWorker) {
  try {
    const initialized = requireRuntimeInitialization(await request(worker, "initialize"))
    if (typeof initialized.session_id === "string" && initialized.session_id) worker.sessionId = initialized.session_id
    setSnapshot(worker, { status: "ready" })
    return initialized
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (worker.snapshot.status !== "error") setSnapshot(worker, { status: "error", message })
    throw error
  }
}

export function requestRuntime(id: string, method: RuntimeMethod, params: Record<string, unknown> = {}) {
  const worker = workers.get(id)
  if (!worker) return Promise.reject(new Error(`Runtime worker does not exist: ${id}`))
  touchWorker(worker)
  if (method === runtimeMethods.sessionPrompt || method === runtimeMethods.sessionFollowUp) {
    worker.turnActive = true
    worker.idleEligible = false
  }
  const longRunning = method === runtimeMethods.sessionPrompt || method === runtimeMethods.sessionFollowUp
  const timeout = longRunning ? 15 * 60_000 : 120_000
  return request(worker, method, params, timeout)
}

export function shutdownRuntime(id: string) {
  const worker = workers.get(id)
  if (!worker) return { ok: true }
  if (worker.shutdownPromise) return worker.shutdownPromise
  worker.shutdownPromise = shutdownWorker(worker)
  return worker.shutdownPromise
}

async function shutdownWorker(worker: RuntimeWorker): Promise<{ ok: true }> {
  clearIdleTimer(worker)
  worker.idleEligible = false
  worker.turnActive = false
  const current = worker.child
  if (!current) {
    setSnapshot(worker, { status: "stopped" })
    workers.delete(worker.id)
    return { ok: true }
  }
  try {
    await request(worker, "shutdown", {}, 5_000)
  } catch (error) {
    log.warn("runtime shutdown request failed", error)
  } finally {
    if (worker.child === current) worker.child.kill()
    await waitForChildExit(current)
    worker.child = undefined
    rejectPending(worker, new Error("Runtime stopped."))
    setSnapshot(worker, { status: "stopped" })
    workers.delete(worker.id)
  }
  return { ok: true }
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

export async function shutdownAllRuntimes() {
  await Promise.allSettled([...workers.keys()].map((id) => shutdownRuntime(id)))
}

export function subscribeRuntime(listener: (snapshot: RuntimeSnapshot) => void) {
  listeners.add(listener)
  for (const worker of workers.values()) listener(worker.snapshot)
  return () => listeners.delete(listener)
}

export function subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void) {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function getRuntimeSnapshots() {
  return [...workers.values()].map((worker) => worker.snapshot)
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
