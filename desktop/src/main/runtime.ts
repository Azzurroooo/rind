import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import log from "electron-log/main"

import type { RuntimeSnapshot } from "../preload/types"

type RuntimeResponse = {
  kind?: string
  request_id?: string
  result?: unknown
  error?: { message?: string }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
const pending = new Map<string, PendingRequest>()
let child: ChildProcessWithoutNullStreams | undefined
let requestSequence = 0
let snapshot: RuntimeSnapshot = { status: "stopped" }

function setSnapshot(next: RuntimeSnapshot) {
  snapshot = next
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
  let message: RuntimeResponse
  try {
    message = JSON.parse(line) as RuntimeResponse
  } catch {
    log.warn("runtime emitted invalid JSON", line)
    return
  }

  if (message.kind !== "response" || !message.request_id) return
  const request = pending.get(message.request_id)
  if (!request) return
  pending.delete(message.request_id)
  clearTimeout(request.timer)
  if (message.error) {
    request.reject(new Error(message.error.message || "Runtime request failed."))
    return
  }
  request.resolve(message.result)
}

function fakeRuntimePath() {
  return join(dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-runtime.mjs")
}

export function startRuntime() {
  if (child) return
  setSnapshot({ status: "starting" })
  child = spawn(process.execPath, [fakeRuntimePath()], {
    cwd: dirname(fakeRuntimePath()),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  const current = child
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
    rejectPending(new Error(`Runtime exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"}).`))
    if (snapshot.status !== "error") setSnapshot({ status: "stopped" })
  })
}

function request(method: string, params: Record<string, unknown> = {}) {
  if (!child?.stdin.writable) return Promise.reject(new Error("Runtime is not running."))
  const requestId = `desktop-${++requestSequence}`
  const message = JSON.stringify({ request_id: requestId, method, params }) + "\n"
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Runtime request timed out: ${method}.`))
    }, 5000)
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

export async function shutdownRuntime() {
  const current = child
  if (!current) {
    setSnapshot({ status: "stopped" })
    return { ok: true }
  }
  try {
    await request("shutdown")
  } finally {
    if (child === current) current.kill()
    child = undefined
    setSnapshot({ status: "stopped" })
  }
  return { ok: true }
}

export function subscribeRuntime(listener: (snapshot: RuntimeSnapshot) => void) {
  listeners.add(listener)
  listener(snapshot)
  return () => listeners.delete(listener)
}
