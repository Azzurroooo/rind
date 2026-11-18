import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRindHome } from "../client/local-files.js";
import { connectSharedRuntime, type SharedRuntimeConnection } from "../client/shared-runtime.js";
import { runtimeMethods } from "../protocol/runtime-protocol.js";
import { readRawSessionIndexEntries } from "./workspaces.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(currentDir, "../../..");

export interface AgentsSnapshot {
  seq: number;
  teams: Array<Record<string, any>>;
  memberships: Array<Record<string, any>>;
  agents: Array<Record<string, any>>;
  tasks: Array<Record<string, any>>;
  runs: Array<Record<string, any>>;
  sessions: Array<Record<string, any>>;
  connectedSessions: string[];
  live: Array<Record<string, any>>;
  folderDefaultsVersion: number;
  notices: Array<Record<string, any>>;
  approvals: Array<Record<string, any>>;
  notes: Array<Record<string, any>>;
  artifacts: Array<Record<string, any>>;
}

export interface ManagementStatePayload {
  snapshot: AgentsSnapshot;
  connection: "connecting" | "connected" | "reconnecting" | "stopped" | "offline";
  service: Record<string, unknown> | null;
  error?: string;
}

export interface ManagementBridge {
  getManagementState(): ManagementStatePayload;
  ensureManagementConnected(options?: { start?: boolean }): Promise<any>;
  requestManagement(method: string, params?: Record<string, unknown>): Promise<unknown>;
  openAgentSession(params?: Record<string, unknown>): Promise<any>;
  createAgentSession(params?: Record<string, unknown>): Promise<any>;
  enrichSessionReplayParams(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  forwardControlToSharedRuntimeIfNeeded(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown | undefined>;
  subscribeManagement(listener: (payload: ManagementStatePayload) => void): () => void;
  subscribeSharedRuntimeEvents(listener: (event: any) => void): () => void;
  isManagedWorkspacePath(targetPath: string): Promise<boolean>;
  closeManagement(): Promise<void>;
}

interface SessionAttachment {
  managementSessionId: string;
  agentId: string;
  teamId: string;
  manager: boolean;
  workspaceRoot: string;
  runtimeSessionId: string;
  externalTools: unknown;
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
    notes: [],
    artifacts: [],
  };
}

function normalizeWorkspaceKey(target: unknown): string {
  if (typeof target !== "string" || !target.trim()) return "";
  const resolved = resolve(target.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readSessionIndexEntries(rindHome: string) {
  const entries = await readRawSessionIndexEntries(join(rindHome, "session_index.json"));
  return entries.map((entry) => ({
    session_id: entry.id,
    title: entry.title,
    updated_at: entry.updatedAt,
    workspace_root: entry.workspaceRoot,
    message_count: entry.messageCount,
    last_model: entry.lastModel,
    last_user_message: entry.preview,
  }));
}

async function tailFile(filePath: string, maxBytes = 16384): Promise<string[]> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    return (size > maxBytes ? lines.slice(1) : lines).slice(-80);
  } catch {
    return ["No log yet."];
  } finally {
    await handle?.close();
  }
}

async function previewArtifactFile(
  filePath: string,
  maxBytes = 256 * 1024,
): Promise<{ binary?: boolean; content?: string; truncated?: boolean }> {
  try {
    const data = await readFile(filePath);
    if (data.includes(0)) return { binary: true };
    if (data.length > maxBytes) {
      return { content: data.subarray(0, maxBytes).toString("utf8"), truncated: true };
    }
    return { content: data.toString("utf8"), truncated: false };
  } catch {
    return {};
  }
}

export function createManagementBridge({
  getRindHome = () => resolveRindHome(process.env.RIND_HOME),
  repoRoot = defaultRepoRoot,
  getRuntimePath = () => process.env.RIND_RUNTIME_PATH || "",
  requestRuntime,
  ensureRuntimeForWorkspace = async () => {},
  isSharedRuntime = () => true,
  allowSharedObserver = false,
  autoStartOnGetState = false,
}: {
  getRindHome?: () => string;
  repoRoot?: string;
  getRuntimePath?: () => string;
  requestRuntime?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  ensureRuntimeForWorkspace?: (workspaceRoot?: string) => Promise<void>;
  isSharedRuntime?: () => boolean;
  allowSharedObserver?: boolean;
  autoStartOnGetState?: boolean;
} = {}): ManagementBridge {
  let managementModulePromise: Promise<any> | undefined;

  function loadManagementModule(): Promise<any> {
    if (!managementModulePromise) {
      const clientUrl = pathToFileURL(join(repoRoot, "agent-management", "dist", "client.js")).href;
      managementModulePromise = import(/* @vite-ignore */ clientUrl).catch((error) => {
        managementModulePromise = undefined;
        throw error;
      });
    }
    return managementModulePromise;
  }

  let client: any;
  let connecting: Promise<any> | undefined;
  let currentSnapshot: AgentsSnapshot = emptyAgentsSnapshot();
  let connectionStatus: ManagementStatePayload["connection"] = "connecting";
  let serviceInfo: Record<string, unknown> | null = null;
  let lastError = "";
  let explicitlyStopped = false;
  let closing = false;

  const stateListeners = new Set<(payload: ManagementStatePayload) => void>();
  const sharedEventListeners = new Set<(event: any) => void>();
  const attachmentsByManagementId = new Map<string, SessionAttachment>();
  const attachmentsByRuntimeId = new Map<string, SessionAttachment>();

  let sharedObserver: SharedRuntimeConnection | undefined;
  let sharedObserverConnecting: Promise<void> | undefined;
  let sharedSequence = 0;

  function launchOptions() {
    const home = getRindHome();
    const runtimePath = getRuntimePath();
    return { home, repoRoot, runtimePath };
  }

  function getManagementState(): ManagementStatePayload {
    return {
      snapshot: currentSnapshot,
      connection: connectionStatus,
      service: serviceInfo,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  function broadcastState(): void {
    const payload = getManagementState();
    for (const listener of stateListeners) {
      try {
        listener(payload);
      } catch {
        // Ignore individual subscriber errors.
      }
    }
  }

  function acceptSnapshot(next: unknown): void {
    if (!next || typeof next !== "object") return;
    currentSnapshot = {
      ...emptyAgentsSnapshot(),
      ...(next as Partial<AgentsSnapshot>),
    };
    broadcastState();
    const hasLiveOrRunning =
      (Array.isArray(currentSnapshot.live) && currentSnapshot.live.length > 0) ||
      (Array.isArray(currentSnapshot.runs) &&
        currentSnapshot.runs.some((r) => r.status === "starting" || r.status === "running"));
    if (
      allowSharedObserver &&
      hasLiveOrRunning &&
      !sharedObserver &&
      !sharedObserverConnecting &&
      !closing
    ) {
      void ensureSharedObserver();
    }
  }

  async function ensureSharedObserver(): Promise<void> {
    if (!allowSharedObserver || isSharedRuntime()) return;
    if (sharedObserver || sharedObserverConnecting || closing) return sharedObserverConnecting;
    sharedObserverConnecting = (async () => {
      try {
        const opts = launchOptions();
        const conn = await connectSharedRuntime({
          rindHome: opts.home,
          start: false,
          onMessage(message) {
            if (!message || message.kind === "runtime") return;
            const inner = message.event;
            if (!inner || typeof inner !== "object" || typeof message.session_id !== "string") {
              return;
            }
            const type = String((inner as Record<string, unknown>).type || "");
            if (!type) return;
            const runtimeEvent = {
              type,
              sequence: Number.isInteger(message.sequence)
                ? (message.sequence as number)
                : ++sharedSequence,
              durability: message.durability === "durable" ? "durable" : "incremental",
              sessionId: message.session_id,
              turnId: String(message.turn_id || ""),
              event: inner,
            };
            for (const listener of sharedEventListeners) {
              try {
                listener(runtimeEvent);
              } catch {
                // Ignore listener errors.
              }
            }
          },
          onDisconnect() {
            sharedObserver = undefined;
          },
        });
        if (closing) {
          conn.close();
          return;
        }
        await conn.request("runtime/observe").catch(() => {});
        sharedObserver = conn;
      } catch {
        // Shared Runtime is not running yet; it will be observed when started.
      } finally {
        sharedObserverConnecting = undefined;
      }
    })();
    return sharedObserverConnecting;
  }

  async function listManagedSessionsLocal(params: Record<string, unknown> = {}) {
    const opts = launchOptions();
    const { managementPaths } = await loadManagementModule();
    const managerWorkspace = managementPaths(opts.home).manager;
    const runtimeSessions = await readSessionIndexEntries(opts.home);
    const snapshot = currentSnapshot;

    const byWorkspace = new Map<string, Record<string, any>>();
    const byAgent = new Map<string, Record<string, any>>();
    for (const agent of snapshot.agents) {
      byWorkspace.set(normalizeWorkspaceKey(agent.canonicalWorkspace), agent);
      if (typeof agent.id === "string") byAgent.set(agent.id, agent);
    }
    const byTeam = new Map<string, Record<string, any>>();
    for (const team of snapshot.teams) {
      if (typeof team.id === "string") byTeam.set(team.id, team);
    }
    const sessionById = new Map<string, Record<string, any>>();
    const byRuntimeSession = new Map<string, Record<string, any>>();
    const connected = new Set(snapshot.connectedSessions || []);
    for (const session of snapshot.sessions) {
      if (typeof session.id === "string") sessionById.set(session.id, session);
      const rId = typeof session.runtimeSessionId === "string" ? session.runtimeSessionId : "";
      if (!rId) continue;
      const prev = byRuntimeSession.get(rId);
      if (
        !prev ||
        (connected.has(String(session.id)) && !connected.has(String(prev.id))) ||
        String(session.lastActivity || "") > String(prev.lastActivity || "")
      ) {
        byRuntimeSession.set(rId, session);
      }
    }
    const runningBySession = new Set(
      (snapshot.runs || [])
        .filter((run) => run.status === "starting" || run.status === "running")
        .map((run) => String(sessionById.get(String(run.sessionId || ""))?.runtimeSessionId || ""))
        .filter(Boolean),
    );
    const liveBySession = new Map<string, Record<string, any>>();
    for (const item of snapshot.live || []) {
      if (typeof item.id === "string") liveBySession.set(item.id, item);
    }
    const managerKey = normalizeWorkspaceKey(managerWorkspace);

    const sessions = runtimeSessions
      .map((item) => {
        const runtimeSessionId = String(item.session_id || "");
        const record = byRuntimeSession.get(runtimeSessionId);
        const agent =
          (record && typeof record.agentId === "string" ? byAgent.get(record.agentId) : undefined) ||
          byWorkspace.get(normalizeWorkspaceKey(item.workspace_root));
        const isManager = Boolean(
          managerKey &&
            normalizeWorkspaceKey(item.workspace_root || agent?.canonicalWorkspace) === managerKey,
        );
        if (!agent && !isManager) return null;
        const memberships = agent
          ? snapshot.memberships.filter((m) => m.agentId === agent.id)
          : [];
        const membership =
          (record?.teamId ? memberships.find((m) => m.teamId === record.teamId) : undefined) ||
          (params.teamId ? memberships.find((m) => m.teamId === params.teamId) : undefined) ||
          memberships[0];
        const team = membership ? byTeam.get(String(membership.teamId || "")) : undefined;
        const live = liveBySession.get(runtimeSessionId);
        const running =
          (live ? live.turn !== "idle" : false) || runningBySession.has(runtimeSessionId);
        const attached = Boolean(
          (live && Number(live.watchers || 0) > 0) ||
            (record && connected.has(String(record.id || ""))),
        );
        const linkedTask = record?.taskId
          ? snapshot.tasks.find((t) => t.id === record.taskId)
          : undefined;
        const resolvedAgentName = isManager ? "Manager" : String(agent?.name || "Member");
        const rawTitle = String(
          item.title || item.last_user_message || linkedTask?.brief || "",
        ).trim();
        const cleanTitle =
          rawTitle &&
          rawTitle !== runtimeSessionId &&
          rawTitle.toLowerCase() !== "new conversation" &&
          rawTitle.toLowerCase() !== "untitled"
            ? rawTitle
            : "";
        return {
          runtimeSessionId,
          title:
            cleanTitle ||
            (record?.taskId
              ? "Task conversation"
              : record?.origin === "managed"
                ? "Managed conversation"
                : `${resolvedAgentName} conversation`),
          updatedAt: String(item.updated_at || record?.lastActivity || ""),
          workspaceRoot: String(
            item.workspace_root || agent?.canonicalWorkspace || managerWorkspace || "",
          ),
          agentId: String(agent?.id || ""),
          agentName: resolvedAgentName,
          teamId: String(team?.id || record?.teamId || ""),
          teamName: String(team?.name || ""),
          roleTitle: isManager ? "Manager" : String(membership?.position || ""),
          manager: isManager,
          attached,
          running,
          status: running ? "working" : attached ? "open" : "idle",
          messageCount: Number(item.message_count || 0),
          model: String(item.last_model || ""),
          lastActivity: String(item.last_user_message || ""),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => (params.manager ? item.manager : true))
      .filter((item) => (params.agentId ? item.agentId === params.agentId : true))
      .filter((item) => (params.teamId ? item.teamId === params.teamId : true))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    return { sessions };
  }

  function ensureManagementConnected({ start = true } = {}): Promise<any> {
    if (client && connectionStatus === "connected") return Promise.resolve(client);
    if (connecting) return connecting;
    if (!start && explicitlyStopped) {
      return Promise.reject(new Error("Agents management is stopped."));
    }
    connectionStatus = client ? "reconnecting" : "connecting";
    lastError = "";
    broadcastState();

    connecting = (async () => {
      const { connectManagement } = await loadManagementModule();
      const opts = launchOptions();
      const connected = await connectManagement({
        ...opts,
        start,
        onSnapshot(snapshot: unknown) {
          if (closing) return;
          acceptSnapshot(snapshot);
        },
        onDisconnect() {
          if (closing) return;
          client = undefined;
          if (explicitlyStopped) {
            connectionStatus = "stopped";
            serviceInfo = null;
            broadcastState();
            return;
          }
          connectionStatus = "reconnecting";
          broadcastState();
          setTimeout(() => {
            if (!closing && !explicitlyStopped && !client) {
              void ensureManagementConnected({ start: false }).catch(() => {
                connectionStatus = "offline";
                broadcastState();
              });
            }
          }, 400).unref?.();
        },
      });
      if (closing) {
        await connected.closeSpawned();
        throw new Error("Management is closing.");
      }
      client = connected;
      explicitlyStopped = false;
      connectionStatus = "connected";
      serviceInfo = connected.service
        ? { ...connected.service, ...(connected.stale ? { stale: connected.stale } : {}) }
        : null;
      const initial = await connected.request("subscribe");
      acceptSnapshot(initial);
      for (const attachment of attachmentsByManagementId.values()) {
        try {
          const reattached = await connected.request("attachSession", {
            agentId: attachment.manager ? undefined : attachment.agentId,
            teamId: attachment.teamId || undefined,
            manager: attachment.manager,
            ...(attachment.runtimeSessionId
              ? { runtimeSessionId: attachment.runtimeSessionId }
              : {}),
            shared: isSharedRuntime(),
          });
          const tools = await connected.request("sessionTools", { sessionId: reattached.id });
          if (attachment.runtimeSessionId && !reattached.runtimeSessionId) {
            await connected
              .request("bindSession", {
                sessionId: reattached.id,
                runtimeSessionId: attachment.runtimeSessionId,
              })
              .catch(() => {});
          }
          attachmentsByManagementId.delete(attachment.managementSessionId);
          attachment.managementSessionId = reattached.id;
          attachment.externalTools = tools;
          attachmentsByManagementId.set(reattached.id, attachment);
        } catch {
          // Ignore stale attachments that can no longer be restored.
        }
      }
      return connected;
    })()
      .catch((error) => {
        connectionStatus = explicitlyStopped ? "stopped" : "offline";
        lastError = (error as Error)?.message || String(error);
        broadcastState();
        throw error;
      })
      .finally(() => {
        connecting = undefined;
      });

    return connecting;
  }

  async function reconcileStaleWorkspaceRuns(
    active: any,
    snap: AgentsSnapshot,
    targetAgentId: string,
    targetWorkspaceRoot: string,
  ): Promise<boolean> {
    const wsKey = normalizeWorkspaceKey(targetWorkspaceRoot);
    const matchingAgentIds = new Set<string>();
    if (targetAgentId) matchingAgentIds.add(targetAgentId);
    for (const agent of snap.agents || []) {
      if (
        typeof agent.id === "string" &&
        wsKey &&
        normalizeWorkspaceKey(agent.canonicalWorkspace) === wsKey
      ) {
        matchingAgentIds.add(agent.id);
      }
    }
    if (matchingAgentIds.size === 0) return false;
    const sessionById = new Map<string, Record<string, any>>();
    for (const session of snap.sessions || []) {
      if (typeof session.id === "string" && matchingAgentIds.has(String(session.agentId || ""))) {
        sessionById.set(session.id, session);
      }
    }
    const liveRunningIds = new Set(
      (snap.live || [])
        .filter((item) => item && typeof item.id === "string" && item.turn && item.turn !== "idle")
        .map((item) => String(item.id)),
    );
    let changed = false;
    for (const run of snap.runs || []) {
      const session = sessionById.get(String(run.sessionId || ""));
      if (!session) continue;
      if (run.status === "unknown" && typeof run.id === "string") {
        await active.request("resolveRun", { runId: run.id, confirmStopped: true }).catch(() => {});
        changed = true;
      } else if (
        !run.taskId &&
        !run.delegationId &&
        (run.status === "running" || run.status === "starting") &&
        typeof run.sessionId === "string"
      ) {
        const rSid = String(session.runtimeSessionId || "");
        if (!rSid || !liveRunningIds.has(rSid)) {
          await active
            .request("reconcileSession", {
              sessionId: run.sessionId,
              connected: true,
              active: false,
              outcome: "failed",
            })
            .catch(() => {});
          changed = true;
        }
      }
    }
    return changed;
  }

  async function resolveManagedAgentByWorkspace(workspaceRoot: string) {
    const wsKey = normalizeWorkspaceKey(workspaceRoot);
    if (!wsKey) return null;
    const managerFolder = normalizeWorkspaceKey(
      join(launchOptions().home, "agents-management", "manager"),
    );
    const agent = currentSnapshot.agents.find(
      (a) => normalizeWorkspaceKey(a.canonicalWorkspace) === wsKey,
    );
    if (
      wsKey === managerFolder ||
      wsKey.replace(/\\/g, "/").endsWith("/agents-management/manager")
    ) {
      return {
        manager: true,
        teamId: "",
        agentId: String(agent?.id || ""),
        workspaceRoot: String(agent?.canonicalWorkspace || workspaceRoot),
      };
    }
    if (!agent) return null;
    const membership = currentSnapshot.memberships.find((m) => m.agentId === agent.id);
    return {
      manager: false,
      teamId: membership ? String(membership.teamId || "") : "",
      agentId: String(agent.id || ""),
      workspaceRoot: String(agent.canonicalWorkspace || workspaceRoot),
    };
  }

  async function openAgentSession(params: Record<string, unknown> = {}) {
    let manager = params.manager === true;
    let teamId = typeof params.teamId === "string" && !manager ? params.teamId.trim() : "";
    let agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    let runtimeSessionId =
      typeof params.runtimeSessionId === "string" ? params.runtimeSessionId.trim() : "";
    const explicitWorkspace = typeof params.workspace === "string" ? params.workspace.trim() : "";

    if (!manager && !teamId && !agentId && explicitWorkspace) {
      const resolvedByWs = await resolveManagedAgentByWorkspace(explicitWorkspace);
      if (resolvedByWs) {
        manager = resolvedByWs.manager;
        teamId = resolvedByWs.teamId;
        agentId = resolvedByWs.agentId;
      }
    }

    if (!manager && !teamId && !agentId && explicitWorkspace && typeof requestRuntime === "function") {
      await ensureRuntimeForWorkspace(explicitWorkspace);
      const opened = await requestRuntime(runtimeMethods.sessionOpen, {
        workspace_root: explicitWorkspace,
        ...(runtimeSessionId ? { session_id: runtimeSessionId } : {}),
      });
      return {
        managementSessionId: "",
        agentId: "",
        teamId: "",
        manager: false,
        workspaceRoot: String(opened?.workspace_root || explicitWorkspace),
        runtimeSessionId: String(opened?.session_id || runtimeSessionId || ""),
        session: opened,
      };
    }

    const active = await ensureManagementConnected({ start: true });
    if (!runtimeSessionId && params.resumeLatest === true) {
      const history = await listManagedSessionsLocal(
        manager
          ? { manager: true }
          : {
              ...(teamId ? { teamId } : {}),
              ...(agentId ? { agentId } : {}),
            },
      ).catch(() => ({ sessions: [] }));
      runtimeSessionId = String(history?.sessions?.[0]?.runtimeSessionId || "");
    }
    const attached = await active.request("attachSession", {
      ...(agentId ? { agentId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(manager ? { manager: true } : {}),
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
      shared: isSharedRuntime(),
    });
    const externalTools = await active
      .request("sessionTools", { sessionId: attached.id })
      .catch(() => null);
    let snap = currentSnapshot;

    const { managementPaths } = await loadManagementModule();
    const agentRecord = snap.agents.find((a) => a.id === attached.agentId);
    const workspaceRoot = String(
      agentRecord?.canonicalWorkspace ||
        (manager ? managementPaths(launchOptions().home).manager : explicitWorkspace),
    );
    if (!workspaceRoot && typeof requestRuntime === "function") {
      throw new Error("Could not resolve workspace for this agent.");
    }

    await reconcileStaleWorkspaceRuns(
      active,
      snap,
      String(attached.agentId || agentId),
      workspaceRoot,
    );

    if (typeof requestRuntime !== "function") {
      if (runtimeSessionId && !attached.runtimeSessionId) {
        await active
          .request("bindSession", {
            sessionId: attached.id,
            runtimeSessionId,
          })
          .catch(() => {});
      }
      const resolvedId = String(runtimeSessionId || attached.runtimeSessionId || "");
      const attachment: SessionAttachment = {
        managementSessionId: String(attached.id),
        agentId: String(attached.agentId || agentId),
        teamId: String(attached.teamId || teamId),
        manager,
        workspaceRoot,
        runtimeSessionId: resolvedId,
        externalTools,
      };
      attachmentsByManagementId.set(attachment.managementSessionId, attachment);
      if (resolvedId) {
        attachmentsByRuntimeId.set(resolvedId, attachment);
      }
      return {
        managementSessionId: attachment.managementSessionId,
        agentId: attachment.agentId,
        teamId: attachment.teamId,
        manager: attachment.manager,
        workspaceRoot: attachment.workspaceRoot,
        runtimeSessionId: resolvedId,
        externalTools: externalTools || null,
      };
    }

    await ensureRuntimeForWorkspace(workspaceRoot);

    const opened = await requestRuntime(runtimeMethods.sessionOpen, {
      workspace_root: workspaceRoot,
      ...(runtimeSessionId ? { session_id: runtimeSessionId, external_tools: externalTools } : {}),
    });

    const resolvedRuntimeSessionId = String(opened?.session_id || runtimeSessionId || "");
    if (resolvedRuntimeSessionId && !attached.runtimeSessionId) {
      await active
        .request("bindSession", {
          sessionId: attached.id,
          runtimeSessionId: resolvedRuntimeSessionId,
        })
        .catch(() => {});
    }

    const attachment: SessionAttachment = {
      managementSessionId: String(attached.id),
      agentId: String(attached.agentId || agentId),
      teamId: String(attached.teamId || teamId),
      manager,
      workspaceRoot,
      runtimeSessionId: resolvedRuntimeSessionId,
      externalTools,
    };
    attachmentsByManagementId.set(attachment.managementSessionId, attachment);
    if (resolvedRuntimeSessionId) {
      attachmentsByRuntimeId.set(resolvedRuntimeSessionId, attachment);
    }

    return {
      managementSessionId: attachment.managementSessionId,
      agentId: attachment.agentId,
      teamId: attachment.teamId,
      manager: attachment.manager,
      workspaceRoot: attachment.workspaceRoot,
      runtimeSessionId: resolvedRuntimeSessionId,
      session: opened,
    };
  }

  async function createAgentSession(params: Record<string, unknown> = {}) {
    if (typeof requestRuntime !== "function") {
      throw new Error("Runtime is not attached to this management host.");
    }
    const managementSessionId =
      typeof params.managementSessionId === "string" ? params.managementSessionId.trim() : "";
    let manager = params.manager === true;
    let teamId = typeof params.teamId === "string" ? params.teamId.trim() : "";
    let agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const requestedWorkspace =
      typeof params.workspace_root === "string" ? params.workspace_root.trim() : "";

    if (!manager && !teamId && !agentId && requestedWorkspace) {
      const resolvedByWs = await resolveManagedAgentByWorkspace(requestedWorkspace);
      if (resolvedByWs) {
        manager = resolvedByWs.manager;
        teamId = resolvedByWs.teamId;
        agentId = resolvedByWs.agentId;
      }
    }

    let attachment = managementSessionId
      ? attachmentsByManagementId.get(managementSessionId)
      : undefined;

    if (!attachment && (manager || teamId || agentId)) {
      const opened = await openAgentSession({
        teamId,
        agentId,
        manager,
        workspace: params.workspace_root,
      });
      attachment = attachmentsByManagementId.get(opened.managementSessionId);
    }

    if (attachment && attachment.runtimeSessionId) {
      const active = await ensureManagementConnected({ start: true });
      const replacement = await active.request("attachSession", {
        ...(attachment.agentId && !attachment.manager ? { agentId: attachment.agentId } : {}),
        ...(attachment.teamId ? { teamId: attachment.teamId } : {}),
        ...(attachment.manager ? { manager: true } : {}),
        shared: false,
      });
      const tools = await active.request("sessionTools", { sessionId: replacement.id });
      attachment = {
        ...attachment,
        managementSessionId: String(replacement.id),
        runtimeSessionId: "",
        externalTools: tools,
      };
      attachmentsByManagementId.set(attachment.managementSessionId, attachment);
    }

    const workspaceRoot = String(attachment?.workspaceRoot || requestedWorkspace);
    if (attachment) {
      const active = await ensureManagementConnected({ start: true });
      await reconcileStaleWorkspaceRuns(active, currentSnapshot, attachment.agentId, workspaceRoot);
    }
    await ensureRuntimeForWorkspace(workspaceRoot || undefined);

    const createParams: Record<string, unknown> = {
      ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
      ...(typeof params.provider_id === "string" && params.provider_id
        ? { provider_id: params.provider_id }
        : {}),
      ...(typeof params.model_id === "string" && params.model_id
        ? { model_id: params.model_id }
        : {}),
      ...(typeof params.reasoning_effort === "string" && params.reasoning_effort
        ? { reasoning_effort: params.reasoning_effort }
        : {}),
      ...(typeof params.name === "string" && params.name ? { name: params.name } : {}),
      ...(params.skill_sources && typeof params.skill_sources === "object"
        ? { skill_sources: params.skill_sources }
        : {}),
      ...(typeof params.session_id === "string" && params.session_id
        ? { session_id: params.session_id }
        : {}),
      ...(attachment ? { external_tools: attachment.externalTools } : {}),
    };

    const created = await requestRuntime(runtimeMethods.sessionCreate, createParams);
    const runtimeSessionId = String(created?.session_id || "");

    if (attachment && runtimeSessionId) {
      attachment.runtimeSessionId = runtimeSessionId;
      attachmentsByRuntimeId.set(runtimeSessionId, attachment);
      const active = await ensureManagementConnected({ start: true });
      await active.request("bindSession", {
        sessionId: attachment.managementSessionId,
        runtimeSessionId,
      });
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
    };
  }

  function hasInitializedManagementState(): boolean {
    return existsSync(join(getRindHome(), "agents-management", "state", "user-token"));
  }

  async function requestManagement(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (method === "getState") {
      if (!client && !explicitlyStopped) {
        await ensureManagementConnected({
          start: autoStartOnGetState || hasInitializedManagementState(),
        }).catch(() => {});
      }
      return getManagementState();
    }
    if (method === "reconnect") {
      explicitlyStopped = false;
      await ensureManagementConnected({ start: true });
      return getManagementState();
    }
    if (method === "serviceLog") {
      const { managementPaths } = await loadManagementModule();
      const paths = managementPaths(launchOptions().home);
      const isRuntime = params.target === "runtime";
      const logPath = isRuntime
        ? join(dirname(paths.root), "runtime", "runtime.log")
        : join(paths.state, "service.log");
      return { path: logPath, lines: await tailFile(logPath) };
    }
    if (method === "listSessions") {
      if (!client && !explicitlyStopped) {
        await ensureManagementConnected({
          start: autoStartOnGetState || hasInitializedManagementState(),
        }).catch(() => {});
      }
      return listManagedSessionsLocal(params);
    }
    if (method === "openSession") {
      return openAgentSession(params);
    }
    if (method === "createSession") {
      return createAgentSession(params);
    }
    if (method === "deleteSession") {
      const active = await ensureManagementConnected({ start: true });
      let runtimeSessionId =
        typeof params.runtimeSessionId === "string" ? params.runtimeSessionId.trim() : "";
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      const matchedRecords = currentSnapshot.sessions.filter(
        (s) =>
          (sessionId && s.id === sessionId) ||
          (runtimeSessionId && s.runtimeSessionId === runtimeSessionId),
      );
      if (
        !runtimeSessionId &&
        matchedRecords[0] &&
        typeof matchedRecords[0].runtimeSessionId === "string"
      ) {
        runtimeSessionId = matchedRecords[0].runtimeSessionId.trim();
      }
      if (!runtimeSessionId) throw new Error("runtimeSessionId or sessionId is required.");
      const attachment = attachmentsByRuntimeId.get(runtimeSessionId);
      if (attachment) {
        attachmentsByRuntimeId.delete(runtimeSessionId);
        attachmentsByManagementId.delete(attachment.managementSessionId);
        await active
          .request("detachSession", { sessionId: attachment.managementSessionId })
          .catch(() => {});
      }
      if (typeof requestRuntime === "function") {
        await ensureRuntimeForWorkspace();
        await requestRuntime(runtimeMethods.sessionDelete, { session_id: runtimeSessionId });
        for (const rec of matchedRecords) {
          if (typeof rec.id === "string" && rec.id) {
            await active.request("forgetSession", { sessionId: rec.id }).catch(() => {});
          }
        }
      } else {
        await active.request("deleteSession", { runtimeSessionId });
      }
      return { deleted: true, runtimeSessionId };
    }
    if (method === "renameSession") {
      if (typeof requestRuntime !== "function") {
        throw new Error("Runtime is not attached to this management host.");
      }
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!sessionId) throw new Error("sessionId is required.");
      await ensureRuntimeForWorkspace();
      const input = name ? `/rename ${name}` : "/rename --reset";
      const result = await requestRuntime(runtimeMethods.commandExecute, {
        session_id: sessionId,
        input,
      });
      const display = result?.display;
      if (display?.type !== "session_renamed") {
        throw new Error(String(result?.text || "Could not rename this conversation."));
      }
      return display;
    }
    if (method === "restartService") {
      const active = await ensureManagementConnected({ start: true });
      explicitlyStopped = true;
      try {
        await active.request("serviceShutdown", { restart: true });
      } catch (error) {
        explicitlyStopped = false;
        throw error;
      }
      client?.close();
      client = undefined;
      await new Promise((r) => setTimeout(r, 250));
      explicitlyStopped = false;
      await ensureManagementConnected({ start: true });
      return getManagementState();
    }
    if (method === "stopServices") {
      const stopAgents = Boolean(params.stopAgents);
      const active = await ensureManagementConnected({ start: false }).catch(() => null);
      if (!active) {
        explicitlyStopped = true;
        connectionStatus = "stopped";
        serviceInfo = null;
        broadcastState();
        return { stopped: true, working: 0 };
      }
      explicitlyStopped = true;
      try {
        const result = await active.request("serviceShutdown", { stopAgents });
        client?.close();
        client = undefined;
        connectionStatus = "stopped";
        serviceInfo = null;
        if (stopAgents) {
          currentSnapshot = { ...currentSnapshot, runs: [] };
        }
        broadcastState();
        return { stopped: true, ...result };
      } catch (error) {
        explicitlyStopped = false;
        throw error;
      }
    }

    const active = await ensureManagementConnected({ start: true });
    if (method === "readArtifactPreview" || method === "readArtifact") {
      const artifact = await active.request("readArtifact", { artifactId: params.artifactId });
      if (artifact?.path && typeof artifact.path === "string") {
        const preview = await previewArtifactFile(artifact.path);
        return { ...artifact, ...preview };
      }
      return artifact;
    }

    const result = await active.request(method, params);
    if (method === "serviceInfo" && result && typeof result === "object") {
      serviceInfo = { ...result, ...(active.stale ? { stale: active.stale } : {}) };
      broadcastState();
    }
    return result;
  }

  async function enrichSessionReplayParams(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!sessionId || params.external_tools) return params;
    const existing = attachmentsByRuntimeId.get(sessionId);
    if (existing) {
      return { ...params, external_tools: existing.externalTools };
    }
    const managedSession = [...currentSnapshot.sessions]
      .reverse()
      .find((s) => s.runtimeSessionId === sessionId);
    if (!managedSession || !client) return params;
    try {
      const agent = currentSnapshot.agents.find((a) => a.id === managedSession.agentId);
      const { managementPaths } = await loadManagementModule();
      const managerFolder = managementPaths(launchOptions().home).manager.toLowerCase();
      const isManager =
        typeof agent?.canonicalWorkspace === "string" &&
        agent.canonicalWorkspace.toLowerCase() === managerFolder;
      const workspaceRoot = String(
        agent?.canonicalWorkspace || managedSession.workspaceRoot || "",
      );
      if (workspaceRoot) {
        await reconcileStaleWorkspaceRuns(
          client,
          currentSnapshot,
          String(managedSession.agentId || ""),
          workspaceRoot,
        );
      }
      const attached = await client.request("attachSession", {
        agentId: isManager ? undefined : managedSession.agentId,
        teamId: managedSession.teamId || undefined,
        manager: isManager,
        runtimeSessionId: sessionId,
        shared: false,
      });
      const externalTools = await client.request("sessionTools", { sessionId: attached.id });
      if (!attached.runtimeSessionId) {
        await client
          .request("bindSession", {
            sessionId: attached.id,
            runtimeSessionId: sessionId,
          })
          .catch(() => {});
      }
      const attachment: SessionAttachment = {
        managementSessionId: String(attached.id),
        agentId: String(managedSession.agentId || ""),
        teamId: String(managedSession.teamId || ""),
        manager: isManager,
        workspaceRoot,
        runtimeSessionId: sessionId,
        externalTools,
      };
      attachmentsByManagementId.set(attachment.managementSessionId, attachment);
      attachmentsByRuntimeId.set(sessionId, attachment);
      return { ...params, external_tools: externalTools };
    } catch {
      return params;
    }
  }

  async function forwardControlToSharedRuntimeIfNeeded(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown | undefined> {
    if (!allowSharedObserver || isSharedRuntime()) return undefined;
    const sessionId = typeof params.session_id === "string" ? params.session_id : "";
    if (!sessionId) return undefined;
    const isLiveInShared =
      Array.isArray(currentSnapshot.live) &&
      currentSnapshot.live.some((item) => item.id === sessionId && item.turn !== "idle");
    if (!isLiveInShared && !sharedObserver) return undefined;
    await ensureSharedObserver();
    if (!sharedObserver) return undefined;
    return sharedObserver.request(method, params);
  }

  function subscribeManagement(listener: (payload: ManagementStatePayload) => void): () => void {
    stateListeners.add(listener);
    listener(getManagementState());
    if (!client && !connecting && !explicitlyStopped) {
      void ensureManagementConnected({ start: true }).catch(() => {});
    }
    return () => {
      stateListeners.delete(listener);
    };
  }

  function subscribeSharedRuntimeEvents(listener: (event: any) => void): () => void {
    sharedEventListeners.add(listener);
    return () => {
      sharedEventListeners.delete(listener);
    };
  }

  let cachedAgentRootsSnapshot: AgentsSnapshot | null = null;
  let cachedAgentRoots = new Set<string>();
  let cachedMgmtPathsHome = "";
  let cachedMgmtPaths: { managerPath: string; workspacesRoot: string } | null = null;

  async function isManagedWorkspacePath(targetPath: string): Promise<boolean> {
    if (!targetPath) return false;
    const normalizedTarget = resolve(targetPath).toLowerCase();
    if (cachedAgentRootsSnapshot !== currentSnapshot) {
      cachedAgentRootsSnapshot = currentSnapshot;
      cachedAgentRoots = new Set(
        currentSnapshot.agents
          .filter(
            (agent) => typeof agent.canonicalWorkspace === "string" && agent.canonicalWorkspace,
          )
          .map((agent) => resolve(agent.canonicalWorkspace).toLowerCase()),
      );
    }
    if (cachedAgentRoots.has(normalizedTarget)) return true;
    for (const attachment of attachmentsByManagementId.values()) {
      if (
        attachment.workspaceRoot &&
        resolve(attachment.workspaceRoot).toLowerCase() === normalizedTarget
      ) {
        return true;
      }
    }
    try {
      const home = launchOptions().home;
      if (!cachedMgmtPaths || cachedMgmtPathsHome !== home) {
        const { managementPaths } = await loadManagementModule();
        const paths = managementPaths(home);
        cachedMgmtPathsHome = home;
        cachedMgmtPaths = {
          managerPath: resolve(paths.manager).toLowerCase(),
          workspacesRoot: resolve(paths.workspaces).toLowerCase(),
        };
      }
      if (
        normalizedTarget === cachedMgmtPaths.managerPath ||
        normalizedTarget.startsWith(`${cachedMgmtPaths.workspacesRoot}\\`) ||
        normalizedTarget.startsWith(`${cachedMgmtPaths.workspacesRoot}/`)
      ) {
        return true;
      }
    } catch {
      // Ignore errors when resolving management paths.
    }
    return false;
  }

  async function closeManagement(): Promise<void> {
    closing = true;
    await Promise.allSettled([connecting, sharedObserverConnecting]);
    const current = client;
    client = undefined;
    if (current) {
      for (const attachment of attachmentsByManagementId.values()) {
        await current
          .request("detachSession", { sessionId: attachment.managementSessionId })
          .catch(() => {});
      }
      current.close();
    }
    attachmentsByManagementId.clear();
    attachmentsByRuntimeId.clear();
    sharedObserver?.close();
    sharedObserver = undefined;
  }

  return {
    getManagementState,
    ensureManagementConnected,
    requestManagement,
    openAgentSession,
    createAgentSession,
    enrichSessionReplayParams,
    forwardControlToSharedRuntimeIfNeeded,
    subscribeManagement,
    subscribeSharedRuntimeEvents,
    isManagedWorkspacePath,
    closeManagement,
  };
}
