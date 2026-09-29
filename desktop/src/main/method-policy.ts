import { localOnlyRuntimeMethods, runtimeMethods, type RuntimeMethod } from "../preload/types.ts"

// Single source of truth for which worker methods each client may call.
// Lifecycle methods (initialize, shutdown) are never part of either list.
const desktopRuntimeMethods: ReadonlySet<string> = new Set<string>(Object.values(runtimeMethods))

/** Methods the desktop renderer may invoke through the preload bridge. */
export function isDesktopRuntimeMethod(method: unknown): method is RuntimeMethod {
  return typeof method === "string" && desktopRuntimeMethods.has(method)
}

/** Methods a remote gateway client may invoke. Auth stays on the desktop:
 *  remote clients cannot answer credential prompts, but may read status. */
export function isRemoteRuntimeMethod(method: unknown): method is RuntimeMethod {
  return isDesktopRuntimeMethod(method) && !localOnlyRuntimeMethods.has(method)
}
