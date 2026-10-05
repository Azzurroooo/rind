export async function managementClient(options = {}) {
  try {
    const { connectManagement } = await import("../../agent-management/dist/client.js");
    return await connectManagement(options);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") throw new Error("Build agents management with: npm install --prefix agent-management && npm run build --prefix agent-management");
    throw error;
  }
}
export function selectRecord(records, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " ID or name is required.");
  const exact = records.find(item => item.id === value);
  if (exact) return exact;
  const matches = records.filter(item => item.name === value || item.id.startsWith(value));
  if (matches.length !== 1) throw new Error(label + ' "' + value + '" is ' + (matches.length ? "ambiguous; use its ID." : "not registered."));
  return matches[0];
}
export function agentStatus(snapshot, agentId, teamId) {
  return snapshot.memberships.find(m => m.agentId === agentId && m.teamId === teamId)?.status || "Unconfirmed";
}
export function overviewText(snapshot) {
  const lines = ["Agents · " + snapshot.teams.length + " teams", ""];
  for (const team of snapshot.teams) {
    const leader = snapshot.agents.find(a => a.id === team.leaderAgentId);
    lines.push(team.name + "  " + team.id + "  Leader: " + (leader?.name || "Choose a leader"));
    for (const member of snapshot.memberships.filter(m => m.teamId === team.id)) {
      const agent = snapshot.agents.find(a => a.id === member.agentId);
      lines.push("  " + agentStatus(snapshot, member.agentId, team.id).padEnd(12) + " " + agent?.name + " · " + (member.position || "Member") + " · " + (agent?.canonicalWorkspace || ""));
    }
    for (const task of snapshot.tasks.filter(t => t.teamId === team.id)) lines.push("  " + task.status + ": " + task.brief.slice(0, 100) + (task.blockedOn ? " → " + task.blockedOn.action : ""));
    lines.push("");
  }
  if (!snapshot.teams.length) lines.push("Create your first team: rind agents team create <name>");
  return lines.join("\n");
}
