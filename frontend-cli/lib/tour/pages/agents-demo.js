import { emptyAgentsSnapshot } from "../../agents-model.js";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const AT = new Date(NOW).toISOString();

// Fictional, serializable management states. Time is fixed for stable replay.
export function agentsScene(phase = "organization") {
  const snapshot = emptyAgentsSnapshot();
  snapshot.teams.push({ id: "product", name: "product", leaderAgentId: "demo", createRoot: "~/demo/worktrees" });
  const members = ["created", "navigation"].includes(phase) ? [["demo", "demo", "Leader"]]
    : [["demo", "demo", "Leader"], ["reviewer", "reviewer", "Code review"]];
  for (const [id, name, position] of members) {
    snapshot.agents.push({ id, name, canonicalWorkspace: id === "demo" ? "~/demo" : "~/reviewer" });
    snapshot.memberships.push({ teamId: "product", agentId: id, position, status: "Idle",
      ...(id !== "demo" ? { reportsToAgentId: "demo" } : {}) });
  }
  const taskPhases = ["queued", "delegated", "resumed", "delivered", "report"];
  if (taskPhases.includes(phase)) {
    const parent = { id: "parser", teamId: "product", assigneeAgentId: "demo", createdBy: "user",
      brief: "Review the Unicode parser", status: phase === "queued" ? "queued"
        : phase === "delegated" ? "blocked" : phase === "resumed" ? "running" : "done" };
    snapshot.tasks.push(parent);
    if (phase !== "queued") {
      const child = { id: "review", teamId: "product", assigneeAgentId: "reviewer", createdBy: "demo",
        brief: "Inspect Unicode handling", parentTaskId: "parser", status: phase === "delegated" ? "running" : "done" };
      snapshot.tasks.push(child);
      if (phase === "delegated") parent.blockedOn = { responder: "children", action: "Continues when its members deliver." };
      else Object.assign(child, { deliveredAt: AT, report: { outcome: "done", summary: "Unicode handling reviewed.",
        evidence: ["4 parser tests passed (simulated)."], artifacts: [] } });
      for (const [agentId, task, status] of [
        ["demo", parent, phase === "delegated" ? "Delegated" : phase === "resumed" ? "Working" : "Idle"],
        ["reviewer", child, phase === "delegated" ? "Working" : "Idle"],
      ]) {
        snapshot.memberships.find(member => member.agentId === agentId).status = status;
        snapshot.sessions.push({ id: "s-" + agentId, runtimeSessionId: "r-" + agentId,
          agentId, teamId: "product", origin: "managed", taskId: task.id, status, lastActivity: AT });
        snapshot.live ||= [];
        snapshot.live.push({ id: "r-" + agentId, title: task.brief });
      }
    }
    if (["delivered", "report"].includes(phase)) {
      parent.deliveredAt = AT;
      parent.report = { outcome: "done", summary: "Unicode review complete.",
        evidence: ["4 parser tests passed (simulated).", "Public API unchanged."], artifacts: ["unicode"] };
      snapshot.artifacts.push({ id: "unicode", taskId: "parser", name: "unicode.md" });
    }
  }
  if (phase === "direct") {
    snapshot.sessions.push({ id: "direct-demo", runtimeSessionId: "demo-direct", agentId: "demo",
      teamId: "product", origin: "direct", status: "Idle", lastActivity: AT });
    snapshot.live = [{ id: "demo-direct", title: "A direct conversation" }];
    // A direct conversation may assign a child, but has no parent task itself.
    snapshot.tasks.push({ id: "standalone-review", teamId: "product", assigneeAgentId: "reviewer",
      createdBy: "demo", brief: "Review requested from direct chat", status: "queued" });
  }
  const tasks = taskPhases.includes(phase) || phase === "direct";
  return { snapshot, now: NOW, page: { kind: "team", teamId: "product", tab: tasks ? "tasks" : "org" },
    selectedId: phase === "direct" ? "t:standalone-review" : tasks ? "t:parser" : "m:demo",
    focus: phase === "navigation" ? "sidebar" : "main", ...(phase === "report" ? { reportTaskId: "parser" } : {}),
    ...(phase === "assign" ? { dialog: { title: "Assign task", description: ["Owner: demo"],
      fields: [{ key: "brief", label: "Task and expected delivery", value: "Review the Unicode parser",
        hint: "Shift+Enter adds a line. The owner reports back with a summary and evidence." }] } } : {}) };
}
