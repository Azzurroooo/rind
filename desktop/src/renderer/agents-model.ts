// Pure data projection, hierarchy builder, 4-column semantic Kanban grouping,
// inbox triage builder, and HTML renderers for Rind Desktop's native Team
// Agents Management workbench.

import { escapeAttribute, escapeHtml } from "./app/html.ts"

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
export type KanbanColumnId = "queued" | "in_progress" | "needs_attention" | "completed"

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
  column: KanbanColumnId
  tone: StatusTone
  statusLabel: string
  notes: Array<Record<string, any>>
  artifactRecords: Array<Record<string, any>>
  activeRun: Record<string, any> | null
  runtimeSessionId: string
}

export type InboxItem = {
  id: string
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
  switch (String(status || "Idle")) {
    case "Working":
    case "Running job":
      return "working"
    case "Needs input":
    case "Unconfirmed":
      return "attention"
    case "Delegated":
    case "Queued":
      return "waiting"
    case "Open":
      return "completed"
    default:
      return "idle"
  }
}

export function taskColumnKey(task: Record<string, any> | null | undefined): KanbanColumnId {
  const status = String(task?.status || "queued")
  if (status === "queued") return "queued"
  if (status === "running") return "in_progress"
  if (status === "blocked") {
    return task?.blockedOn?.responder === "user" ? "needs_attention" : "in_progress"
  }
  if (status === "needs_attention") return "needs_attention"
  if (status === "done") {
    if (task?.report && !task?.review) return "needs_attention"
    return "completed"
  }
  return "completed"
}

export function taskStatusMeta(task: Record<string, any> | null | undefined): {
  label: string
  tone: StatusTone
  column: KanbanColumnId
} {
  const status = String(task?.status || "queued")
  if (status === "running") {
    return { label: "Running", tone: "working", column: "in_progress" }
  }
  if (status === "queued") {
    return {
      label: task?.queueReason ? `Queued · ${task.queueReason}` : "Queued",
      tone: "waiting",
      column: "queued",
    }
  }
  if (status === "blocked") {
    if (task?.blockedOn?.responder === "user") {
      return { label: "Needs user input", tone: "attention", column: "needs_attention" }
    }
    return { label: "Waiting on sub-task", tone: "waiting", column: "in_progress" }
  }
  if (status === "needs_attention") {
    return { label: "Needs attention", tone: "attention", column: "needs_attention" }
  }
  if (status === "done") {
    if (task?.report && !task?.review) {
      return { label: "Ready for review", tone: "attention", column: "needs_attention" }
    }
    if (task?.review?.decision === "rework") {
      return { label: "Sent for rework", tone: "waiting", column: "completed" }
    }
    if (task?.review?.decision === "accepted") {
      return { label: "Accepted", tone: "completed", column: "completed" }
    }
    return { label: "Done", tone: "completed", column: "completed" }
  }
  if (status === "cancelled") {
    return { label: "Cancelled", tone: "idle", column: "completed" }
  }
  return { label: status, tone: "idle", column: "queued" }
}

export function buildTeamSummary(rawSnapshot: unknown, teamId: string): TeamSummary | null {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const team = snapshot.teams.find((item) => item.id === teamId) || null
  if (!team) return null

  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const teamMemberships = snapshot.memberships.filter((m) => m.teamId === team.id)
  const teamTasks = snapshot.tasks.filter((t) => t.teamId === team.id)
  const teamSessions = snapshot.sessions.filter((s) => s.teamId === team.id)

  const members: OrgMemberSummary[] = teamMemberships.map((membership) => {
    const agent = agentById.get(membership.agentId) || { id: membership.agentId, name: membership.agentId }
    const isLeader = team.leaderAgentId === membership.agentId
    const supervisor = membership.reportsToAgentId ? agentById.get(membership.reportsToAgentId) : null
    const memberTasks = teamTasks.filter((t) => t.assigneeAgentId === membership.agentId)
    const activeTask =
      memberTasks.find((t) => t.status === "running" || t.status === "blocked" || t.status === "needs_attention") ||
      memberTasks.find((t) => t.status === "queued") ||
      null
    const directSessions = teamSessions.filter(
      (s) => s.agentId === membership.agentId && s.origin === "direct" && s.runtimeSessionId,
    )
    const latestDirectSession = directSessions[directSessions.length - 1] || null
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
      latestRuntimeSessionId: latestDirectSession ? String(latestDirectSession.runtimeSessionId) : "",
      taskCounts: {
        active: memberTasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "blocked").length,
        attention: memberTasks.filter(
          (t) =>
            t.status === "needs_attention" ||
            (t.status === "blocked" && t.blockedOn?.responder === "user") ||
            (t.status === "done" && t.report && !t.review),
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
    tasksQueued: teamTasks.filter((t) => taskColumnKey(t) === "queued").length,
    tasksInProgress: teamTasks.filter((t) => taskColumnKey(t) === "in_progress").length,
    tasksAttention: teamTasks.filter((t) => taskColumnKey(t) === "needs_attention").length,
    tasksCompleted: teamTasks.filter((t) => taskColumnKey(t) === "completed").length,
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
  const activeRun =
    snapshot.runs.find(
      (r) => r.taskId === task.id && (r.status === "starting" || r.status === "running" || r.status === "unknown"),
    ) ||
    snapshot.runs.filter((r) => r.taskId === task.id).pop() ||
    null
  const taskSession = snapshot.sessions.find((s) => s.taskId === task.id && s.runtimeSessionId) || null

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
    column: meta.column,
    tone: meta.tone,
    statusLabel: meta.label,
    notes,
    artifactRecords,
    activeRun,
    runtimeSessionId: taskSession ? String(taskSession.runtimeSessionId) : "",
  }
}

export const KANBAN_COLUMNS: ReadonlyArray<{ id: KanbanColumnId; label: string; emptyText: string }> = [
  { id: "queued", label: "Queued", emptyText: "No queued tasks" },
  { id: "in_progress", label: "In Progress", emptyText: "No tasks currently running" },
  { id: "needs_attention", label: "Needs Review / Input", emptyText: "Nothing blocked or awaiting review" },
  { id: "completed", label: "Completed", emptyText: "No completed tasks yet" },
]

export function groupTeamTasks(rawSnapshot: unknown, teamId = "") {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const filtered = teamId ? snapshot.tasks.filter((t) => t.teamId === teamId) : snapshot.tasks
  const enriched = filtered.map((task) => enrichTask(snapshot, task)).filter((t): t is EnrichedTask => Boolean(t))

  const priorityRank: Record<string, number> = { high: 0, normal: 1, low: 2 }
  enriched.sort((a, b) => {
    const rankDiff = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)
    if (rankDiff !== 0 && a.column !== "completed" && b.column !== "completed") return rankDiff
    return String(b.id).localeCompare(String(a.id))
  })

  const columns: Record<KanbanColumnId, EnrichedTask[]> = {
    queued: [],
    in_progress: [],
    needs_attention: [],
    completed: [],
  }
  for (const item of enriched) {
    columns[item.column].push(item)
  }
  return { all: enriched, columns }
}

export function buildInboxItems(rawSnapshot: unknown): InboxItem[] {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]))
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]))
  const items: InboxItem[] = []

  for (const approval of snapshot.approvals) {
    const team = teamById.get(approval.teamId)
    items.push({
      id: `approval:${approval.id}`,
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
      items.push({
        id: `blocker:${task.id}`,
        kind: "blocker",
        tone: "attention",
        badge: "Needs Your Input",
        title: String(task.blockedOn.action || task.brief || "Task waiting on your answer"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.brief || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        raw: enrichTask(snapshot, task),
      })
    } else if (task.status === "needs_attention") {
      items.push({
        id: `attention:${task.id}`,
        kind: "attention",
        tone: "attention",
        badge: "Needs Attention",
        title: String(task.brief || "Task needs attention"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.error || task.report?.summary || "Run stopped before submitting a final report."),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        raw: enrichTask(snapshot, task),
      })
    } else if (task.status === "done" && task.report && !task.review) {
      items.push({
        id: `delivery:${task.id}`,
        kind: "delivery",
        tone: "completed",
        badge: "Delivery Ready for Review",
        title: String(task.brief || "Completed task delivery"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.report.summary || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.deliveredAt || ""),
        raw: enrichTask(snapshot, task),
      })
    }
  }

  for (const run of snapshot.runs) {
    if (run.status === "unknown") {
      const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null
      items.push({
        id: `run:${run.id}`,
        kind: "unconfirmed_run",
        tone: "attention",
        badge: "Unconfirmed Run",
        title: task ? `Unconfirmed run for "${task.brief}"` : `Run ${run.id} lost host contact`,
        subtitle: `Started ${run.startedAt || "recently"}`,
        runId: String(run.id),
        taskId: run.taskId ? String(run.taskId) : "",
        teamId: task?.teamId ? String(task.teamId) : "",
        raw: run,
      })
    }
  }

  for (const notice of snapshot.notices) {
    const team = teamById.get(notice.teamId)
    const agent = agentById.get(notice.agentId)
    items.push({
      id: `notice:${notice.id}`,
      kind: "notice",
      tone: "waiting",
      badge: "Notice",
      title: String(notice.title || "Team update"),
      subtitle: [team?.name, agent?.name].filter(Boolean).join(" · "),
      noticeId: String(notice.id),
      teamId: String(notice.teamId || ""),
      agentId: String(notice.agentId || ""),
      createdAt: String(notice.createdAt || ""),
      raw: notice,
    })
  }

  return items
}

export function inboxBadgeCount(rawSnapshot: unknown): number {
  return buildInboxItems(rawSnapshot).length
}

export function activeBackgroundCount(rawSnapshot: unknown): number {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot)
  const activeRuns = snapshot.runs.filter(
    (r) => r.status === "starting" || r.status === "running" || r.status === "unknown",
  ).length
  const liveBg = snapshot.live.reduce((sum, item) => sum + (Number(item?.background?.count) || 0), 0)
  return activeRuns + liveBg
}

function normalizePathKey(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
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
      if (!managedSession.teamId && agent && String(agent.name).toLowerCase() === "manager") {
        return {
          kind: "manager",
          agentName: "Manager",
          roleLabel: "Organization Coordinator",
        }
      }
    }
  }

  if (wsKey) {
    if (wsKey.endsWith("/agents/manager")) {
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

// ---------- Pure HTML Renderers for Desktop Renderer & Node Tests ----------

export function renderOrgNodeHtml(node: OrgMemberSummary, depth = 0): string {
  const childrenHtml = node.children.length
    ? `<div class="org-tree-children" role="group" aria-label="Direct reports of ${escapeAttribute(node.name)}">${node.children
        .map((c) => renderOrgNodeHtml(c, depth + 1))
        .join("")}</div>`
    : ""

  return `
    <div class="org-tree-branch depth-${Math.min(depth, 4)}" data-agent-id="${escapeAttribute(node.agentId)}">
      <div class="org-member-card${node.isLeader ? " is-leader" : ""}">
        <div class="org-member-top">
          <div class="org-member-identity">
            <div class="org-member-name-row">
              <strong class="org-member-name">${escapeHtml(node.name)}</strong>
              ${node.isLeader ? `<span class="org-leader-badge">Leader</span>` : ""}
              <span class="org-role-pill">${escapeHtml(node.position)}</span>
              ${node.worktreeOf ? `<span class="org-worktree-pill" title="${escapeAttribute(node.worktreeOf)}">Worktree</span>` : ""}
            </div>
            <div class="org-member-sub">
              <span>${node.reportsToName ? `Reports to ${escapeHtml(node.reportsToName)}` : node.isLeader ? "Coordinates team & delegates work" : "Direct team member"}</span>
              ${node.canonicalWorkspace ? `<code class="org-workspace-path">${escapeHtml(node.canonicalWorkspace)}</code>` : ""}
            </div>
          </div>
          <span class="agent-status-pill tone-${node.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(node.status)}</span></span>
        </div>
        ${node.responsibility ? `<p class="org-member-responsibility">${escapeHtml(node.responsibility)}</p>` : ""}
        ${
          node.activeTask
            ? `<button type="button" class="org-active-task" data-agent-select-task="${escapeAttribute(node.activeTask.id)}" data-agent-team="${escapeAttribute(node.teamId)}"><span class="org-active-task-kicker">Current Task</span><span class="org-active-task-brief">${escapeHtml(String(node.activeTask.brief || ""))}</span></button>`
            : ""
        }
        <div class="org-member-footer">
          <div class="org-member-stats">
            <span>${node.taskCounts.active} active</span>
            ${node.taskCounts.attention > 0 ? `<span class="org-stat-attention">${node.taskCounts.attention} need review</span>` : ""}
            <span>${node.taskCounts.done} completed</span>
          </div>
          <div class="org-member-actions">
            <button type="button" class="agent-btn primary sm" data-agent-chat="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}" data-agent-session="${escapeAttribute(node.latestRuntimeSessionId)}">Chat</button>
            <button type="button" class="agent-btn secondary sm" data-agent-quick-assign="${escapeAttribute(node.agentId)}">Assign task</button>
            ${!node.isLeader ? `<button type="button" class="agent-btn ghost sm" data-agent-make-leader="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}">Make leader</button>` : ""}
            <button type="button" class="agent-btn ghost sm danger-text" data-agent-remove="${escapeAttribute(node.agentId)}" data-agent-team="${escapeAttribute(node.teamId)}">Remove</button>
          </div>
        </div>
      </div>
      ${childrenHtml}
    </div>
  `
}

export type DesktopAgentSurfaceState =
  | { kind: "chat" }
  | { kind: "inbox" }
  | { kind: "background" }
  | {
      kind: "team"
      teamId: string
      tab: "organization" | "tasks"
      taskLayout: "board" | "list"
      assigneeFilter: string
      selectedTaskId: string
      addMemberOpen: boolean
      memberMode: "workspace" | "existing" | "worktree"
      assignOpen: boolean
      assignAgentId: string
      deleteConfirmOpen: boolean
    }

export function renderSidebarAgentsHtml(options: {
  snapshot: AgentsSnapshotData
  surface: DesktopAgentSurfaceState
  chatContext: SessionAgentContext
  collapsedTeams: ReadonlySet<string>
  newTeamOpen: boolean
  busy: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const inboxCount = inboxBadgeCount(snapshot)
  const bgCount = activeBackgroundCount(snapshot)
  const isInbox = options.surface.kind === "inbox"
  const isBg = options.surface.kind === "background"
  const isManagerChat = options.surface.kind === "chat" && options.chatContext.kind === "manager"

  const teamRows = snapshot.teams
    .map((team) => {
      const summary = buildTeamSummary(snapshot, team.id)
      const isSelectedTeam = options.surface.kind === "team" && options.surface.teamId === team.id
      const isCollapsed = options.collapsedTeams.has(team.id)
      const attentionCount = summary ? summary.counts.tasksAttention + summary.counts.attention : 0
      const workingCount = summary ? summary.counts.working : 0
      const membersHtml =
        !isCollapsed && summary && summary.members.length > 0
          ? `<div class="sidebar-team-members" role="group" aria-label="${escapeAttribute(team.name)} members">${summary.members
              .map((member) => {
                const isMemberActive =
                  options.surface.kind === "chat" &&
                  options.chatContext.kind === "member" &&
                  options.chatContext.agentId === member.agentId
                return `<button type="button" class="sidebar-member-row${isMemberActive ? " is-active" : ""}" data-agent-chat="${escapeAttribute(member.agentId)}" data-agent-team="${escapeAttribute(team.id)}" data-agent-session="${escapeAttribute(member.latestRuntimeSessionId)}" title="${escapeAttribute(`${member.name} · ${member.position} (${member.status})`)}"><span class="agent-status-dot tone-${member.tone}"></span><span class="sidebar-member-name">${escapeHtml(member.name)}</span>${member.isLeader ? `<span class="sidebar-leader-tag">Lead</span>` : `<span class="sidebar-member-role">${escapeHtml(member.position)}</span>`}</button>`
              })
              .join("")}</div>`
          : ""

      return `
        <div class="sidebar-team-group">
          <div class="sidebar-team-header${isSelectedTeam ? " is-active" : ""}">
            <button type="button" class="sidebar-team-chevron" data-sidebar-toggle-team="${escapeAttribute(team.id)}" aria-label="${isCollapsed ? "Expand" : "Collapse"} ${escapeAttribute(team.name)}">${isCollapsed ? "▸" : "▾"}</button>
            <button type="button" class="sidebar-team-main" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="organization">
              <span class="sidebar-team-name">${escapeHtml(String(team.name || team.id))}</span>
              <span class="sidebar-team-badges">
                ${workingCount > 0 ? `<span class="sidebar-mini-dot working" title="Working"></span>` : ""}
                ${attentionCount > 0 ? `<span class="sidebar-nav-badge attention">${attentionCount}</span>` : ""}
              </span>
            </button>
            <button type="button" class="sidebar-team-board-btn" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="tasks" title="Open ${escapeAttribute(team.name)} Tasks Board">Board</button>
          </div>
          ${membersHtml}
        </div>
      `
    })
    .join("")

  return `
    <div class="sidebar-global-nav" role="navigation" aria-label="Workspace surfaces">
      <button type="button" class="sidebar-nav-item${isInbox ? " is-active" : ""}" data-sidebar-surface="inbox">
        <span class="sidebar-nav-label">Inbox &amp; Approvals</span>
        ${inboxCount > 0 ? `<span class="sidebar-nav-badge attention">${inboxCount}</span>` : ""}
      </button>
      <button type="button" class="sidebar-nav-item${isManagerChat ? " is-active" : ""}" data-sidebar-open-manager="1" title="Chat with the global Organization Manager">
        <span class="sidebar-nav-label">Manager Agent</span>
        <span class="sidebar-nav-tag">Coord</span>
      </button>
      <button type="button" class="sidebar-nav-item${isBg ? " is-active" : ""}" data-sidebar-surface="background">
        <span class="sidebar-nav-label">Background &amp; Runtime</span>
        ${bgCount > 0 ? `<span class="sidebar-nav-badge working">${bgCount}</span>` : ""}
      </button>
    </div>
    <div class="sidebar-teams-section">
      <div class="sidebar-heading">
        <h2 class="sidebar-section-title">Teams</h2>
        <button type="button" class="ghost-button" data-sidebar-toggle-new-team="1">${options.newTeamOpen ? "Close" : "+ New"}</button>
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
          ? `<div class="sidebar-teams-empty"><span>No agent teams yet.</span><button type="button" class="sidebar-inline-link" data-sidebar-toggle-new-team="1">Create a team</button></div>`
          : `<div class="sidebar-teams-list">${teamRows}</div>`
      }
    </div>
  `
}

export function renderHeaderAgentBreadcrumbHtml(context: SessionAgentContext): string {
  if (!context || context.kind === "independent") return ""
  if (context.kind === "manager") {
    return `<div class="header-agent-breadcrumb"><span class="header-agent-pill manager"><span class="agent-status-dot tone-working"></span><span>Manager</span></span><span class="header-agent-role">${escapeHtml(context.roleLabel || "Organization Coordinator")}</span></div>`
  }
  const tone = memberStatusTone(context.status)
  return `
    <div class="header-agent-breadcrumb">
      <button type="button" class="header-team-link" data-sidebar-open-team="${escapeAttribute(context.teamId)}" data-sidebar-team-tab="organization" title="Open team ${escapeAttribute(context.teamName)}">${escapeHtml(context.teamName)}</button>
      <span class="header-breadcrumb-sep" aria-hidden="true">/</span>
      <span class="header-agent-pill member"><span class="agent-status-dot tone-${tone}"></span><span>${escapeHtml(context.agentName)}</span></span>
      <span class="header-agent-role">${escapeHtml(context.roleLabel)}${context.isLeader ? " · Leader" : ""}</span>
    </div>
  `
}

export function renderTaskDrawerHtml(options: {
  task: EnrichedTask | null
  busy: boolean
  artifactPreview: { path: string; content: string; truncated: boolean } | null
}): string {
  const { task, busy, artifactPreview } = options
  if (!task) return ""
  const needsUserAnswer = task.status === "blocked" && task.blockedOn?.responder === "user"
  const canReviewReport = task.status === "done" && Boolean(task.report)
  const canCancel = task.status === "queued" || task.status === "running" || task.status === "blocked"
  const filesChanged: string[] = Array.isArray(task.report?.filesChanged) ? task.report.filesChanged : []

  return `
    <aside class="agent-task-drawer" aria-label="Task inspection drawer">
      <header class="agent-drawer-head">
        <div class="agent-drawer-title-group">
          <div class="agent-drawer-meta-row">
            <span class="agent-status-pill tone-${task.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(task.statusLabel)}</span></span>
            <span class="agent-priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>
            <code class="agent-id-chip">${escapeHtml(task.id)}</code>
          </div>
          <h3 class="agent-drawer-title">${escapeHtml(task.brief)}</h3>
          <div class="agent-drawer-subtitle">
            <span>Team <strong>${escapeHtml(task.teamName)}</strong></span>
            <span>·</span>
            <span>Assignee <strong>${escapeHtml(task.assigneeName)}</strong> (${escapeHtml(task.assigneePosition)})</span>
          </div>
        </div>
        <button type="button" class="icon-button" data-task-drawer-close="1" aria-label="Close task drawer">✕</button>
      </header>
      <div class="agent-drawer-body panel-scroll">
        <div class="agent-drawer-actions-bar">
          <button type="button" class="agent-btn secondary" data-agent-chat="${escapeAttribute(task.assigneeAgentId)}" data-agent-team="${escapeAttribute(task.teamId)}" data-agent-session="${escapeAttribute(task.runtimeSessionId)}">Open ${escapeHtml(task.assigneeName)} Chat</button>
          ${canCancel ? `<button type="button" class="agent-btn danger-ghost" data-task-cancel="${escapeAttribute(task.id)}" ${busy ? "disabled" : ""}>Cancel Task</button>` : ""}
        </div>
        ${
          needsUserAnswer
            ? `<section class="agent-drawer-card attention-card">
                <div class="agent-card-kicker">Blocker · Waiting on your input</div>
                <p class="agent-blocker-question">${escapeHtml(String(task.blockedOn?.action || "The agent needs your clarification to proceed."))}</p>
                <form id="agent-task-answer-form" class="agent-inline-form" data-task-id="${escapeAttribute(task.id)}">
                  <textarea id="agent-task-answer-input" class="agent-textarea" rows="3" placeholder="Write your answer to resume the task..." required></textarea>
                  <div class="agent-form-actions">
                    <button type="submit" class="agent-btn primary" ${busy ? "disabled" : ""}>Send Answer &amp; Resume</button>
                  </div>
                </form>
              </section>`
            : ""
        }
        ${
          task.error
            ? `<section class="agent-drawer-card danger-card"><div class="agent-card-kicker">Execution Issue</div><p class="agent-report-text">${escapeHtml(String(task.error))}</p></section>`
            : ""
        }
        ${
          task.report
            ? `<section class="agent-drawer-card report-card">
                <div class="agent-card-header-row">
                  <div class="agent-card-kicker">Delivery Report</div>
                  ${task.deliveredAt ? `<span class="agent-timestamp">${escapeHtml(String(task.deliveredAt))}</span>` : ""}
                </div>
                <div class="agent-report-section">
                  <h4>Summary</h4>
                  <p class="agent-report-text">${escapeHtml(String(task.report.summary || ""))}</p>
                </div>
                ${
                  task.report.details
                    ? `<div class="agent-report-section"><h4>Details</h4><pre class="agent-report-pre">${escapeHtml(String(task.report.details))}</pre></div>`
                    : ""
                }
                ${
                  filesChanged.length > 0
                    ? `<div class="agent-report-section">
                        <h4>Artifacts &amp; Changed Files (${filesChanged.length})</h4>
                        <div class="agent-artifact-list">
                          ${filesChanged
                            .map(
                              (filePath) => `
                            <div class="agent-artifact-item">
                              <code class="agent-artifact-path">${escapeHtml(filePath)}</code>
                              <button type="button" class="agent-btn ghost sm" data-task-read-artifact="${escapeAttribute(task.id)}" data-artifact-path="${escapeAttribute(filePath)}">${artifactPreview?.path === filePath ? "Hide" : "Preview"}</button>
                            </div>
                          `,
                            )
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
                  canReviewReport
                    ? `<div class="agent-review-box">
                        <div class="agent-card-kicker">${task.review ? `Reviewed · ${task.review.decision === "accepted" ? "Accepted" : "Rework requested"}` : "Review Delivery"}</div>
                        ${task.review?.comment ? `<p class="agent-review-existing">Previous review note: ${escapeHtml(String(task.review.comment))}</p>` : ""}
                        <textarea id="agent-task-review-comment" class="agent-textarea" rows="2" placeholder="Optional review note or rework instructions..."></textarea>
                        <div class="agent-form-actions">
                          <button type="button" class="agent-btn primary" data-task-review="${escapeAttribute(task.id)}" data-review-decision="accepted" ${busy ? "disabled" : ""}>Accept Delivery</button>
                          <button type="button" class="agent-btn warning" data-task-review="${escapeAttribute(task.id)}" data-review-decision="rework" ${busy ? "disabled" : ""}>Request Rework</button>
                        </div>
                      </div>`
                    : ""
                }
              </section>`
            : ""
        }
        <section class="agent-drawer-card">
          <div class="agent-card-kicker">Task Notes (${task.notes.length})</div>
          ${
            task.notes.length > 0
              ? `<div class="agent-notes-list">${task.notes
                  .map(
                    (note) => `<div class="agent-note-item"><div class="agent-note-meta"><strong>${escapeHtml(String(note.author || "user"))}</strong><span>${escapeHtml(String(note.createdAt || ""))}</span></div><p>${escapeHtml(String(note.text || ""))}</p></div>`,
                  )
                  .join("")}</div>`
              : `<p class="agent-empty-hint">No notes recorded on this task yet.</p>`
          }
          <form id="agent-task-note-form" class="agent-inline-form" data-task-id="${escapeAttribute(task.id)}">
            <input id="agent-task-note-input" type="text" class="agent-input" placeholder="Add a coordination note to this task..." />
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
  busy: boolean
  artifactPreview: { path: string; content: string; truncated: boolean } | null
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const { surface, busy, artifactPreview } = options
  const summary = buildTeamSummary(snapshot, surface.teamId)
  if (!summary) {
    return `<div class="agent-surface-empty"><h2>Team not found</h2><p>Select another team or return to the conversation.</p><button type="button" class="agent-btn secondary" data-sidebar-surface="chat">Back to Chat</button></div>`
  }
  const { team, leader, members, orgRoots, counts } = summary
  const groupedTasks = groupTeamTasks(snapshot, team.id)
  const filteredTasks = surface.assigneeFilter
    ? groupedTasks.all.filter((t) => t.assigneeAgentId === surface.assigneeFilter)
    : groupedTasks.all
  const selectedTask = surface.selectedTaskId ? groupedTasks.all.find((t) => t.id === surface.selectedTaskId) || null : null
  const existingAgentsOutsideTeam = snapshot.agents.filter(
    (a) => !members.some((m) => m.agentId === a.id) && String(a.name).toLowerCase() !== "manager",
  )

  const addMemberFormHtml = surface.addMemberOpen
    ? `<form id="agent-add-member-form" class="agent-inline-panel" data-team-id="${escapeAttribute(team.id)}">
        <div class="agent-panel-head">
          <h3>Add Member to ${escapeHtml(team.name)}</h3>
          <div class="agent-segmented" role="group" aria-label="Member source">
            <button type="button" class="agent-seg-btn${surface.memberMode === "workspace" ? " is-active" : ""}" data-member-mode="workspace">New / Folder</button>
            <button type="button" class="agent-seg-btn${surface.memberMode === "worktree" ? " is-active" : ""}" data-member-mode="worktree">Git Worktree</button>
            ${existingAgentsOutsideTeam.length > 0 ? `<button type="button" class="agent-seg-btn${surface.memberMode === "existing" ? " is-active" : ""}" data-member-mode="existing">Existing Agent</button>` : ""}
          </div>
        </div>
        <div class="agent-form-grid">
          ${
            surface.memberMode === "existing"
              ? `<label class="agent-field"><span>Agent</span><select name="existingAgentId" class="agent-select" required><option value="">Select existing agent...</option>${existingAgentsOutsideTeam.map((a) => `<option value="${escapeAttribute(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.canonicalWorkspace)})</option>`).join("")}</select></label>`
              : `<label class="agent-field"><span>Agent Name</span><input name="name" type="text" class="agent-input" placeholder="e.g. frontend-specialist" required /></label>
                 ${
                   surface.memberMode === "worktree"
                     ? `<label class="agent-field"><span>Source Git Repo Path</span><input name="worktreeFrom" type="text" class="agent-input" value="${escapeAttribute(team.createRoot)}" placeholder="Leave blank to use team root (${escapeAttribute(team.createRoot || "repo root")})" /></label>`
                     : `<label class="agent-field"><span>Workspace Folder (optional)</span><input name="workspace" type="text" class="agent-input" placeholder="Leave blank to auto-create under ~/.rind/agents/" /></label>`
                 }`
          }
          <label class="agent-field"><span>Role / Position</span><input name="position" type="text" class="agent-input" placeholder="e.g. UI Architecture Specialist" /></label>
          <label class="agent-field"><span>Reports To</span><select name="reportsTo" class="agent-select"><option value="">${leader ? `${escapeHtml(leader.name)} (Team Leader)` : "Team Leader"}</option>${members.map((m) => `<option value="${escapeAttribute(m.agentId)}">${escapeHtml(m.name)} (${escapeHtml(m.position)})</option>`).join("")}</select></label>
          <label class="agent-field span-2"><span>Responsibility</span><input name="responsibility" type="text" class="agent-input" placeholder="What is this member responsible for?" /></label>
        </div>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost" data-team-toggle-add-member="0">Cancel</button>
          <button type="submit" class="agent-btn primary" ${busy ? "disabled" : ""}>Add Member</button>
        </div>
      </form>`
    : ""

  const assignFormHtml = surface.assignOpen
    ? `<form id="agent-assign-task-form" class="agent-inline-panel" data-team-id="${escapeAttribute(team.id)}">
        <div class="agent-panel-head"><h3>Assign Delegated Task</h3></div>
        <div class="agent-form-grid">
          <label class="agent-field"><span>Assignee</span><select name="agentId" class="agent-select"><option value="">${leader ? `${escapeHtml(leader.name)} (Team Leader - default)` : "Select member..."}</option>${members.map((m) => `<option value="${escapeAttribute(m.agentId)}" ${surface.assignAgentId === m.agentId ? "selected" : ""}>${escapeHtml(m.name)} · ${escapeHtml(m.position)} (${escapeHtml(m.status)})</option>`).join("")}</select></label>
          <label class="agent-field"><span>Priority</span><select name="priority" class="agent-select"><option value="high">High</option><option value="normal" selected>Normal</option><option value="low">Low</option></select></label>
          <label class="agent-field span-2"><span>Task Brief</span><textarea name="brief" class="agent-textarea" rows="3" placeholder="Describe the objective, deliverables, and constraints..." required></textarea></label>
        </div>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost" data-team-toggle-assign="0">Cancel</button>
          <button type="submit" class="agent-btn primary" ${busy ? "disabled" : ""}>Dispatch Task</button>
        </div>
      </form>`
    : ""

  const deleteConfirmHtml = surface.deleteConfirmOpen
    ? `<div class="agent-inline-panel danger-panel">
        <div class="agent-panel-head"><h3>Delete Team "${escapeHtml(team.name)}"?</h3></div>
        <p class="agent-empty-hint">Deleting a team archives its structure and stops queued tasks. Member workspaces on disk are preserved unless you choose to clean up managed workspaces.</p>
        <div class="agent-form-actions">
          <button type="button" class="agent-btn ghost" data-team-toggle-delete="0">Cancel</button>
          <button type="button" class="agent-btn secondary" data-team-confirm-delete="${escapeAttribute(team.id)}" data-cleanup-workspaces="0" ${busy ? "disabled" : ""}>Archive Team Only</button>
          <button type="button" class="agent-btn danger-ghost" data-team-confirm-delete="${escapeAttribute(team.id)}" data-cleanup-workspaces="1" ${busy ? "disabled" : ""}>Delete &amp; Clean Up Managed Workspaces</button>
        </div>
      </div>`
    : ""

  const bodyHtml =
    surface.tab === "organization"
      ? `<div class="agent-org-canvas">
          ${
            orgRoots.length === 0
              ? `<div class="agent-empty-box"><h3>No members in ${escapeHtml(team.name)} yet</h3><p>Add a team leader and specialists to build your reporting hierarchy and start delegating tasks.</p><button type="button" class="agent-btn primary" data-team-toggle-add-member="1">+ Add First Member</button></div>`
              : `<div class="org-tree-root" role="tree" aria-label="${escapeAttribute(team.name)} organization hierarchy">${orgRoots.map((rootNode) => renderOrgNodeHtml(rootNode, 0)).join("")}</div>`
          }
        </div>`
      : `<div class="agent-tasks-canvas">
          <div class="agent-tasks-toolbar">
            <div class="agent-filter-chips">
              <button type="button" class="agent-filter-chip${!surface.assigneeFilter ? " is-active" : ""}" data-team-filter-assignee="">All members (${groupedTasks.all.length})</button>
              ${members.map((m) => `<button type="button" class="agent-filter-chip${surface.assigneeFilter === m.agentId ? " is-active" : ""}" data-team-filter-assignee="${escapeAttribute(m.agentId)}"><span class="agent-status-dot tone-${m.tone}"></span><span>${escapeHtml(m.name)}</span></button>`).join("")}
            </div>
            <div class="agent-segmented" role="group" aria-label="Task view layout">
              <button type="button" class="agent-seg-btn${surface.taskLayout === "board" ? " is-active" : ""}" data-team-task-layout="board">Board</button>
              <button type="button" class="agent-seg-btn${surface.taskLayout === "list" ? " is-active" : ""}" data-team-task-layout="list">List</button>
            </div>
          </div>
          ${
            surface.taskLayout === "board"
              ? `<div class="agent-kanban-grid">
                  ${KANBAN_COLUMNS.map((col) => {
                    const colTasks = groupedTasks.columns[col.id].filter(
                      (t) => !surface.assigneeFilter || t.assigneeAgentId === surface.assigneeFilter,
                    )
                    return `
                      <div class="agent-kanban-col">
                        <div class="agent-kanban-col-head">
                          <span class="agent-kanban-col-title">${escapeHtml(col.label)}</span>
                          <span class="agent-kanban-col-count">${colTasks.length}</span>
                        </div>
                        <div class="agent-kanban-col-body">
                          ${
                            colTasks.length === 0
                              ? `<div class="agent-kanban-empty">${escapeHtml(col.emptyText)}</div>`
                              : colTasks
                                  .map(
                                    (task) => `
                                  <button type="button" class="agent-task-card${surface.selectedTaskId === task.id ? " is-selected" : ""}" data-agent-select-task="${escapeAttribute(task.id)}" data-agent-team="${escapeAttribute(team.id)}">
                                    <div class="agent-task-card-top">
                                      <span class="agent-status-pill tone-${task.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(task.statusLabel)}</span></span>
                                      <span class="agent-priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>
                                    </div>
                                    <p class="agent-task-card-brief">${escapeHtml(task.brief)}</p>
                                    ${task.report?.summary ? `<p class="agent-task-card-report">${escapeHtml(String(task.report.summary))}</p>` : ""}
                                    <div class="agent-task-card-foot">
                                      <span class="agent-task-assignee">${escapeHtml(task.assigneeName)}</span>
                                      <code class="agent-id-chip">${escapeHtml(task.id)}</code>
                                    </div>
                                  </button>
                                `,
                                  )
                                  .join("")
                          }
                        </div>
                      </div>
                    `
                  }).join("")}
                </div>`
              : `<div class="agent-task-list-table">
                  ${
                    filteredTasks.length === 0
                      ? `<div class="agent-empty-box"><p>No tasks match the current filter.</p></div>`
                      : filteredTasks
                          .map(
                            (task) => `
                          <button type="button" class="agent-task-list-row${surface.selectedTaskId === task.id ? " is-selected" : ""}" data-agent-select-task="${escapeAttribute(task.id)}" data-agent-team="${escapeAttribute(team.id)}">
                            <span class="agent-status-pill tone-${task.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(task.statusLabel)}</span></span>
                            <span class="agent-priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>
                            <span class="agent-task-row-brief">${escapeHtml(task.brief)}</span>
                            <span class="agent-task-row-assignee">${escapeHtml(task.assigneeName)}</span>
                            <code class="agent-id-chip">${escapeHtml(task.id)}</code>
                          </button>
                        `,
                          )
                          .join("")
                  }
                </div>`
          }
        </div>`

  return `
    <div class="agent-surface team-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-title-block">
            <div class="agent-surface-kicker">Team Workspace</div>
            <div class="agent-surface-headline-row">
              <h2 class="agent-surface-title">${escapeHtml(team.name)}</h2>
              <div class="agent-metric-pills">
                <span class="agent-metric-pill">${counts.members} ${counts.members === 1 ? "member" : "members"}</span>
                ${counts.working > 0 ? `<span class="agent-metric-pill tone-working">${counts.working} active</span>` : ""}
                ${counts.tasksAttention > 0 ? `<span class="agent-metric-pill tone-attention">${counts.tasksAttention} need review</span>` : ""}
              </div>
            </div>
            ${team.createRoot ? `<div class="agent-surface-sub"><code class="org-workspace-path">${escapeHtml(team.createRoot)}</code></div>` : ""}
          </div>
          <div class="agent-surface-actions">
            ${leader ? `<button type="button" class="agent-btn secondary" data-agent-chat="${escapeAttribute(leader.agentId)}" data-agent-team="${escapeAttribute(team.id)}" data-agent-session="${escapeAttribute(leader.latestRuntimeSessionId)}">Chat with Leader (${escapeHtml(leader.name)})</button>` : ""}
            <button type="button" class="agent-btn secondary" data-team-toggle-add-member="1">+ Add Member</button>
            <button type="button" class="agent-btn primary" data-team-toggle-assign="1">+ Assign Task</button>
            <button type="button" class="agent-btn ghost danger-text" data-team-toggle-delete="1">Delete Team</button>
          </div>
        </header>
        <div class="agent-subnav-bar">
          <div class="agent-subnav-tabs" role="tablist" aria-label="Team surface views">
            <button type="button" role="tab" aria-selected="${surface.tab === "organization"}" class="agent-subnav-tab${surface.tab === "organization" ? " is-active" : ""}" data-team-switch-tab="organization">Organization &amp; Hierarchy <span class="agent-tab-count">${counts.members}</span></button>
            <button type="button" role="tab" aria-selected="${surface.tab === "tasks"}" class="agent-subnav-tab${surface.tab === "tasks" ? " is-active" : ""}" data-team-switch-tab="tasks">Tasks &amp; Deliveries <span class="agent-tab-count">${counts.tasksTotal}</span></button>
          </div>
        </div>
        ${deleteConfirmHtml}
        ${addMemberFormHtml}
        ${assignFormHtml}
        <div class="agent-surface-body panel-scroll">${bodyHtml}</div>
      </div>
      ${renderTaskDrawerHtml({ task: selectedTask, busy, artifactPreview })}
    </div>
  `
}

export function renderInboxSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  selectedTaskId: string
  busy: boolean
  artifactPreview: { path: string; content: string; truncated: boolean } | null
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const items = buildInboxItems(snapshot)
  const rawTask = options.selectedTaskId ? snapshot.tasks.find((t) => t.id === options.selectedTaskId) : null
  const selectedTask = rawTask ? enrichTask(snapshot, rawTask) : null

  return `
    <div class="agent-surface inbox-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-title-block">
            <div class="agent-surface-kicker">Management Triage</div>
            <div class="agent-surface-headline-row">
              <h2 class="agent-surface-title">Inbox &amp; Approvals</h2>
              <span class="agent-metric-pill">${items.length} pending</span>
            </div>
            <p class="agent-surface-desc">Human-in-the-loop approvals, blocked questions, completed task deliveries awaiting acceptance, and runtime notices across all teams.</p>
          </div>
          <div class="agent-surface-actions">
            <button type="button" class="agent-btn ghost" data-sidebar-surface="chat">Back to Chat</button>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          ${
            items.length === 0
              ? `<div class="agent-empty-box"><h3>Inbox Zero</h3><p>No pending approvals, blocked questions, or unreviewed task deliveries right now.</p></div>`
              : `<div class="agent-inbox-list">
                  ${items
                    .map(
                      (item) => `
                    <article class="agent-inbox-card tone-${item.tone}">
                      <div class="agent-inbox-card-main">
                        <div class="agent-inbox-meta">
                          <span class="agent-status-pill tone-${item.tone}"><span class="agent-status-dot"></span><span>${escapeHtml(item.badge)}</span></span>
                          ${item.subtitle ? `<span class="agent-inbox-subtitle">${escapeHtml(item.subtitle)}</span>` : ""}
                          ${item.createdAt ? `<span class="agent-timestamp">${escapeHtml(item.createdAt)}</span>` : ""}
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
                            ? `<button type="button" class="agent-btn primary sm" data-inbox-inspect-task="${escapeAttribute(item.taskId)}">${item.kind === "delivery" ? "Review Delivery" : item.kind === "blocker" ? "Answer Blocker" : "Inspect Task"}</button>`
                            : ""
                        }
                        ${
                          item.kind === "unconfirmed_run" && item.runId
                            ? `<button type="button" class="agent-btn warning sm" data-inbox-stop-run="${escapeAttribute(item.runId)}" ${options.busy ? "disabled" : ""}>Stop Unconfirmed Run</button>`
                            : ""
                        }
                        ${
                          item.kind === "notice" && item.noticeId
                            ? `<button type="button" class="agent-btn ghost sm" data-inbox-dismiss-notice="${escapeAttribute(item.noticeId)}" ${options.busy ? "disabled" : ""}>Dismiss</button>`
                            : ""
                        }
                        ${
                          item.teamId
                            ? `<button type="button" class="agent-btn ghost sm" data-sidebar-open-team="${escapeAttribute(item.teamId)}" data-sidebar-team-tab="organization">Open Team</button>`
                            : ""
                        }
                      </div>
                    </article>
                  `,
                    )
                    .join("")}
                </div>`
          }
        </div>
      </div>
      ${renderTaskDrawerHtml({ task: selectedTask, busy: options.busy, artifactPreview: options.artifactPreview })}
    </div>
  `
}

export function renderBackgroundSurfaceHtml(options: {
  snapshot: AgentsSnapshotData
  serviceInfo: Record<string, any> | null
  logView: { title: string; content: string } | null
  busy: boolean
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const activeRuns = snapshot.runs.filter(
    (r) => r.status === "starting" || r.status === "running" || r.status === "unknown",
  )
  const recentRuns = snapshot.runs
    .filter((r) => r.status !== "starting" && r.status !== "running" && r.status !== "unknown")
    .slice(-15)
    .reverse()
  const runtimeInfo = options.serviceInfo?.runtime || null
  const mgmtInfo = options.serviceInfo?.service || null

  return `
    <div class="agent-surface background-surface">
      <div class="agent-surface-main">
        <header class="agent-surface-header">
          <div class="agent-surface-title-block">
            <div class="agent-surface-kicker">Operations &amp; Observability</div>
            <div class="agent-surface-headline-row">
              <h2 class="agent-surface-title">Background Runs &amp; Shared Runtime</h2>
              <span class="agent-metric-pill tone-working">${activeRuns.length} active runs</span>
            </div>
            <p class="agent-surface-desc">Monitor delegated background agent runs, live runtime sessions, and shared management daemon health.</p>
          </div>
          <div class="agent-surface-actions">
            <button type="button" class="agent-btn secondary" data-bg-read-log="service" ${options.busy ? "disabled" : ""}>Service Log</button>
            <button type="button" class="agent-btn secondary" data-bg-read-log="runtime" ${options.busy ? "disabled" : ""}>Runtime Log</button>
            <button type="button" class="agent-btn ghost" data-sidebar-surface="chat">Back to Chat</button>
          </div>
        </header>
        <div class="agent-surface-body panel-scroll">
          <div class="agent-health-grid">
            <div class="agent-health-card">
              <div class="agent-card-kicker">Management Service</div>
              <div class="agent-health-status">
                <span class="agent-status-dot tone-${mgmtInfo ? "completed" : "working"}"></span>
                <strong>${mgmtInfo ? `Running (PID ${mgmtInfo.pid || "active"})` : "Connected"}</strong>
              </div>
              <div class="agent-health-meta">
                <span>Teams: ${snapshot.teams.length}</span>
                <span>Agents: ${snapshot.agents.length}</span>
                <span>Tasks: ${snapshot.tasks.length}</span>
              </div>
            </div>
            <div class="agent-health-card">
              <div class="agent-card-kicker">Shared Python Runtime</div>
              <div class="agent-health-status">
                <span class="agent-status-dot tone-completed"></span>
                <strong>${runtimeInfo?.host ? `${escapeHtml(String(runtimeInfo.host))}:${escapeHtml(String(runtimeInfo.port))}` : "Active"}</strong>
              </div>
              <div class="agent-health-meta">
                <span>Connected sessions: ${snapshot.connectedSessions.length}</span>
                <span>Live observers: ${snapshot.live.length}</span>
              </div>
            </div>
          </div>
          ${
            options.logView
              ? `<section class="agent-drawer-card"><div class="agent-card-header-row"><div class="agent-card-kicker">${escapeHtml(options.logView.title)}</div><button type="button" class="agent-btn ghost sm" data-bg-close-log="1">Close</button></div><pre class="agent-report-pre">${escapeHtml(options.logView.content)}</pre></section>`
              : ""
          }
          <section class="agent-bg-section">
            <h3 class="agent-section-heading">Active Delegated Runs (${activeRuns.length})</h3>
            ${
              activeRuns.length === 0
                ? `<div class="agent-empty-box compact"><p>No delegated agent runs are currently executing.</p></div>`
                : `<div class="agent-runs-list">
                    ${activeRuns
                      .map((run) => {
                        const task = snapshot.tasks.find((t) => t.id === run.taskId)
                        const agent = snapshot.agents.find((a) => a.id === run.agentId)
                        return `
                          <div class="agent-run-row">
                            <div class="agent-run-main">
                              <span class="agent-status-pill tone-${run.status === "unknown" ? "attention" : "working"}"><span class="agent-status-dot"></span><span>${escapeHtml(String(run.status))}</span></span>
                              <strong>${escapeHtml(String(agent?.name || run.agentId))}</strong>
                              <span class="agent-run-brief">${escapeHtml(String(task?.brief || `Run ${run.id}`))}</span>
                            </div>
                            <div class="agent-run-actions">
                              <button type="button" class="agent-btn ghost sm" data-bg-read-run-log="${escapeAttribute(run.id)}">Logs</button>
                              <button type="button" class="agent-btn danger-ghost sm" data-inbox-stop-run="${escapeAttribute(run.id)}" ${options.busy ? "disabled" : ""}>Stop</button>
                            </div>
                          </div>
                        `
                      })
                      .join("")}
                  </div>`
            }
          </section>
          ${
            recentRuns.length > 0
              ? `<section class="agent-bg-section">
                  <h3 class="agent-section-heading">Recent Runs</h3>
                  <div class="agent-runs-list">
                    ${recentRuns
                      .map((run) => {
                        const task = snapshot.tasks.find((t) => t.id === run.taskId)
                        const agent = snapshot.agents.find((a) => a.id === run.agentId)
                        return `
                          <div class="agent-run-row">
                            <div class="agent-run-main">
                              <span class="agent-status-pill tone-${run.status === "completed" ? "completed" : "idle"}"><span>${escapeHtml(String(run.status))}</span></span>
                              <strong>${escapeHtml(String(agent?.name || run.agentId))}</strong>
                              <span class="agent-run-brief">${escapeHtml(String(task?.brief || `Run ${run.id}`))}</span>
                            </div>
                            <div class="agent-run-actions">
                              <button type="button" class="agent-btn ghost sm" data-bg-read-run-log="${escapeAttribute(run.id)}">Logs</button>
                            </div>
                          </div>
                        `
                      })
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

export function renderInspectorTeamSectionHtml(options: {
  snapshot: AgentsSnapshotData
  chatContext: SessionAgentContext
}): string {
  const snapshot = normalizeAgentsSnapshot(options.snapshot)
  const { chatContext } = options
  const activeTeamId = chatContext.kind === "member" ? chatContext.teamId : snapshot.teams[0]?.id || ""
  const summary = activeTeamId ? buildTeamSummary(snapshot, activeTeamId) : null

  if (!summary && chatContext.kind !== "manager") return ""

  if (chatContext.kind === "manager" && !summary) {
    return `
      <div class="activity-section inspector-team-box">
        <div class="inspector-section-head">
          <span class="inspector-section-title">Manager Context</span>
          <span class="agent-status-pill tone-working">Coordinator</span>
        </div>
        <p class="inspector-empty">Chatting with the global Manager agent. Ask Manager to create teams or coordinate multi-agent workflows.</p>
      </div>
    `
  }

  if (!summary) return ""
  const { team, members, counts } = summary
  const grouped = groupTeamTasks(snapshot, team.id)
  const activeTasks = [...grouped.columns.needs_attention, ...grouped.columns.in_progress, ...grouped.columns.queued]

  return `
    <div class="activity-section inspector-team-box">
      <div class="inspector-section-head">
        <span class="inspector-section-title">Team · ${escapeHtml(team.name)}</span>
        <div class="inspector-team-links">
          <button type="button" class="ghost-button" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="organization">Org</button>
          <button type="button" class="ghost-button" data-sidebar-open-team="${escapeAttribute(team.id)}" data-sidebar-team-tab="tasks">Board (${counts.tasksTotal})</button>
        </div>
      </div>
      <div class="inspector-team-roster">
        ${members
          .map(
            (member) => `
          <button type="button" class="inspector-member-row${chatContext.kind === "member" && chatContext.agentId === member.agentId ? " is-active" : ""}" data-agent-chat="${escapeAttribute(member.agentId)}" data-agent-team="${escapeAttribute(team.id)}" data-agent-session="${escapeAttribute(member.latestRuntimeSessionId)}">
            <span class="agent-status-dot tone-${member.tone}"></span>
            <span class="inspector-member-name">${escapeHtml(member.name)}</span>
            <span class="inspector-member-role">${escapeHtml(member.position)}</span>
          </button>
        `,
          )
          .join("")}
      </div>
      ${
        activeTasks.length > 0
          ? `<div class="inspector-team-tasks">
              ${activeTasks
                .slice(0, 4)
                .map(
                  (task) => `
                <button type="button" class="inspector-task-mini" data-agent-select-task="${escapeAttribute(task.id)}" data-agent-team="${escapeAttribute(team.id)}">
                  <span class="agent-status-pill tone-${task.tone}">${escapeHtml(task.statusLabel)}</span>
                  <span class="inspector-task-mini-brief">${escapeHtml(task.brief)}</span>
                </button>
              `,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
  `
}

