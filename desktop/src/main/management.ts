import { open, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildRuntimeEnv, resolveSourcePython } from "../../../rind-runtime-client/runtime-env.js"
import { resolveRindHome } from "../../../rind-runtime-client/local-files.js"
import { runtimeMethods, type RuntimeEvent } from "../preload/types.ts"
import { initializeRuntime, requestRuntime, startRuntime, getRuntimeSnapshot } from "./runtime.ts"

export type AgentsSnapshot = {
  seq?: number
  teams: Array<Record<string, unknown>>
  memberships: Array<Record<string, unknown>>
  agents: Array<Record<string, unknown>>
  tasks: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  connectedSessions?: string[]
  live?: Array<Record<string, unknown>>
  folderDefaultsVersion?: number
  notices?: Array<Record<string, unknown>>
  approvals?: Array<Record<string, unknown>>
  archivedTeams?: Array<Record<string, unknown>>
  notes?: Array<Record<string, unknown>>
  artifacts?: Array<Record<string, unknown>>
}

export type ManagementStatePayload = {
  snapshot: AgentsSnapshot
  connection: "connecting" | "connected" | "reconnecting" | "stopped" | "offline"
  service: Record<string, unknown> | null
  error?: string
}

type ManagementClient = {
  request: (method: string, params?: Record<string, unknown>) => Promise<any>
  close: () => void
  service?: Record<string, unknown> | null
  stale?: unknown
}

type SessionAttachment = {
  managementSessionId: string
  agentId: string
  teamId: string
  manager: boolean
  workspaceRoot: string
  runtimeSessionId: string
  externalTools: Record<string, unknown>
}

export function emptyAgentsSnapshot(): AgentsSnapshot {
  return {
    seq: 0,
    teams: [],
    memberships: [],
    agents: [],
    tasks: [],
    runs: [],
    sessions: [],
    connectedSessions: [],
    live: [],
    folderDefaultsVersion: 0,
    notices: [],
    approvals: [],
    archivedTeams: [],
    notes: [],
    artifacts: [],
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDir, "../../..")

let managementModulePromise: Promise<any> | undefined
let sharedRuntimeModulePromise: Promise<any> | undefined

function loadManagementModule() {
  if (!managementModulePromise) {
    const clientUrl = pathToFileURL(join(repoRoot, "agent-management", "dist", "client.js")).href
    managementModulePromise = import(/* @vite-ignore */ clientUrl).catch((error) => {
      managementModulePromise = undefined
      throw error
    })
  }
  return managementModulePromise
}

function loadSharedRuntimeModule() {
  if (!sharedRuntimeModulePromise) {
    const sharedUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "shared-runtime.js")).href
    sharedRuntimeModulePromise = import(/* @vite-ignore */ sharedUrl).catch((error) => {
      sharedRuntimeModulePromise = undefined
      throw error
    })
  }
  return sharedRuntimeModulePromise
}

let client: ManagementClient | undefined
let connecting: Promise<ManagementClient> | undefined
let currentSnapshot: AgentsSnapshot = emptyAgentsSnapshot()
let connectionStatus: ManagementStatePayload["connection"] = "connecting"
let serviceInfo: Record<string, unknown> | null = null
let lastError = ""
let explicitlyStopped = false
let closing = false

const stateListeners = new Set<(payload: ManagementStatePayload) => void>()
const sharedEventListeners = new Set<(event: RuntimeEvent) => void>()
const attachmentsByManagementId = new Map<string, SessionAttachment>()
const attachmentsByRuntimeId = new Map<string, SessionAttachment>()

let sharedObserver: { request: (method: string, params?: Record<string, unknown>) => Promise<any>; close: () => void } | undefined
let sharedObserverConnecting: Promise<void> | undefined
let sharedSequence = 0

function launchOptions() {
  const home = resolveRindHome(process.env.RIND_HOME)
  const runtimePath = process.env.RIND_RUNTIME_PATH || ""
  const python = runtimePath ? undefined : resolveSourcePython(process.env.RIND_PYTHON, repoRoot)
  return { home, python, repoRoot, runtimePath }
}

function broadcastState() {
  const payload = getManagementState()
  for (const listener of stateListeners) {
    try {
      listener(payload)
    } catch {
      // Ignore individual subscriber errors.
    }
  }
}

function acceptSnapshot(next: unknown) {
  if (!next || typeof next !== "object") return
  currentSnapshot = {
    ...emptyAgentsSnapshot(),
    ...(next as Record<string, unknown>),
  } as AgentsSnapshot
  broadcastState()
  // Attach Shared Runtime observer if background runs or live sessions exist.
  const hasLiveOrRunning =
    (Array.isArray(currentSnapshot.live) && currentSnapshot.live.length > 0) ||
    (Array.isArray(currentSnapshot.runs) &&
      currentSnapshot.runs.some((r) => r.status === "starting" || r.status === "running"))
  if (hasLiveOrRunning && !sharedObserver && !sharedObserverConnecting && !closing) {
    void ensureSharedObserver()
  }
}

function normalizeWorkspaceKey(target: unknown): string {
  if (typeof target !== "string" || !target.trim()) return ""
  const resolved = resolve(target.trim()).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

async function readSessionIndexEntries(rindHome: string): Promise<Array<Record<string, unknown>>> {
  const indexPath = join(rindHome, "session_index.json")
  try {
    const raw = JSON.parse(await readFile(indexPath, "utf8"))
    const map = raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
      ? raw.sessions
      : raw && typeof raw === "object"
        ? raw
        : {}
    return Object.entries(map)
      .filter(([, value]) => value && typeof value === "object")
      .map(([id, value]: [string, any]) => ({
        session_id: String(value.id || value.session_id || id),
        title: String(value.title || ""),
        updated_at: String(value.updated_at || value.created_at || ""),
        workspace_root: String(value.workspace_root || ""),
        message_count: Number(value.message_count || 0),
        last_model: String(value.last_model || ""),
        last_user_message: String(value.last_user_message || ""),
      }))
  } catch {
    return []
  }
}

async function listManagedSessionsLocal(params: Record<string, unknown> = {}) {
  const opts = launchOptions()
  const { managementPaths } = await loadManagementModule()
  const managerWorkspace = managementPaths(opts.home).manager
  const runtimeSessions = await readSessionIndexEntries(opts.home)
  const snapshot = currentSnapshot

  const byWorkspace = new Map<string, Record<string, unknown>>()
  const byAgent = new Map<string, Record<string, unknown>>()
  for (const agent of snapshot.agents) {
    byWorkspace.set(normalizeWorkspaceKey(agent.canonicalWorkspace), agent)
    if (typeof agent.id === "string") byAgent.set(agent.id, agent)
  }
  const byTeam = new Map<string, Record<string, unknown>>()
  for (const team of snapshot.teams) {
    if (typeof team.id === "string") byTeam.set(team.id, team)
  }
  const byRuntimeSession = new Map<string, Record<string, unknown>>()
  const connected = new Set(snapshot.connectedSessions || [])
  for (const session of snapshot.sessions) {
    const rId = typeof session.runtimeSessionId === "string" ? session.runtimeSessionId : ""
    if (!rId) continue
    const prev = byRuntimeSession.get(rId)
    if (
      !prev ||
      (connected.has(String(session.id)) && !connected.has(String(prev.id))) ||
      String(session.updatedAt || "") > String(prev.updatedAt || "")
    ) {
      byRuntimeSession.set(rId, session)
    }
  }
  const runningBySession = new Set(
    (snapshot.runs || [])
      .filter((run) => run.status === "starting" || run.status === "running")
      .map((run) => String(run.runtimeSessionId || ""))
      .filter(Boolean),
  )
  const liveBySession = new Map<string, Record<string, unknown>>()
  for (const item of snapshot.live || []) {
    if (typeof item.id === "string") liveBySession.set(item.id, item)
  }
  const managerKey = normalizeWorkspaceKey(managerWorkspace)

  const sessions = runtimeSessions
    .map((item) => {
      const runtimeSessionId = String(item.session_id || "")
      const record = byRuntimeSession.get(runtimeSessionId)
      const agent =
        (record && typeof record.agentId === "string" ? byAgent.get(record.agentId) : undefined) ||
        byWorkspace.get(normalizeWorkspaceKey(item.workspace_root))
      const isManager = Boolean(
        managerKey &&
          normalizeWorkspaceKey(item.workspace_root || agent?.canonicalWorkspace) === managerKey,
      )
      if (!agent && !isManager) return null
      const memberships = agent
        ? snapshot.memberships.filter((m) => m.agentId === agent.id)
        : []
      const membership =
        (record?.teamId ? memberships.find((m) => m.teamId === record.teamId) : undefined) ||
        (params.teamId ? memberships.find((m) => m.teamId === params.teamId) : undefined) ||
        memberships[0]
      const team = membership ? byTeam.get(String(membership.teamId || "")) : undefined
      const live = liveBySession.get(runtimeSessionId)
      const running =
        (live ? live.turn !== "idle" : false) || runningBySession.has(runtimeSessionId)
      const attached = Boolean(
        (live && Number(live.windows || 0) > 0) ||
          (record && connected.has(String(record.id || ""))),
      )
      return {
        runtimeSessionId,
        title: String(item.title || item.last_user_message || runtimeSessionId),
        updatedAt: String(item.updated_at || record?.updatedAt || ""),
        workspaceRoot: String(item.workspace_root || agent?.canonicalWorkspace || managerWorkspace || ""),
        agentId: String(agent?.id || ""),
        agentName: isManager ? "Manager" : String(agent?.displayName || ""),
        teamId: String(team?.id || record?.teamId || ""),
        teamName: String(team?.name || ""),
        roleTitle: isManager ? "Manager" : String(membership?.roleTitle || ""),
        manager: isManager,
        attached,
        running,
        status: running ? "working" : attached ? "open" : "idle",
        messageCount: Number(item.message_count || 0),
        model: String(item.last_model || ""),
        lastActivity: String(item.last_user_message || ""),
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => (params.manager ? item.manager : true))
    .filter((item) => (params.agentId ? item.agentId === params.agentId : true))
    .filter((item) => (params.teamId ? item.teamId === params.teamId : true))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))

  return { sessions }
}

async function ensureSharedObserver() {
  if (Boolean(process.versions.electron) && !process.env.RIND_RUNTIME_PATH) return
  if (sharedObserver || sharedObserverConnecting || closing) return sharedObserverConnecting
  sharedObserverConnecting = (async () => {
    try {
      const { connectSharedRuntime } = await loadSharedRuntimeModule()
      const opts = launchOptions()
      const conn = await connectSharedRuntime({
        rindHome: opts.home,
        start: false,
        onMessage(message: any) {
          if (!message || message.kind === "runtime") return
          const inner = message.event
          if (!inner || typeof inner !== "object" || typeof message.session_id !== "string") return
          const type = String(inner.type || "")
          if (!type) return
          const runtimeEvent: RuntimeEvent = {
            type,
            sequence: Number.isInteger(message.sequence) ? message.sequence : ++sharedSequence,
            durability: message.durability === "durable" ? "durable" : "incremental",
            sessionId: message.session_id,
            turnId: String(message.turn_id || ""),
            event: inner,
          }
          for (const listener of sharedEventListeners) {
            try {
              listener(runtimeEvent)
            } catch {
              // Ignore listener errors.
            }
          }
        },
        onDisconnect() {
          sharedObserver = undefined
        },
      })
      if (closing) {
        conn.close()
        return
      }
      await conn.request("runtime/observe").catch(() => {})
      sharedObserver = conn
    } catch {
      // Shared Runtime is not running yet; it will be observed when started.
    } finally {
      sharedObserverConnecting = undefined
    }
  })()
  return sharedObserverConnecting
}

export function getManagementState(): ManagementStatePayload {
  return {
    snapshot: currentSnapshot,
    connection: connectionStatus,
    service: serviceInfo,
    ...(lastError ? { error: lastError } : {}),
  }
}

export function ensureManagementConnected({ start = true }: { start?: boolean } = {}): Promise<ManagementClient> {
  if (client && connectionStatus === "connected") return Promise.resolve(client)
  if (connecting) return connecting
  if (!start && explicitlyStopped) {
    return Promise.reject(new Error("Agents management is stopped."))
  }
  connectionStatus = client ? "reconnecting" : "connecting"
  lastError = ""
  broadcastState()

  connecting = (async () => {
    const { connectManagement } = await loadManagementModule()
    const opts = launchOptions()
    // Ensure environment variables are populated for any child processes.
    buildRuntimeEnv(repoRoot, process.env, { sourceRuntime: !opts.runtimePath, rindHome: opts.home })
    const connected: ManagementClient = await connectManagement({
      ...opts,
      start,
      onSnapshot(snapshot: unknown) {
        if (closing) return
        acceptSnapshot(snapshot)
      },
      onDisconnect() {
        if (closing) return
        client = undefined
        if (explicitlyStopped) {
          connectionStatus = "stopped"
          serviceInfo = null
          broadcastState()
          return
        }
        connectionStatus = "reconnecting"
        broadcastState()
        setTimeout(() => {
          if (!closing && !explicitlyStopped && !client) {
            void ensureManagementConnected({ start: false }).catch(() => {
              connectionStatus = "offline"
              broadcastState()
            })
          }
        }, 400).unref?.()
      },
    })
    if (closing) {
      connected.close()
      throw new Error("Management is closing.")
    }
    client = connected
    explicitlyStopped = false
    connectionStatus = "connected"
    serviceInfo = connected.service
      ? { ...connected.service, ...(connected.stale ? { stale: connected.stale } : {}) }
      : null
    const initial = await connected.request("subscribe", { afterSeq: currentSnapshot.seq || 0 })
    acceptSnapshot(initial)
    // Reattach any direct sessions held by this process after a service restart.
    for (const attachment of attachmentsByManagementId.values()) {
      try {
        const reattached = await connected.request("attachSession", {
          agentId: attachment.manager ? undefined : attachment.agentId,
          teamId: attachment.teamId || undefined,
          manager: attachment.manager,
          shared: false,
        })
        const tools = await connected.request("sessionTools", { sessionId: reattached.id })
        if (attachment.runtimeSessionId) {
          await connected.request("bindSession", {
            sessionId: reattached.id,
            runtimeSessionId: attachment.runtimeSessionId,
          }).catch(() => {})
        }
        attachmentsByManagementId.delete(attachment.managementSessionId)
        attachment.managementSessionId = reattached.id
        attachment.externalTools = tools
        attachmentsByManagementId.set(reattached.id, attachment)
      } catch {
        // Ignore stale attachments that can no longer be restored.
      }
    }
    return connected
  })()
    .catch((error: Error) => {
      connectionStatus = explicitlyStopped ? "stopped" : "offline"
      lastError = error?.message || String(error)
      broadcastState()
      throw error
    })
    .finally(() => {
      connecting = undefined
    })

  return connecting
}

async function tailFile(filePath: string, maxBytes = 16384): Promise<string[]> {
  let handle
  try {
    handle = await open(filePath, "r")
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(maxBytes, size))
    await handle.read(buffer, 0, buffer.length, size - buffer.length)
    const lines = buffer.toString("utf8").split(/\r?\n/)
    return (size > maxBytes ? lines.slice(1) : lines).slice(-80)
  } catch {
    return ["No log yet."]
  } finally {
    await handle?.close()
  }
}

async function previewArtifactFile(filePath: string, maxBytes = 256 * 1024): Promise<{ content?: string; truncated?: boolean; binary?: boolean }> {
  try {
    const data = await readFile(filePath)
    if (data.includes(0)) return { binary: true }
    if (data.length > maxBytes) {
      return { content: data.subarray(0, maxBytes).toString("utf8"), truncated: true }
    }
    return { content: data.toString("utf8"), truncated: false }
  } catch {
    return {}
  }
}

export async function requestManagement(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (method === "getState") {
    if (!client && !explicitlyStopped) {
      await ensureManagementConnected({ start: true }).catch(() => {})
    }
    return getManagementState()
  }
  if (method === "reconnect") {
    explicitlyStopped = false
    await ensureManagementConnected({ start: true })
    return getManagementState()
  }
  if (method === "serviceLog") {
    const { managementPaths } = await loadManagementModule()
    const paths = managementPaths(launchOptions().home)
    const isRuntime = params.target === "runtime"
    const logPath = isRuntime ? join(dirname(paths.root), "runtime", "runtime.log") : join(paths.state, "service.log")
    return { path: logPath, lines: await tailFile(logPath) }
  }
  if (method === "listSessions") {
    if (!client && !explicitlyStopped) {
      await ensureManagementConnected({ start: true }).catch(() => {})
    }
    return listManagedSessionsLocal(params)
  }
  if (method === "openSession") {
    return openAgentSession(params)
  }
  if (method === "createSession") {
    return createAgentSession(params)
  }
  if (method === "deleteSession") {
    const active = await ensureManagementConnected({ start: true })
    let runtimeSessionId = typeof params.runtimeSessionId === "string" ? params.runtimeSessionId.trim() : ""
    const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : ""
    if (!runtimeSessionId && sessionId) {
      const record = currentSnapshot.sessions.find((s) => s.id === sessionId)
      if (record && typeof record.runtimeSessionId === "string") {
        runtimeSessionId = record.runtimeSessionId.trim()
      }
    }
    if (!runtimeSessionId) throw new Error("runtimeSessionId or sessionId is required.")
    const attachment = attachmentsByRuntimeId.get(runtimeSessionId)
    if (attachment) {
      attachmentsByRuntimeId.delete(runtimeSessionId)
      attachmentsByManagementId.delete(attachment.managementSessionId)
      await active.request("detachSession", { sessionId: attachment.managementSessionId }).catch(() => {})
    }
    await ensureRuntimeForWorkspace()
    await requestRuntime(runtimeMethods.sessionDelete, { session_id: runtimeSessionId })
    await active.request("forgetSession", {
      ...(sessionId ? { sessionId } : {}),
      runtimeSessionId,
    }).catch(() => {})
    acceptSnapshot(await active.request("snapshot"))
    return { deleted: true, runtimeSessionId }
  }
  if (method === "renameSession") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : ""
    const name = typeof params.name === "string" ? params.name.trim() : ""
    if (!sessionId) throw new Error("sessionId is required.")
    await ensureRuntimeForWorkspace()
    const input = name ? `/rename ${name}` : "/rename --reset"
    const result = (await requestRuntime(runtimeMethods.commandExecute, { session_id: sessionId, input })) as Record<string, unknown>
    const display = result?.display as Record<string, unknown> | undefined
    if (display?.type !== "session_renamed") {
      throw new Error(String(result?.text || "Could not rename this conversation."))
    }
    return display
  }
  if (method === "restartService") {
    const active = await ensureManagementConnected({ start: true })
    explicitlyStopped = true
    try {
      await active.request("serviceShutdown", { restart: true })
    } catch (error) {
      explicitlyStopped = false
      throw error
    }
    client?.close()
    client = undefined
    await new Promise((r) => setTimeout(r, 250))
    explicitlyStopped = false
    await ensureManagementConnected({ start: true })
    return getManagementState()
  }
  if (method === "stopServices") {
    const stopAgents = Boolean(params.stopAgents)
    const active = await ensureManagementConnected({ start: false }).catch(() => null)
    if (!active) {
      explicitlyStopped = true
      connectionStatus = "stopped"
      serviceInfo = null
      broadcastState()
      return { stopped: true, working: 0 }
    }
    explicitlyStopped = true
    try {
      const result = await active.request("serviceShutdown", { stopAgents })
      client?.close()
      client = undefined
      connectionStatus = "stopped"
      serviceInfo = null
      if (stopAgents) {
        currentSnapshot = { ...currentSnapshot, runs: [] }
      }
      broadcastState()
      return { stopped: true, ...result }
    } catch (error) {
      explicitlyStopped = false
      throw error
    }
  }

  const active = await ensureManagementConnected({ start: true })
  if (method === "readArtifactPreview" || method === "readArtifact") {
    const artifact = await active.request("readArtifact", { artifactId: params.artifactId })
    if (artifact?.path && typeof artifact.path === "string") {
      const preview = await previewArtifactFile(artifact.path)
      return { ...artifact, ...preview }
    }
    return artifact
  }

  const result = await active.request(method, params)
  if (method === "serviceInfo" && result && typeof result === "object") {
    serviceInfo = { ...result, ...(active.stale ? { stale: active.stale } : {}) }
    broadcastState()
  } else if (method !== "snapshot" && method !== "subscribe") {
    try {
      acceptSnapshot(await active.request("snapshot"))
    } catch {
      // Snapshot push will also arrive via subscription.
    }
  }
  return result
}

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

export async function openAgentSession(params: {
  teamId?: unknown
  agentId?: unknown
  manager?: unknown
  runtimeSessionId?: unknown
  existingRuntimeSessionId?: unknown
  resumeLatest?: unknown
  workspace?: unknown
}) {
  const manager = params.manager === true
  const teamId = typeof params.teamId === "string" && !manager ? params.teamId.trim() : ""
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : ""
  let runtimeSessionId =
    typeof params.runtimeSessionId === "string"
      ? params.runtimeSessionId.trim()
      : typeof params.existingRuntimeSessionId === "string"
        ? params.existingRuntimeSessionId.trim()
        : ""
  const explicitWorkspace = typeof params.workspace === "string" ? params.workspace.trim() : ""

  // Plain independent workspace session (outside any team and not Manager):
  if (!manager && !teamId && !agentId && explicitWorkspace) {
    await ensureRuntimeForWorkspace(explicitWorkspace)
    const opened = (await requestRuntime(runtimeMethods.sessionOpen, {
      workspace_root: explicitWorkspace,
      ...(runtimeSessionId ? { session_id: runtimeSessionId } : {}),
    })) as Record<string, unknown>
    return {
      managementSessionId: "",
      agentId: "",
      teamId: "",
      manager: false,
      workspaceRoot: String(opened.workspace_root || explicitWorkspace),
      runtimeSessionId: String(opened.session_id || runtimeSessionId || ""),
      session: opened,
    }
  }

  const active = await ensureManagementConnected({ start: true })
  if (!runtimeSessionId && params.resumeLatest === true) {
    const history = await listManagedSessionsLocal(
      manager
        ? { manager: true }
        : {
            ...(teamId ? { teamId } : {}),
            ...(agentId ? { agentId } : {}),
          },
    ).catch(() => ({ sessions: [] }))
    runtimeSessionId = String(history?.sessions?.[0]?.runtimeSessionId || "")
  }
  // Attach with shared: false without runtimeSessionId first so sessionTools resolves
  // synchronously in agent-management without spawning executionHost().
  const attached = await active.request("attachSession", {
    ...(agentId ? { agentId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(manager ? { manager: true } : {}),
    shared: false,
  })
  const externalTools = (await active.request("sessionTools", { sessionId: attached.id })) as Record<string, unknown>
  const snap = (await active.request("snapshot")) as AgentsSnapshot
  acceptSnapshot(snap)

  const { managementPaths } = await loadManagementModule()
  const agentRecord = snap.agents.find((a) => a.id === attached.agentId)
  const workspaceRoot = String(
    agentRecord?.canonicalWorkspace ||
      (manager ? managementPaths(launchOptions().home).manager : explicitWorkspace),
  )
  if (!workspaceRoot) {
    throw new Error("Could not resolve workspace for this agent.")
  }

  await ensureRuntimeForWorkspace(workspaceRoot)

  // Passing runtimeSessionId opens that conversation; omitting it returns blank_info for a new draft conversation.
  const opened = (await requestRuntime(runtimeMethods.sessionOpen, {
    workspace_root: workspaceRoot,
    ...(runtimeSessionId ? { session_id: runtimeSessionId, external_tools: externalTools } : {}),
  })) as Record<string, unknown>

  const resolvedRuntimeSessionId = String(opened.session_id || runtimeSessionId || "")
  if (resolvedRuntimeSessionId && !attached.runtimeSessionId) {
    await active.request("bindSession", {
      sessionId: attached.id,
      runtimeSessionId: resolvedRuntimeSessionId,
    }).catch(() => {})
    acceptSnapshot(await active.request("snapshot"))
  }

  const attachment: SessionAttachment = {
    managementSessionId: String(attached.id),
    agentId: String(attached.agentId || agentId),
    teamId: String(attached.teamId || teamId),
    manager,
    workspaceRoot,
    runtimeSessionId: resolvedRuntimeSessionId,
    externalTools,
  }
  attachmentsByManagementId.set(attachment.managementSessionId, attachment)
  if (resolvedRuntimeSessionId) {
    attachmentsByRuntimeId.set(resolvedRuntimeSessionId, attachment)
  }

  return {
    managementSessionId: attachment.managementSessionId,
    agentId: attachment.agentId,
    teamId: attachment.teamId,
    manager: attachment.manager,
    workspaceRoot: attachment.workspaceRoot,
    runtimeSessionId: resolvedRuntimeSessionId,
    session: opened,
  }
}

export async function createAgentSession(params: Record<string, unknown>) {
  const managementSessionId = typeof params.management_session_id === "string"
    ? params.management_session_id.trim()
    : typeof params.managementSessionId === "string"
      ? params.managementSessionId.trim()
      : ""
  const manager = params.manager === true
  const teamId = typeof params.team_id === "string"
    ? params.team_id.trim()
    : typeof params.teamId === "string"
      ? params.teamId.trim()
      : ""
  const agentId = typeof params.agent_id === "string"
    ? params.agent_id.trim()
    : typeof params.agentId === "string"
      ? params.agentId.trim()
      : ""

  let attachment = managementSessionId ? attachmentsByManagementId.get(managementSessionId) : undefined

  if (!attachment && (manager || teamId || agentId)) {
    const opened = await openAgentSession({ teamId, agentId, manager, workspace: params.workspace_root })
    attachment = attachmentsByManagementId.get(opened.managementSessionId)
  }

  // If the previous session on this attachment already bound or was deleted, attach a fresh management session.
  if (attachment && attachment.runtimeSessionId) {
    const active = await ensureManagementConnected({ start: true })
    const replacement = await active.request("attachSession", {
      ...(attachment.agentId && !attachment.manager ? { agentId: attachment.agentId } : {}),
      ...(attachment.teamId ? { teamId: attachment.teamId } : {}),
      ...(attachment.manager ? { manager: true } : {}),
      shared: false,
    })
    const tools = (await active.request("sessionTools", { sessionId: replacement.id })) as Record<string, unknown>
    attachment = {
      ...attachment,
      managementSessionId: String(replacement.id),
      runtimeSessionId: "",
      externalTools: tools,
    }
    attachmentsByManagementId.set(attachment.managementSessionId, attachment)
  }

  const workspaceRoot = String(
    attachment?.workspaceRoot ||
      (typeof params.workspace_root === "string" ? params.workspace_root.trim() : ""),
  )
  await ensureRuntimeForWorkspace(workspaceRoot || undefined)

  const createParams: Record<string, unknown> = {
    ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
    ...(typeof params.provider_id === "string" && params.provider_id ? { provider_id: params.provider_id } : {}),
    ...(typeof params.model_id === "string" && params.model_id ? { model_id: params.model_id } : {}),
    ...(typeof params.reasoning_effort === "string" && params.reasoning_effort ? { reasoning_effort: params.reasoning_effort } : {}),
    ...(typeof params.name === "string" && params.name ? { name: params.name } : {}),
    ...(params.skill_sources && typeof params.skill_sources === "object" ? { skill_sources: params.skill_sources } : {}),
    ...(typeof params.session_id === "string" && params.session_id ? { session_id: params.session_id } : {}),
    ...(attachment ? { external_tools: attachment.externalTools } : {}),
  }

  const created = (await requestRuntime(runtimeMethods.sessionCreate, createParams)) as Record<string, unknown>
  const runtimeSessionId = String(created.session_id || "")

  if (attachment && runtimeSessionId) {
    attachment.runtimeSessionId = runtimeSessionId
    attachmentsByRuntimeId.set(runtimeSessionId, attachment)
    const active = await ensureManagementConnected({ start: true })
    await active.request("bindSession", {
      sessionId: attachment.managementSessionId,
      runtimeSessionId,
    })
    acceptSnapshot(await active.request("snapshot"))
  }

  return {
    ...created,
    ...(attachment
      ? {
          managementSessionId: attachment.managementSessionId,
          agentId: attachment.agentId,
          teamId: attachment.teamId,
          manager: attachment.manager,
        }
      : {}),
  }
}

export async function enrichSessionReplayParams(
  sessionId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!sessionId || params.external_tools) return params
  const existing = attachmentsByRuntimeId.get(sessionId)
  if (existing) {
    return { ...params, external_tools: existing.externalTools }
  }
  const managedSession = currentSnapshot.sessions.find((s) => s.runtimeSessionId === sessionId)
  if (!managedSession || !client) return params
  try {
    const agent = currentSnapshot.agents.find((a) => a.id === managedSession.agentId)
    const { managementPaths } = await loadManagementModule()
    const managerFolder = managementPaths(launchOptions().home).manager.toLowerCase()
    const isManager =
      typeof agent?.canonicalWorkspace === "string" &&
      agent.canonicalWorkspace.toLowerCase() === managerFolder
    const attached = await client.request("attachSession", {
      agentId: isManager ? undefined : managedSession.agentId,
      teamId: managedSession.teamId || undefined,
      manager: isManager,
      shared: false,
    })
    const externalTools = (await client.request("sessionTools", { sessionId: attached.id })) as Record<string, unknown>
    await client.request("bindSession", {
      sessionId: attached.id,
      runtimeSessionId: sessionId,
    }).catch(() => {})
    const attachment: SessionAttachment = {
      managementSessionId: String(attached.id),
      agentId: String(managedSession.agentId || ""),
      teamId: String(managedSession.teamId || ""),
      manager: isManager,
      workspaceRoot: String(agent?.canonicalWorkspace || ""),
      runtimeSessionId: sessionId,
      externalTools,
    }
    attachmentsByManagementId.set(attachment.managementSessionId, attachment)
    attachmentsByRuntimeId.set(sessionId, attachment)
    return { ...params, external_tools: externalTools }
  } catch {
    return params
  }
}

export async function forwardControlToSharedRuntimeIfNeeded(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown | undefined> {
  if (Boolean(process.versions.electron) && !process.env.RIND_RUNTIME_PATH) return undefined
  const sessionId = typeof params.session_id === "string" ? params.session_id : ""
  if (!sessionId) return undefined
  const isLiveInShared =
    Array.isArray(currentSnapshot.live) &&
    currentSnapshot.live.some((item) => item.id === sessionId && item.turn !== "idle")
  if (!isLiveInShared && !sharedObserver) return undefined
  await ensureSharedObserver()
  if (!sharedObserver) return undefined
  return sharedObserver.request(method, params)
}

export function subscribeManagement(listener: (payload: ManagementStatePayload) => void): () => void {
  stateListeners.add(listener)
  listener(getManagementState())
  if (!client && !connecting && !explicitlyStopped) {
    void ensureManagementConnected({ start: true }).catch(() => {})
  }
  return () => {
    stateListeners.delete(listener)
  }
}

export function subscribeSharedRuntimeEvents(listener: (event: RuntimeEvent) => void): () => void {
  sharedEventListeners.add(listener)
  return () => {
    sharedEventListeners.delete(listener)
  }
}

export async function isManagedWorkspacePath(targetPath: string): Promise<boolean> {
  if (!targetPath) return false
  const normalizedTarget = resolve(targetPath).toLowerCase()
  for (const agent of currentSnapshot.agents) {
    if (
      typeof agent.canonicalWorkspace === "string" &&
      resolve(agent.canonicalWorkspace).toLowerCase() === normalizedTarget
    ) {
      return true
    }
  }
  for (const attachment of attachmentsByManagementId.values()) {
    if (
      attachment.workspaceRoot &&
      resolve(attachment.workspaceRoot).toLowerCase() === normalizedTarget
    ) {
      return true
    }
  }
  try {
    const { managementPaths } = await loadManagementModule()
    const paths = managementPaths(launchOptions().home)
    const managerPath = resolve(paths.manager).toLowerCase()
    const workspacesRoot = resolve(paths.workspaces).toLowerCase()
    if (normalizedTarget === managerPath || normalizedTarget.startsWith(`${workspacesRoot}\\`) || normalizedTarget.startsWith(`${workspacesRoot}/`)) {
      return true
    }
  } catch {
    // Ignore errors when resolving management paths.
  }
  return false
}

export async function closeManagement(): Promise<void> {
  closing = true
  const current = client
  client = undefined
  if (current) {
    for (const attachment of attachmentsByManagementId.values()) {
      await current.request("detachSession", { sessionId: attachment.managementSessionId }).catch(() => {})
    }
    current.close()
  }
  attachmentsByManagementId.clear()
  attachmentsByRuntimeId.clear()
  sharedObserver?.close()
  sharedObserver = undefined
}
