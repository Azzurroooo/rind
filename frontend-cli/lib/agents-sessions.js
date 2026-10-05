export function sessionRows(snapshot, agentId, history = [], query = "", filter = "All") {
  const rows = new Map();
  for (const session of history) rows.set(session.runtimeSessionId, { ...session, id: session.runtimeSessionId, status: "Inactive" });
  for (const session of snapshot.sessions.filter(s => !agentId || s.agentId === agentId)) {
    if (!session.runtimeSessionId) continue;
    const previous = rows.get(session.runtimeSessionId);
    rows.set(session.runtimeSessionId, { ...previous, ...session, id: session.runtimeSessionId });
  }
  const order = { "Needs input": 0, Unconfirmed: 1, Working: 2, Ready: 3, Inactive: 4 };
  return [...rows.values()].map(session => {
    const agent = snapshot.agents.find(a => a.id === (agentId || session.agentId));
    const team = snapshot.teams.find(t => t.id === session.teamId);
    const task = snapshot.tasks.find(t => t.id === session.taskId);
    const title = session.title || session.first_user_message || task?.brief || session.runtimeSessionId;
    const scope = team?.name || "Independent";
    return { id: session.runtimeSessionId, kind: "session", title, status: session.status || "Inactive", agentId: agent?.id, teamId: session.teamId,
      caption: (agent?.name || "Member") + " · " + scope + " · " + (session.lastActivity || session.updated_at || "No activity yet"),
      details: [title, scope, agent?.canonicalWorkspace || "", "", "Session: " + session.runtimeSessionId, "Status: " + (session.status || "Inactive"), ...(task ? ["Task", task.brief] : []), "", "Enter joins this conversation in its workspace."] };
  }).filter(row => (!query || [row.title, row.caption, ...row.details].join(" ").toLowerCase().includes(query.toLowerCase())) && (filter === "All" || row.status === filter))
    .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
}

export function overviewRows(snapshot, query = "", filter = "All") {
  const rows = sessionRows(snapshot, null, [], query, filter);
  if (!snapshot.teams.length && !rows.length) return [{ id: "new", kind: "new", title: "+ Create your first team", caption: "Add folders as members, then organize their responsibilities" }];

  for (const member of snapshot.memberships) {
    if (snapshot.sessions.some(s => s.agentId === member.agentId && s.teamId === member.teamId && s.runtimeSessionId)) continue;
    const agent = snapshot.agents.find(a => a.id === member.agentId);
    const team = snapshot.teams.find(t => t.id === member.teamId);
    const row = { id: member.teamId + "/" + member.agentId, agentId: member.agentId, teamId: member.teamId, kind: "member", title: agent?.name,
      caption: team?.name + " · No sessions", status: member.status, details: [agent?.canonicalWorkspace || "", member.responsibility || "", "Enter to start a conversation"] };
    if ((filter === "All" || row.status === filter) && (!query || [row.title, row.caption, ...row.details].join(" ").toLowerCase().includes(query.toLowerCase()))) rows.push(row);
  }
  return rows;
}
