import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import log from "electron-log/main"

import type { RuntimeEvent, RuntimeSnapshot } from "../preload/types"

type RuntimeMessage = {
  kind?: "response" | "event"
  request_id?: string | number
  result?: unknown
  error?: { message?: string; type?: string }
  event?: Record<string, unknown>
  event_type?: string
  sequence?: number
  session_id?: string
  turn_id?: string
}

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
}

const workers = new Map<string, RuntimeWorker>()
const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const eventListeners = new Set<(event: RuntimeEvent) => void>()
const maxStderrChars = 4096

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

function appendStderr(current: string, chunk: unknown) {
  return `${current}${String(chunk)}`.slice(-maxStderrChars)
}

function runtimeExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return new Error(detail ? `Runtime exited unexpectedly (${status}): ${detail}` : `Runtime exited unexpectedly (${status}).`)
}

function handleLine(worker: RuntimeWorker, line: string) {
  let message: RuntimeMessage
  try {
    message = JSON.parse(line) as RuntimeMessage
  } catch {
    log.warn("runtime emitted invalid JSON", line)
    return
  }

  if (message.kind === "event" && message.event) {
    for (const listener of eventListeners) listener({
      runtimeId: worker.id,
      type: String(message.event_type || message.event.type || ""),
      sequence: Number(message.sequence || 0),
      sessionId: String(message.session_id || worker.sessionId || ""),
      turnId: String(message.turn_id || ""),
      event: message.event,
    })
    return
  }
  if (message.kind !== "response" || message.request_id === undefined) return
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
}

function runtimeLaunch() {
  const configuredPath = process.env.RIND_RUNTIME_PATH
  if (configuredPath) return { command: configuredPath, args: [] }
  if (!process.env.ELECTRON_RENDERER_URL) {
    return { command: join(process.resourcesPath, "runtime", "rind-runtime.exe"), args: [] }
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
  }
}

export function startRuntime(id: string, workspace: string, sessionId?: string) {
  const existing = workers.get(id)
  if (existing?.child) return existing.snapshot
  const worker = existing || createWorker(id, workspace, sessionId)
  worker.workspace = workspace
  worker.sessionId = sessionId
  workers.set(id, worker)
  setSnapshot(worker, { status: "starting" })
  const launch = runtimeLaunch()
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${delimiter}${process.env.PYTHONPATH}` : repoRoot,
    PYTHONUTF8: "1",
  }
  const args = [...launch.args, "app-server", "--stdio", "--cwd", workspace]
  if (sessionId) args.push("--session", sessionId)
  const current = spawn(launch.command, args, {
    cwd: workspace,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
    const runtimeError = new Error(`Runtime could not start: ${error.message}`)
    setSnapshot(worker, { status: "error", message: runtimeError.message })
    rejectPending(worker, runtimeError)
  })
  current.once("exit", (code, signal) => {
    if (worker.child !== current) return
    worker.child = undefined
    const error = runtimeExitError(code, signal, stderr)
    rejectPending(worker, error)
    setSnapshot(worker, code === 0 ? { status: "stopped" } : { status: "error", message: error.message })
  })
  return worker.snapshot
}

function request(worker: RuntimeWorker, method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
  if (!worker.child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  const requestId = `desktop-${++worker.requestSequence}`
  const message = JSON.stringify({ request_id: requestId, method, params }) + "\n"
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(requestId)
      reject(new Error(`Runtime request timed out: ${method}.`))
    }, timeoutMs)
    worker.pending.set(requestId, { resolve, reject, timer })
    worker.child?.stdin.write(message, (error) => {
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
    const result = await request(worker, "initialize")
    const initialized = result && typeof result === "object" ? result as Record<string, unknown> : undefined
    if (initialized && typeof initialized.session_id === "string" && initialized.session_id) worker.sessionId = initialized.session_id
    setSnapshot(worker, { status: "ready" })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (worker.snapshot.status !== "error") setSnapshot(worker, { status: "error", message })
    throw error
  }
}

export function requestRuntime(id: string, method: string, params: Record<string, unknown> = {}) {
  const worker = workers.get(id)
  if (!worker) return Promise.reject(new Error(`Runtime worker does not exist: ${id}`))
  const timeout = method === "turn.start" || method === "slash.execute" ? 15 * 60_000 : 30_000
  return request(worker, method, params, timeout)
}

export async function shutdownRuntime(id: string) {
  const worker = workers.get(id)
  if (!worker) return { ok: true }
  const current = worker.child
  if (!current) {
    setSnapshot(worker, { status: "stopped" })
    workers.delete(id)
    return { ok: true }
  }
  try {
    await request(worker, "shutdown", {}, 5_000)
  } finally {
    if (worker.child === current) worker.child.kill()
    worker.child = undefined
    rejectPending(worker, new Error("Runtime stopped."))
    setSnapshot(worker, { status: "stopped" })
    workers.delete(id)
  }
  return { ok: true }
}

export async function shutdownAllRuntimes() {
  await Promise.all([...workers.keys()].map((id) => shutdownRuntime(id)))
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
