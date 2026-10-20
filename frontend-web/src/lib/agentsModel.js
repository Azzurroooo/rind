// Pure data projection, hierarchy, session merge, action-first task grouping,
// Inbox sections, and Background model for Rind's native Team Agents surface.
// Faithfully aligned with `frontend-cli/lib/agents-model.js` and `agent-management`.

export const STATUS_META = Object.freeze({
  "Needs input": { glyph: "!", tone: "attention", rank: 0 },
  Unconfirmed: { glyph: "?", tone: "attention", rank: 0 },
  Working: { glyph: "●", tone: "working", rank: 1 },
  "Running job": { glyph: "↻", tone: "working", rank: 1 },
  Delegated: { glyph: "⋯", tone: "waiting", rank: 2 },
  Queued: { glyph: "◦", tone: "waiting", rank: 3 },
  Open: { glyph: "○", tone: "completed", rank: 4 },
  Done: { glyph: "✓", tone: "completed", rank: 4 },
  Idle: { glyph: "·", tone: "idle", rank: 5 },
  Cancelled: { glyph: "×", tone: "idle", rank: 6 },
});

export function statusGlyph(status) {
  return (STATUS_META[status] || STATUS_META.Idle).glyph;
}

export function statusRank(status) {
  return (STATUS_META[status] || STATUS_META.Idle).rank;
}

export function memberStatusTone(status) {
  return (STATUS_META[String(status || "Idle")] || STATUS_META.Idle).tone;
}

export function formatRelativeAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : String(iso).slice(0, 10);
}

export function emptyAgentsSnapshot() {
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
  };
}

export function normalizeAgentsSnapshot(raw) {
  const base = emptyAgentsSnapshot();
  if (!raw || typeof raw !== "object") return base;
  return {
    seq: Number(raw.seq) || 0,
    teams: Array.isArray(raw.teams) ? raw.teams : [],
    memberships: Array.isArray(raw.memberships) ? raw.memberships : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    connectedSessions: Array.isArray(raw.connectedSessions) ? raw.connectedSessions : [],
    live: Array.isArray(raw.live) ? raw.live : [],
    folderDefaultsVersion: Number(raw.folderDefaultsVersion) || 0,
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    approvals: Array.isArray(raw.approvals) ? raw.approvals : [],
    archivedTeams: Array.isArray(raw.archivedTeams) ? raw.archivedTeams : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
  };
}

export function formatJobSummary(liveItem, run) {
  const parts = [];
  if (run) {
    parts.push(run.origin === "task" ? "Task run" : "Delegation run");
  }
  if (liveItem?.pendingInput) {
    parts.push("Waiting for user input");
  } else if (liveItem?.turn && liveItem.turn !== "idle") {
    parts.push(liveItem.turn === "stopping" ? "Stopping turn" : "Running turn");
  }
  const tasks = Array.isArray(liveItem?.background?.tasks) ? liveItem.background.tasks : [];
  for (const job of tasks.slice(0, 2)) {
    const cmd = String(job.command || "command").replace(/\s+/g, " ").trim();
    parts.push(
      `${cmd.length > 42 ? `${cmd.slice(0, 41)}…` : cmd}${job.pid ? ` (pid ${job.pid})` : ""}`,
    );
  }
  if (tasks.length > 2) {
    parts.push(`+${tasks.length - 2} more`);
  } else if (!tasks.length && Number(liveItem?.background?.count) > 0) {
    parts.push(`${liveItem.background.count} background command(s)`);
  }
  return parts.join(" · ") || "Working";
}

function computeSessionStatus(session, liveItem, connectedSet) {
  if (liveItem?.pendingInput) return "Needs input";
  const turn = liveItem?.turn || liveItem?.turnStatus;
  if (turn && turn !== "idle") return "Working";
  if (Number(liveItem?.background?.count) > 0) return "Running job";
  if (session?.pendingDelegations?.length) return "Delegated";
  if (
    session &&
    (connectedSet.has(session.id) ||
      (session.runtimeSessionId && connectedSet.has(session.runtimeSessionId)))
  ) {
    return "Open";
  }
  return "Idle";
}

function getLiveRuntimeId(item) {
  return String(item?.id || item?.runtimeSessionId || item?.sessionId || "");
}

/**
 * Merges saved session history (`listSessions({ teamId })`) with live runtime
 * state (`snapshot.sessions` + `snapshot.live`), matching `teamSessions` in CLI.
 */
export function mergeTeamSessions(rawSnapshot, teamId, historyEntries = []) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const connected = new Set(snapshot.connectedSessions || []);
  const liveByRuntime = new Map(
    (snapshot.live || []).map((item) => [getLiveRuntimeId(item), item]),
  );
  const savedById = new Map(
    (Array.isArray(historyEntries) ? historyEntries : [])
      .filter((s) => s && s.runtimeSessionId)
      .map((s) => [String(s.runtimeSessionId), s]),
  );
  const sessionByRuntime = new Map(
    snapshot.sessions
      .filter((s) => s.teamId === teamId && s.runtimeSessionId)
      .map((s) => [String(s.runtimeSessionId), s]),
  );
  const ids = new Set([...savedById.keys(), ...sessionByRuntime.keys()]);

  const rows = [...ids]
    .map((runtimeSessionId) => {
      const saved = savedById.get(runtimeSessionId);
      const session = sessionByRuntime.get(runtimeSessionId);
      const liveItem = liveByRuntime.get(runtimeSessionId);
      const agentId = String(saved?.agentId || session?.agentId || "");
      const agent = snapshot.agents.find((a) => a.id === agentId);
      const taskId = String(saved?.taskId || session?.taskId || "");
      const task = taskId ? snapshot.tasks.find((t) => t.id === taskId) : null;
      const activeRun = snapshot.runs.find(
        (r) => r.sessionId === session?.id && (r.status === "starting" || r.status === "running"),
      );
      const status = activeRun && computeSessionStatus(session, liveItem, connected) === "Idle"
        ? "Working"
        : computeSessionStatus(session, liveItem, connected);
      const updatedAt = String(liveItem?.updatedAt || saved?.updatedAt || session?.createdAt || "");
      const title = String(
        saved?.title ||
          liveItem?.title ||
          task?.brief ||
          (session?.origin === "delegation" ? "Delegated conversation" : "New conversation"),
      );
      return {
        runtimeSessionId,
        sessionId: session?.id ? String(session.id) : "",
        teamId: String(teamId || saved?.teamId || session?.teamId || ""),
        agentId,
        agentName: String(agent?.name || saved?.agentName || agentId || "Member"),
        taskId,
        taskBrief: task ? String(task.brief || "") : "",
        origin: String(session?.origin || (taskId ? "task" : "direct")),
        title,
        updatedAt,
        ageText: formatRelativeAge(updatedAt),
        model: String(liveItem?.model || saved?.model || ""),
        status,
        tone: memberStatusTone(status),
        glyph: statusGlyph(status),
        pendingInput: Boolean(liveItem?.pendingInput),
        jobSummary:
          status === "Working" || status === "Running job" || status === "Needs input"
            ? formatJobSummary(liveItem, activeRun)
            : "",
      };
    })
    .filter((row) => row.agentId);

  rows.sort((a, b) => {
    const aActive = statusRank(a.status) < 5 ? 0 : 1;
    const bActive = statusRank(b.status) < 5 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const timeDiff = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (timeDiff !== 0) return timeDiff;
    return statusRank(a.status) - statusRank(b.status);
  });

  return rows;
}

/**
 * Merges saved Manager session history (`listSessions({ manager: true })`) with
 * live Manager sessions in `snapshot.sessions` and `snapshot.live`.
 */
export function mergeManagerSessions(rawSnapshot, historyEntries = []) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const connected = new Set(snapshot.connectedSessions || []);
  const liveByRuntime = new Map((snapshot.live || []).map((item) => [item.id, item]));
  const memberIds = new Set(snapshot.memberships.map((m) => m.agentId));
  const managerAgents = snapshot.agents.filter(
    (a) =>
      (!memberIds.has(a.id) && String(a.name || "").toLowerCase() === "manager") ||
      normalizePathKey(a.canonicalWorkspace).endsWith("/agents-management/manager") ||
      normalizePathKey(a.canonicalWorkspace).endsWith("/agents/manager"),
  );
  const managerAgentIds = new Set(managerAgents.map((a) => a.id));
  const liveManagerSessions = snapshot.sessions.filter(
    (s) => !s.teamId && (managerAgentIds.has(s.agentId) || !memberIds.has(s.agentId)),
  );
  const savedById = new Map(
    (Array.isArray(historyEntries) ? historyEntries : [])
      .filter((s) => s && s.runtimeSessionId)
      .map((s) => [String(s.runtimeSessionId), s]),
  );
  const sessionByRuntime = new Map(
    liveManagerSessions
      .filter((s) => s.runtimeSessionId)
      .map((s) => [String(s.runtimeSessionId), s]),
  );
  const ids = new Set([...savedById.keys(), ...sessionByRuntime.keys()]);

  const sessions = [...ids].map((runtimeSessionId) => {
    const saved = savedById.get(runtimeSessionId);
    const session = sessionByRuntime.get(runtimeSessionId);
    const liveItem = liveByRuntime.get(runtimeSessionId);
    const status = computeSessionStatus(session, liveItem, connected);
    const updatedAt = String(liveItem?.updatedAt || saved?.updatedAt || session?.createdAt || "");
    return {
      runtimeSessionId,
      sessionId: session?.id ? String(session.id) : "",
      manager: true,
      title: String(saved?.title || liveItem?.title || "Manager conversation"),
      updatedAt,
      ageText: formatRelativeAge(updatedAt),
      model: String(liveItem?.model || saved?.model || ""),
      status,
      tone: memberStatusTone(status),
      glyph: statusGlyph(status),
      pendingInput: Boolean(liveItem?.pendingInput),
      jobSummary:
        status === "Working" || status === "Running job" || status === "Needs input"
          ? formatJobSummary(liveItem, null)
          : "",
    };
  });

  sessions.sort((a, b) => {
    const aActive = statusRank(a.status) < 5 ? 0 : 1;
    const bActive = statusRank(b.status) < 5 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  let overallStatus = "Idle";
  for (const s of sessions) {
    if (statusRank(s.status) < statusRank(overallStatus)) {
      overallStatus = s.status;
    }
  }

  return {
    status: overallStatus,
    tone: memberStatusTone(overallStatus),
    glyph: statusGlyph(overallStatus),
    sessionCount: sessions.length,
    latestRuntimeSessionId: sessions[0]?.runtimeSessionId || "",
    sessions,
  };
}

export function taskGroupKey(task) {
  const status = String(task?.status || "queued");
  if (status === "needs_attention") return "needs";
  if (status === "blocked") {
    return task?.blockedOn?.responder === "user" ? "needs" : "delegated";
  }
  if (status === "running") return "working";
  if (status === "queued") return "queued";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  return "queued";
}

export function taskColumnKey(task) {
  const status = String(task?.status || "queued");
  if (status === "queued") return "queued";
  if (status === "running") return "in_progress";
  if (status === "blocked") {
    return task?.blockedOn?.responder === "user" ? "needs_attention" : "in_progress";
  }
  if (status === "needs_attention") return "needs_attention";
  if (status === "done") {
    if (task?.report && !task?.review) return "needs_attention";
    return "completed";
  }
  return "completed";
}

export function taskStatusMeta(task) {
  const status = String(task?.status || "queued");
  if (status === "running") {
    return { label: "In progress", status: "Working", tone: "working", group: "working", column: "in_progress" };
  }
  if (status === "queued") {
    const reason =
      task?.queueReason === "member_busy"
        ? "member busy"
        : task?.queueReason === "Runtime unavailable"
          ? "runtime unavailable"
          : task?.queueReason || "";
    return {
      label: reason ? `Queued · ${reason}` : "Queued",
      status: "Queued",
      tone: "waiting",
      group: "queued",
      column: "queued",
    };
  }
  if (status === "blocked") {
    if (task?.blockedOn?.responder === "user") {
      return {
        label: "Waiting on you",
        status: "Needs input",
        tone: "attention",
        group: "needs",
        column: "needs_attention",
      };
    }
    return {
      label: "Delegated to member",
      status: "Delegated",
      tone: "waiting",
      group: "delegated",
      column: "in_progress",
    };
  }
  if (status === "needs_attention") {
    return {
      label: "Needs your attention",
      status: "Needs input",
      tone: "attention",
      group: "needs",
      column: "needs_attention",
    };
  }
  if (status === "done") {
    if (task?.report && !task?.review) {
      return {
        label: "Delivered · To review",
        status: "Done",
        tone: "attention",
        group: "done",
        column: "needs_attention",
      };
    }
    if (task?.review?.decision === "rework") {
      return {
        label: "Rework requested",
        status: "Done",
        tone: "waiting",
        group: "done",
        column: "completed",
      };
    }
    if (task?.review?.decision === "accepted") {
      return {
        label: "Accepted",
        status: "Done",
        tone: "completed",
        group: "done",
        column: "completed",
      };
    }
    return { label: "Delivered", status: "Done", tone: "completed", group: "done", column: "completed" };
  }
  if (status === "cancelled") {
    return { label: "Cancelled", status: "Cancelled", tone: "idle", group: "cancelled", column: "completed" };
  }
  return { label: status, status: "Idle", tone: "idle", group: "queued", column: "queued" };
}

export const taskSectionKey = taskGroupKey;

export function buildTeamSummary(rawSnapshot, teamId, historyEntries = []) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const team = snapshot.teams.find((item) => item.id === teamId) || null;
  if (!team) return null;

  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const teamMemberships = snapshot.memberships.filter((m) => m.teamId === team.id);
  const teamTasks = snapshot.tasks.filter((t) => t.teamId === team.id);
  const mergedSessions = mergeTeamSessions(snapshot, team.id, historyEntries);
  const sessionsByAgent = new Map();
  for (const session of mergedSessions) {
    if (!sessionsByAgent.has(session.agentId)) {
      sessionsByAgent.set(session.agentId, []);
    }
    sessionsByAgent.get(session.agentId).push(session);
  }

  const members = teamMemberships.map((membership) => {
    const agent = agentById.get(membership.agentId) || { id: membership.agentId, name: membership.agentId };
    const isLeader = team.leaderAgentId === membership.agentId;
    const supervisor = membership.reportsToAgentId ? agentById.get(membership.reportsToAgentId) : null;
    const memberTasks = teamTasks.filter((t) => t.assigneeAgentId === membership.agentId);
    const activeTask =
      memberTasks.find((t) => t.status === "running" || t.status === "blocked" || t.status === "needs_attention") ||
      memberTasks.find((t) => t.status === "queued") ||
      null;
    const memberSessions = sessionsByAgent.get(membership.agentId) || [];
    const status = String(membership.status || "Idle");

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
      glyph: statusGlyph(status),
      tone: memberStatusTone(status),
      activeTask,
      sessions: memberSessions,
      sessionCount: memberSessions.length,
      latestRuntimeSessionId: memberSessions[0]?.runtimeSessionId || "",
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
    };
  });

  members.sort((a, b) => {
    if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const memberById = new Map(members.map((m) => [m.agentId, { ...m, children: [] }]));
  const roots = [];
  for (const node of memberById.values()) {
    const parentId = node.reportsToAgentId;
    if (parentId && parentId !== node.agentId && memberById.has(parentId)) {
      let cursor = memberById.get(parentId);
      let cycle = false;
      const seen = new Set([node.agentId]);
      while (cursor) {
        if (seen.has(cursor.agentId)) {
          cycle = true;
          break;
        }
        seen.add(cursor.agentId);
        cursor = cursor.reportsToAgentId ? memberById.get(cursor.reportsToAgentId) : null;
      }
      if (!cycle) {
        memberById.get(parentId).children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const leader = members.find((m) => m.isLeader) || members[0] || null;
  const activeTasks = teamTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const unreviewedCount = teamTasks.filter((t) => t.status === "done" && t.report && !t.review).length;
  const needsInputCount =
    members.filter((m) => m.status === "Needs input" || m.status === "Unconfirmed").length +
    activeTasks.filter((t) => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder === "user")).length;
  const workingCount = members.filter((m) => m.status === "Working" || m.status === "Running job").length;
  const queuedCount = activeTasks.filter((t) => t.status === "queued").length;

  let teamStatus = "Idle";
  for (const m of members) {
    if (statusRank(m.status) < statusRank(teamStatus)) teamStatus = m.status;
  }
  if (needsInputCount > 0) teamStatus = "Needs input";

  const counts = {
    members: members.length,
    working: workingCount,
    attention: needsInputCount + unreviewedCount,
    needsInput: needsInputCount,
    unreviewed: unreviewedCount,
    sessions: mergedSessions.length,
    tasksTotal: teamTasks.length,
    tasksQueued: queuedCount,
    tasksInProgress: teamTasks.filter((t) => t.status === "running").length,
    tasksDelegated: teamTasks.filter((t) => t.status === "blocked" && t.blockedOn?.responder !== "user").length,
    tasksAttention: needsInputCount + unreviewedCount,
    tasksCompleted: teamTasks.filter((t) => t.status === "done").length,
  };

  return {
    team: {
      id: String(team.id),
      name: String(team.name || team.id),
      leaderAgentId: team.leaderAgentId ? String(team.leaderAgentId) : "",
      createRoot: String(team.createRoot || ""),
      status: teamStatus,
      glyph: statusGlyph(teamStatus),
      tone: memberStatusTone(teamStatus),
    },
    leader,
    members,
    orgRoots: roots,
    sessions: mergedSessions,
    counts,
  };
}

export function enrichTask(rawSnapshot, task) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  if (!task) return null;
  const team = snapshot.teams.find((t) => t.id === task.teamId);
  const agent = snapshot.agents.find((a) => a.id === task.assigneeAgentId);
  const membership = snapshot.memberships.find(
    (m) => m.teamId === task.teamId && m.agentId === task.assigneeAgentId,
  );
  const meta = taskStatusMeta(task);
  const notes = snapshot.notes.filter((n) => n.taskId === task.id);
  const artifactRecords = snapshot.artifacts.filter((a) => a.taskId === task.id);
  const taskRuns = snapshot.runs.filter((r) => r.taskId === task.id);
  const activeRun =
    taskRuns.find((r) => r.status === "starting" || r.status === "running" || r.status === "unknown") ||
    taskRuns[taskRuns.length - 1] ||
    null;
  const taskSession =
    snapshot.sessions.find((s) => s.taskId === task.id && s.runtimeSessionId) || null;
  const unreviewed = Boolean(task.status === "done" && task.report && !task.review);

  let blockedSummary = "";
  if (task.status === "blocked" && task.blockedOn) {
    if (task.blockedOn.responder === "user") {
      blockedSummary = String(task.blockedOn.action || "Waiting on your answer");
    } else if (Array.isArray(task.blockedOn.children) && task.blockedOn.children.length > 0) {
      const childNames = task.blockedOn.children.map((c) => {
        const childAgent = snapshot.agents.find((a) => a.id === c.agentId);
        return `${childAgent?.name || c.agentId} (${c.status})`;
      });
      blockedSummary = `Waiting on ${childNames.join(", ")}`;
    }
  }

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
    group: meta.group,
    column: meta.column,
    tone: meta.tone,
    statusLabel: meta.label,
    glyph: statusGlyph(meta.status),
    unreviewed,
    blockedSummary,
    notes,
    artifactRecords,
    runs: taskRuns,
    activeRun,
    runtimeSessionId: taskSession ? String(taskSession.runtimeSessionId) : "",
    ageText: formatRelativeAge(task.deliveredAt || task.startedAt || task.createdAt),
  };
}

export const TASK_SECTION_DEFS = Object.freeze([
  { id: "needs", label: "Needs you", emptyText: "Nothing waiting on your input" },
  { id: "working", label: "In progress", emptyText: "No tasks currently running" },
  { id: "queued", label: "Queued", emptyText: "No tasks in queue" },
  { id: "delegated", label: "Delegated to members", emptyText: "No tasks waiting on sub-delegations" },
  { id: "done", label: "Delivered", emptyText: "No delivered tasks yet" },
  { id: "cancelled", label: "Cancelled", emptyText: "No cancelled tasks" },
]);

export const KANBAN_COLUMNS = Object.freeze([
  { id: "queued", label: "Queued", emptyText: "No queued tasks" },
  { id: "in_progress", label: "In Progress", emptyText: "No tasks currently running" },
  { id: "needs_attention", label: "Needs Review / Input", emptyText: "Nothing blocked or awaiting review" },
  { id: "completed", label: "Completed", emptyText: "No completed tasks yet" },
]);

export function groupTeamTasks(rawSnapshot, teamId = "") {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const filtered = teamId
    ? snapshot.tasks.filter((t) => t.teamId === teamId)
    : snapshot.tasks;
  const enriched = filtered.map((task) => enrichTask(snapshot, task)).filter(Boolean);

  const priorityRank = { high: 0, normal: 1, low: 2 };
  enriched.sort((a, b) => {
    // In Delivered, show unreviewed deliveries first.
    if (a.group === "done" && b.group === "done" && a.unreviewed !== b.unreviewed) {
      return a.unreviewed ? -1 : 1;
    }
    const rankDiff = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    if (rankDiff !== 0 && a.group !== "done" && a.group !== "cancelled") return rankDiff;
    const aTime = String(a.deliveredAt || a.startedAt || a.createdAt || "");
    const bTime = String(b.deliveredAt || b.startedAt || b.createdAt || "");
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return String(b.id).localeCompare(String(a.id));
  });

  const groups = {
    needs: [],
    working: [],
    queued: [],
    delegated: [],
    done: [],
    cancelled: [],
  };
  const columns = {
    queued: [],
    in_progress: [],
    needs_attention: [],
    completed: [],
  };

  for (const item of enriched) {
    groups[item.group]?.push(item);
    columns[item.column]?.push(item);
  }

  const sections = TASK_SECTION_DEFS.map((def) => ({
    ...def,
    tasks: groups[def.id] || [],
  }));

  return {
    all: enriched,
    groups,
    sections,
    columns,
  };
}

/**
 * Builds the 3 canonical Inbox sections from `frontend-cli/lib/agents-model.js`:
 * 1. `needsYou` (approvals, user blockers, tasks needing attention, unconfirmed runs, live sessions waiting on input)
 * 2. `notices` (`Changed by the Manager`)
 * 3. `delivered` (`Recently delivered` tasks with unreviewed review state highlighted)
 */
export function buildInboxSections(rawSnapshot) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]));
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]));

  const needsYou = [];
  const notices = [];
  const delivered = [];

  for (const approval of snapshot.approvals) {
    const team = teamById.get(approval.teamId);
    needsYou.push({
      id: `approval:${approval.id}`,
      kind: "approval",
      tone: "attention",
      glyph: "!",
      badge: approval.kind === "deleteTeam" ? "Confirm Team Deletion" : "Confirm Run Stop",
      title: String(approval.title || "Approval requested"),
      subtitle: team ? `Team ${team.name}` : "Management approval",
      teamId: String(approval.teamId || ""),
      approvalId: String(approval.id),
      taskId: approval.taskId ? String(approval.taskId) : "",
      runId: approval.runId ? String(approval.runId) : "",
      createdAt: String(approval.createdAt || ""),
      ageText: formatRelativeAge(approval.createdAt),
      raw: approval,
    });
  }

  for (const task of snapshot.tasks) {
    const team = teamById.get(task.teamId);
    const agent = agentById.get(task.assigneeAgentId);
    const subtitle = [team?.name, agent?.name].filter(Boolean).join(" › ");

    if (task.status === "blocked" && task.blockedOn?.responder === "user") {
      needsYou.push({
        id: `blocker:${task.id}`,
        kind: "blocker",
        tone: "attention",
        glyph: "!",
        badge: "Waiting on your answer",
        title: String(task.blockedOn.action || task.brief || "Task waiting on your answer"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.brief || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.startedAt || task.createdAt || ""),
        ageText: formatRelativeAge(task.startedAt || task.createdAt),
        raw: enrichTask(snapshot, task),
      });
    } else if (task.status === "needs_attention") {
      needsYou.push({
        id: `attention:${task.id}`,
        kind: "attention",
        tone: "attention",
        glyph: "!",
        badge: "Needs attention",
        title: String(task.brief || "Task needs attention"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.error || task.report?.summary || "Run stopped before submitting a final report."),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.completedAt || task.startedAt || task.createdAt || ""),
        ageText: formatRelativeAge(task.completedAt || task.startedAt || task.createdAt),
        raw: enrichTask(snapshot, task),
      });
    } else if (task.status === "done") {
      const enriched = enrichTask(snapshot, task);
      const isUnreviewed = Boolean(task.report && !task.review);
      delivered.push({
        id: `delivery:${task.id}`,
        kind: "delivery",
        tone: isUnreviewed ? "attention" : "completed",
        glyph: isUnreviewed ? "!" : "✓",
        unreviewed: isUnreviewed,
        badge: isUnreviewed
          ? "New delivery · To review"
          : task.review?.decision === "accepted"
            ? "Accepted"
            : task.review?.decision === "rework"
              ? "Sent for rework"
              : "Delivered",
        title: String(task.brief || "Completed task delivery"),
        subtitle: subtitle || `Task ${task.id}`,
        detail: String(task.report?.summary || task.report?.outcome || ""),
        teamId: String(task.teamId || ""),
        agentId: String(task.assigneeAgentId || ""),
        taskId: String(task.id),
        createdAt: String(task.deliveredAt || task.completedAt || ""),
        ageText: formatRelativeAge(task.deliveredAt || task.completedAt),
        raw: enriched,
      });
    }
  }

  for (const run of snapshot.runs) {
    if (run.status === "unknown") {
      const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null;
      const team = task?.teamId ? teamById.get(task.teamId) : null;
      const agent = agentById.get(run.agentId);
      needsYou.push({
        id: `run:${run.id}`,
        kind: "unconfirmed_run",
        tone: "attention",
        glyph: "?",
        badge: "Unconfirmed run",
        title: task ? `Unconfirmed run for "${task.brief}"` : `Run ${run.id} lost host contact`,
        subtitle: [team?.name, agent?.name].filter(Boolean).join(" › ") || `Started ${formatRelativeAge(run.startedAt)}`,
        detail: "Confirm whether the agent process has stopped so queued work can proceed safely.",
        runId: String(run.id),
        taskId: run.taskId ? String(run.taskId) : "",
        teamId: task?.teamId ? String(task.teamId) : "",
        createdAt: String(run.startedAt || ""),
        ageText: formatRelativeAge(run.startedAt),
        raw: run,
      });
    }
  }

  for (const liveItem of snapshot.live) {
    if (!liveItem?.pendingInput) continue;
    const session = snapshot.sessions.find((s) => s.runtimeSessionId === liveItem.id);
    if (!session?.teamId) continue;
    const team = teamById.get(session.teamId);
    const agent = agentById.get(session.agentId);
    needsYou.push({
      id: `session:${liveItem.id}`,
      kind: "session_input",
      tone: "attention",
      glyph: "!",
      badge: "Conversation waiting on you",
      title: String(liveItem.title || "Conversation waiting for your input"),
      subtitle: [team?.name, agent?.name].filter(Boolean).join(" › "),
      detail: "This member session is paused on a question or tool confirmation.",
      teamId: String(session.teamId),
      agentId: String(session.agentId || ""),
      runtimeSessionId: String(liveItem.id),
      createdAt: String(liveItem.updatedAt || ""),
      ageText: formatRelativeAge(liveItem.updatedAt),
      raw: liveItem,
    });
  }

  for (const notice of snapshot.notices) {
    const team = teamById.get(notice.teamId);
    const agent = agentById.get(notice.agentId);
    notices.push({
      id: `notice:${notice.id}`,
      kind: "notice",
      tone: "waiting",
      glyph: "•",
      badge: "Changed by Manager",
      title: String(notice.title || "Team update"),
      subtitle: [team?.name, agent?.name].filter(Boolean).join(" › "),
      noticeId: String(notice.id),
      teamId: String(notice.teamId || ""),
      agentId: String(notice.agentId || ""),
      taskId: notice.taskId ? String(notice.taskId) : "",
      createdAt: String(notice.createdAt || ""),
      ageText: formatRelativeAge(notice.createdAt),
      raw: notice,
    });
  }

  delivered.sort((a, b) => {
    if (a.unreviewed !== b.unreviewed) return a.unreviewed ? -1 : 1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  return {
    needsYou,
    notices,
    delivered,
    unreviewedDeliveries: delivered.filter((d) => d.unreviewed),
  };
}

export function buildInboxItems(rawSnapshot) {
  const { needsYou, notices, unreviewedDeliveries } = buildInboxSections(rawSnapshot);
  return [...needsYou, ...unreviewedDeliveries, ...notices];
}

export function inboxBadgeCount(rawSnapshot) {
  const { needsYou, notices, unreviewedDeliveries } = buildInboxSections(rawSnapshot);
  return needsYou.length + notices.length + unreviewedDeliveries.length;
}

/**
 * Builds the unified Background model matching `backgroundRows` in CLI:
 * - `runningNow`: merged active runtime sessions (`snapshot.live`) and managed runs (`snapshot.runs`)
 * - `unconfirmedRuns`: runs with status === "unknown"
 */
export function buildBackgroundModel(rawSnapshot, service = null) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]));
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));
  const sessionByRuntime = new Map(
    snapshot.sessions.filter((s) => s.runtimeSessionId).map((s) => [String(s.runtimeSessionId), s]),
  );
  const activeRunByRuntime = new Map();
  for (const run of snapshot.runs) {
    if (run.status !== "starting" && run.status !== "running") continue;
    const sess = sessionById.get(run.sessionId);
    if (sess?.runtimeSessionId) {
      activeRunByRuntime.set(String(sess.runtimeSessionId), run);
    }
  }

  const runningNow = [];
  const seenRunIds = new Set();

  for (const liveItem of snapshot.live) {
    const isWorking =
      Boolean(liveItem.pendingInput) ||
      (liveItem.turn && liveItem.turn !== "idle") ||
      Number(liveItem?.background?.count) > 0;
    const run = activeRunByRuntime.get(String(liveItem.id));
    if (!isWorking && !run) continue;
    if (run) seenRunIds.add(run.id);

    const session = sessionByRuntime.get(String(liveItem.id));
    const team = session?.teamId ? teamById.get(session.teamId) : null;
    const agent = session?.agentId ? agentById.get(session.agentId) : null;
    const task = run?.taskId
      ? snapshot.tasks.find((t) => t.id === run.taskId)
      : session?.taskId
        ? snapshot.tasks.find((t) => t.id === session.taskId)
        : null;

    const status = liveItem.pendingInput
      ? "Needs input"
      : Number(liveItem?.background?.count) > 0 && (!liveItem.turn || liveItem.turn === "idle")
        ? "Running job"
        : "Working";

    const scopeLabel = team
      ? `${team.name} › ${agent?.name || session?.agentId || "Member"}`
      : agent && String(agent.name).toLowerCase() === "manager"
        ? "Manager"
        : liveItem.workspace
          ? `Workspace · ${String(liveItem.workspace).replace(/\\/g, "/").split("/").filter(Boolean).pop()}`
          : "Independent session";

    runningNow.push({
      id: `live:${liveItem.id}`,
      runtimeSessionId: String(liveItem.id),
      runId: run ? String(run.id) : "",
      taskId: task ? String(task.id) : "",
      teamId: team ? String(team.id) : "",
      agentId: agent ? String(agent.id) : "",
      title: String(task?.brief || liveItem.title || "Active conversation"),
      scopeLabel,
      jobSummary: formatJobSummary(liveItem, run),
      status,
      tone: memberStatusTone(status),
      glyph: statusGlyph(status),
      updatedAt: String(liveItem.updatedAt || run?.startedAt || ""),
      ageText: formatRelativeAge(liveItem.updatedAt || run?.startedAt),
    });
  }

  for (const run of snapshot.runs) {
    if ((run.status !== "starting" && run.status !== "running") || seenRunIds.has(run.id)) continue;
    const session = sessionById.get(run.sessionId);
    const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null;
    const teamId = task?.teamId || session?.teamId || "";
    const team = teamId ? teamById.get(teamId) : null;
    const agent = agentById.get(run.agentId);
    runningNow.push({
      id: `run:${run.id}`,
      runtimeSessionId: session?.runtimeSessionId ? String(session.runtimeSessionId) : "",
      runId: String(run.id),
      taskId: task ? String(task.id) : "",
      teamId: String(teamId),
      agentId: String(run.agentId || ""),
      title: String(task?.brief || (run.origin === "task" ? "Task execution" : "Delegated run")),
      scopeLabel: [team?.name, agent?.name || run.agentId].filter(Boolean).join(" › ") || "Managed run",
      jobSummary: run.status === "starting" ? "Starting agent run…" : "Running managed task",
      status: "Working",
      tone: "working",
      glyph: "●",
      updatedAt: String(run.startedAt || ""),
      ageText: formatRelativeAge(run.startedAt),
    });
  }

  const unconfirmedRuns = snapshot.runs
    .filter((r) => r.status === "unknown")
    .map((run) => {
      const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null;
      const team = task?.teamId ? teamById.get(task.teamId) : null;
      const agent = agentById.get(run.agentId);
      return {
        id: String(run.id),
        runId: String(run.id),
        taskId: task ? String(task.id) : "",
        teamId: team ? String(team.id) : "",
        agentId: String(run.agentId || ""),
        title: String(task?.brief || `Run ${run.id}`),
        scopeLabel: [team?.name, agent?.name || run.agentId].filter(Boolean).join(" › ") || "Unconfirmed run",
        startedAt: String(run.startedAt || ""),
        ageText: formatRelativeAge(run.startedAt),
      };
    });

  return {
    runningNow,
    unconfirmedRuns,
    service,
  };
}

export function activeBackgroundCount(rawSnapshot) {
  const { runningNow, unconfirmedRuns } = buildBackgroundModel(rawSnapshot);
  return runningNow.length + unconfirmedRuns.length;
}

function normalizePathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isManagedAgentWorkspace(workspacePath, rawSnapshot) {
  const wsKey = normalizePathKey(workspacePath);
  if (!wsKey) return false;
  if (
    wsKey.endsWith("/agents-management/manager") ||
    wsKey.endsWith("/agents/manager") ||
    wsKey.includes("/agents-management/workspaces/") ||
    wsKey.includes("/agents/workspaces/")
  ) {
    return true;
  }
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  if (snapshot.agents.some((a) => normalizePathKey(a.canonicalWorkspace) === wsKey)) {
    return true;
  }
  if (snapshot.sessions.some((s) => normalizePathKey(s.workspaceRoot) === wsKey)) {
    return true;
  }
  return false;
}

export function resolveSessionAgentContext(rawSnapshot, sessionId, workspaceRoot) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const sid = String(sessionId || "").trim();
  const wsKey = normalizePathKey(workspaceRoot);

  if (sid) {
    const managedSession = snapshot.sessions.find((s) => s.runtimeSessionId === sid);
    if (managedSession) {
      const agent = snapshot.agents.find((a) => a.id === managedSession.agentId);
      const team = managedSession.teamId ? snapshot.teams.find((t) => t.id === managedSession.teamId) : null;
      const membership = team
        ? snapshot.memberships.find((m) => m.teamId === team.id && m.agentId === managedSession.agentId)
        : null;
      if (team && agent) {
        return {
          kind: "member",
          workspaceRoot: String(managedSession.workspaceRoot || agent.canonicalWorkspace || workspaceRoot || ""),
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(agent.id),
          agentName: String(agent.name || agent.id),
          roleLabel: String(membership?.position || (team.leaderAgentId === agent.id ? "Team Leader" : "Specialist")),
          isLeader: team.leaderAgentId === agent.id,
          status: String(membership?.status || "Idle"),
        };
      }
      if (!managedSession.teamId && agent && String(agent.name).toLowerCase() === "manager") {
        return {
          kind: "manager",
          workspaceRoot: String(managedSession.workspaceRoot || agent.canonicalWorkspace || workspaceRoot || ""),
          agentId: String(agent.id),
          agentName: "Manager",
          roleLabel: "Organization Coordinator",
        };
      }
    }
  }

  if (wsKey) {
    if (wsKey.endsWith("/agents-management/manager") || wsKey.endsWith("/agents/manager")) {
      return {
        kind: "manager",
        workspaceRoot: String(workspaceRoot || ""),
        agentId: "",
        agentName: "Manager",
        roleLabel: "Organization Coordinator",
      };
    }
    const matchingAgent = snapshot.agents.find(
      (a) => normalizePathKey(a.canonicalWorkspace) === wsKey,
    );
    if (matchingAgent) {
      const membership = snapshot.memberships.find((m) => m.agentId === matchingAgent.id);
      const team = membership ? snapshot.teams.find((t) => t.id === membership.teamId) : null;
      if (team) {
        return {
          kind: "member",
          workspaceRoot: String(matchingAgent.canonicalWorkspace || workspaceRoot || ""),
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(matchingAgent.id),
          agentName: String(matchingAgent.name || matchingAgent.id),
          roleLabel: String(
            membership?.position || (team.leaderAgentId === matchingAgent.id ? "Team Leader" : "Specialist"),
          ),
          isLeader: team.leaderAgentId === matchingAgent.id,
          status: String(membership?.status || "Idle"),
        };
      }
    }
  }

  return { kind: "independent" };
}
