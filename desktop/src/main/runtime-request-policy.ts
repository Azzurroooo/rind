import { runtimeMethods, type RuntimeMethod } from "../preload/types.ts"

const longRunning = new Set<RuntimeMethod>([
  runtimeMethods.sessionPrompt,
  runtimeMethods.sessionFollowUp,
  runtimeMethods.sessionCompact,
  runtimeMethods.commandExecute,
  runtimeMethods.authLogin,
])

// Includes slash commands: /compact waits for the same model as the direct RPC.
export function runtimeRequestTimeout(method: RuntimeMethod) {
  return longRunning.has(method) ? 15 * 60_000 : 30_000
}
