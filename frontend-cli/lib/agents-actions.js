import path from "node:path";
import { open } from "node:fs/promises";

// The last lines of a log, read from its end so a large log costs nothing.
async function tail(file, bytes = 16384) {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(bytes, size));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    return (size > bytes ? lines.slice(1) : lines).slice(-80);
  } catch { return ["No log yet."]; }
  finally { await handle?.close(); }
}
import { single, roleOf, STATUS_FILTERS } from "./agents-model.js";
import { createReviewActions } from "./agents-review.js";
import { groupModels } from "./model-menu-state.js";

// Multi-step management flows. Each flow only talks to the page through the
// small `ui` surface, so the key handling and the service calls stay separate.
export function createActions(ui) {
  const snap = () => ui.view.snapshot;
  const agentName = id => single(snap().agents.find(a => a.id === id)?.name) || "Member";
  // Notes and blockers may name "user" or "children" rather than an agent.
  const display = id => single(snap().agents.find(a => a.id === id)?.name) || id;
  const teamOf = id => snap().teams.find(t => t.id === id);
  const membership = (teamId, agentId) => snap().memberships.find(m => m.teamId === teamId && m.agentId === agentId);
  const review = createReviewActions(ui, { agentName, display, teamOf, assignTask, taskActions, answer });
  const { delivery } = review;

  function createTeam() {
    ui.form("New team", [{ key: "name", label: "Team name", hint: "What the team works on, e.g. Product, Research or Finance." }], async values => {
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

  // Shared by every way of adding a member, so the wording never drifts.
  const roleFields = (current = {}) => [
    { key: "position", label: "Role", optional: true, value: current.position, hint: "A short job title shown beside the name in the team tree, e.g. Reviewer or Frontend. The leader also sees it when choosing who to delegate to." },
    { key: "responsibility", label: "Responsibility", optional: true, value: current.responsibility, hint: "What this member is in charge of, in a sentence. It is added to the member's instructions on every team task, e.g. \"Owns the login and payment pages and their tests.\"" },
  ];

  function addMember(teamId, reportsToAgentId) {
    const where = placement(teamId, reportsToAgentId);
    ui.choose("Add member", [
      { label: "Existing folder", description: "Keep its files, skills and history", action: () => ui.form("Add existing folder", [
        { key: "workspace", label: "Folder", kind: "path", require: "folder", hint: "Tab completes folder names; ↑↓ choose a suggestion. Files stay where they are." },
        { key: "name", label: "Name", optional: true, derive: values => (values.workspace ? path.basename(ui.resolvePath(values.workspace)) : ""), hint: "How the member is called in the team. Defaults to the folder name." },
        ...roleFields(),
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
      { label: "Copy folder", description: "Review the files first; secrets and build output are skipped", action: () => ui.form("Copy folder", [{ key: "name", label: "New folder name", kind: "name", root: teamOf(teamId).createRoot, derive: () => path.basename(values.workspace) + "-copy" }], async ({ name }) => {
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

  // A worktree is described in the order people think about it: which
  // repository, which branch, then where it lives (derived from the branch).
  function createWorkspace(teamId, worktree, source = {}) {
    const root = teamOf(teamId)?.createRoot;
    const folder = { key: "name", label: "Folder name", kind: "name", root, hint: "A new folder inside the team's workspace area." };
    const fields = worktree ? [
      { key: "repository", label: "Repository", kind: "path", require: "git", value: source.workspace, hint: "The Git repository to branch from. Tab completes folder names." },
      { key: "branch", label: "New branch", hint: "Created for this member, e.g. feature/search. Must not exist yet." },
      { ...folder, derive: values => values.branch.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "") },
      { key: "base", label: "Start from", value: "HEAD", hint: "Branch, tag or commit the new branch starts at. HEAD is the repository's current commit." },
      ...(source.position || source.responsibility ? [] : roleFields()),
    ] : [folder, ...roleFields()];
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
        { description: ["The leader can split work across the team."], searchable: true });
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
    ui.form("Role and responsibility", roleFields(current), async values => { await ui.request("updateMember", { teamId, agentId, ...values }); ui.notify("Updated " + agentName(agentId) + ".", "success"); }, { description: [agentName(agentId)] });
  }

  // A member runs on its folder's defaults; the user and the Manager choose them.
  const MODEL_SOURCES = { folder: "chosen for this member", main_repository: "from its main repository", settings: "from settings.json" };
  async function memberModel(teamId, agentId) {
    const name = agentName(agentId);
    const [{ models }, current] = await Promise.all([ui.request("listModels"), ui.request("getMemberModel", { teamId, agentId })]);
    const { resolved, inherited, folder } = current;
    const levels = models.find(m => m.provider_id === resolved.provider && m.id === resolved.model)?.reasoning_efforts || [];
    const set = (values, text) => async () => { await ui.request("setMemberModel", { teamId, agentId, ...values }); ui.notify(name + " now uses " + text + " from its next task.", "success"); };
    const clear = part => async () => { await ui.request("clearMemberModel", { teamId, agentId, part }); ui.notify(name + " uses the default " + (part === "model" ? "model" : "effort") + " from its next task.", "success"); };
    // First, and only when the member chose its own: what clearing it falls back to.
    const fallback = (own, value, source, part) => (own ? [{ id: "default", label: "Use the default", description: value + " · " + MODEL_SOURCES[source], action: clear(part) }] : []);
    const modelItems = groupModels(models, { provider_id: resolved.provider, model_id: resolved.model }).map(entry => (entry.header
      ? { header: true, label: entry.name }
      : { id: entry.providerId + "/" + entry.modelId, label: entry.modelId, description: entry.current ? "current" : "", action: set({ provider: entry.providerId, model: entry.modelId }, entry.modelId) }));
    ui.choose("Model and effort", [
      { label: "Model", key: "m", description: resolved.provider + " / " + resolved.model + " · " + MODEL_SOURCES[resolved.model_source], action: () => ui.choose("Model · " + name, [
        ...fallback(folder.model, inherited.provider + " / " + inherited.model, inherited.model_source, "model"),
        ...modelItems,
      ], { selected: resolved.provider + "/" + resolved.model, description: ["Only connections you are logged in to are listed."], searchable: true }) },
      ...(levels.length ? [{ label: "Effort", key: "e", description: (resolved.reasoning_effort || "unset") + " · " + MODEL_SOURCES[resolved.effort_source], action: () => ui.choose("Effort · " + name, [
        ...fallback(folder.reasoning_effort, inherited.reasoning_effort || "unset", inherited.effort_source, "reasoningEffort"),
        ...levels.map(level => ({ id: level, label: level, action: set({ reasoningEffort: level }, "effort " + level) })),
      ], { selected: resolved.reasoning_effort }) }] : []),
    ], { description: [name + " · applies from its next task; running work keeps its model.", "New conversations in its folder start with it too."] });
  }

  function changeSupervisor(teamId, agentId) {
    const candidates = snap().memberships.filter(m => m.teamId === teamId && m.agentId !== agentId);
    ui.choose("Reports to", candidates.map(m => ({ id: m.agentId, label: agentName(m.agentId), description: roleOf(snap(), teamId, m.agentId),
      action: async () => { await ui.request("setSupervisor", { teamId, agentId, reportsToAgentId: m.agentId }); ui.notify(agentName(agentId) + " now reports to " + agentName(m.agentId) + ".", "success"); } })),
    { description: [agentName(agentId) + " and everyone below them move together."], selected: membership(teamId, agentId)?.reportsToAgentId, searchable: true });
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
      { label: "Open member", key: "enter", description: "Every conversation in this team", action: () => ui.openMember(teamId, agentId) },
      { label: "New conversation", key: "c", description: "Talk to this member directly", action: () => ui.startNew({ agentId, teamId }) },
      { label: "Assign task", key: "t", description: "Tracked work with a delivery report", action: () => assignTask(teamId, agentId) },
      { label: "Add member below", key: "a", description: "Add a member below " + agentName(agentId), action: () => addMember(teamId, agentId) },
      { label: "Edit role and responsibility", key: "e", action: () => editMember(teamId, agentId) },
      { label: "Model and effort", key: "m", description: "What this member runs on", action: () => memberModel(teamId, agentId) },
      ...(team?.leaderAgentId !== agentId ? [
        { label: "Change supervisor", key: "s", action: () => changeSupervisor(teamId, agentId) },
        { label: "Make team leader", key: "l", action: async () => { await ui.request("setLeader", { teamId, agentId }); ui.notify(agentName(agentId) + " now leads the team.", "success"); } },
      ] : []),
      ...(run ? [{ label: "Resolve unconfirmed run", key: "u", description: "Confirm the old process stopped", action: () => resolveRun(run) }] : []),
      { label: "Remove from team", key: "x", danger: true, description: "Folder and history are kept", action: () => ui.confirm("Remove " + agentName(agentId) + "?", ["They leave " + single(team?.name) + ". The folder, its files and history are kept. Their unfinished tasks will need attention."], "Remove member",
        async () => { await ui.request("removeMember", { teamId, agentId }); ui.notify(agentName(agentId) + " removed from the team.", "success"); }) },
    ]);
  }

  // Empty restores the first message as its title.
  function rename(row) {
    ui.form("Rename conversation", [{ key: "name", label: "Name", optional: true, hint: "Leave empty to show it by its first message again." }],
      async ({ name }) => {
        const renamed = await ui.rename(row.sessionId, name);
        ui.notify(renamed.name ? "Named " + single(renamed.name) + "." : "Shown by its first message again.", "success");
      }, { description: ["Now shown as: " + single(row.title)] });
  }
  const renameItem = row => ({ label: "Rename…", key: "r", description: "A name of your own; otherwise its first message", action: () => rename(row) });

  function sessionActions(row) {
    const task = snap().tasks.find(t => t.id === row.taskId);
    if (row.independent) {
      ui.choose(row.title, [
        { label: "Continue conversation", key: "enter", description: "Outside any team", action: () => ui.join(row) },
        { label: "New conversation in this folder", key: "c", action: () => ui.startNew(row) },
        renameItem(row),
      ], { description: [row.workspace] });
      return;
    }
    ui.choose(row.title, [
      { label: "Join conversation", key: "enter", description: row.manager ? "Continue with the Manager" : "Continue in " + agentName(row.agentId) + "'s workspace", action: () => ui.join(row) },
      ...(row.manager ? [] : [
        { label: "All conversations of " + agentName(row.agentId), action: () => ui.openMember(row.teamId, row.agentId) },
        { label: "New conversation", key: "c", action: () => ui.startNew(row) },
      ]),
      ...(task ? [{ label: "Task report", description: single(task.brief), action: () => delivery(task.id) }] : []),
      renameItem(row),
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
      { label: "Open report", key: "enter", description: "Outcome, evidence, files and history", action: () => delivery(taskId) },
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

  // Stop is destructive and separate from leaving: Cancel is the default, the
  // dialog says what keeps existing, and the button names what it does.
  // `running`: the Background page's Running now rows, jobs included.
  function stopAll(running = []) {
    const working = running.length;
    const names = running.slice(0, 5).map(row => "• " + single(row.context) + " — " + single(row.title) + (row.status === "Running job" ? " (running " + single(row.note) + ")" : ""));
    const jobs = running.filter(row => row.status === "Running job").length;
    const description = [
      ...(working ? [working + (working === 1 ? " agent is" : " agents are") + " working:", ...names, ...(working > 5 ? ["  and " + (working - 5) + " more"] : []), ""] : ["Nothing is running."]),
      "Running work is cancelled now and cannot be resumed where it stopped." + (jobs ? " Jobs they started are stopped too." : "") + " Teams, members, tasks and conversation history are kept.",
    ];
    // Every open conversation depends on these services, so stopping them
    // also leaves Rind rather than stranding windows on a stopped Runtime.
    const stop = async () => {
      const result = await ui.stopServices(true);
      ui.leave(result.working ? "Stopped " + result.working + (result.working === 1 ? " agent" : " agents") + " and the background services." : "Stopped the background services.");
    };
    ui.choose(working ? "Stop all agents?" : "Stop background services?", [
      { label: "Cancel", key: "n", description: "Keep everything running", action() {} },
      { label: (working ? "Stop all agents" : "Stop services") + " and leave Rind", key: "y", danger: true, description: "Closes every Rind window", action: stop },
    ], { description: [...description, "", "Every Rind window closes; open conversations cannot continue without these services."], danger: true });
  }

  // Services: restart management to load an update, or read the end of a log.
  async function serviceActions(row) {
    const management = row.id === "svc:management";
    // Loaded on demand: a plain chat must start even before the service is built.
    const { managementPaths } = await import("../../agent-management/dist/paths.js");
    const paths = managementPaths(ui.launch.home);
    const log = management ? path.join(paths.state, "service.log") : path.join(path.dirname(paths.root), "runtime", "runtime.log");
    ui.choose(row.title, [
      ...(management && row.stale ? [{ label: "Restart to load the update", key: "r", description: "Conversations keep running; windows reconnect by themselves",
        action: async () => { await ui.restartService(); ui.notify("Agents management restarted on the current version.", "success"); } }] : []),
      { label: "Show recent log", key: "l", description: log, action: async () => ui.showText(row.title + " log", [log, "", ...(await tail(log)) ]) },
    ], { description: [row.note] });
  }

  function chooseFilter() {
    ui.choose("Show only", STATUS_FILTERS.map(status => ({ label: status, description: status === "All" ? "Everything in this view" : undefined, action() { ui.setFilter(status); } })), { selected: ui.view.filter, searchable: true });
  }

  return { ...review, createTeam, addMember, assignTask, editMember, memberActions, sessionActions, taskActions, answer, resolveRun, chooseFilter, stopAll, serviceActions };
}
