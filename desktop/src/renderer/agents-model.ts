// Pure data projection, hierarchy builder, session history merger, action-first
// task grouping, inbox triage builder, and HTML renderers for Rind Desktop's
// native Team Agents Management workbench.

import { escapeAttribute, escapeHtml } from "./app/html.ts"
import { renderCustomSelectHtml } from "./custom-select.ts"

export type AgentsSnapshotData = {
  seq: number
  teams: Array<Record<string, any>>
  memberships: Array<Record<string, any>>
  agents: Array<Record<string, any>>
  tasks: Array<Record<string, any>>
  runs: Array<Record<string, any>>
  sessions: Array<Record<string, any>>
  connectedSessions: string[]
  live: Array<Record<string, any>>
  folderDefaultsVersion: number
  notices: Array<Record<string, any>>
  approvals: Array<Record<string, any>>
  archivedTeams: Array<Record<string, any>>
  notes: Array<Record<string, any>>
  artifacts: Array<Record<string, any>>
}

export type StatusTone = "working" | "attention" | "waiting" | "completed" | "idle"
export type TaskSectionKey = "needs" | "working" | "queued" | "delegated" | "done" | "cancelled"

export const STATUS_META: Record<string, { dot: string; tone: StatusTone; label: string }> = {
  Working: { dot: "●", tone: "working", label: "Working" },
  "Running job": { dot: "◐", tone: "working", label: "Running job" },
  "Needs input": { dot: "!", tone: "attention", label: "Needs input" },
  Unconfirmed: { dot: "?", tone: "attention", label: "Unconfirmed" },
  Delegated: { dot: "↗", tone: "waiting", label: "Delegated" },
  Queued: { dot: "…", tone: "waiting", label: "Queued" },
  Open: { dot: "○", tone: "completed", label: "Open" },
  Idle: { dot: "·", tone: "idle", label: "Idle" },
}

export type MemberSessionSummary = {
  runtimeSessionId: string
  managementSessionId: string
  teamId?: string
  agentId?: string
  agentName?: string
  position?: string
  workspaceRoot: string
  origin: string
  taskId: string
  title: string
  updatedAt: string
  createdAt: string
  model: string
  status: string
  tone: StatusTone
  connected: boolean
  live: Record<string, any> | null
}

export type OrgMemberSummary = {
  agentId: string
  teamId: string
  name: string
  canonicalWorkspace: string
  adapter: string
  worktreeOf: string
  position: string
  responsibility: string
  reportsToAgentId: string
  reportsToName: string
  isLeader: boolean
  status: string
  tone: StatusTone
  activeTask: Record<string, any> | null
  latestRuntimeSessionId: string
  sessions: MemberSessionSummary[]
  sessionCount: number
  taskCounts: {
    active: number
    attention: number
    done: number
  }
  children: OrgMemberSummary[]
}

export type TeamSummary = {
  team: {
    id: string
    name: string
    leaderAgentId: string
    createRoot: string
  }
  leader: OrgMemberSummary | null
  members: OrgMemberSummary[]
  orgRoots: OrgMemberSummary[]
  sessionsByAgent: Map<string, MemberSessionSummary[]>
  counts: {
    members: number
    working: number
    attention: number
    tasksTotal: number
    tasksQueued: number
    tasksInProgress: number
    tasksAttention: number
    tasksCompleted: number
  }
}

export type EnrichedTask = Record<string, any> & {
  id: string
  teamId: string
  teamName: string
  assigneeAgentId: string
  assigneeName: string
  assigneePosition: string
  brief: string
  priority: "high" | "normal" | "low"
  section: TaskSectionKey
  tone: StatusTone
  statusLabel: string
  notes: Array<Record<string, any>>
  artifactRecords: Array<Record<string, any>>
  runs: Array<Record<string, any>>
  activeRun: Record<string, any> | null
  runtimeSessionId: string
  parentTask: Record<string, any> | null
  childTasks: Array<Record<string, any>>
}

export type InboxItem = {
  id: string
  section: "needsYou" | "notices" | "delivered"
  kind: "approval" | "blocker" | "attention" | "delivery" | "unconfirmed_run" | "notice"
  tone: StatusTone
  badge: string
  title: string
  subtitle: string
  detail?: string
  teamId?: string
  agentId?: string
  taskId?: string
  runId?: string
  approvalId?: string
  noticeId?: string
  createdAt?: string
  raw?: any
}

export type SessionAgentContext =
  | { kind: "independent" }
  | { kind: "manager"; managementSessionId?: string; workspaceRoot?: string; agentName: string; roleLabel: string }
  | {
      kind: "member"
      managementSessionId?: string
      workspaceRoot?: string
      teamId: string
      teamName: string
      agentId: string
      agentName: string
      roleLabel: string
      isLeader: boolean
      status: string
    }

export function emptyAgentsSnapshot(): AgentsSnapshotData {
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

export function normalizeAgentsSnapshot(raw: unknown): AgentsSnapshotData {
  const base = emptyAgentsSnapshot()
  if (!raw || typeof raw !== "object") return base
  const obj = raw as Record<string, unknown>
  return {
    seq: Number(obj.seq) || 0,
    teams: Array.isArray(obj.teams) ? (obj.teams as Array<Record<string, any>>) : [],
    memberships: Array.isArray(obj.memberships) ? (obj.memberships as Array<Record<string, any>>) : [],
    agents: Array.isArray(obj.agents) ? (obj.agents as Array<Record<string, any>>) : [],
    tasks: Array.isArray(obj.tasks) ? (obj.tasks as Array<Record<string, any>>) : [],
    runs: Array.isArray(obj.runs) ? (obj.runs as Array<Record<string, any>>) : [],
    sessions: Array.isArray(obj.sessions) ? (obj.sessions as Array<Record<string, any>>) : [],
    connectedSessions: Array.isArray(obj.connectedSessions) ? (obj.connectedSessions as string[]) : [],
    live: Array.isArray(obj.live) ? (obj.live as Array<Record<string, any>>) : [],
    folderDefaultsVersion: Number(obj.folderDefaultsVersion) || 0,
    notices: Array.isArray(obj.notices) ? (obj.notices as Array<Record<string, any>>) : [],
    approvals: Array.isArray(obj.approvals) ? (obj.approvals as Array<Record<string, any>>) : [],
    archivedTeams: Array.isArray(obj.archivedTeams) ? (obj.archivedTeams as Array<Record<string, any>>) : [],
    notes: Array.isArray(obj.notes) ? (obj.notes as Array<Record<string, any>>) : [],
    artifacts: Array.isArray(obj.artifacts) ? (obj.artifacts as Array<Record<string, any>>) : [],
  }
}

export function memberStatusTone(status: unknown): StatusTone {
  return STATUS_META[String(status || "Idle")]?.tone || "idle"
}

export function relativeTimeLabel(iso: unknown): string {
  if (!iso) return ""
  const ts = Date.parse(String(iso))
  if (!Number.isFinite(ts)) return String(iso)
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (diffSec < 45) return "just now"
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

export function mergeTeamSessions(
  rawSnapshot: unknown,
  teamId: string,
  savedTeamSessions: Array<Record<string, any>> = [],
): Map<string, MemberSessionSummary[]> {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const byAgent = new Map<string, MemberSessionSummary[]>()
  const liveByRuntimeId = new Map(snapshot.live.map((item) => [item.runtimeSessionId, item]))
  const connectedSet = new Set(snapshot.connectedSessions)
  const savedList = Array.isArray(savedTeamSessions) ? savedTeamSessions : []

  const seenByAgent = new Map<string, Set<string>>()
  const ensureList = (agentId: string) => {
    if (!byAgent.has(agentId)) {
      byAgent.set(agentId, [])
      seenByAgent.set(agentId, new Set())
    }
    return { list: byAgent.get(agentId)!, seen: seenByAgent.get(agentId)! }
  }

  for (const row of savedList) {
    if (!row?.agentId || !row?.runtimeSessionId) continue
    const { list, seen } = ensureList(String(row.agentId))
    const rid = String(row.runtimeSessionId)
    if (seen.has(rid)) continue
    seen.add(rid)
    const live = liveByRuntimeId.get(rid) || null
    const connected = connectedSet.has(rid)
    const status = live?.question
      ? "Needs input"
      : live?.turnStatus === "running"
        ? "Working"
        : live?.background?.count
          ? "Running job"
          : connected
            ? "Open"
            : String(row.status || "Idle")
    list.push({
      runtimeSessionId: rid,
      managementSessionId: String(row.managementSessionId || ""),
      teamId: String(row.teamId || teamId),
      agentId: String(row.agentId),
      agentName: String(row.agentName || ""),
      position: String(row.position || ""),
      workspaceRoot: String(row.workspaceRoot || ""),
      origin: String(row.origin || "direct"),
      taskId: row.taskId ? String(row.taskId) : "",
      title: String(row.title || "Conversation"),
      updatedAt: String(row.updatedAt || row.createdAt || ""),
      createdAt: String(row.createdAt || ""),
      model: String(row.model || ""),
      status,
      tone: memberStatusTone(status),
      connected,
      live,
    })
  }

  for (const ms of snapshot.sessions) {
    if (ms.teamId !== teamId || !ms.agentId || !ms.runtimeSessionId) continue
    const { list, seen } = ensureList(String(ms.agentId))
    const rid = String(ms.runtimeSessionId)
    if (seen.has(rid)) continue
    seen.add(rid)
    const live = liveByRuntimeId.get(rid) || null
    const connected = connectedSet.has(rid)
    const status = live?.question
      ? "Needs input"
      : live?.turnStatus === "running"
        ? "Working"
        : live?.background?.count
          ? "Running job"
          : connected
            ? "Open"
            : "Idle"
    const linkedTask = ms.taskId ? snapshot.tasks.find((t) => t.id === ms.taskId) : null
    list.push({
      runtimeSessionId: rid,
      managementSessionId: String(ms.id || ""),
      teamId: String(teamId),
      agentId: String(ms.agentId),
      workspaceRoot: String(ms.workspaceRoot || ""),
      origin: String(ms.origin || "direct"),
      taskId: ms.taskId ? String(ms.taskId) : "",
      title: linkedTask?.brief ? String(linkedTask.brief) : ms.origin === "task" ? "Task session" : "Active conversation",
      updatedAt: String(ms.updatedAt || ms.createdAt || ""),
      createdAt: String(ms.createdAt || ""),
      model: "",
      status,
      tone: memberStatusTone(status),
      connected,
      live,
    })
  }

  for (const [, list] of byAgent.entries()) {
    list.sort((a, b) => {
      if (a.tone === "working" && b.tone !== "working") return -1
      if (b.tone === "working" && a.tone !== "working") return 1
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    })
  }

  return byAgent
}

function normalizePathKey(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function isManagerWorkspace(value: unknown): boolean {
  return normalizePathKey(value).endsWith("/agents-management/manager")
}

export function mergeManagerSessions(
  rawSnapshot: unknown,
  savedManagerSessions: Array<Record<string, any>> = [],
): MemberSessionSummary[] {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const liveByRuntimeId = new Map(snapshot.live.map((item) => [item.runtimeSessionId, item]))
  const connectedSet = new Set(snapshot.connectedSessions)
  const seen = new Set<string>()
  const result: MemberSessionSummary[] = []

  const savedList = Array.isArray(savedManagerSessions) ? savedManagerSessions : []
  for (const row of savedList) {
    if (!row?.runtimeSessionId) continue
    const rid = String(row.runtimeSessionId)
    if (seen.has(rid)) continue
    seen.add(rid)
    const live = liveByRuntimeId.get(rid) || null
    const connected = connectedSet.has(rid)
    const status = live?.question
      ? "Needs input"
      : live?.turnStatus === "running"
        ? "Working"
        : live?.background?.count
          ? "Running job"
          : connected
            ? "Open"
            : String(row.status || "Idle")
    result.push({
      runtimeSessionId: rid,
      managementSessionId: String(row.managementSessionId || ""),
      workspaceRoot: String(row.workspaceRoot || ""),
      origin: String(row.origin || "direct"),
      taskId: "",
      title: String(row.title || "Manager conversation"),
      updatedAt: String(row.updatedAt || row.createdAt || ""),
      createdAt: String(row.createdAt || ""),
      model: String(row.model || ""),
      status,
      tone: memberStatusTone(status),
      connected,
      live,
    })
  }

  const managerAgent = snapshot.agents.find((a) => isManagerWorkspace(a.canonicalWorkspace))
  for (const ms of snapshot.sessions) {
    if (ms.teamId || !ms.runtimeSessionId) continue
    if (ms.agentId !== managerAgent?.id && !isManagerWorkspace(ms.workspaceRoot)) continue
    const rid = String(ms.runtimeSessionId)
    if (seen.has(rid)) continue
    seen.add(rid)
    const live = liveByRuntimeId.get(rid) || null
    const connected = connectedSet.has(rid)
    const status = live?.question
      ? "Needs input"
      : live?.turnStatus === "running"
        ? "Working"
        : connected
          ? "Open"
          : "Idle"
    result.push({
      runtimeSessionId: rid,
      managementSessionId: String(ms.id || ""),
      workspaceRoot: String(ms.workspaceRoot || managerAgent?.canonicalWorkspace || ""),
      origin: String(ms.origin || "direct"),
      taskId: "",
      title: "Manager conversation",
      updatedAt: String(ms.updatedAt || ms.createdAt || ""),
      createdAt: String(ms.createdAt || ""),
      model: "",
      status,
      tone: memberStatusTone(status),
      connected,
      live,
    })
  }

  result.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  return result
}

export const TASK_SECTION_DEFS: ReadonlyArray<{ id: TaskSectionKey; label: string; emptyText: string }> = [
  { id: "needs", label: "Needs you", emptyText: "Nothing waiting on your answer or review" },
  { id: "working", label: "In progress", emptyText: "No tasks currently running" },
  { id: "queued", label: "Queued", emptyText: "No queued tasks" },
  { id: "delegated", label: "Delegated to members", emptyText: "No parent tasks waiting on delegated sub-tasks" },
  { id: "done", label: "Delivered", emptyText: "No delivered tasks yet" },
  { id: "cancelled", label: "Cancelled", emptyText: "No cancelled tasks" },
]

export function taskSectionKey(task: Record<string, any> | null | undefined): TaskSectionKey {
  const status = String(task?.status || "queued")
  if (status === "needs_attention") return "needs"
  if (status === "blocked") {
    return task?.blockedOn?.responder === "user" ? "needs" : "delegated"
  }
  if (status === "done") {
    if (task?.report && !task?.review && !task?.parentTaskId) return "needs"
    return "done"
  }
  if (status === "running") return "working"
  if (status === "queued") return "queued"
  if (status === "cancelled") return "cancelled"
  return "queued"
}

export function taskStatusMeta(task: Record<string, any> | null | undefined): {
  label: string
  tone: StatusTone
  section: TaskSectionKey
} {
  const status = String(task?.status || "queued")
  const section = taskSectionKey(task)
  if (status === "running") {
    return { label: "Working", tone: "working", section }
  }
  if (status === "queued") {
    return {
      label: task?.queueReason ? `Queued · ${task.queueReason}` : "Queued",
      tone: "waiting",
      section,
    }
  }
  if (status === "blocked") {
    if (task?.blockedOn?.responder === "user") {
      return { label: "Needs input", tone: "attention", section }
    }
    return { label: "Delegated", tone: "waiting", section }
  }
  if (status === "needs_attention") {
    return { label: "Needs attention", tone: "attention", section }
  }
  if (status === "done") {
    if (task?.report && !task?.review && !task?.parentTaskId) {
      return { label: "Ready for review", tone: "attention", section }
    }
    if (task?.review?.decision === "rework") {
      return { label: "Rework requested", tone: "waiting", section }
    }
    if (task?.review?.decision === "accepted") {
      return { label: "Accepted", tone: "completed", section }
    }
    return { label: "Delivered", tone: "completed", section }
  }
  if (status === "cancelled") {
    return { label: "Cancelled", tone: "idle", section }
  }
  return { label: status, tone: "idle", section }
}

export function buildTeamSummary(
  rawSnapshot: unknown,
  teamId: string,
  savedTeamSessions: Array<Record<string, any>> = [],
): TeamSummary | null {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const team = snapshot.teams.find((item) => item.id === teamId) || null
  if (!team) return null

  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const teamMemberships = snapshot.memberships.filter((m) => m.teamId === team.id)
  const teamTasks = snapshot.tasks.filter((t) => t.teamId === team.id)
  const teamSessions = snapshot.sessions.filter((s) => s.teamId === team.id)
  const sessionsByAgent = mergeTeamSessions(snapshot, team.id, savedTeamSessions)

  const members: OrgMemberSummary[] = teamMemberships.map((membership) => {
    const agent = agentById.get(membership.agentId) || { id: membership.agentId, name: membership.agentId }
    const isLeader = team.leaderAgentId === membership.agentId
    const supervisor = membership.reportsToAgentId ? agentById.get(membership.reportsToAgentId) : null
    const memberTasks = teamTasks.filter((t) => t.assigneeAgentId === membership.agentId)
    const activeTask =
      memberTasks.find((t) => t.status === "running" || t.status === "blocked" || t.status === "needs_attention") ||
      memberTasks.find((t) => t.status === "queued") ||
      null
    const memberSessions = sessionsByAgent.get(String(membership.agentId)) || []
    const directSessions = teamSessions.filter(
      (s) => s.agentId === membership.agentId && s.origin === "direct" && s.runtimeSessionId,
    )
    const latestDirectSession = directSessions[directSessions.length - 1] || null
    const latestRuntimeSessionId =
      memberSessions[0]?.runtimeSessionId ||
      (latestDirectSession ? String(latestDirectSession.runtimeSessionId) : "")
    const status = String(membership.status || "Idle")

    return {
      agentId: String(membership.agentId),
      teamId: String(team.id),
      name: String(agent.name || membership.agentId),
      canonicalWorkspace: String(agent.canonicalWorkspace || ""),
      adapter: String(agent.adapter || "rind"),
      worktreeOf: agent.worktreeOf ? String(agent.worktreeOf) : "",
      position: String(membership.position || (isLeader ? "Team Leader" : "Specialist")),
      responsibility: String(membership.responsibility || ""),
      reportsToAgentId: membership.reportsToAgentId ? String(membership.reportsToAgentId) : "",
      reportsToName: supervisor ? String(supervisor.name || supervisor.id) : "",
      isLeader,
      status,
      tone: memberStatusTone(status),
      activeTask,
      latestRuntimeSessionId,
      sessions: memberSessions,
      sessionCount: memberSessions.length,
      taskCounts: {
        active: memberTasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "blocked").length,
        attention: memberTasks.filter(
          (t) =>
            t.status === "needs_attention" ||
            (t.status === "blocked" && t.blockedOn?.responder === "user") ||
            (t.status === "done" && t.report && !t.review && !t.parentTaskId),
        ).length,
        done: memberTasks.filter((t) => t.status === "done").length,
      },
      children: [],
    }
  })

  members.sort((a, b) => {
    if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const memberById = new Map(members.map((m) => [m.agentId, { ...m, children: [] as OrgMemberSummary[] }]))
  const roots: OrgMemberSummary[] = []
  for (const node of memberById.values()) {
    const parentId = node.reportsToAgentId
    if (parentId && parentId !== node.agentId && memberById.has(parentId)) {
      let cursor = memberById.get(parentId)
      let cycle = false
      const seen = new Set([node.agentId])
      while (cursor) {
        if (seen.has(cursor.agentId)) {
          cycle = true
          break
        }
        seen.add(cursor.agentId)
        cursor = cursor.reportsToAgentId ? memberById.get(cursor.reportsToAgentId) : undefined
      }
      if (!cycle) {
        memberById.get(parentId)!.children.push(node)
        continue
      }
    }
    roots.push(node)
  }

  const leader = members.find((m) => m.isLeader) || members[0] || null
  const counts = {
    members: members.length,
    working: members.filter((m) => m.tone === "working").length,
    attention: members.filter((m) => m.tone === "attention").length,
    tasksTotal: teamTasks.length,
    tasksQueued: teamTasks.filter((t) => taskSectionKey(t) === "queued").length,
    tasksInProgress: teamTasks.filter(
      (t) => taskSectionKey(t) === "working" || taskSectionKey(t) === "delegated",
    ).length,
    tasksAttention: teamTasks.filter((t) => taskSectionKey(t) === "needs").length,
    tasksCompleted: teamTasks.filter((t) => taskSectionKey(t) === "done").length,
  }

  return {
    team: {
      id: String(team.id),
      name: String(team.name || team.id),
      leaderAgentId: team.leaderAgentId ? String(team.leaderAgentId) : "",
      createRoot: String(team.createRoot || ""),
    },
    leader,
    members,
    orgRoots: roots,
    sessionsByAgent,
    counts,
  }
}

export function enrichTask(rawSnapshot: unknown, task: Record<string, any> | null | undefined): EnrichedTask | null {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  if (!task) return null
  const team = snapshot.teams.find((t) => t.id === task.teamId)
  const agent = snapshot.agents.find((a) => a.id === task.assigneeAgentId)
  const membership = snapshot.memberships.find(
    (m) => m.teamId === task.teamId && m.agentId === task.assigneeAgentId,
  )
  const meta = taskStatusMeta(task)
  const notes = snapshot.notes.filter((n) => n.taskId === task.id)
  const artifactRecords = snapshot.artifacts.filter((a) => a.taskId === task.id)
  const runs = snapshot.runs.filter((r) => r.taskId === task.id)
  const activeRun =
    runs.find((r) => r.status === "starting" || r.status === "running" || r.status === "unknown") ||
    runs[runs.length - 1] ||
    null
  const taskSession = snapshot.sessions.find((s) => s.taskId === task.id && s.runtimeSessionId) || null
  const parentTask = task.parentTaskId ? snapshot.tasks.find((t) => t.id === task.parentTaskId) || null : null
  const childTasks = snapshot.tasks.filter((t) => t.parentTaskId === task.id)

  return {
    ...task,
    id: String(task.id),
    teamId: String(task.teamId || ""),
    teamName: String(team?.name || task.teamId || ""),
    assigneeAgentId: String(task.assigneeAgentId || ""),
    assigneeName: String(agent?.name || task.assigneeAgentId || "Unassigned"),
    assigneePosition: String(
      membership?.position || (team?.leaderAgentId === task.assigneeAgentId ? "Team Leader" : "Specialist"),
    ),
    brief: String(task.brief || ""),
    priority: task.priority === "high" || task.priority === "low" ? task.priority : "normal",
    section: meta.section,
    tone: meta.tone,
    statusLabel: meta.label,
    notes,
    artifactRecords,
    runs,
    activeRun,
    runtimeSessionId: taskSession
      ? String(taskSession.runtimeSessionId)
      : activeRun?.runtimeSessionId
        ? String(activeRun.runtimeSessionId)
        : "",
    parentTask,
    childTasks,
  }
}

export function groupTeamTasks(rawSnapshot: unknown, teamId = "") {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const filtered = teamId ? snapshot.tasks.filter((t) => t.teamId === teamId) : snapshot.tasks
  const enriched = filtered.map((task) => enrichTask(snapshot, task)).filter((t): t is EnrichedTask => Boolean(t))

  const priorityRank: Record<string, number> = { high: 0, normal: 1, low: 2 }
  enriched.sort((a, b) => {
    const rankDiff = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)
    if (rankDiff !== 0 && a.section !== "done" && b.section !== "done") return rankDiff
    return String(b.updatedAt || b.createdAt || b.id).localeCompare(String(a.updatedAt || a.createdAt || a.id))
  })

  const sections: Record<TaskSectionKey, EnrichedTask[]> = {
    needs: [],
    working: [],
    queued: [],
    delegated: [],
    done: [],
    cancelled: [],
  }
  for (const item of enriched) {
    sections[item.section].push(item)
  }

  const nonEmptySections = TASK_SECTION_DEFS.map((def) => ({
    ...def,
    items: sections[def.id],
  })).filter((sec) => sec.items.length > 0)

  return { all: enriched, sections, nonEmptySections }
}

export function buildInboxSections(rawSnapshot: unknown) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]))
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]))

  const needsYou: InboxItem[] = []
  const notices: InboxItem[] = []
  const delivered: InboxItem[] = []

  for (const approval of snapshot.approvals) {
    if (approval.status && approval.status !== "pending") continue
    const team = teamById.get(approval.teamId)
    needsYou.push({
      id: `approval:${approval.id}`,
      section: "needsYou",
      kind: "approval",
      tone: "attention",
      badge: approval.kind === "deleteTeam" ? "Delete Team Approval" : "Cancel Run Approval",
      title: String(approval.title || "Approval requested"),
      subtitle: team ? `Team ${team.name}` : "Management approval",
      teamId: String(approval.teamId || ""),
      approvalId: String(approval.id),
      taskId: approval.taskId ? String(approval.taskId) : "",
      runId: approval.runId ? String(approval.runId) : "",
      createdAt: String(approval.createdAt || ""),
      raw: approval,
    })
  }

  for (const task of snapshot.tasks) {
    const team = teamById.get(task.teamId)
    const agent = agentById.get(task.assigneeAgentId)
    const subtitle = [team?.name, agent?.name].filter(Boolean).join(" · ")

    if (task.status === "blocked" && task.blockedOn?.responder === "user") {
      needsYou.push({
        id: `blocker:${task.id}`,
        section: "needsYou",
        kind: "blocker",
        tone: "attention",
        badge: "Needs Your Input",
        title: String(task.blockedOn.action || task.brief || "Task waiting on your answer"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.brief || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.updatedAt || task.createdAt || ""),
        raw: enrichTask(snapshot, task),
      })
    } else if (task.status === "needs_attention") {
      needsYou.push({
        id: `attention:${task.id}`,
        section: "needsYou",
        kind: "attention",
        tone: "attention",
        badge: "Needs Attention",
        title: String(task.brief || "Task needs attention"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.error || task.report?.summary || "Run stopped before submitting a final report."),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.updatedAt || task.createdAt || ""),
        raw: enrichTask(snapshot, task),
      })
    } else if (task.status === "done" && task.report && !task.review && !task.parentTaskId) {
      needsYou.push({
        id: `delivery:${task.id}`,
        section: "needsYou",
        kind: "delivery",
        tone: "attention",
        badge: "Delivery Ready for Review",
        title: String(task.brief || "Completed task delivery"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.report.summary || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.deliveredAt || task.updatedAt || ""),
        raw: enrichTask(snapshot, task),
      })
    } else if (task.status === "done" && task.report) {
      delivered.push({
        id: `delivered:${task.id}`,
        section: "delivered",
        kind: "delivery",
        tone: "completed",
        badge: task.review?.decision === "accepted" ? "Accepted" : "Delivered",
        title: String(task.brief || "Delivered task"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.report.summary || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.deliveredAt || task.updatedAt || ""),
        raw: enrichTask(snapshot, task),
      })
    }
  }

  for (const run of snapshot.runs) {
    if (run.status === "unknown") {
      const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null
      const agent = agentById.get(run.agentId)
      needsYou.push({
        id: `run:${run.id}`,
        section: "needsYou",
        kind: "unconfirmed_run",
        tone: "attention",
        badge: "Unconfirmed Run",
        title: task ? `Unconfirmed run for "${task.brief}"` : `Run ${run.id} lost host contact`,
        subtitle: [agent?.name, `Started ${relativeTimeLabel(run.startedAt)}`].filter(Boolean).join(" · "),
        detail: String(run.error || "Check Background before starting duplicate work."),
        runId: String(run.id),
        taskId: run.taskId ? String(run.taskId) : "",
        teamId: task?.teamId ? String(task.teamId) : "",
        createdAt: String(run.startedAt || ""),
        raw: run,
      })
    }
  }

  for (const notice of snapshot.notices) {
    if (notice.dismissedAt) continue
    const team = teamById.get(notice.teamId)
    const agent = agentById.get(notice.agentId)
    notices.push({
      id: `notice:${notice.id}`,
      section: "notices",
      kind: "notice",
      tone: "waiting",
      badge: "Manager Change",
      title: String(notice.title || "Organization update"),
      subtitle: [team?.name, agent?.name].filter(Boolean).join(" · "),
      noticeId: String(notice.id),
      teamId: String(notice.teamId || ""),
      agentId: String(notice.agentId || ""),
      createdAt: String(notice.createdAt || ""),
      raw: notice,
    })
  }

  return {
    needsYou,
    notices,
    delivered: delivered.slice(0, 10),
    badgeCount: needsYou.length + notices.length,
    totalCount: needsYou.length + notices.length + delivered.length,
  }
}

export function buildInboxItems(rawSnapshot: unknown): InboxItem[] {
  const sections = buildInboxSections(rawSnapshot)
  return [...sections.needsYou, ...sections.notices, ...sections.delivered]
}

export function inboxBadgeCount(rawSnapshot: unknown): number {
  return buildInboxSections(rawSnapshot).badgeCount
}

export function buildBackgroundModel(rawSnapshot: unknown, serviceInfo: Record<string, any> | null = null) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]))
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]))
  const sessionByRuntimeId = new Map(snapshot.sessions.map((s) => [s.runtimeSessionId, s]))

  const runningNow: Array<Record<string, any>> = []
  const unconfirmedRuns: Array<Record<string, any>> = []
  const seenRuntimeIds = new Set<string>()

  for (const run of snapshot.runs) {
    const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null
    const agent = agentById.get(run.agentId)
    const team = task ? teamById.get(task.teamId) : null
    const live = run.runtimeSessionId
      ? snapshot.live.find((l) => l.runtimeSessionId === run.runtimeSessionId) || null
      : null

    if (run.status === "starting" || run.status === "running") {
      if (run.runtimeSessionId) seenRuntimeIds.add(String(run.runtimeSessionId))
      runningNow.push({
        id: `run:${run.id}`,
        kind: "delegated_run",
        runId: String(run.id),
        taskId: run.taskId ? String(run.taskId) : "",
        teamId: team?.id ? String(team.id) : "",
        teamName: team?.name ? String(team.name) : "",
        agentId: String(run.agentId || ""),
        agentName: String(agent?.name || run.agentId || "Agent"),
        runtimeSessionId: run.runtimeSessionId ? String(run.runtimeSessionId) : "",
        status: String(run.status),
        title: String(task?.brief || `Delegated run ${run.id}`),
        detail: live?.currentTool
          ? `Tool: ${live.currentTool}`
          : live?.lastPreview
            ? String(live.lastPreview)
            : `Started ${relativeTimeLabel(run.startedAt)}`,
      })
    } else if (run.status === "unknown") {
      unconfirmedRuns.push({
        id: `unknown:${run.id}`,
        runId: String(run.id),
        taskId: run.taskId ? String(run.taskId) : "",
        teamId: team?.id ? String(team.id) : "",
        teamName: team?.name ? String(team.name) : "",
        agentId: String(run.agentId || ""),
        agentName: String(agent?.name || run.agentId || "Agent"),
        runtimeSessionId: run.runtimeSessionId ? String(run.runtimeSessionId) : "",
        title: String(task?.brief || `Unconfirmed run ${run.id}`),
        detail: String(run.error || "Lost contact with runtime session while running."),
        startedAt: String(run.startedAt || ""),
      })
    }
  }

  for (const live of snapshot.live) {
    if (!live.runtimeSessionId || seenRuntimeIds.has(live.runtimeSessionId)) continue
    const isWorking = live.turnStatus === "running" || Number(live.background?.count) > 0 || Boolean(live.question)
    if (!isWorking) continue
    const ms = sessionByRuntimeId.get(live.runtimeSessionId)
    const agent = ms ? agentById.get(ms.agentId) : null
    const team = ms?.teamId ? teamById.get(ms.teamId) : null
    runningNow.push({
      id: `live:${live.runtimeSessionId}`,
      kind: "live_session",
      runtimeSessionId: String(live.runtimeSessionId),
      teamId: team?.id ? String(team.id) : "",
      teamName: team?.name ? String(team.name) : "",
      agentId: agent?.id ? String(agent.id) : "",
      agentName: String(
        isManagerWorkspace(ms?.workspaceRoot || agent?.canonicalWorkspace || live.workspace)
          ? "Manager"
          : agent?.name || "Session",
      ),
      status: live.question
        ? "Needs input"
        : Number(live.background?.count) > 0
          ? `${live.background.count} bg job(s)`
          : "Working",
      title: String(live.lastPreview || "Active conversation turn"),
      detail: live.currentTool ? `Running ${live.currentTool}` : "",
    })
  }

  const recentRuns = snapshot.runs
    .filter((r) => r.status !== "starting" && r.status !== "running" && r.status !== "unknown")
    .slice(-15)
    .reverse()

  return {
    runningNow,
    unconfirmedRuns,
    recentRuns,
    service: serviceInfo || null,
    runningCount: runningNow.length + unconfirmedRuns.length,
  }
}

export function activeBackgroundCount(rawSnapshot: unknown): number {
  return buildBackgroundModel(rawSnapshot).runningCount
}

export function resolveSessionAgentContext(
  rawSnapshot: unknown,
  sessionId: string,
  workspaceRoot: string,
): SessionAgentContext {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const sid = String(sessionId || "").trim()
  const wsKey = normalizePathKey(workspaceRoot)

  if (sid) {
    const managedSession = snapshot.sessions.find((s) => s.runtimeSessionId === sid)
    if (managedSession) {
      const agent = snapshot.agents.find((a) => a.id === managedSession.agentId)
      const team = managedSession.teamId ? snapshot.teams.find((t) => t.id === managedSession.teamId) : null
      const membership = team
        ? snapshot.memberships.find((m) => m.teamId === team.id && m.agentId === managedSession.agentId)
        : null
      if (team && agent) {
        return {
          kind: "member",
          managementSessionId: String(managedSession.id || ""),
          workspaceRoot: String(managedSession.workspaceRoot || agent.canonicalWorkspace || ""),
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(agent.id),
          agentName: String(agent.name || agent.id),
          roleLabel: String(
            membership?.position || (team.leaderAgentId === agent.id ? "Team Leader" : "Specialist"),
          ),
          isLeader: team.leaderAgentId === agent.id,
          status: String(membership?.status || "Idle"),
        }
      }
      if (
        !managedSession.teamId &&
        (isManagerWorkspace(managedSession.workspaceRoot) || (agent && isManagerWorkspace(agent.canonicalWorkspace)))
      ) {
        return {
          kind: "manager",
          managementSessionId: String(managedSession.id || ""),
          workspaceRoot: String(managedSession.workspaceRoot || agent?.canonicalWorkspace || ""),
          agentName: "Manager",
          roleLabel: "Organization Coordinator",
        }
      }
    }
  }

  if (wsKey) {
    if (isManagerWorkspace(wsKey)) {
      return {
        kind: "manager",
        workspaceRoot,
        agentName: "Manager",
        roleLabel: "Organization Coordinator",
      }
    }
    const matchingAgent = snapshot.agents.find((a) => normalizePathKey(a.canonicalWorkspace) === wsKey)
    if (matchingAgent) {
      const membership = snapshot.memberships.find((m) => m.agentId === matchingAgent.id)
      const team = membership ? snapshot.teams.find((t) => t.id === membership.teamId) : null
      if (team) {
        return {
          kind: "member",
          workspaceRoot,
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(matchingAgent.id),
          agentName: String(matchingAgent.name || matchingAgent.id),
          roleLabel: String(
            membership?.position || (team.leaderAgentId === matchingAgent.id ? "Team Leader" : "Specialist"),
          ),
          isLeader: team.leaderAgentId === matchingAgent.id,
          status: String(membership?.status || "Idle"),
        }
      }
    }
  }

  return { kind: "independent" }
}

export type DesktopAgentSurfaceState =
  | { kind: "chat" }
  | { kind: "inbox" }
  | { kind: "manager" }
  | { kind: "background" }
  | { kind: "archive" }
  | {
      kind: "team"
      teamId: string
      tab: "organization" | "tasks"
      assigneeFilter: string
      selectedTaskId: string
      addMemberOpen: boolean
      memberMode: "workspace" | "existing" | "worktree"
      assignOpen: boolean
      assignAgentId: string
      deleteConfirmOpen: boolean
    }

// ---------- Pure HTML Renderers for Desktop Renderer & Node Tests ----------

const PROJECT_MENU_ICON_SVG = `<svg class="project-menu-icon" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg>`
const SESSION_MENU_ICON_SVG = `<svg class="session-menu-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`
const SESSION_SPINNER_SVG = `<svg class="session-spinner" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`

export const DEFAULT_SIDEBAR_SESSIONS_LIMIT = 5

function renderAgentSidebarSessionRow(options: {
  sess: MemberSessionSummary
  menuKey?: string
  isCurrent: boolean
  menuOpen: boolean
  confirmingDelete: boolean
  deleting: boolean
  openAttrs: string
}): string {
  const { sess, isCurrent, menuOpen, confirmingDelete, deleting, openAttrs } = options
  const id = sess.runtimeSessionId
  const menuKey = options.menuKey || id
  const title = sess.title || "Untitled"
  const running = sess.tone === "working"
  const when = relativeTimeLabel(sess.updatedAt)
  const deleteLabel = isCurrent
    ? "Delete (open session)"
    : deleting
      ? "Deleting…"
      : confirmingDelete
        ? "Confirm delete"
        : "Delete"

  return `
    <div class="session-item-row${menuOpen ? " menu-open" : ""}" data-session-row="${escapeAttribute(id)}">
      <button type="button" class="session-item${running ? " running" : ""}${isCurrent ? " selected" : ""}" ${openAttrs} title="${escapeAttribute(when ? `${title} - ${when}` : title)}"${isCurrent ? ' aria-current="page"' : ""}>
        <span class="session-item-title">${running ? SESSION_SPINNER_SVG : ""}<span class="session-item-title-text">${escapeHtml(title)}</span></span>
      </button>
      <div class="session-menu-wrap${menuOpen ? " menu-open" : ""}">
        <button type="button" class="session-menu-trigger" data-agent-session-menu="${escapeAttribute(menuKey)}" aria-label="Actions for ${escapeAttribute(title)}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}">${SESSION_MENU_ICON_SVG}</button>
        ${
          menuOpen
            ? `<div class="session-menu menu" role="menu" aria-label="Actions for ${escapeAttribute(title)}">
                <button type="button" class="menu-item" role="menuitem" data-agent-session-fork="${escapeAttribute(id)}"${running ? " disabled" : ""}>Fork</button>
                <button type="button" class="menu-item" role="menuitem" data-agent-session-export="${escapeAttribute(id)}" data-session-title="${escapeAttribute(title)}">Export replay</button>
                <div class="menu-separator" role="separator"></div>
                <button type="button" class="menu-item menu-item-danger${confirmingDelete ? " confirm" : ""}" role="menuitem" data-agent-delete-session="${escapeAttribute(id)}"${isCurrent || deleting ? " disabled" : ""}${isCurrent ? ' title="The open session cannot be deleted"' : ""}>${deleteLabel}</button>
              </div>`
            : ""
        }
      </div>
    </div>
  `
}

export type OrgViewMode = "minimal" | "detailed"
export const DEFAULT_ORG_VIEW_MODE: OrgViewMode = "minimal"

export function renderOrgFlowNodeHtml(
  node: OrgMemberSummary,
  depth = 0,
  expandedFlowNodes: ReadonlySet<string> = new Set(),
  expandedOrgMembers: ReadonlySet<string> = new Set(),
  viewedSessionId = "",
  sessionLimits: Record<string, number> = {},
  itemMenuKey = "",
): string {
  const isSessionsOpen = expandedOrgMembers.has(node.agentId)
  const sessions = node.sessions || []
  const limitKey = `org:${node.agentId}`
  const limit = sessionLimits[limitKey] || DEFAULT_SIDEBAR_SESSIONS_LIMIT
  const visibleSessions = sessions.slice(0, limit)
  const memberMenuKey = `org-member:${node.agentId}`
  const memberMenuOpen = itemMenuKey === memberMenuKey
  const isNodeExpanded = expandedFlowNodes.has(node.agentId) || isSessionsOpen || memberMenuOpen
  const hasChildren = node.children.length > 0

  const childrenHtml = hasChildren
    ? `<div class="org-flow-children" role="group" aria-label="Direct reports of ${escapeAttribute(node.name)}">${node.children
        .map(
          (c) =>
            `<div class="org-flow-child-item">${renderOrgFlowNodeHtml(
              c,
              depth + 1,
              expandedFlowNodes,
              expandedOrgMembers,
              viewedSessionId,
              sessionLimits,
              itemMenuKey,
            )}</div>`,
        )
        .join("")}</div>`
    : ""
  const branchMenuOpen = memberMenuOpen || childrenHtml.includes(" menu-open")

  const metaItems: string[] = []
  if (node.reportsToName) metaItems.push(`Reports to ${escapeHtml(node.reportsToName)}`)
  if (node.responsibility) metaItems.push(escapeHtml(node.responsibility))

  const expandedBodyHtml = `<div class="org-flow-node-collapse${isNodeExpanded ? " is-open" : ""}" aria-hidden="${String(!isNodeExpanded)}"${!isNodeExpanded ? " inert" : ""}>
      <div class="org-flow-node-collapse-inner">
        <div class="org-flow-node-body">
          ${metaItems.length > 0 ? `<div class="org-member-sub">${metaItems.join(" · ")}</div>` : ""}
          <div class="org-flow-node-actions org-member-actions">
            <button type="button" class="agent-btn primary sm" data-agent-chat="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" data-agent-session="${escapeAttribute(node.latestRuntimeSessionId)}">Chat</button>
            <button type="button" class="agent-btn secondary sm" data-agent-quick-assign="${escapeAttribute(node.agentId)}">Assign</button>
            <div class="project-menu-wrap${memberMenuOpen ? " menu-open" : ""}">
              <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="${escapeAttribute(memberMenuKey)}" title="Member actions" aria-label="Actions for ${escapeAttribute(node.name)}" aria-haspopup="menu" aria-expanded="${String(memberMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
              ${
                memberMenuOpen
                  ? `<div class="project-menu" role="menu">
                      <button type="button" data-agent-new-session="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" role="menuitem">New chat</button>
                      <button type="button" data-agent-quick-assign="${escapeAttribute(node.agentId)}" role="menuitem">Assign task</button>
                      <button type="button" data-agent-remove="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" role="menuitem">Remove</button>
                    </div>`
                  : ""
              }
            </div>
          </div>
          ${
            node.activeTask
              ? `<button type="button" class="org-active-task" data-agent-select-task="${escapeAttribute(node.activeTask.id)}" data-agent-team="${escapeAttribute(node.teamId)}"><span class="org-active-task-kicker">Working on</span><span class="org-active-task-brief">${escapeHtml(String(node.activeTask.brief || ""))}</span></button>`
              : ""
          }
          <div class="org-member-meta-bar">
            <button type="button" class="org-sessions-toggle" data-org-toggle-member-sessions="${escapeAttribute(node.agentId)}" aria-expanded="${String(isSessionsOpen)}">
              <span>${isSessionsOpen ? "▾" : "▸"}</span>
              <span>Conversations (${sessions.length})</span>
            </button>
            <div class="org-member-stats">
              ${node.taskCounts.active > 0 ? `<span>${node.taskCounts.active} active</span>` : ""}
              ${node.taskCounts.attention > 0 ? `<span class="org-stat-attention">${node.taskCounts.attention} need review</span>` : ""}
              <button type="button" class="agent-btn ghost sm org-flow-sessions-new-btn" data-agent-new-session="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}"${!isSessionsOpen ? " hidden" : ""}>+ New</button>
            </div>
          </div>
          <div class="org-member-sessions-collapse${isSessionsOpen ? " is-open" : ""}" aria-hidden="${String(!isSessionsOpen)}"${!isSessionsOpen ? " inert" : ""}>
            <div class="org-member-sessions-collapse-inner">
              <div class="org-member-sessions-list">
                ${
                  sessions.length === 0
                    ? `<div class="org-sessions-empty">No conversations yet.</div>`
                    : visibleSessions
                        .map((sess) => {
                          const isCurrent = sess.runtimeSessionId === viewedSessionId
                          return `
                            <div class="org-session-item${isCurrent ? " is-active" : ""}">
                              <button type="button" class="org-session-open" data-agent-chat="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" data-agent-session="${escapeAttribute(sess.runtimeSessionId)}">
                                <span class="agent-status-dot tone-${sess.tone}"></span>
                                <span class="org-session-title">${escapeHtml(sess.title || "Conversation")}</span>
                                ${sess.origin === "task" ? `<span class="org-role-pill">Task</span>` : ""}
                                <span class="org-session-time">${escapeHtml(relativeTimeLabel(sess.updatedAt))}</span>
                              </button>
                            </div>
                          `
                        })
                        .join("") +
                      (sessions.length > limit
                        ? `<button type="button" class="sidebar-load-more" data-agent-more-sessions="${escapeAttribute(limitKey)}">Show ${sessions.length - limit} more</button>`
                        : "")
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`

  return `
    <div class="org-flow-branch depth-${Math.min(depth, 6)}${isNodeExpanded ? " is-node-expanded" : ""}${branchMenuOpen ? " menu-open" : ""}" data-agent-id="${escapeAttribute(node.agentId)}">
      <div class="org-flow-node-wrap${hasChildren ? " has-children" : ""}${depth > 0 ? " has-parent" : ""}">
        ${depth > 0 ? `<span class="org-flow-port in" aria-hidden="true"></span>` : ""}
        <div class="org-flow-node org-member-card${memberMenuOpen ? " menu-open" : ""} tone-${node.tone}${node.isLeader ? " is-leader" : ""}${isNodeExpanded ? " is-expanded" : ""}" data-flow-node="${escapeAttribute(node.agentId)}">
          <button type="button" class="org-flow-node-trigger" data-org-toggle-flow-node="${escapeAttribute(node.agentId)}" aria-expanded="${String(isNodeExpanded)}">
            <div class="org-flow-node-head">
              <span class="agent-status-dot tone-${node.tone}"></span>
              <strong class="org-flow-node-name org-member-name">${escapeHtml(node.name)}</strong>
              ${node.isLeader ? `<span class="org-leader-badge">Leader</span>` : ""}
            </div>
            <div class="org-flow-node-subrow">
              <span class="org-role-pill" title="${escapeAttribute(node.position)}">${escapeHtml(node.position)}</span>
              ${node.worktreeOf ? `<span class="org-worktree-pill" title="${escapeAttribute(node.worktreeOf)}">Worktree</span>` : ""}
              ${node.status && node.status !== "Idle" ? `<span class="agent-status-pill tone-${node.tone}">${escapeHtml(node.status)}</span>` : ""}
              ${sessions.length > 0 ? `<span class="org-flow-mini-stat" title="${sessions.length} conversation(s)" aria-hidden="${String(isNodeExpanded)}">${sessions.length}</span>` : ""}
              ${node.taskCounts.attention > 0 ? `<span class="org-flow-mini-stat attention" aria-hidden="${String(isNodeExpanded)}">!${node.taskCounts.attention}</span>` : ""}
            </div>
            ${
              node.activeTask
                ? `<div class="org-flow-mini-task-collapse${isNodeExpanded ? " is-hidden" : ""}" aria-hidden="${String(isNodeExpanded)}"><div class="org-flow-mini-task-collapse-inner"><div class="org-flow-mini-task" title="${escapeAttribute(String(node.activeTask.brief || ""))}"><span class="org-flow-mini-task-dot"></span><span class="org-flow-mini-task-text">${escapeHtml(String(node.activeTask.brief || ""))}</span></div></div></div>`
                : ""
            }
          </button>
          ${expandedBodyHtml}
        </div>
        ${hasChildren ? `<span class="org-flow-port out" aria-hidden="true"></span>` : ""}
      </div>
      ${childrenHtml}
    </div>
  `
}

export function renderOrgNodeHtml(
  node: OrgMemberSummary,
  depth = 0,
  expandedOrgMembers: ReadonlySet<string> = new Set(),
  viewedSessionId = "",
  sessionLimits: Record<string, number> = {},
  itemMenuKey = "",
): string {
  const isSessionsOpen = expandedOrgMembers.has(node.agentId)
  const sessions = node.sessions || []
  const limitKey = `org:${node.agentId}`
  const limit = sessionLimits[limitKey] || DEFAULT_SIDEBAR_SESSIONS_LIMIT
  const visibleSessions = sessions.slice(0, limit)
  const memberMenuKey = `org-member:${node.agentId}`
  const memberMenuOpen = itemMenuKey === memberMenuKey
  const childrenHtml = node.children.length
    ? `<div class="org-tree-children" role="group" aria-label="Direct reports of ${escapeAttribute(node.name)}">${node.children
        .map((c) => renderOrgNodeHtml(c, depth + 1, expandedOrgMembers, viewedSessionId, sessionLimits, itemMenuKey))
        .join("")}</div>`
    : ""
  const branchMenuOpen = memberMenuOpen || childrenHtml.includes(" menu-open")

  const metaItems: string[] = []
  if (node.reportsToName) metaItems.push(`Reports to ${escapeHtml(node.reportsToName)}`)
  if (node.responsibility) metaItems.push(escapeHtml(node.responsibility))

  return `
    <div class="org-tree-branch depth-${Math.min(depth, 4)}${branchMenuOpen ? " menu-open" : ""}" data-agent-id="${escapeAttribute(node.agentId)}">
      <div class="org-member-card${node.isLeader ? " is-leader" : ""}${memberMenuOpen ? " menu-open" : ""}">
        <div class="org-member-top">
          <div class="org-member-identity">
            <div class="org-member-name-row">
              <span class="agent-status-dot tone-${node.tone}"></span>
              <strong class="org-member-name">${escapeHtml(node.name)}</strong>
              ${node.isLeader ? `<span class="org-leader-badge">Leader</span>` : ""}
              <span class="org-role-pill">${escapeHtml(node.position)}</span>
              ${node.worktreeOf ? `<span class="org-worktree-pill" title="${escapeAttribute(node.worktreeOf)}">Worktree</span>` : ""}
              ${node.status && node.status !== "Idle" ? `<span class="agent-status-pill tone-${node.tone}">${escapeHtml(node.status)}</span>` : ""}
            </div>
            ${metaItems.length > 0 ? `<div class="org-member-sub">${metaItems.join(" · ")}</div>` : ""}
          </div>
          <div class="org-member-actions">
            <button type="button" class="agent-btn primary sm" data-agent-chat="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" data-agent-session="${escapeAttribute(node.latestRuntimeSessionId)}">Chat</button>
            <div class="project-menu-wrap${memberMenuOpen ? " menu-open" : ""}">
              <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="${escapeAttribute(memberMenuKey)}" title="Member actions" aria-label="Actions for ${escapeAttribute(node.name)}" aria-haspopup="menu" aria-expanded="${String(memberMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
              ${
                memberMenuOpen
                  ? `<div class="project-menu" role="menu">
                      <button type="button" data-agent-new-session="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" role="menuitem">New chat</button>
                      <button type="button" data-agent-quick-assign="${escapeAttribute(node.agentId)}" role="menuitem">Assign task</button>
                      <button type="button" data-agent-remove="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" role="menuitem">Remove</button>
                    </div>`
                  : ""
              }
            </div>
          </div>
        </div>
        ${
          node.activeTask
            ? `<button type="button" class="org-active-task" data-agent-select-task="${escapeAttribute(node.activeTask.id)}" data-agent-team="${escapeAttribute(node.teamId)}"><span class="org-active-task-kicker">Working on</span><span class="org-active-task-brief">${escapeHtml(String(node.activeTask.brief || ""))}</span></button>`
            : ""
        }
        <div class="org-member-meta-bar">
          <button type="button" class="org-sessions-toggle" data-org-toggle-member-sessions="${escapeAttribute(node.agentId)}" aria-expanded="${String(isSessionsOpen)}">
            <span>${isSessionsOpen ? "▾" : "▸"}</span>
            <span>Conversations (${sessions.length})</span>
          </button>
          <div class="org-member-stats">
            ${node.taskCounts.active > 0 ? `<span>${node.taskCounts.active} active</span>` : ""}
            ${node.taskCounts.attention > 0 ? `<span class="org-stat-attention">${node.taskCounts.attention} need review</span>` : ""}
            ${isSessionsOpen ? `<button type="button" class="agent-btn ghost sm" data-agent-new-session="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}">+ New</button>` : ""}
          </div>
        </div>
        ${
          isSessionsOpen
            ? `<div class="org-member-sessions-list">
                ${
                  sessions.length === 0
                    ? `<div class="org-sessions-empty">No conversations yet.</div>`
                    : visibleSessions
                        .map((sess) => {
                          const isCurrent = sess.runtimeSessionId === viewedSessionId
                          return `
                            <div class="org-session-item${isCurrent ? " is-active" : ""}">
                              <button type="button" class="org-session-open" data-agent-chat="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" data-agent-session="${escapeAttribute(sess.runtimeSessionId)}">
                                <span class="agent-status-dot tone-${sess.tone}"></span>
                                <span class="org-session-title">${escapeHtml(sess.title || "Conversation")}</span>
                                ${sess.origin === "task" ? `<span class="org-role-pill">Task</span>` : ""}
                                <span class="org-session-time">${escapeHtml(relativeTimeLabel(sess.updatedAt))}</span>
                              </button>
                            </div>
                          `
                        })
                        .join("") +
                      (sessions.length > limit
                        ? `<button type="button" class="sidebar-load-more" data-agent-more-sessions="${escapeAttribute(limitKey)}">Show ${sessions.length - limit} more</button>`
                        : "")
                }
              </div>`
            : ""
        }
      </div>
      ${childrenHtml}
    </div>
  `
}

export function renderSidebarAgentsHtml(options: {
  snapshot: AgentsSnapshotData
  surface: DesktopAgentSurfaceState
  chatContext: SessionAgentContext
  collapsedTeams: ReadonlySet<string>
  expandedSidebarMembers?: ReadonlySet<string>
  managerExpanded?: boolean
  teamSessionsByTeam?: Record<string, Array<Record<string, any>>>
  managerSessions?: Array<Record<string, any>>
  archivedTeams?: Array<Record<string, any>>
  viewedSessionId?: string
  itemMenuKey?: string
  sessionMenuId?: string
  sessionDeleteConfirmId?: string
  sessionDeleteBusyId?: string
  sessionLimits?: Record<string, number>
  newTeamOpen: boolean
  busy: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const inboxCount = inboxBadgeCount(snapshot)
  const bgCount = activeBackgroundCount(snapshot)
  const isInbox = options.surface.kind === "inbox"
  const isBg = options.surface.kind === "background"
  const isArchive = options.surface.kind === "archive"
  const isManagerActive =
    options.surface.kind === "manager" || (options.surface.kind === "chat" && options.chatContext.kind === "manager")
  const expandedMembers = options.expandedSidebarMembers || new Set<string>()
  const teamSessionsByTeam = options.teamSessionsByTeam || {}
  const managerSessionsList = mergeManagerSessions(snapshot, options.managerSessions || [])
  const archivedList = options.archivedTeams?.length ? options.archivedTeams : snapshot.archivedTeams
  const itemMenuKey = options.itemMenuKey || ""
  const sessionMenuId = options.sessionMenuId || ""
  const sessionDeleteConfirmId = options.sessionDeleteConfirmId || ""
  const sessionDeleteBusyId = options.sessionDeleteBusyId || ""
  const sessionLimits = options.sessionLimits || {}

  const managerLimit = sessionLimits.manager || DEFAULT_SIDEBAR_SESSIONS_LIMIT
  const visibleManagerSessions = managerSessionsList.slice(0, managerLimit)
  const managerMenuOpen = itemMenuKey === "manager"
  const managerHasOpenSessionMenu = Boolean(
    options.managerExpanded &&
      visibleManagerSessions.some(
        (sess) =>
          sessionMenuId === `manager:${sess.runtimeSessionId}` ||
          sessionMenuId === sess.runtimeSessionId,
      ),
  )
  const managerItemMenuOpen = managerMenuOpen || managerHasOpenSessionMenu

  const managerSessionsHtml = options.managerExpanded
    ? `<div class="project-sessions${managerHasOpenSessionMenu ? " menu-open" : ""}" role="group" aria-label="Manager sessions">
        ${
          visibleManagerSessions.length === 0
            ? `<p class="session-search-empty">No sessions yet.</p>`
            : visibleManagerSessions
                .map((sess) => {
                  const isCurrent =
                    options.surface.kind === "chat" &&
                    options.chatContext.kind === "manager" &&
                    sess.runtimeSessionId === options.viewedSessionId
                  const sessMenuKey = `manager:${sess.runtimeSessionId}`
                  return renderAgentSidebarSessionRow({
                    sess,
                    menuKey: sessMenuKey,
                    isCurrent,
                    menuOpen: sessionMenuId === sessMenuKey || sessionMenuId === sess.runtimeSessionId,
                    confirmingDelete: sessionDeleteConfirmId === sess.runtimeSessionId,
                    deleting: sessionDeleteBusyId === sess.runtimeSessionId,
                    openAttrs: `data-sidebar-open-manager-session="${escapeAttribute(sess.runtimeSessionId)}"`,
                  })
                })
                .join("")
        }
        ${
          managerSessionsList.length > managerLimit
            ? `<button type="button" class="sidebar-load-more" data-agent-more-sessions="manager">View more sessions</button>`
            : ""
        }
      </div>`
    : ""

  const teamRows = snapshot.teams
    .map((team) => {
      const summary = buildTeamSummary(snapshot, team.id, teamSessionsByTeam[team.id] || [])
      const isSelectedTeam = options.surface.kind === "team" && options.surface.teamId === team.id
      const isCollapsed = options.collapsedTeams.has(team.id)
      const attentionCount = summary ? summary.counts.tasksAttention + summary.counts.attention : 0
      const workingCount = summary ? summary.counts.working : 0
      const membersCount = summary?.counts.members ?? 0
      const tasksCount = summary?.counts.tasksTotal ?? 0
      const teamMenuKey = `team:${team.id}`
      const teamMenuOpen = itemMenuKey === teamMenuKey
      const membersCountLabel = `${membersCount} ${membersCount === 1 ? "member" : "members"}`

      const renderSidebarMemberBranch = (member: OrgMemberSummary, depth = 0): string => {
        const memberKey = `${team.id}:${member.agentId}`
        const memberMenuKey = `member:${memberKey}`
        const memberMenuOpen = itemMenuKey === memberMenuKey
        const isMemberActive =
          options.surface.kind === "chat" &&
          options.chatContext.kind === "member" &&
          options.chatContext.agentId === member.agentId
        const isMemberExpanded = expandedMembers.has(memberKey)
        const memberSessions = member.sessions || []
        const memberLimit = sessionLimits[memberKey] || DEFAULT_SIDEBAR_SESSIONS_LIMIT
        const visibleMemberSessions = memberSessions.slice(0, memberLimit)
        const memberHasOpenSessionMenu = Boolean(
          isMemberExpanded &&
            visibleMemberSessions.some(
              (sess) =>
                sessionMenuId === `member:${memberKey}:${sess.runtimeSessionId}` ||
                sessionMenuId === sess.runtimeSessionId,
            ),
        )
        const memberItemMenuOpen = memberMenuOpen || memberHasOpenSessionMenu
        const childrenHtml =
          Array.isArray(member.children) && member.children.length > 0
            ? `<div class="sidebar-org-children" role="group" aria-label="Direct reports of ${escapeAttribute(member.name)}">${member.children
                .map((child) => renderSidebarMemberBranch(child, depth + 1))
                .join("")}</div>`
            : ""
        const branchMenuOpen = memberItemMenuOpen || childrenHtml.includes(" menu-open")

        return `
          <div class="sidebar-org-branch${branchMenuOpen ? " menu-open" : ""}" data-org-depth="${depth}" data-agent-id="${escapeAttribute(member.agentId)}">
            <section class="project-item member-project-item${isMemberExpanded ? " expanded" : ""}${isMemberActive ? " is-selected-member" : ""}${memberItemMenuOpen ? " menu-open" : ""}">
              <div class="project-row${memberMenuOpen ? " menu-open" : ""}">
                <button type="button" class="project-trigger" data-sidebar-toggle-member="${escapeAttribute(memberKey)}" aria-expanded="${isMemberExpanded}" title="${escapeAttribute(member.name)}">
                  <span class="project-name-row">
                    <span class="agent-status-dot tone-${member.tone}"></span>
                    <span class="project-name">${escapeHtml(member.name)}</span>
                  </span>
                </button>
                <div class="project-menu-wrap${memberMenuOpen ? " menu-open" : ""}">
                  <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="${escapeAttribute(memberMenuKey)}" title="Member actions" aria-label="Actions for ${escapeAttribute(member.name)}" aria-haspopup="menu" aria-expanded="${String(memberMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
                  ${
                    memberMenuOpen
                      ? `<div class="project-menu" role="menu">
                          <button type="button" data-agent-new-session="${escapeAttribute(member.agentId)}" data-agent-team="${escapeAttribute(team.id)}" role="menuitem">New chat</button>
                          <button type="button" data-sidebar-member-assign="${escapeAttribute(member.agentId)}" data-team-id="${escapeAttribute(team.id)}" role="menuitem">Assign task</button>
                          <button type="button" data-agent-remove="${escapeAttribute(member.agentId)}" data-agent-team="${escapeAttribute(team.id)}" role="menuitem">Remove</button>
                        </div>`
                      : ""
                  }
                </div>
              </div>
              ${
                isMemberExpanded
                  ? `<div class="project-sessions member-sessions-group${memberHasOpenSessionMenu ? " menu-open" : ""}" role="group" aria-label="${escapeAttribute(member.name)} sessions">
                      ${
                        visibleMemberSessions.length === 0
                          ? `<p class="session-search-empty">No sessions yet.</p>`
                          : visibleMemberSessions
                              .map((sess) => {
                                const isCurrent =
                                  options.surface.kind === "chat" &&
                                  sess.runtimeSessionId === options.viewedSessionId
                                const sessMenuKey = `member:${memberKey}:${sess.runtimeSessionId}`
                                return renderAgentSidebarSessionRow({
                                  sess,
                                  menuKey: sessMenuKey,
                                  isCurrent,
                                  menuOpen: sessionMenuId === sessMenuKey || sessionMenuId === sess.runtimeSessionId,
                                  confirmingDelete: sessionDeleteConfirmId === sess.runtimeSessionId,
                                  deleting: sessionDeleteBusyId === sess.runtimeSessionId,
                                  openAttrs: `data-agent-chat="${escapeAttribute(member.agentId)}" data-agent-team="${escapeAttribute(team.id)}" data-agent-session="${escapeAttribute(sess.runtimeSessionId)}"`,
                                })
                              })
                              .join("")
                      }
                      ${
                        memberSessions.length > memberLimit
                          ? `<button type="button" class="sidebar-load-more" data-agent-more-sessions="${escapeAttribute(memberKey)}">View more sessions</button>`
                          : ""
                      }
                    </div>`
                  : ""
              }
            </section>
            ${childrenHtml}
          </div>
        `
      }

      const rootNodes = summary ? (summary.orgRoots.length > 0 ? summary.orgRoots : summary.members) : []
      const renderedMembers =
        !isCollapsed && summary && rootNodes.length > 0
          ? rootNodes.map((rootNode) => renderSidebarMemberBranch(rootNode, 0)).join("")
          : ""
      const membersGroupMenuOpen = renderedMembers.includes(" menu-open")
      const membersHtml =
        !isCollapsed && summary
          ? `<div class="project-sessions team-members-group${membersGroupMenuOpen ? " menu-open" : ""}" role="group" aria-label="${escapeAttribute(team.name)} members">${
              rootNodes.length === 0 ? `<p class="session-search-empty">No members yet.</p>` : renderedMembers
            }</div>`
          : ""
      const teamItemMenuOpen = teamMenuOpen || membersGroupMenuOpen

      return `
        <section class="project-item team-project-item${!isCollapsed ? " expanded" : ""}${isSelectedTeam ? " is-selected-team" : ""}${teamItemMenuOpen ? " menu-open" : ""}">
          <div class="project-row${teamMenuOpen ? " menu-open" : ""}">
            <button type="button" class="project-trigger" data-sidebar-toggle-team="${escapeAttribute(team.id)}" aria-expanded="${!isCollapsed}" title="${escapeAttribute(team.createRoot || team.name)}">
              <span class="project-name-row">
                <span class="project-name">${escapeHtml(String(team.name || team.id))}</span>
                ${workingCount > 0 ? `<span class="sidebar-mini-dot working" title="Working"></span>` : ""}
                ${attentionCount > 0 ? `<span class="sidebar-nav-badge attention">${attentionCount}</span>` : ""}
              </span>
              ${
                !isCollapsed
                  ? `<span class="team-trigger-meta-wrap"><span class="team-trigger-meta">${escapeHtml(membersCountLabel)}</span></span>`
                  : ""
              }
            </button>
            <div class="project-menu-wrap${teamMenuOpen ? " menu-open" : ""}">
              <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="${escapeAttribute(teamMenuKey)}" title="Team actions" aria-label="Team actions for ${escapeAttribute(team.name)}" aria-haspopup="menu" aria-expanded="${String(teamMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
              ${
                teamMenuOpen
                  ? `<div class="project-menu" role="menu">
                      <button type="button" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="organization" role="menuitem">Organization</button>
                      <button type="button" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="tasks" role="menuitem">Tasks (${tasksCount})</button>
                      <button type="button" data-sidebar-team-action="assign" data-team-id="${escapeAttribute(team.id)}" role="menuitem">Assign task</button>
                      <button type="button" data-sidebar-team-action="add-member" data-team-id="${escapeAttribute(team.id)}" role="menuitem">Add member</button>
                      <button type="button" data-sidebar-team-action="delete" data-team-id="${escapeAttribute(team.id)}" role="menuitem">Delete team</button>
                    </div>`
                  : ""
              }
            </div>
          </div>
          ${membersHtml}
        </section>
      `
    })
    .join("")

  return `
    <div class="sidebar-actions">
      <button type="button" class="primary-button" data-agent-top-new-chat="1" title="Start a new chat with the active agent or Manager">New chat</button>
    </div>
    <div class="sidebar-body panel-scroll">
      <section class="sidebar-projects" aria-label="Multi-agent workspaces">
        <div class="sidebar-global-nav" role="navigation" aria-label="Multi-agent surfaces">
          <div class="session-item-row">
            <button type="button" class="session-item${isInbox ? " selected" : ""}" data-sidebar-surface="inbox"${isInbox ? ' aria-current="page"' : ""}>
              <span class="session-item-title"><span class="session-item-title-text">Inbox</span></span>
              ${inboxCount > 0 ? `<span class="sidebar-nav-badge attention">${inboxCount}</span>` : ""}
            </button>
          </div>
          <div class="session-item-row">
            <button type="button" class="session-item${isBg ? " selected" : ""}" data-sidebar-surface="background"${isBg ? ' aria-current="page"' : ""}>
              <span class="session-item-title"><span class="session-item-title-text">Background</span></span>
              ${bgCount > 0 ? `<span class="sidebar-nav-badge working">${bgCount}</span>` : ""}
            </button>
          </div>
          ${
            archivedList.length > 0
              ? `<div class="session-item-row">
                  <button type="button" class="session-item${isArchive ? " selected" : ""}" data-sidebar-surface="archive"${isArchive ? ' aria-current="page"' : ""}>
                    <span class="session-item-title"><span class="session-item-title-text">Archive</span></span>
                    <span class="sidebar-nav-tag">${archivedList.length}</span>
                  </button>
                </div>`
              : ""
          }
        </div>
        <div class="project-list">
          <section class="project-item manager-project-item${options.managerExpanded ? " expanded" : ""}${isManagerActive ? " is-selected-team" : ""}${managerItemMenuOpen ? " menu-open" : ""}">
            <div class="project-row${managerMenuOpen ? " menu-open" : ""}">
              <button type="button" class="project-trigger" data-sidebar-toggle-manager="1" aria-expanded="${Boolean(options.managerExpanded)}" title="Organization coordinator">
                <span class="project-name">Manager</span>
              </button>
              <div class="project-menu-wrap${managerMenuOpen ? " menu-open" : ""}">
                <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="manager" title="Manager actions" aria-label="Manager actions" aria-haspopup="menu" aria-expanded="${String(managerMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
                ${
                  managerMenuOpen
                    ? `<div class="project-menu" role="menu">
                        <button type="button" data-sidebar-new-manager-session="1" role="menuitem">New chat</button>
                        <button type="button" data-sidebar-surface="manager" role="menuitem">Coordinator panel</button>
                      </div>`
                    : ""
                }
              </div>
            </div>
            ${managerSessionsHtml}
          </section>
        </div>
      </section>
      <section class="sidebar-projects" aria-label="Teams">
        <div class="sidebar-heading">
          <h2 class="sidebar-section-title">Teams</h2>
          <button type="button" class="ghost-button" data-sidebar-toggle-new-team="1" title="Add team">${options.newTeamOpen ? "Close" : "Add"}</button>
        </div>
        ${
          options.newTeamOpen
            ? `<form id="sidebar-new-team-form" class="sidebar-new-team-form">
                <input id="sidebar-new-team-name" type="text" class="agent-input sm" placeholder="Team name (e.g. Core Platform)" required />
                <div class="sidebar-new-team-actions">
                  <button type="button" class="agent-btn ghost sm" data-sidebar-toggle-new-team="1">Cancel</button>
                  <button type="submit" class="agent-btn primary sm" ${options.busy ? "disabled" : ""}>Create</button>
                </div>
              </form>`
            : ""
        }
        ${
          snapshot.teams.length === 0
            ? `<div class="sidebar-empty"><strong>No teams</strong><span>Create a team or ask Manager to set one up.</span></div>`
            : `<div class="project-list sidebar-teams-list">${teamRows}</div>`
        }
      </section>
    </div>
  `
}

const HEADER_CHEVRON_DOWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-select-chevron" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>`
const HEADER_CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-select-check-icon" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`

export function renderHeaderAgentBreadcrumbHtml(
  context: SessionAgentContext,
  options: {
    sessions?: MemberSessionSummary[]
    viewedSessionId?: string
    menuOpen?: boolean
  } = {},
): string {
  if (!context || context.kind === "independent") return ""
  const sessions = options.sessions || []
  const menuOpen = Boolean(options.menuOpen)
  const sessionsSwitcherHtml = `
    <div class="header-sessions-dropdown-wrap">
      <button type="button" class="header-agent-action" data-header-toggle-sessions="1" aria-expanded="${menuOpen}">
        <span>Sessions (${sessions.length})</span>
        ${HEADER_CHEVRON_DOWN_SVG}
      </button>
      ${
        menuOpen
          ? `<div class="header-sessions-menu" role="menu">
              <div class="header-sessions-menu-head">
                <span>${escapeHtml(context.agentName)} conversations</span>
                <button type="button" class="agent-btn primary sm" ${
                  context.kind === "manager"
                    ? `data-sidebar-new-manager-session="1"`
                    : `data-agent-new-session="${escapeAttribute(context.agentId)}" data-agent-team="${escapeAttribute(context.teamId)}"`
                }>New chat</button>
              </div>
              <div class="header-sessions-menu-list panel-scroll">
                ${
                  sessions.length === 0
                    ? `<div class="org-sessions-empty">No saved conversations yet.</div>`
                    : sessions
                        .slice(0, DEFAULT_SIDEBAR_SESSIONS_LIMIT)
                        .map((sess) => {
                          const isCurrent = sess.runtimeSessionId === options.viewedSessionId
                          return `
                            <div class="org-session-item${isCurrent ? " is-active" : ""}">
                              <button type="button" role="menuitem" aria-current="${isCurrent ? "true" : "false"}" class="org-session-open" ${
                                context.kind === "manager"
                                  ? `data-sidebar-open-manager-session="${escapeAttribute(sess.runtimeSessionId)}"`
                                  : `data-agent-chat="${escapeAttribute(context.agentId)}" data-agent-team="${escapeAttribute(context.teamId)}" data-agent-session="${escapeAttribute(sess.runtimeSessionId)}"`
                              }>
                                <span class="agent-status-dot tone-${sess.tone}"></span>
                                <span class="org-session-title">${escapeHtml(sess.title || "Conversation")}</span>
                                <span class="org-session-time">${escapeHtml(relativeTimeLabel(sess.updatedAt))}</span>
                                ${isCurrent ? `<span class="settings-select-check" aria-hidden="true">${HEADER_CHECK_SVG}</span>` : ""}
                              </button>
                            </div>
                          `
                        })
                        .join("")
                }
              </div>
            </div>`
          : ""
      }
    </div>
  `

  if (context.kind === "manager") {
    return `
      <div class="header-agent-breadcrumb">
        <button type="button" class="header-agent-pill manager" data-sidebar-surface="manager" title="Manager">
          <span class="agent-status-dot tone-working"></span>
          <span>Manager</span>
        </button>
        ${sessionsSwitcherHtml}
      </div>
    `
  }
  const tone = memberStatusTone(context.status)
  return `
    <div class="header-agent-breadcrumb">
      <button type="button" class="header-team-link" data-sidebar-open-team="${escapeAttribute(context.teamId)}" data-sidebar-team-tab="organization" title="Open team ${escapeAttribute(context.teamName)}">${escapeHtml(context.teamName)}</button>
      <span class="header-breadcrumb-sep" aria-hidden="true">/</span>
      <span class="header-agent-pill member" title="${escapeAttribute(context.agentName)}"><span class="agent-status-dot tone-${tone}"></span><span>${escapeHtml(context.agentName)}</span></span>
      ${sessionsSwitcherHtml}
    </div>
  `
}

export function renderTaskDrawerHtml(options: {
  task: EnrichedTask | null
  busy: boolean
  artifactPreview: { artifactId?: string; path: string; content: string; truncated: boolean } | null
  width?: number
  expanded?: boolean
}): string {
  const { task, busy, artifactPreview, width, expanded = false } = options
  if (!task) return ""
  const needsUserAnswer = task.status === "blocked" && task.blockedOn?.responder === "user"
  const canReviewReport = task.status === "done" && Boolean(task.report) && !task.parentTaskId
  const canStartNow = task.status === "queued"
  const canStopRun = task.activeRun && (task.activeRun.status === "starting" || task.activeRun.status === "running")
  const canCancel = task.status === "queued" || task.status === "running" || task.status === "blocked"
  const reportEvidence: string[] = Array.isArray(task.report?.evidence) ? task.report.evidence : []
  const publishedFiles: Array<Record<string, any>> =
    Array.isArray(task.artifactRecords) && task.artifactRecords.length > 0
      ? task.artifactRecords
      : Array.isArray(task.report?.files)
        ? task.report.files
        : []
  const styleAttr = !expanded && width && width >= 320 ? ` style="width: ${Math.round(width)}px;"` : ""

  return `
    <aside class="agent-task-drawer${expanded ? " is-expanded" : ""}" aria-label="Task inspection drawer"${styleAttr}>
      <div class="task-drawer-resize-handle" data-task-drawer-resize="1" role="separator" aria-orientation="vertical" aria-label="Resize task report panel" title="Drag to resize · Double-click to toggle wide view"></div>
      <header class="agent-drawer-head">
        <div class="agent-drawer-title-group">
          <div class="agent-drawer-meta-row">
            <span class="agent-status-pill tone-${task.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(task.statusLabel)}</span></span>
            <span class="agent-drawer-subtitle">${escapeHtml(task.teamName)} › <strong>${escapeHtml(task.assigneeName)}</strong></span>
            ${
              task.status === "queued"
                ? renderCustomSelectHtml({
                    ariaLabel: "Task priority",
                    value: task.priority,
                    disabled: busy,
                    sm: true,
                    dataAttrs: { "task-priority": task.id },
                    options: [
                      { value: "high", label: "High" },
                      { value: "normal", label: "Normal" },
                      { value: "low", label: "Low" },
                    ],
                  })
                : task.priority !== "normal"
                  ? `<span class="agent-priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>`
                  : ""
            }
          </div>
          <h3 class="agent-drawer-title">${escapeHtml(task.brief)}</h3>
        </div>
        <div class="agent-drawer-head-actions">
          <button type="button" class="icon-button" data-task-drawer-expand="1" aria-pressed="${expanded}" aria-label="${expanded ? "Restore panel width" : "Expand for wide reading"}" title="${expanded ? "Restore panel width" : "Expand for wide reading"}">${expanded ? "❐" : "⤢"}</button>
          <button type="button" class="icon-button" data-task-drawer-close="1" aria-label="Close task drawer" title="Close (Esc)">✕</button>
        </div>
      </header>
      <div class="agent-drawer-body panel-scroll">
        <div class="agent-drawer-actions-bar">
          ${canStartNow ? `<button type="button" class="agent-btn primary sm" data-task-start="${escapeAttribute(task.id)}" ${busy ? "disabled" : ""}>Start Now</button>` : ""}
          <button type="button" class="agent-btn secondary sm" data-agent-chat="${escapeAttribute(task.assigneeAgentId)}" data-agent-team="${escapeAttribute(task.teamId)}" data-agent-session="${escapeAttribute(task.runtimeSessionId)}">${task.runtimeSessionId ? "Open Session" : `Chat with ${escapeHtml(task.assigneeName)}`}</button>
          ${canStopRun && task.activeRun ? `<button type="button" class="agent-btn warning sm" data-inbox-stop-run="${escapeAttribute(String(task.activeRun.id))}" ${busy ? "disabled" : ""}>Stop Run</button>` : ""}
          ${canCancel ? `<button type="button" class="agent-btn ghost sm danger-text" data-task-cancel="${escapeAttribute(task.id)}" ${busy ? "disabled" : ""}>Cancel</button>` : ""}
        </div>
        ${
          needsUserAnswer
            ? `<section class="agent-drawer-card attention-card">
                <div class="agent-card-kicker">Waiting on your answer</div>
                <p class="agent-blocker-question">${escapeHtml(String(task.blockedOn?.action || "The agent needs your clarification to proceed."))}</p>
                <form id="agent-task-answer-form" class="agent-inline-form" data-task-id="${escapeAttribute(task.id)}">
                  <textarea id="agent-task-answer-input" class="agent-textarea" rows="2" placeholder="Write your answer to resume..." required></textarea>
                  <div class="agent-form-actions">
                    <button type="submit" class="agent-btn primary sm" ${busy ? "disabled" : ""}>Send Answer &amp; Resume</button>
                  </div>
                </form>
              </section>`
            : ""
        }
        ${
          task.error
            ? `<section class="agent-drawer-card danger-card"><div class="agent-card-kicker">Issue</div><p class="agent-report-text">${escapeHtml(String(task.error))}</p></section>`
            : ""
        }
        ${
          task.report
            ? `<section class="agent-drawer-card report-card">
                <div class="agent-card-header-row">
                  <div class="agent-card-kicker">Delivery Report · ${escapeHtml(String(task.report.outcome || "Completed"))}</div>
                  ${task.deliveredAt ? `<span class="agent-timestamp">${escapeHtml(relativeTimeLabel(task.deliveredAt))}</span>` : ""}
                </div>
                <div class="agent-report-section">
                  <p class="agent-report-text">${escapeHtml(String(task.report.summary || ""))}</p>
                </div>
                ${
                  reportEvidence.length > 0
                    ? `<div class="agent-report-section">
                        <h4>Verification</h4>
                        <ul class="agent-evidence-list">
                          ${reportEvidence.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}
                        </ul>
                      </div>`
                    : ""
                }
                ${
                  publishedFiles.length > 0
                    ? `<div class="agent-report-section">
                        <h4>Artifacts (${publishedFiles.length})</h4>
                        <div class="agent-artifact-list">
                          ${publishedFiles
                            .map((art) => {
                              const artId = String(art.id || "")
                              const filePath = String(art.sourcePath || art.publishedPath || art.label || "")
                              const isPreviewing =
                                (artId && artifactPreview?.artifactId === artId) ||
                                (filePath && artifactPreview?.path === filePath)
                              return `
                                <div class="agent-artifact-item">
                                  <div class="agent-artifact-meta">
                                    <strong>${escapeHtml(String(art.label || filePath))}</strong>
                                  </div>
                                  ${
                                    artId
                                      ? `<button type="button" class="agent-btn ghost sm" data-task-read-artifact="${escapeAttribute(artId)}" data-artifact-path="${escapeAttribute(filePath)}">${isPreviewing ? "Hide" : "Preview"}</button>`
                                      : ""
                                  }
                                </div>
                              `
                            })
                            .join("")}
                        </div>
                        ${
                          artifactPreview
                            ? `<div class="agent-artifact-preview"><div class="agent-artifact-preview-head"><code>${escapeHtml(artifactPreview.path)}</code>${artifactPreview.truncated ? `<span>Truncated</span>` : ""}</div><pre class="agent-report-pre">${escapeHtml(artifactPreview.content)}</pre></div>`
                            : ""
                        }
                      </div>`
                    : ""
                }
                ${
                  task.report.next
                    ? `<div class="agent-report-section"><h4>Next Step</h4><p class="agent-report-text">${escapeHtml(String(task.report.next))}</p></div>`
                    : ""
                }
                ${
                  canReviewReport
                    ? `<div class="agent-review-box">
                        ${task.review?.feedback ? `<p class="agent-review-existing">Feedback: ${escapeHtml(String(task.review.feedback))}</p>` : ""}
                        <textarea id="agent-task-review-comment" class="agent-textarea" rows="2" placeholder="Optional review feedback or rework instructions..."></textarea>
                        <div class="agent-form-actions">
                          <button type="button" class="agent-btn primary sm" data-task-review="${escapeAttribute(task.id)}" data-review-decision="accept" ${busy ? "disabled" : ""}>Accept Delivery</button>
                          <button type="button" class="agent-btn warning sm" data-task-review="${escapeAttribute(task.id)}" data-review-decision="rework" ${busy ? "disabled" : ""}>Send for Rework</button>
                        </div>
                      </div>`
                    : ""
                }
              </section>`
            : ""
        }
        <section class="agent-drawer-card">
          <div class="agent-card-kicker">Notes${task.notes.length > 0 ? ` (${task.notes.length})` : ""}</div>
          ${
            task.notes.length > 0
              ? `<div class="agent-notes-list">${task.notes
                  .map(
                    (note) => `<div class="agent-note-item"><div class="agent-note-meta"><strong>${escapeHtml(String(note.author || "user"))}</strong><span>${escapeHtml(relativeTimeLabel(note.createdAt))}</span></div><p>${escapeHtml(String(note.text || ""))}</p></div>`,
                  )
                  .join("")}</div>`
              : ""
          }
          <form id="agent-task-note-form" class="agent-inline-form-row" data-task-id="${escapeAttribute(task.id)}">
            <input id="agent-task-note-input" type="text" class="agent-input sm" placeholder="Add guidance or a note..." />
            <button type="submit" class="agent-btn secondary sm" ${busy ? "disabled" : ""}>Add Note</button>
          </form>
        </section>
      </div>
    </aside>
  `
}

export function renderTeamSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  surface: Extract<DesktopAgentSurfaceState, { kind: "team" }>
  teamSessions?: Array<Record<string, any>>
  orgViewMode?: OrgViewMode
  expandedFlowNodes?: ReadonlySet<string>
  expandedOrgMembers?: ReadonlySet<string>
  viewedSessionId?: string
  sessionLimits?: Record<string, number>
  itemMenuKey?: string
  busy: boolean
  artifactPreview: { artifactId?: string; path: string; content: string; truncated: boolean } | null
  drawerWidth?: number
  drawerExpanded?: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const { surface, busy, artifactPreview } = options
  const orgViewMode: OrgViewMode = options.orgViewMode === "detailed" ? "detailed" : DEFAULT_ORG_VIEW_MODE
  const summary = buildTeamSummary(snapshot, surface.teamId, options.teamSessions || [])
  if (!summary) {
    return `<div class="agent-surface-empty"><h2>Team not found</h2><p>Select another team from the sidebar.</p></div>`
  }
  const { team, leader, members, orgRoots, counts } = summary
  const groupedTasks = groupTeamTasks(snapshot, team.id)
  const selectedTask = surface.selectedTaskId ? groupedTasks.all.find((t) => t.id === surface.selectedTaskId) || null : null
  const itemMenuKey = options.itemMenuKey || ""
  const headerMenuKey = `team-surface:${team.id}`
  const headerMenuOpen = itemMenuKey === headerMenuKey

  const addMemberFormHtml = surface.addMemberOpen
    ? `<form id="agent-add-member-form" class="agent-inline-panel" data-team-id="${escapeAttribute(team.id)}">
        <div class="agent-panel-head">
          <h3>Add Member</h3>
          <div class="agent-segmented" role="group" aria-label="Member source">
            <button type="button" class="agent-seg-btn${surface.memberMode === "workspace" ? " is-active" : ""}" data-member-mode="workspace">Managed Workspace</button>
            <button type="button" class="agent-seg-btn${surface.memberMode === "worktree" ? " is-active" : ""}" data-member-mode="worktree">Git Worktree</button>
            <button type="button" class="agent-seg-btn${surface.memberMode === "existing" ? " is-active" : ""}" data-member-mode="existing">Existing Folder</button>
          </div>
        </div>
        <div class="agent-form-grid">
          <label class="agent-field"><span>Agent Name</span><input name="name" type="text" class="agent-input" placeholder="e.g. frontend-specialist" required /></label>
          ${
            surface.memberMode === "worktree"
              ? `<label class="agent-field"><span>Source Git Repository</span><input name="repository" type="text" class="agent-input" value="${escapeAttribute(team.createRoot)}" placeholder="${escapeAttribute(team.createRoot || "Path to git repository")}" required /></label>
                 <label class="agent-field"><span>Branch Name (optional)</span><input name="branch" type="text" class="agent-input" placeholder="e.g. feat/agent-worktree" /></label>`
              : surface.memberMode === "existing"
                ? `<label class="agent-field"><span>Existing Workspace Folder</span><input name="workspace" type="text" class="agent-input" placeholder="Absolute path to folder" required /></label>`
                : ""
          }
          <label class="agent-field"><span>Role / Position</span><input name="position" type="text" class="agent-input" placeholder="e.g. UI Specialist" /></label>
          <div class="agent-field"><span>Reports To</span>${renderCustomSelectHtml({
            name: "reportsToAgentId",
            ariaLabel: "Reports To",
            value: "",
            options: [
              { value: "", label: leader ? `${leader.name} (Leader)` : "Team Leader" },
              ...members.map((m) => ({ value: m.agentId, label: `${m.name} (${m.position})` })),
            ],
          })}</div>
          <label class="agent-field span-2"><span>Responsibility</span><input name="responsibility" type="text" class="agent-input" placeholder="Primary area of ownership" /></label>
        </div>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost sm" data-team-toggle-add-member="0">Cancel</button>
          <button type="submit" class="agent-btn primary sm" ${busy ? "disabled" : ""}>Add Member</button>
        </div>
      </form>`
    : ""

  const assignFormHtml = surface.assignOpen
    ? `<form id="agent-assign-task-form" class="agent-inline-panel" data-team-id="${escapeAttribute(team.id)}">
        <div class="agent-panel-head"><h3>Assign Task</h3></div>
        <div class="agent-form-grid">
          <div class="agent-field"><span>Assignee</span>${renderCustomSelectHtml({
            name: "assigneeAgentId",
            ariaLabel: "Assignee",
            value: surface.assignAgentId || "",
            options: [
              { value: "", label: leader ? `${leader.name} (Leader)` : "Select member..." },
              ...members.map((m) => ({ value: m.agentId, label: `${m.name} · ${m.position}` })),
            ],
          })}</div>
          <div class="agent-field"><span>Priority</span>${renderCustomSelectHtml({
            name: "priority",
            ariaLabel: "Priority",
            value: "normal",
            options: [
              { value: "high", label: "High" },
              { value: "normal", label: "Normal" },
              { value: "low", label: "Low" },
            ],
          })}</div>
          <label class="agent-field span-2"><span>Task Brief</span><textarea name="brief" class="agent-textarea" rows="3" placeholder="Describe the objective and expected deliverables..." required></textarea></label>
        </div>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost sm" data-team-toggle-assign="0">Cancel</button>
          <button type="submit" class="agent-btn primary sm" ${busy ? "disabled" : ""}>Dispatch Task</button>
        </div>
      </form>`
    : ""

  const deleteConfirmHtml = surface.deleteConfirmOpen
    ? `<form id="agent-delete-team-form" class="agent-inline-panel danger-panel" data-team-id="${escapeAttribute(team.id)}">
        <div class="agent-panel-head"><h3>Delete Team "${escapeHtml(team.name)}"?</h3></div>
        <p class="agent-empty-hint">Type <strong>${escapeHtml(team.name)}</strong> to archive this team and stop active runs:</p>
        <div class="agent-form-grid">
          <input id="agent-delete-confirm-name" name="confirmName" type="text" class="agent-input" placeholder="${escapeAttribute(team.name)}" required />
        </div>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost sm" data-team-toggle-delete="0">Cancel</button>
          <button type="submit" class="agent-btn danger-ghost sm" ${busy ? "disabled" : ""}>Confirm Delete</button>
        </div>
      </form>`
    : ""

  const nonEmptyTaskSections = TASK_SECTION_DEFS.map((sec) => ({
    ...sec,
    items: groupedTasks.sections[sec.id].filter(
      (t) => !surface.assigneeFilter || t.assigneeAgentId === surface.assigneeFilter,
    ),
  })).filter((sec) => sec.items.length > 0)

  const bodyHtml =
    surface.tab === "organization"
      ? `<div class="agent-org-canvas ${orgViewMode === "minimal" ? "is-flow-view" : "is-cards-view"}">
          ${
            orgRoots.length === 0
              ? `<div class="agent-empty-box"><h3>No members yet</h3><p>Add a team leader and specialists to start collaborating.</p><button type="button" class="agent-btn primary sm" data-team-toggle-add-member="1">+ Add Member</button></div>`
              : orgViewMode === "minimal"
                ? `<div class="org-flow-canvas" role="tree" aria-label="${escapeAttribute(team.name)} organization hierarchy"><div class="org-flow-roots">${orgRoots
                    .map((rootNode) =>
                      renderOrgFlowNodeHtml(
                        rootNode,
                        0,
                        options.expandedFlowNodes || new Set(),
                        options.expandedOrgMembers || new Set(),
                        options.viewedSessionId || "",
                        options.sessionLimits || {},
                        itemMenuKey,
                      ),
                    )
                    .join("")}</div></div>`
                : `<div class="org-tree-root" role="tree" aria-label="${escapeAttribute(team.name)} organization hierarchy">${orgRoots
                    .map((rootNode) =>
                      renderOrgNodeHtml(
                        rootNode,
                        0,
                        options.expandedOrgMembers || new Set(),
                        options.viewedSessionId || "",
                        options.sessionLimits || {},
                        itemMenuKey,
                      ),
                    )
                    .join("")}</div>`
          }
        </div>`
      : `<div class="agent-tasks-canvas">
          ${
            members.length > 1
              ? `<div class="agent-tasks-toolbar">
                  <div class="agent-filter-chips">
                    <button type="button" class="agent-filter-chip${!surface.assigneeFilter ? " is-active" : ""}" data-team-filter-assignee="">All (${groupedTasks.all.length})</button>
                    ${members.map((m) => `<button type="button" class="agent-filter-chip${surface.assigneeFilter === m.agentId ? " is-active" : ""}" data-team-filter-assignee="${escapeAttribute(m.agentId)}"><span class="agent-status-dot tone-${m.tone}"></span><span>${escapeHtml(m.name)}</span></button>`).join("")}
                  </div>
                </div>`
              : ""
          }
          ${
            nonEmptyTaskSections.length === 0
              ? `<div class="agent-empty-box"><h3>No tasks found</h3><p>Dispatch a task to the team leader or any specialist.</p><button type="button" class="agent-btn primary sm" data-team-toggle-assign="1">+ Assign Task</button></div>`
              : `<div class="agent-task-sections">
                  ${nonEmptyTaskSections
                    .map(
                      (sec) => `
                        <section class="agent-task-section">
                          <header class="agent-task-section-head">
                            <h4>${escapeHtml(sec.label)}</h4>
                            <span class="agent-tab-count">${sec.items.length}</span>
                          </header>
                          <div class="agent-task-list-table">
                            ${sec.items
                              .map(
                                (task) => `
                                  <button type="button" class="agent-task-list-row${surface.selectedTaskId === task.id ? " is-selected" : ""}" data-agent-select-task="${escapeAttribute(task.id)}" data-agent-team="${escapeAttribute(team.id)}">
                                    <span class="agent-status-pill tone-${task.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(task.statusLabel)}</span></span>
                                    <span class="agent-task-row-brief">${escapeHtml(task.brief)}${task.report?.summary ? ` <em class="agent-task-row-summary">— ${escapeHtml(String(task.report.summary))}</em>` : ""}</span>
                                    <span class="agent-task-row-meta">
                                      ${task.priority !== "normal" ? `<span class="agent-priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>` : ""}
                                      <span class="agent-task-row-assignee">${escapeHtml(task.assigneeName)}</span>
                                    </span>
                                  </button>
                                `,
                              )
                              .join("")}
                          </div>
                        </section>
                      `,
                    )
                    .join("")}
                </div>`
          }
        </div>`

  return `
    <div class="agent-surface team-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header${headerMenuOpen ? " menu-open" : ""}">
          <div class="agent-surface-headline-row">
            <h2 class="agent-surface-title">${escapeHtml(team.name)}</h2>
            <div class="agent-segmented" role="tablist" aria-label="Team surface views">
              <button type="button" role="tab" aria-selected="${surface.tab === "organization"}" class="agent-seg-btn${surface.tab === "organization" ? " is-active" : ""}" data-team-switch-tab="organization">Members <span class="agent-tab-count">${counts.members}</span></button>
              <button type="button" role="tab" aria-selected="${surface.tab === "tasks"}" class="agent-seg-btn${surface.tab === "tasks" ? " is-active" : ""}" data-team-switch-tab="tasks">Tasks <span class="agent-tab-count">${counts.tasksTotal}</span></button>
            </div>
            ${counts.working > 0 ? `<span class="agent-metric-pill tone-working">${counts.working} active</span>` : ""}
            ${counts.tasksAttention > 0 ? `<span class="agent-metric-pill tone-attention">${counts.tasksAttention} need review</span>` : ""}
          </div>
          <div class="agent-surface-actions">
            ${
              surface.tab === "organization"
                ? `<div class="agent-segmented org-view-switcher" role="group" aria-label="Organization layout view">
                    <button type="button" class="agent-seg-btn${orgViewMode === "minimal" ? " is-active" : ""}" data-org-view-mode="minimal" aria-pressed="${String(orgViewMode === "minimal")}" title="Minimalist workflow tree view">Flow</button>
                    <button type="button" class="agent-seg-btn${orgViewMode === "detailed" ? " is-active" : ""}" data-org-view-mode="detailed" aria-pressed="${String(orgViewMode === "detailed")}" title="Detailed member cards view">Cards</button>
                  </div>`
                : ""
            }
            <button type="button" class="agent-btn secondary sm" data-team-toggle-add-member="1">+ Member</button>
            <button type="button" class="agent-btn primary sm" data-team-toggle-assign="1">+ Task</button>
            <div class="project-menu-wrap${headerMenuOpen ? " menu-open" : ""}">
              <button type="button" class="project-menu-trigger ghost-button" data-agent-item-menu="${escapeAttribute(headerMenuKey)}" title="Team actions" aria-label="Team actions" aria-haspopup="menu" aria-expanded="${String(headerMenuOpen)}">${PROJECT_MENU_ICON_SVG}</button>
              ${
                headerMenuOpen
                  ? `<div class="project-menu" role="menu">
                      ${leader ? `<button type="button" data-agent-chat="${escapeAttribute(leader.agentId)}" data-agent-team="${escapeAttribute(team.id)}" data-agent-session="${escapeAttribute(leader.latestRuntimeSessionId)}" role="menuitem">Chat with Leader (${escapeHtml(leader.name)})</button>` : ""}
                      <button type="button" data-team-toggle-delete="1" role="menuitem">Delete team…</button>
                    </div>`
                  : ""
              }
            </div>
          </div>
        </header>
        ${deleteConfirmHtml}
        ${addMemberFormHtml}
        ${assignFormHtml}
        <div class="agent-surface-body panel-scroll">${bodyHtml}</div>
      </div>
      ${renderTaskDrawerHtml({
        task: selectedTask,
        busy,
        artifactPreview,
        width: options.drawerWidth,
        expanded: options.drawerExpanded,
      })}
    </div>
  `
}

export function renderManagerSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  managerSessions?: Array<Record<string, any>>
  viewedSessionId?: string
  busy: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const sessions = mergeManagerSessions(snapshot, options.managerSessions || [])
  const inbox = buildInboxSections(snapshot)

  return `
    <div class="agent-surface manager-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-headline-row">
            <h2 class="agent-surface-title">Manager</h2>
            <span class="agent-surface-meta">Organization Coordinator · ${snapshot.teams.length} ${snapshot.teams.length === 1 ? "team" : "teams"}</span>
          </div>
          <div class="agent-surface-actions">
            <button type="button" class="agent-btn secondary sm" data-sidebar-new-manager-session="1" ${options.busy ? "disabled" : ""}>+ New Chat</button>
            <button type="button" class="agent-btn primary sm" data-sidebar-open-manager="1" ${options.busy ? "disabled" : ""}>Resume Chat</button>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          <section class="agent-bg-section">
            <h3 class="agent-section-heading">Manager Conversations (${sessions.length})</h3>
            ${
              sessions.length === 0
                ? `<div class="agent-empty-box compact"><p>No Manager conversations yet. Start a chat to create or organize teams.</p></div>`
                : `<div class="agent-runs-list">
                    ${sessions
                      .map((sess) => {
                        const isCurrent = sess.runtimeSessionId === options.viewedSessionId
                        return `
                          <div class="agent-run-row${isCurrent ? " is-selected" : ""}">
                            <div class="agent-run-main">
                              <span class="agent-status-dot tone-${sess.tone}"></span>
                              <strong>${escapeHtml(sess.title || "Manager conversation")}</strong>
                              ${sess.status !== "Idle" ? `<span class="agent-status-pill tone-${sess.tone}">${escapeHtml(sess.status)}</span>` : ""}
                              <span class="agent-timestamp">${escapeHtml(relativeTimeLabel(sess.updatedAt))}</span>
                            </div>
                            <div class="agent-run-actions">
                              <button type="button" class="agent-btn secondary sm" data-sidebar-open-manager-session="${escapeAttribute(sess.runtimeSessionId)}">Open</button>
                              <button type="button" class="agent-btn ghost sm danger-text" data-agent-delete-session="${escapeAttribute(sess.runtimeSessionId)}" data-agent-manager="1">Delete</button>
                            </div>
                          </div>
                        `
                      })
                      .join("")}
                  </div>`
            }
          </section>
          ${
            inbox.notices.length > 0
              ? `<section class="agent-bg-section">
                  <h3 class="agent-section-heading">Recent Updates (${inbox.notices.length})</h3>
                  <div class="agent-runs-list">
                    ${inbox.notices
                      .map(
                        (notice) => `
                          <div class="agent-run-row">
                            <div class="agent-run-main">
                              <span class="agent-status-dot tone-waiting"></span>
                              <strong>${escapeHtml(notice.title)}</strong>
                              ${notice.subtitle ? `<span class="agent-timestamp">${escapeHtml(notice.subtitle)}</span>` : ""}
                            </div>
                            <div class="agent-run-actions">
                              <button type="button" class="agent-btn ghost sm" data-inbox-dismiss-notice="${escapeAttribute(notice.noticeId || "")}">Dismiss</button>
                            </div>
                          </div>
                        `,
                      )
                      .join("")}
                  </div>
                </section>`
              : ""
          }
        </div>
      </div>
    </div>
  `
}

export function renderInboxSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  selectedTaskId: string
  busy: boolean
  artifactPreview: { artifactId?: string; path: string; content: string; truncated: boolean } | null
  drawerWidth?: number
  drawerExpanded?: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const sections = buildInboxSections(snapshot)
  const rawTask = options.selectedTaskId ? snapshot.tasks.find((t) => t.id === options.selectedTaskId) : null
  const selectedTask = rawTask ? enrichTask(snapshot, rawTask) : null

  const renderCard = (item: InboxItem) => `
    <article class="agent-inbox-card tone-${item.tone}">
      <div class="agent-inbox-card-main">
        <div class="agent-inbox-meta">
          <span class="agent-status-pill tone-${item.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(item.badge)}</span></span>
          ${item.subtitle ? `<span class="agent-inbox-subtitle">${escapeHtml(item.subtitle)}</span>` : ""}
          ${item.createdAt ? `<span class="agent-timestamp">${escapeHtml(relativeTimeLabel(item.createdAt))}</span>` : ""}
        </div>
        <h3 class="agent-inbox-title">${escapeHtml(item.title)}</h3>
        ${item.detail ? `<p class="agent-inbox-detail">${escapeHtml(item.detail)}</p>` : ""}
      </div>
      <div class="agent-inbox-actions">
        ${
          item.kind === "approval" && item.approvalId
            ? `<button type="button" class="agent-btn primary sm" data-inbox-approve="${escapeAttribute(item.approvalId)}" ${options.busy ? "disabled" : ""}>Approve</button>
               <button type="button" class="agent-btn ghost sm" data-inbox-reject="${escapeAttribute(item.approvalId)}" ${options.busy ? "disabled" : ""}>Reject</button>`
            : ""
        }
        ${
          (item.kind === "blocker" || item.kind === "delivery" || item.kind === "attention") && item.taskId
            ? `<button type="button" class="agent-btn primary sm" data-inbox-inspect-task="${escapeAttribute(item.taskId)}">${item.kind === "delivery" ? "Review" : item.kind === "blocker" ? "Answer" : "Inspect"}</button>`
            : ""
        }
        ${
          item.kind === "unconfirmed_run" && item.runId
            ? `<button type="button" class="agent-btn warning sm" data-inbox-resolve-run="${escapeAttribute(item.runId)}" ${options.busy ? "disabled" : ""}>Confirm Stopped</button>`
            : ""
        }
        ${
          item.kind === "notice" && item.noticeId
            ? `<button type="button" class="agent-btn ghost sm" data-inbox-dismiss-notice="${escapeAttribute(item.noticeId)}" ${options.busy ? "disabled" : ""}>Dismiss</button>`
            : ""
        }
      </div>
    </article>
  `

  return `
    <div class="agent-surface inbox-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-headline-row">
            <h2 class="agent-surface-title">Inbox</h2>
            <span class="agent-metric-pill">${sections.badgeCount} pending</span>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          ${
            sections.totalCount === 0
              ? `<div class="agent-empty-box"><h3>All caught up</h3><p>No pending approvals, questions, or deliveries waiting on you.</p></div>`
              : `
                ${
                  sections.needsYou.length > 0
                    ? `<section class="agent-bg-section">
                        <h3 class="agent-section-heading">Needs you (${sections.needsYou.length})</h3>
                        <div class="agent-inbox-list">${sections.needsYou.map(renderCard).join("")}</div>
                      </section>`
                    : ""
                }
                ${
                  sections.notices.length > 0
                    ? `<section class="agent-bg-section">
                        <h3 class="agent-section-heading">Changed by the Manager (${sections.notices.length})</h3>
                        <div class="agent-inbox-list">${sections.notices.map(renderCard).join("")}</div>
                      </section>`
                    : ""
                }
                ${
                  sections.delivered.length > 0
                    ? `<section class="agent-bg-section">
                        <h3 class="agent-section-heading">Recently delivered (${sections.delivered.length})</h3>
                        <div class="agent-inbox-list">${sections.delivered.map(renderCard).join("")}</div>
                      </section>`
                    : ""
                }
              `
          }
        </div>
      </div>
      ${renderTaskDrawerHtml({
        task: selectedTask,
        busy: options.busy,
        artifactPreview: options.artifactPreview,
        width: options.drawerWidth,
        expanded: options.drawerExpanded,
      })}
    </div>
  `
}

export function renderBackgroundSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  serviceInfo: Record<string, any> | null
  busy: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const bg = buildBackgroundModel(snapshot, options.serviceInfo)
  const runtimeInfo = options.serviceInfo?.runtime || null
  const mgmtInfo = options.serviceInfo?.service || null

  return `
    <div class="agent-surface background-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-headline-row">
            <h2 class="agent-surface-title">Background</h2>
            <span class="agent-metric-pill tone-working">${bg.runningCount} active</span>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          <div class="agent-health-strip">
            <span class="agent-health-item">
              <span class="agent-status-dot tone-${mgmtInfo ? "completed" : "working"}"></span>
              <span>Service: <strong>${mgmtInfo ? `Running (PID ${mgmtInfo.pid || "active"})` : "Connected"}</strong></span>
            </span>
            <span class="agent-health-sep">·</span>
            <span class="agent-health-item">
              <span class="agent-status-dot tone-completed"></span>
              <span>Runtime: <strong>${runtimeInfo?.host ? `${escapeHtml(String(runtimeInfo.host))}:${escapeHtml(String(runtimeInfo.port))}` : "Active"}</strong></span>
            </span>
            <span class="agent-health-sep">·</span>
            <span class="agent-health-item">${snapshot.connectedSessions.length} connected sessions</span>
          </div>
          ${
            bg.unconfirmedRuns.length > 0
              ? `<section class="agent-bg-section">
                  <h3 class="agent-section-heading">Unconfirmed Runs (${bg.unconfirmedRuns.length})</h3>
                  <div class="agent-runs-list">
                    ${bg.unconfirmedRuns
                      .map(
                        (run) => `
                          <div class="agent-run-row">
                            <div class="agent-run-main">
                              <span class="agent-status-pill tone-attention"><span class="agent-status-dot"></span><span>Unconfirmed</span></span>
                              <strong>${escapeHtml(String(run.agentName))}</strong>
                              <span class="agent-run-brief">${escapeHtml(String(run.title))}</span>
                            </div>
                            <div class="agent-run-actions">
                              <button type="button" class="agent-btn warning sm" data-inbox-resolve-run="${escapeAttribute(String(run.runId))}" ${options.busy ? "disabled" : ""}>Confirm Stopped</button>
                              <button type="button" class="agent-btn danger-ghost sm" data-inbox-stop-run="${escapeAttribute(String(run.runId))}" ${options.busy ? "disabled" : ""}>Cancel</button>
                            </div>
                          </div>
                        `,
                      )
                      .join("")}
                  </div>
                </section>`
              : ""
          }
          <section class="agent-bg-section">
            <h3 class="agent-section-heading">Running Now (${bg.runningNow.length})</h3>
            ${
              bg.runningNow.length === 0
                ? `<div class="agent-empty-box compact"><p>No background runs or active turns right now.</p></div>`
                : `<div class="agent-runs-list">
                    ${bg.runningNow
                      .map(
                        (item) => `
                          <div class="agent-run-row">
                            <div class="agent-run-main">
                              <span class="agent-status-pill tone-working"><span class="agent-status-dot"></span><span>${escapeHtml(String(item.status))}</span></span>
                              <strong>${escapeHtml(String(item.agentName))}</strong>
                              <span class="agent-run-brief">${escapeHtml(String(item.title))}</span>
                              ${item.detail ? `<span class="agent-timestamp">${escapeHtml(String(item.detail))}</span>` : ""}
                            </div>
                            <div class="agent-run-actions">
                              ${
                                item.agentId && item.teamId
                                  ? `<button type="button" class="agent-btn secondary sm" data-agent-chat="${escapeAttribute(String(item.agentId))}" data-agent-team="${escapeAttribute(String(item.teamId))}" data-agent-session="${escapeAttribute(String(item.runtimeSessionId || ""))}">Open</button>`
                                  : ""
                              }
                              ${
                                item.runId
                                  ? `<button type="button" class="agent-btn danger-ghost sm" data-inbox-stop-run="${escapeAttribute(String(item.runId))}" ${options.busy ? "disabled" : ""}>Stop</button>`
                                  : ""
                              }
                            </div>
                          </div>
                        `,
                      )
                      .join("")}
                  </div>`
            }
          </section>
        </div>
      </div>
    </div>
  `
}

export function renderArchiveSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  archivedTeams?: Array<Record<string, any>>
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const archived = options.archivedTeams?.length ? options.archivedTeams : snapshot.archivedTeams

  return `
    <div class="agent-surface archive-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-headline-row">
            <h2 class="agent-surface-title">Archived Teams</h2>
            <span class="agent-metric-pill">${archived.length} archived</span>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          ${
            archived.length === 0
              ? `<div class="agent-empty-box"><h3>No archived teams</h3><p>Deleted teams appear here with their preserved workspace paths.</p></div>`
              : `<div class="agent-runs-list">
                  ${archived
                    .map(
                      (item) => `
                        <div class="agent-run-row">
                          <div class="agent-run-main">
                            <strong>${escapeHtml(String(item.name || item.id))}</strong>
                            <span class="agent-timestamp">Archived ${escapeHtml(relativeTimeLabel(item.deletedAt))}</span>
                            ${
                              Array.isArray(item.workspaces) && item.workspaces.length > 0
                                ? `<code class="org-workspace-path">${escapeHtml(item.workspaces.map((w: any) => w.workspace || w).join(", "))}</code>`
                                : ""
                            }
                          </div>
                        </div>
                      `,
                    )
                    .join("")}
                </div>`
          }
        </div>
      </div>
    </div>
  `
}

