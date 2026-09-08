// Shared between the main process (wrap) and the preload bridge (unwrap).
//
// Worker error envelopes are delivered to callers as rejected promises today,
// which makes Electron's ipcMain.handle print a full stack for every expected
// race (e.g. "The requested turn is no longer active."). Returning a wrapped
// error envelope instead keeps the console quiet while the preload bridge
// re-throws an identical Error, so renderer call sites keep their semantics.

export const RUNTIME_IPC_ERROR_KEY = "__runtimeError__"

export interface RuntimeIpcErrorPayload {
  name: string
  message: string
}

export function wrapRuntimeIpcError(error: unknown): { [RUNTIME_IPC_ERROR_KEY]: RuntimeIpcErrorPayload } {
  if (error instanceof Error) {
    return { [RUNTIME_IPC_ERROR_KEY]: { name: errName(error), message: error.message || "Runtime request failed." } }
  }
  return { [RUNTIME_IPC_ERROR_KEY]: { name: "RuntimeError", message: String(error) || "Runtime request failed." } }
}

function errName(error: Error): string {
  return error.name || "RuntimeError"
}

export function unwrapRuntimeIpcResult<T>(result: T): T {
  const candidate = result as { [RUNTIME_IPC_ERROR_KEY]?: RuntimeIpcErrorPayload } | null
  const payload = candidate?.[RUNTIME_IPC_ERROR_KEY]
  if (payload) {
    const error = new Error(payload.message || "Runtime request failed.")
    error.name = payload.name || "RuntimeError"
    throw error
  }
  return result
}
