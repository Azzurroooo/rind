// Pure data projection and hierarchy/Kanban/inbox builders for Rind's native
// Team Agents Management surface.

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

export function memberStatusTone(status) {
  switch (String(status || "Idle")) {
    case "Working":
    case "Running job":
      return "working";
    case "Needs input":
    case "Unconfirmed":
      return "attention";
    case "Delegated":
    case "Queued":
      return "waiting";
    case "Open":
      return "completed";
    default:
      return "idle";
  }
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
    return { label: "Running", tone: "working", column: "in_progress" };
  }
  if (status === "queued") {
    return {
      label: task?.queueReason ? `Queued · ${task.queueReason}` : "Queued",
      tone: "waiting",
      column: "queued",
    };
  }
  if (status === "blocked") {
    if (task?.blockedOn?.responder === "user") {
      return { label: "Needs user input", tone: "attention", column: "needs_attention" };
    }
    return { label: "Waiting on sub-task", tone: "waiting", column: "in_progress" };
  }
  if (status === "needs_attention") {
    return { label: "Needs attention", tone: "attention", column: "needs_attention" };
  }
  if (status === "done") {
    if (task?.report && !task?.review) {
      return { label: "Ready for review", tone: "attention", column: "needs_attention" };
    }
    if (task?.review?.decision === "rework") {
      return { label: "Sent for rework", tone: "waiting", column: "completed" };
    }
    if (task?.review?.decision === "accepted") {
      return { label: "Accepted", tone: "completed", column: "completed" };
    }
    return { label: "Done", tone: "completed", column: "completed" };
  }
  if (status === "cancelled") {
    return { label: "Cancelled", tone: "idle", column: "completed" };
  }
  return { label: status, tone: "idle", column: "queued" };
}

export function buildTeamSummary(rawSnapshot, teamId) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const team = snapshot.teams.find((item) => item.id === teamId) || null;
  if (!team) return null;

  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const teamMemberships = snapshot.memberships.filter((m) => m.teamId === team.id);
  const teamTasks = snapshot.tasks.filter((t) => t.teamId === team.id);
  const teamSessions = snapshot.sessions.filter((s) => s.teamId === team.id);

  const members = teamMemberships.map((membership) => {
    const agent = agentById.get(membership.agentId) || { id: membership.agentId, name: membership.agentId };
    const isLeader = team.leaderAgentId === membership.agentId;
    const supervisor = membership.reportsToAgentId ? agentById.get(membership.reportsToAgentId) : null;
    const memberTasks = teamTasks.filter((t) => t.assigneeAgentId === membership.agentId);
    const activeTask =
      memberTasks.find((t) => t.status === "running" || t.status === "blocked" || t.status === "needs_attention") ||
      memberTasks.find((t) => t.status === "queued") ||
      null;
    const directSessions = teamSessions.filter(
      (s) => s.agentId === membership.agentId && s.origin === "direct" && s.runtimeSessionId,
    );
    const latestDirectSession = directSessions[directSessions.length - 1] || null;
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
    };
  });

  // Sort: leader first, then working/attention, then alphabetical.
  members.sort((a, b) => {
    if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const memberById = new Map(members.map((m) => [m.agentId, { ...m, children: [] }]));
  const roots = [];
  for (const node of memberById.values()) {
    const parentId = node.reportsToAgentId;
    if (parentId && parentId !== node.agentId && memberById.has(parentId)) {
      // Guard against cycles in reporting chain.
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
  const counts = {
    members: members.length,
    working: members.filter((m) => m.tone === "working").length,
    attention: members.filter((m) => m.tone === "attention").length,
    tasksTotal: teamTasks.length,
    tasksQueued: teamTasks.filter((t) => taskColumnKey(t) === "queued").length,
    tasksInProgress: teamTasks.filter((t) => taskColumnKey(t) === "in_progress").length,
    tasksAttention: teamTasks.filter((t) => taskColumnKey(t) === "needs_attention").length,
    tasksCompleted: teamTasks.filter((t) => taskColumnKey(t) === "completed").length,
  };

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
  const activeRun =
    snapshot.runs.find((r) => r.taskId === task.id && (r.status === "starting" || r.status === "running" || r.status === "unknown")) ||
    snapshot.runs.filter((r) => r.taskId === task.id).pop() ||
    null;
  const taskSession =
    snapshot.sessions.find((s) => s.taskId === task.id && s.runtimeSessionId) || null;

  return {
    ...task,
    id: String(task.id),
    teamId: String(task.teamId || ""),
    teamName: String(team?.name || task.teamId || ""),
    assigneeAgentId: String(task.assigneeAgentId || ""),
    assigneeName: String(agent?.name || task.assigneeAgentId || "Unassigned"),
    assigneePosition: String(membership?.position || (team?.leaderAgentId === task.assigneeAgentId ? "Team Leader" : "Specialist")),
    brief: String(task.brief || ""),
    priority: task.priority === "high" || task.priority === "low" ? task.priority : "normal",
    column: meta.column,
    tone: meta.tone,
    statusLabel: meta.label,
    notes,
    artifactRecords,
    activeRun,
    runtimeSessionId: taskSession ? String(taskSession.runtimeSessionId) : "",
  };
}

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

  // Sort high priority first within active states, then newest first.
  const priorityRank = { high: 0, normal: 1, low: 2 };
  enriched.sort((a, b) => {
    const rankDiff = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    if (rankDiff !== 0 && a.column !== "completed" && b.column !== "completed") return rankDiff;
    return String(b.id).localeCompare(String(a.id));
  });

  const columns = {
    queued: [],
    in_progress: [],
    needs_attention: [],
    completed: [],
  };
  for (const item of enriched) {
    columns[item.column]?.push(item);
  }
  return {
    all: enriched,
    columns,
  };
}

export function buildInboxItems(rawSnapshot) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]));
  const agentById = new Map(snapshot.agents.map((a) => [a.id, a]));
  const items = [];

  for (const approval of snapshot.approvals) {
    const team = teamById.get(approval.teamId);
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
    });
  }

  for (const task of snapshot.tasks) {
    const team = teamById.get(task.teamId);
    const agent = agentById.get(task.assigneeAgentId);
    const subtitle = [team?.name, agent?.name].filter(Boolean).join(" · ");

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
      });
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
      });
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
      });
    }
  }

  for (const run of snapshot.runs) {
    if (run.status === "unknown") {
      const task = run.taskId ? snapshot.tasks.find((t) => t.id === run.taskId) : null;
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
      });
    }
  }

  for (const notice of snapshot.notices) {
    const team = teamById.get(notice.teamId);
    const agent = agentById.get(notice.agentId);
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
    });
  }

  return items;
}

export function inboxBadgeCount(rawSnapshot) {
  return buildInboxItems(rawSnapshot).length;
}

export function activeBackgroundCount(rawSnapshot) {
  const snapshot = normalizeAgentsSnapshot(rawSnapshot);
  const activeRuns = snapshot.runs.filter(
    (r) => r.status === "starting" || r.status === "running" || r.status === "unknown",
  ).length;
  const liveBg = snapshot.live.reduce((sum, item) => sum + (Number(item?.background?.count) || 0), 0);
  return activeRuns + liveBg;
}

function normalizePathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
          agentId: String(agent.id),
          agentName: "Manager",
          roleLabel: "Organization Coordinator",
        };
      }
    }
  }

  if (wsKey) {
    if (wsKey.endsWith("/agents/manager")) {
      return {
        kind: "manager",
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
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(matchingAgent.id),
          agentName: String(matchingAgent.name || matchingAgent.id),
          roleLabel: String(membership?.position || (team.leaderAgentId === matchingAgent.id ? "Team Leader" : "Specialist")),
          isLeader: team.leaderAgentId === matchingAgent.id,
          status: String(membership?.status || "Idle"),
        };
      }
    }
  }

  return { kind: "independent" };
}
