import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import log from "electron-log/main"
import { RuntimeInputs } from "./runtime-inputs.ts"
import { runtimeRequestTimeout } from "./runtime-request-policy.ts"
import { buildRuntimeEnv, resolveSourcePython } from "../../../rind-runtime-client/runtime-env.js"
import { resolveRindHome } from "../../../rind-runtime-client/local-files.js"

import { buildAuthReply, parseAuthPrompt, parseAuthUpdate, validateAuthReply } from "./auth-messages.ts"
import {
  runtimeProtocolVersion,
  type DesktopAuthPrompt,
  type DesktopAuthUpdate,
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

type SharedRuntimeConnection = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  close: () => void
}

type RuntimeWorker = {
  child?: ChildProcessWithoutNullStreams
  sharedClient?: SharedRuntimeConnection
  sharedConnecting?: Promise<SharedRuntimeConnection>
  workspace?: string
  pending: Map<string, PendingRequest>
  requestSequence: number
  snapshot: RuntimeSnapshot
  initializing?: Promise<unknown>
  shutdownPromise?: Promise<{ ok: true }>
}

const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const eventListeners = new Set<(event: RuntimeEvent) => void>()
const inputs = new RuntimeInputs()
const authPromptListeners = new Set<(prompt: DesktopAuthPrompt) => void>()
const authUpdateListeners = new Set<(update: DesktopAuthUpdate) => void>()
// Worker-initiated auth prompts still waiting for an answer from the window.
let pendingAuthPrompts: ReadonlySet<string> = new Set()
const sharedAuthResolvers = new Map<string, (value: string) => void>()
const maxStderrChars = 4096
const worker: RuntimeWorker = {
  pending: new Map(),
  requestSequence: 0,
  snapshot: { status: "stopped" },
}

function useSharedRuntime() {
  return Boolean(process.versions.electron) && !process.env.RIND_RUNTIME_PATH
}

export function isSharedRuntime() {
  return useSharedRuntime()
}

function setSnapshot(next: RuntimeSnapshot) {
  worker.snapshot = next
  for (const listener of listeners) listener(worker.snapshot)
}

function rejectPending(error: Error) {
  inputs.clear()
  pendingAuthPrompts = new Set()
  for (const resolveAuth of sharedAuthResolvers.values()) {
    try {
      resolveAuth("")
    } catch {
      // Ignore auth cancellation errors.
    }
  }
  sharedAuthResolvers.clear()
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

function dispatchRuntimeEnvelope(message: unknown) {
  const authUpdate = parseAuthUpdate(message)
  if (authUpdate) {
    for (const listener of authUpdateListeners) listener(authUpdate)
    return true
  }
  if (isRuntimeEventEnvelope(message)) {
    const enriched = inputs.enrich(message)
    const type = String(enriched.event.type || "")
    for (const listener of eventListeners) listener({
      type,
      sequence: message.sequence,
      durability: message.durability,
      sessionId: message.session_id,
      turnId: message.turn_id,
      event: enriched.event,
      generation: runtimeGeneration,
    })
    return true
  }
  return false
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

  const authPrompt = parseAuthPrompt(message)
  if (authPrompt) {
    pendingAuthPrompts = new Set([...pendingAuthPrompts, authPrompt.requestId])
    for (const listener of authPromptListeners) listener(authPrompt)
    return
  }
  if (dispatchRuntimeEnvelope(message)) return
  if (!isRuntimeResponseEnvelope(message)) return
  const requestId = String(message.request_id)
  inputs.finish(requestId)
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
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  return { command: resolveSourcePython(process.env.RIND_PYTHON, repoRoot), args: [join(repoRoot, "main.py")] }
}

let runtimeGeneration = 0
let sharedRuntimeModulePromise: Promise<any> | undefined

function loadSharedRuntimeModule(repoRoot: string) {
  if (!sharedRuntimeModulePromise) {
    const sharedUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "shared-runtime.js")).href
    sharedRuntimeModulePromise = import(/* @vite-ignore */ sharedUrl).catch((error) => {
      sharedRuntimeModulePromise = undefined
      throw error
    })
  }
  return sharedRuntimeModulePromise
}

function ensureSharedClient(): Promise<SharedRuntimeConnection> {
  if (worker.sharedClient) return Promise.resolve(worker.sharedClient)
  if (worker.sharedConnecting) return worker.sharedConnecting
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const rindHome = resolveRindHome(process.env.RIND_HOME)
  const isSource = Boolean(process.env.ELECTRON_RENDERER_URL)
  const packagedRuntimePath = !isSource
    ? join(process.resourcesPath, "runtime", process.platform === "win32" ? "rind-runtime.exe" : "rind-runtime")
    : undefined
  buildRuntimeEnv(repoRoot, process.env, { sourceRuntime: isSource, rindHome })

  worker.sharedConnecting = (async () => {
    const { connectSharedRuntime } = await loadSharedRuntimeModule(repoRoot)
    const conn = (await connectSharedRuntime({
      rindHome,
      repoRoot: isSource ? repoRoot : undefined,
      python: isSource ? resolveSourcePython(process.env.RIND_PYTHON, repoRoot) : undefined,
      runtimePath: packagedRuntimePath,
      onMessage(message: unknown) {
        dispatchRuntimeEnvelope(message)
      },
      onRequest(prompt: unknown) {
        const authPrompt = parseAuthPrompt(prompt)
        if (!authPrompt) return ""
        pendingAuthPrompts = new Set([...pendingAuthPrompts, authPrompt.requestId])
        return new Promise<string>((resolve) => {
          sharedAuthResolvers.set(authPrompt.requestId, resolve)
          for (const listener of authPromptListeners) listener(authPrompt)
        })
      },
      onDisconnect() {
        worker.sharedClient = undefined
        if (worker.snapshot.status === "stopping" || worker.snapshot.status === "stopped") return
        rejectPending(new Error("Runtime connection lost."))
        setSnapshot({ status: "stopped" })
      },
    })) as SharedRuntimeConnection
    worker.sharedClient = conn
    return conn
  })().finally(() => {
    worker.sharedConnecting = undefined
  })

  return worker.sharedConnecting
}

export function startRuntime(workspace: string) {
  if (worker.snapshot.status === "stopping") throw new Error("Runtime is shutting down.")
  if (!workspace) throw new Error("Workspace is required to start the runtime worker.")
  worker.workspace = workspace

  if (useSharedRuntime()) {
    if (worker.sharedClient || worker.sharedConnecting || worker.snapshot.status === "ready") {
      return worker.snapshot
    }
    setSnapshot({ status: "starting" })
    runtimeGeneration += 1
    worker.shutdownPromise = undefined
    void ensureSharedClient().catch((error: Error) => {
      if (worker.snapshot.status !== "stopped") {
        setSnapshot({ status: "error", message: error?.message || "Runtime could not start." })
      }
    })
    return worker.snapshot
  }

  if (worker.child && !worker.child.killed && worker.child.exitCode === null) return worker.snapshot
  setSnapshot({ status: "starting" })
  runtimeGeneration += 1
  const launch = runtimeLaunch()
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const environment: NodeJS.ProcessEnv = buildRuntimeEnv(repoRoot, process.env, {
    sourceRuntime: Boolean(process.env.ELECTRON_RENDERER_URL) && !process.env.RIND_RUNTIME_PATH,
  })
  if (launch.command === process.execPath && /\.(?:c|m)?js$/i.test(process.env.RIND_RUNTIME_PATH || "")) {
    environment.ELECTRON_RUN_AS_NODE = "1"
  }
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

async function requestShared(method: RuntimeServerMethod, params: Record<string, unknown> = {}) {
  const client = await ensureSharedClient()
  if (method !== "initialize" && method !== "shutdown" && worker.snapshot.status !== "ready") {
    await initializeRuntime()
  }
  const requestId = `desktop-${++worker.requestSequence}`
  inputs.begin(requestId, method, params)
  try {
    const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : ""
    if (method === "session/replay" && sessionId) {
      await client.request("session/subscribe", { session_id: sessionId }).catch(() => {})
    } else if (method === "session/delete" && sessionId) {
      await client.request("session/unsubscribe", { session_id: sessionId }).catch(() => {})
    }
    return await client.request(method, params)
  } catch (error: any) {
    if (error && typeof error === "object" && typeof error.code === "string" && error.code) {
      error.name = error.code
    }
    throw error
  } finally {
    inputs.finish(requestId)
  }
}

function request(method: RuntimeServerMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
  if (useSharedRuntime()) {
    return requestShared(method, params)
  }
  if (!worker.child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  const requestId = `desktop-${++worker.requestSequence}`
  const message: RuntimeRequestEnvelope = { kind: "request", request_id: requestId, method, params }
  inputs.begin(requestId, method, params)
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(requestId)
      inputs.finish(requestId)
      reject(new Error(`Runtime request timed out: ${method}.`))
    }, timeoutMs)
    worker.pending.set(requestId, { resolve, reject, timer })
    worker.child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) return
      inputs.finish(requestId)
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
    if (useSharedRuntime()) {
      const client = await ensureSharedClient()
      const initialized = requireRuntimeInitialization(await client.request("initialize", {}))
      await client.request("runtime/observe", {}).catch(() => {})
      setSnapshot({ status: "ready" })
      return initialized
    }
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
  return request(method, params, runtimeRequestTimeout(method))
}

/** Answer a worker auth prompt. An empty value cancels the login. */
export async function respondAuthPrompt(requestId: unknown, value: unknown): Promise<boolean> {
  const reply = validateAuthReply(pendingAuthPrompts, requestId, value)
  if (useSharedRuntime()) {
    if (!worker.sharedClient) return Promise.reject(new Error("Runtime is not running."))
    pendingAuthPrompts = new Set([...pendingAuthPrompts].filter((id) => id !== reply.requestId))
    const resolve = sharedAuthResolvers.get(reply.requestId)
    sharedAuthResolvers.delete(reply.requestId)
    resolve?.(reply.value)
    return true
  }
  if (!worker.child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  pendingAuthPrompts = new Set([...pendingAuthPrompts].filter((id) => id !== reply.requestId))
  const envelope = buildAuthReply(reply.requestId, reply.value)
  return new Promise<boolean>((resolve, reject) => {
    worker.child?.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => (error ? reject(error) : resolve(true)))
  })
}

export function subscribeAuthPrompts(listener: (prompt: DesktopAuthPrompt) => void) {
  authPromptListeners.add(listener)
  return () => authPromptListeners.delete(listener)
}

export function subscribeAuthUpdates(listener: (update: DesktopAuthUpdate) => void) {
  authUpdateListeners.add(listener)
  return () => authUpdateListeners.delete(listener)
}

export function shutdownRuntime() {
  if (worker.shutdownPromise) return worker.shutdownPromise
  worker.shutdownPromise = shutdownWorker()
  return worker.shutdownPromise
}

async function shutdownWorker(): Promise<{ ok: true }> {
  if (useSharedRuntime()) {
    const current = worker.sharedClient
    if (!current && worker.snapshot.status === "stopped") {
      return { ok: true }
    }
    setSnapshot({ status: "stopping" })
    try {
      await current?.request("shutdown", {}).catch(() => {})
    } finally {
      current?.close()
      worker.sharedClient = undefined
      rejectPending(new Error("Runtime stopped."))
      setSnapshot({ status: "stopped" })
    }
    return { ok: true }
  }
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
  return worker.child || worker.sharedClient || worker.snapshot.status !== "stopped" ? worker.snapshot : undefined
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
