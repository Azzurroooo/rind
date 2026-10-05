import path from "node:path";
import { single, roleOf, STATUS_FILTERS } from "./agents-model.js";

// Multi-step management flows. Each flow only talks to the page through the
// small `ui` surface, so the key handling and the service calls stay separate.
export function createActions(ui) {
  const snap = () => ui.view.snapshot;
  const agentName = id => single(snap().agents.find(a => a.id === id)?.name) || "Member";
  // Notes and blockers may name "user" or "children" rather than an agent.
  const display = id => single(snap().agents.find(a => a.id === id)?.name) || id;
  const teamOf = id => snap().teams.find(t => t.id === id);
  const membership = (teamId, agentId) => snap().memberships.find(m => m.teamId === teamId && m.agentId === agentId);

  function createTeam() {
    ui.form("New team", [{ key: "name", label: "Team name", hint: "For example: Product, Research or Finance" }], async values => {
      const team = await ui.request("createTeam", values);
      ui.openTeam(team.id, "org");
      ui.notify("Team " + single(team.name) + " created. Add its first member; they become the leader.", "success");
      addMember(team.id);
    });
  }

  async function memberAdded(teamId, member) {
    const agentId = member.agentId || member.id;
    ui.openTeam(teamId, "org", "m:" + agentId);
    const team = teamOf(teamId);
    ui.notify(agentName(agentId) + (team?.leaderAgentId === agentId ? " is the team leader." : " added · reports to " + agentName(membership(teamId, agentId)?.reportsToAgentId || team?.leaderAgentId) + "."), "success");
  }

  function placement(teamId, reportsToAgentId) {
    const team = teamOf(teamId);
    if (!team?.leaderAgentId) return "The first member becomes the team leader.";
    return "Reports to " + agentName(reportsToAgentId || team.leaderAgentId) + ".";
  }

  function addMember(teamId, reportsToAgentId) {
    const where = placement(teamId, reportsToAgentId);
    ui.choose("Add member", [
      { label: "Existing folder", description: "Keep its files, skills and history", action: () => ui.form("Add existing folder", [
        { key: "workspace", label: "Folder path", hint: "Paste or type a path. Files stay where they are." },
        { key: "position", label: "Position", optional: true, hint: "Shown next to the name, e.g. Backend" },
        { key: "responsibility", label: "Responsibility", optional: true, hint: "What this member owns" },
      ], values => addExisting(teamId, { ...values, reportsToAgentId }), { description: [where] }) },
      { label: "New empty workspace", description: "A fresh folder for a new role", action: () => createWorkspace(teamId, false, { reportsToAgentId }) },
      { label: "New Git worktree", description: "Parallel work on its own branch", action: () => createWorkspace(teamId, true, { reportsToAgentId }) },
    ], { description: [where] });
  }

  async function addExisting(teamId, values, share = false) {
    try {
      await memberAdded(teamId, await ui.request("addMember", { teamId, ...values, share }));
    } catch (error) {
      if (error.code !== "WORKSPACE_SHARED") throw error;
      ui.choose("Folder already belongs to a team", [
        { label: "Make an independent copy", description: "Recommended · separate files and history", action: () => chooseCopy(teamId, values) },
        { label: "Share this folder", description: "Same files · runs wait for each other", action: () => addExisting(teamId, values, true) },
        { label: "Cancel", description: "Leave both teams unchanged", action() {} },
      ], { description: ["Used by: " + error.details.teams.join(", "), values.workspace] });
    }
  }

  function chooseCopy(teamId, values) {
    const extra = { position: values.position, responsibility: values.responsibility, reportsToAgentId: values.reportsToAgentId };
    ui.choose("Independent copy", [
      { label: "Git worktree", description: "A new branch of the same repository", action: () => createWorkspace(teamId, true, { ...extra, workspace: values.workspace }) },
      { label: "Copy folder", description: "Review the files first; secrets and build output are skipped", action: () => ui.form("Copy folder", [{ key: "name", label: "New folder name" }], async ({ name }) => {
        const preview = await ui.request("previewCopy", { source: values.workspace });
        const destination = path.join(teamOf(teamId).createRoot, name);
        ui.choose("Review copy", [
          { label: "Copy " + preview.files.length + " files", description: preview.bytes + " bytes", action: async () => memberAdded(teamId, await ui.request("copyWorkspace", { teamId, name, source: values.workspace, ...extra, confirmation: preview.fingerprint })) },
          { label: "View file list", description: "Included and skipped files", action() { const review = ui.view.dialog; ui.showText("Copy to " + destination, ["INCLUDED", ...preview.files, "", "SKIPPED", ...preview.excluded], { back: () => ui.reopen(review) }); } },
          { label: "Cancel", description: "Copy nothing", action() {} },
        ], { description: ["Destination: " + destination, "Skipped: " + (preview.excluded.slice(0, 4).join(", ") || "nothing")] });
      }) },
    ]);
  }

  function createWorkspace(teamId, worktree, source = {}) {
    const fields = [{ key: "name", label: "Folder name", hint: "Created inside " + teamOf(teamId)?.createRoot }, ...(worktree ? [
      { key: "repository", label: "Repository", value: source.workspace }, { key: "branch", label: "New branch" }, { key: "base", label: "Start from", value: "HEAD" },
    ] : [])];
    ui.form(worktree ? "New Git worktree" : "New workspace", fields, async values => memberAdded(teamId, await ui.request(worktree ? "createWorktree" : "createWorkspace",
      { teamId, position: source.position, responsibility: source.responsibility, reportsToAgentId: source.reportsToAgentId, ...values })), { description: [placement(teamId, source.reportsToAgentId)] });
  }

  function assignTask(teamId, agentId) {
    const members = snap().memberships.filter(m => m.teamId === teamId);
    if (!members.length) { ui.notify("Add a member before assigning work.", "error"); return; }
    if (!agentId) {
      const leader = teamOf(teamId)?.leaderAgentId;
      const ordered = [...members].sort((a, b) => Number(b.agentId === leader) - Number(a.agentId === leader));
      ui.choose("Who owns this task?", ordered.map(m => ({ label: agentName(m.agentId), description: roleOf(snap(), teamId, m.agentId) + (m.responsibility ? " · " + single(m.responsibility) : ""), action: () => assignTask(teamId, m.agentId) })),
        { description: ["The leader can split work across the team."] });
      return;
    }
    ui.form("Assign task", [{ key: "brief", label: "Task and expected delivery", hint: "Shift+Enter adds a line. The owner reports back with a summary and evidence." }], async values => {
      const task = await ui.request("assignTask", { teamId, assigneeAgentId: agentId, ...values });
      ui.openTeam(teamId, "tasks", "t:" + task.id);
      ui.notify("Task queued for " + agentName(agentId) + ".", "success");
    }, { description: ["Owner: " + agentName(agentId)] });
  }

  function editMember(teamId, agentId) {
    const current = membership(teamId, agentId);
    ui.form("Role and responsibility", [
      { key: "position", label: "Position", optional: true, value: current?.position },
      { key: "responsibility", label: "Responsibility", optional: true, value: current?.responsibility },
    ], async values => { await ui.request("updateMember", { teamId, agentId, ...values }); ui.notify("Updated " + agentName(agentId) + ".", "success"); }, { description: [agentName(agentId)] });
  }

  function changeSupervisor(teamId, agentId) {
    const candidates = snap().memberships.filter(m => m.teamId === teamId && m.agentId !== agentId);
    ui.choose("Reports to", candidates.map(m => ({ id: m.agentId, label: agentName(m.agentId), description: roleOf(snap(), teamId, m.agentId),
      action: async () => { await ui.request("setSupervisor", { teamId, agentId, reportsToAgentId: m.agentId }); ui.notify(agentName(agentId) + " now reports to " + agentName(m.agentId) + ".", "success"); } })),
    { description: [agentName(agentId) + " and everyone below them move together."], selected: membership(teamId, agentId)?.reportsToAgentId });
  }

  function unknownRun(teamId, agentId) {
    return snap().runs.find(r => r.status === "unknown" && snap().sessions.some(s => s.id === r.sessionId && s.agentId === agentId && s.teamId === teamId));
  }
  function resolveRun(run) {
    ui.confirm("Release the workspace?", ["Only continue once the previous process has stopped. Until then its workspace stays reserved."], "Process stopped · release",
      async () => { await ui.request("resolveRun", { runId: run.id, confirmStopped: true }); ui.notify("Workspace released.", "success"); });
  }

  function memberActions(teamId, agentId) {
    const team = teamOf(teamId), run = unknownRun(teamId, agentId);
    ui.choose(agentName(agentId), [
      { label: "Conversations", key: "enter", description: "Every conversation in this team", action: () => ui.openMember(teamId, agentId) },
      { label: "New conversation", key: "c", description: "Talk to this member directly", action: () => ui.chat({ agentId, teamId }) },
      { label: "Assign task", key: "t", description: "Tracked work with a delivery report", action: () => assignTask(teamId, agentId) },
      { label: "Add direct report", key: "a", description: "Add a member below " + agentName(agentId), action: () => addMember(teamId, agentId) },
      { label: "Edit role and responsibility", key: "e", action: () => editMember(teamId, agentId) },
      ...(team?.leaderAgentId !== agentId ? [
        { label: "Change supervisor", key: "s", action: () => changeSupervisor(teamId, agentId) },
        { label: "Make team leader", key: "l", action: async () => { await ui.request("setLeader", { teamId, agentId }); ui.notify(agentName(agentId) + " now leads the team.", "success"); } },
      ] : []),
      ...(run ? [{ label: "Resolve unconfirmed run", key: "u", description: "Confirm the old process stopped", action: () => resolveRun(run) }] : []),
      { label: "Remove from team", key: "x", danger: true, description: "Folder and history are kept", action: () => ui.confirm("Remove " + agentName(agentId) + "?", ["They leave " + single(team?.name) + ". The folder, its files and history are kept. Their unfinished tasks will need attention."], "Remove member",
        async () => { await ui.request("removeMember", { teamId, agentId }); ui.notify(agentName(agentId) + " removed from the team.", "success"); }) },
    ]);
  }

  function sessionActions(row) {
    const task = snap().tasks.find(t => t.id === row.taskId);
    ui.choose(row.title, [
      { label: "Join conversation", key: "enter", description: row.manager ? "Continue with the Manager" : "Continue in " + agentName(row.agentId) + "'s workspace", action: () => ui.chat({ agentId: row.agentId, teamId: row.teamId, runtimeSessionId: row.sessionId, manager: row.manager }) },
      ...(row.manager ? [] : [
        { label: "All conversations of " + agentName(row.agentId), action: () => ui.openMember(row.teamId, row.agentId) },
        { label: "New conversation", key: "c", action: () => ui.chat({ agentId: row.agentId, teamId: row.teamId }) },
      ]),
      ...(task ? [{ label: "Task delivery", description: single(task.brief), action: () => delivery(task.id) }] : []),
    ]);
  }

  function answer(taskId) {
    const task = snap().tasks.find(t => t.id === taskId);
    const blocked = task?.blockedOn?.responder === "user";
    ui.form(blocked ? "Answer and resume" : "Task note", [{ key: "text", label: blocked ? "Your answer" : "Note", hint: blocked ? "The owner resumes with your answer." : "Shared with the task owner." }],
      async values => { await ui.request("postTaskNote", { taskId, ...values, answer: blocked }); ui.notify(blocked ? "Answer sent. The task resumes." : "Note added.", "success"); },
      { description: blocked ? [task.blockedOn.action] : [single(task?.brief)] });
  }

  function taskActions(taskId) {
    const task = snap().tasks.find(t => t.id === taskId);
    if (!task) return;
    const run = snap().runs.find(r => r.taskId === taskId && ["starting", "running", "unknown"].includes(r.status));
    ui.choose("Task", [
      { label: "Delivery", key: "enter", description: "Summary, evidence, artifacts and notes", action: () => delivery(taskId) },
      { label: task.blockedOn?.responder === "user" ? "Answer blocker" : "Add note", key: "n", description: task.blockedOn?.responder === "user" ? single(task.blockedOn.action) : "Share context with the owner", action: () => answer(taskId) },
      ...(!run && ["queued", "blocked", "needs_attention"].includes(task.status) ? [{ label: task.status === "queued" ? "Start now" : "Retry", key: "s", action: async () => { await ui.request("startTask", { taskId }); ui.notify("Task started.", "success"); } }] : []),
      ...(task.status === "queued" ? [{ label: "Queue priority", key: "p", description: "Currently " + (task.priority || "normal"), action: () => ui.choose("Queue priority", ["high", "normal", "low"].map(priority => ({ label: priority[0].toUpperCase() + priority.slice(1),
        description: priority === "high" ? "Runs before other waiting tasks" : priority === "low" ? "Runs after other waiting tasks" : "Default order", action: async () => { await ui.request("setTaskPriority", { taskId, priority }); ui.notify("Priority set to " + priority + ".", "success"); } })),
        { description: ["Running work is never interrupted."], selected: (task.priority || "normal").replace(/^./, c => c.toUpperCase()) }) }] : []),
      ...(run?.status === "unknown" ? [{ label: "Resolve unconfirmed run", key: "u", action: () => resolveRun(run) }]
        : run ? [{ label: "Stop", key: "x", danger: true, action: () => ui.confirm("Stop this task?", [single(task.brief)], "Stop execution", async () => { await ui.request("cancelRun", { runId: run.id }); ui.notify("Stopping the task.", "success"); }) }] : []),
      ...(!run && !["done", "cancelled"].includes(task.status) ? [{ label: "Cancel task", key: "x", danger: true, action: () => ui.confirm("Cancel this task?", [single(task.brief)], "Cancel task", async () => { await ui.request("cancelTask", { taskId }); ui.notify("Task cancelled.", "success"); }) }] : []),
    ], { description: [single(task.brief)] });
  }

  async function delivery(taskId) {
    const task = await ui.request("getTask", { taskId });
    const artifacts = await Promise.all((task.report?.artifacts || []).map(async artifactId => { const artifact = await ui.request("readArtifact", { artifactId }); return "  " + artifact.name + "  " + artifact.path; }));
    const runs = snap().runs.filter(run => run.taskId === taskId);
    const section = (title, lines) => lines.length ? ["", title.toUpperCase(), ...lines] : [];
    ui.showText(single(task.brief), [
      "Owner " + agentName(task.assigneeAgentId) + " · " + task.status + (task.priority ? " · " + task.priority + " priority" : ""),
      ...section("Needs " + display(task.blockedOn?.responder), task.blockedOn ? [task.blockedOn.action] : []),
      ...section("Problem", task.error ? [task.error] : []),
      ...(task.report ? [...section("Delivery · " + task.report.outcome, [task.report.summary]), ...section("Evidence", task.report.evidence.map(item => "  • " + item)), ...section("Artifacts", artifacts),
        ...section("Next", task.report.nextAction ? [task.report.nextAction] : [])] : section("Delivery", ["No report yet."])),
      ...section("Notes", task.notes.map(note => note.createdAt.slice(0, 16).replace("T", " ") + "  " + display(note.author) + ": " + note.text)),
      ...section("Runs", runs.map(run => run.startedAt.slice(0, 16).replace("T", " ") + "  " + run.status)),
    ], { taskId, refresh: () => delivery(taskId) });
  }

  function chooseFilter() {
    ui.choose("Show only", STATUS_FILTERS.map(status => ({ label: status, description: status === "All" ? "Everything in this view" : undefined, action() { ui.setFilter(status); } })), { selected: ui.view.filter });
  }

  return { createTeam, addMember, assignTask, editMember, memberActions, sessionActions, taskActions, answer, delivery, resolveRun, chooseFilter };
}
