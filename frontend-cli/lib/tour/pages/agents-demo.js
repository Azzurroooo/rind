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

// Interactive setup snapshots. Fields mirror the real actions; editors and
// choice state are reconstructed by the renderer, never by filesystem checks.
const ROLE_FIELDS = [
  { key: "position", label: "Role", optional: true,
    hint: "A short job title shown beside the name in the team tree, e.g. Reviewer or Frontend. The leader also sees it when choosing who to delegate to." },
  { key: "responsibility", label: "Responsibility", optional: true,
    hint: 'What this member is in charge of, in a sentence. It is added to the member\'s instructions on every team task, e.g. "Owns the login and payment pages and their tests."' },
];
const ADD_OPTIONS = [
  { label: "Existing folder", description: "Keep its files, skills and history" },
  { label: "New empty workspace", description: "A fresh folder for a new role" },
  { label: "New Git worktree", description: "Parallel work on its own branch" },
];

function folderForm(first = false, index = 0) {
  return { title: "Add existing folder", description: [first ? "The first member becomes the team leader." : "Reports to demo."], index,
    fields: [
      { key: "workspace", label: "Folder", kind: "path", require: "folder", value: first ? "~/demo" : "~/finance",
        hint: "Tab completes folder names; ↑↓ choose a suggestion. Files stay where they are." },
      { key: "name", label: "Name", optional: true, value: first ? "demo" : "finance",
        hint: "How the member is called in the team. Defaults to the folder name." },
      ...ROLE_FIELDS.map(field => ({ ...field, value: first ? "" : field.key === "position" ? "Finance" : "Reconcile invoices" })),
    ] };
}

function worktreeForm(index, feature = "search") {
  return { title: "New Git worktree", description: ["Reports to demo."], index,
    fields: [
      { key: "repository", label: "Repository", kind: "path", require: "git", value: "~/demo", hint: "The Git repository to branch from. Tab completes folder names." },
      { key: "branch", label: "New branch", value: "feature/" + feature, hint: "Created for this member, e.g. feature/search. Must not exist yet." },
      { key: "name", label: "Folder name", kind: "name", value: "feature-" + feature, hint: "A new folder inside the team's workspace area." },
      { key: "base", label: "Start from", value: "HEAD", hint: "Branch, tag or commit the new branch starts at. HEAD is the repository's current commit." },
      ...ROLE_FIELDS.map(field => ({ ...field, value: field.key === "position" ? feature === "search" ? "Search" : "Export" : "Implement " + feature + " and its tests" })),
    ] };
}

function addMember(scene, id, name, workspace, position) {
  scene.snapshot.agents.push({ id, name, canonicalWorkspace: workspace });
  scene.snapshot.memberships.push({ agentId: id, teamId: "product", reportsToAgentId: "demo", position, status: "Idle" });
}

export function agentsSetupScene(phase) {
  const scene = agentsScene(phase === "leader-sessions" ? "organization" : "created");
  if (["empty-navigation", "new-team"].includes(phase)) {
    scene.snapshot = emptyAgentsSnapshot();
    scene.page = { kind: "inbox" };
    scene.navId = "inbox";
    scene.selectedId = "new-team";
    scene.focus = "sidebar";
    if (phase === "new-team") scene.dialog = { title: "New team", fields: [
      { key: "name", label: "Team name", value: "product", hint: "What the team works on, e.g. Product, Research or Finance." },
    ] };
  } else if (phase.startsWith("first-member")) {
    scene.snapshot.agents = [];
    scene.snapshot.memberships = [];
    delete scene.snapshot.teams[0].leaderAgentId;
    scene.selectedId = "add-member";
    scene.dialog = phase === "first-member-menu"
      ? { kind: "choice", title: "Add member", description: ["The first member becomes the team leader."], items: ADD_OPTIONS, index: 0 }
      : folderForm(true);
  } else if (["add-menu", "worktree-menu"].includes(phase)) {
    scene.dialog = { kind: "choice", title: "Add member", description: ["Reports to demo."], items: ADD_OPTIONS,
      index: phase === "worktree-menu" ? 2 : 0 };
  } else if (phase.startsWith("specialist-")) {
    scene.dialog = folderForm(false, { "specialist-folder": 0, "specialist-role": 2, "specialist-responsibility": 3 }[phase]);
  } else if (["share-folder", "share-confirm"].includes(phase)) {
    scene.dialog = { kind: "choice", title: "Folder already belongs to a team", description: ["Used by: operations", "~/finance"],
      items: [
        { label: "Make an independent copy", description: "Recommended · separate files and history" },
        { label: "Share this folder", description: "Same files · runs wait for each other" },
        { label: "Cancel", description: "Leave both teams unchanged" },
      ], index: phase === "share-confirm" ? 1 : 0 };
  } else if (phase === "specialist") {
    addMember(scene, "finance", "finance", "~/finance", "Finance");
    scene.selectedId = "m:finance";
  } else if (phase.startsWith("worktree-")) {
    scene.dialog = worktreeForm({ "worktree-repository": 0, "worktree-branch": 1, "worktree-folder": 2, "worktree-base": 3 }[phase]);
  } else if (["search", "export-branch", "worktrees"].includes(phase)) {
    addMember(scene, "search", "feature-search", "~/demo/worktrees/feature-search", "Search");
    scene.selectedId = "m:search";
    if (phase === "export-branch") scene.dialog = worktreeForm(1, "export");
    if (phase === "worktrees") {
      addMember(scene, "export", "feature-export", "~/demo/worktrees/feature-export", "Export");
      scene.selectedId = "m:export";
    }
  } else if (phase === "leader-sessions") {
    scene.page = { kind: "member", teamId: "product", agentId: "demo" };
    scene.selectedId = "s:demo-direct";
    scene.snapshot.sessions.push({ id: "direct-demo", runtimeSessionId: "demo-direct", agentId: "demo",
      teamId: "product", origin: "direct", status: "Idle", lastActivity: AT });
    scene.snapshot.live = [{ id: "demo-direct", title: "A direct conversation" }];
  } else throw new Error("Unknown tour setup scene: " + phase);
  return scene;
}
