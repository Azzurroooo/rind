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

const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const eventListeners = new Set<(event: RuntimeEvent) => void>()
const pending = new Map<string, PendingRequest>()
let child: ChildProcessWithoutNullStreams | undefined
let requestSequence = 0
let workspaceRoot = ""
let snapshot: RuntimeSnapshot = { status: "stopped" }

function setSnapshot(next: RuntimeSnapshot) {
  snapshot = { ...next, workspace: workspaceRoot || undefined }
  for (const listener of listeners) listener(snapshot)
}

function rejectPending(error: Error) {
  for (const [requestId, request] of pending) {
    clearTimeout(request.timer)
    request.reject(error)
    pending.delete(requestId)
  }
}

function handleLine(line: string) {
  let message: RuntimeMessage
  try {
    message = JSON.parse(line) as RuntimeMessage
  } catch {
    log.warn("runtime emitted invalid JSON", line)
    return
  }

  if (message.kind === "event" && message.event) {
    for (const listener of eventListeners) listener({
      type: String(message.event_type || message.event.type || ""),
      sequence: Number(message.sequence || 0),
      sessionId: String(message.session_id || ""),
      turnId: String(message.turn_id || ""),
      event: message.event,
    })
    return
  }
  if (message.kind !== "response" || message.request_id === undefined) return
  const requestId = String(message.request_id)
  const request = pending.get(requestId)
  if (!request) return
  pending.delete(requestId)
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
  if (configuredPath) return { command: configuredPath, args: [] }
  if (!process.env.ELECTRON_RENDERER_URL) {
    return { command: join(process.resourcesPath, "runtime", "rind-runtime.exe"), args: [] }
  }
  const python = process.env.RIND_PYTHON || (process.platform === "win32" ? "python" : "python3")
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  return { command: python, args: [join(repoRoot, "main.py")] }
}

export function startRuntime(nextWorkspace: string, rindHome: string) {
  if (child) return
  workspaceRoot = nextWorkspace
  setSnapshot({ status: "starting" })
  const launch = runtimeLaunch()
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const current = spawn(launch.command, [...launch.args, "app-server", "--stdio", "--cwd", workspaceRoot], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${delimiter}${process.env.PYTHONPATH}` : repoRoot,
      PYTHONUTF8: "1",
      RIND_HOME: rindHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child = current
  createInterface({ input: current.stdout }).on("line", handleLine)
  current.stderr.on("data", (chunk) => log.warn("runtime stderr", String(chunk).trimEnd()))
  current.once("error", (error) => {
    if (child !== current) return
    setSnapshot({ status: "error", message: error.message })
    rejectPending(error)
  })
  current.once("exit", (code, signal) => {
    if (child !== current) return
    child = undefined
    rejectPending(new Error(`Runtime exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`))
    if (snapshot.status !== "error") setSnapshot({ status: "stopped" })
  })
  void initializeRuntime().catch(() => undefined)
}

function request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
  if (!child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  const requestId = `desktop-${++requestSequence}`
  const message = JSON.stringify({ request_id: requestId, method, params }) + "\n"
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Runtime request timed out: ${method}.`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    child?.stdin.write(message, (error) => {
      if (!error) return
      clearTimeout(timer)
      pending.delete(requestId)
      reject(error)
    })
  })
}

export async function initializeRuntime() {
  try {
    const result = await request("initialize")
    setSnapshot({ status: "ready" })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setSnapshot({ status: "error", message })
    throw error
  }
}

export function requestRuntime(method: string, params: Record<string, unknown> = {}) {
  const timeout = method === "turn.start" || method === "slash.execute" ? 15 * 60_000 : 30_000
  return request(method, params, timeout)
}

export async function shutdownRuntime() {
  const current = child
  if (!current) {
    setSnapshot({ status: "stopped" })
    return { ok: true }
  }
  try {
    await request("shutdown", {}, 5_000)
  } finally {
    if (child === current) current.kill()
    child = undefined
    rejectPending(new Error("Runtime stopped."))
    setSnapshot({ status: "stopped" })
  }
  return { ok: true }
}

export function subscribeRuntime(listener: (snapshot: RuntimeSnapshot) => void) {
  listeners.add(listener)
  listener(snapshot)
  return () => listeners.delete(listener)
}

export function subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void) {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function getWorkspaceRoot() {
  return workspaceRoot
}

export function getRuntimeSnapshot() {
  return snapshot
}
