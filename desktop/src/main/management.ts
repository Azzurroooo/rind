import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRindHome } from "../../../rind-runtime-client/local-files.js"
import { resolveSourcePython } from "../../../rind-runtime-client/runtime-env.js"
import {
  createManagementBridge,
  emptyAgentsSnapshot,
  type AgentsSnapshot,
  type ManagementStatePayload,
} from "../../../rind-runtime-client/remote/management.js"
import type { RuntimeEvent, RuntimeMethod } from "../preload/types.ts"
import {
  getRuntimeSnapshot,
  initializeRuntime,
  isSharedRuntime,
  requestRuntime,
  startRuntime,
} from "./runtime.ts"

export { emptyAgentsSnapshot, type AgentsSnapshot, type ManagementStatePayload }

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDir, "../../..")

async function ensureRuntimeForWorkspace(workspaceRoot?: string) {
  const snap = getRuntimeSnapshot()
  const fallbackWorkspace = workspaceRoot || process.cwd()
  if (!snap || snap.status === "stopped" || snap.status === "error") {
    startRuntime(fallbackWorkspace)
  }
  if (getRuntimeSnapshot()?.status !== "ready") {
    await initializeRuntime()
  }
}

export const managementBridge = createManagementBridge({
  getRindHome: () => resolveRindHome(process.env.RIND_HOME),
  repoRoot,
  getRuntimePath: () => process.env.RIND_RUNTIME_PATH || "",
  getPython: () => {
    const runtimePath = process.env.RIND_RUNTIME_PATH || ""
    return runtimePath ? undefined : resolveSourcePython(process.env.RIND_PYTHON, repoRoot)
  },
  requestRuntime: (method, params) => requestRuntime(method as RuntimeMethod, params),
  ensureRuntimeForWorkspace,
  isSharedRuntime,
  allowSharedObserver: true,
})

export const getManagementState = () => managementBridge.getManagementState()
export const ensureManagementConnected = (options?: { start?: boolean }) =>
  managementBridge.ensureManagementConnected(options)
export const requestManagement = (method: string, params?: Record<string, unknown>) =>
  managementBridge.requestManagement(method, params)
export const openAgentSession = (params: Record<string, unknown>) =>
  managementBridge.openAgentSession(params)
export const createAgentSession = (params: Record<string, unknown>) =>
  managementBridge.createAgentSession(params)
export const enrichSessionReplayParams = (sessionId: string, params: Record<string, unknown>) =>
  managementBridge.enrichSessionReplayParams(sessionId, params)
export const forwardControlToSharedRuntimeIfNeeded = (
  method: string,
  params: Record<string, unknown>,
) => managementBridge.forwardControlToSharedRuntimeIfNeeded(method, params)
export const subscribeManagement = (listener: (payload: ManagementStatePayload) => void) =>
  managementBridge.subscribeManagement(listener)
export const subscribeSharedRuntimeEvents = (listener: (event: RuntimeEvent) => void) =>
  managementBridge.subscribeSharedRuntimeEvents(listener)
export const isManagedWorkspacePath = (targetPath: string) =>
  managementBridge.isManagedWorkspacePath(targetPath)
export const closeManagement = () => managementBridge.closeManagement()
