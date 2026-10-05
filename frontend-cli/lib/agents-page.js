import path from "node:path";
import { createTui } from "./tui/tui.js";
import { parseTerminalKey } from "./terminal-key.js";
import { createLineEditor } from "./line-editor.js";
import { createChoiceMenuState } from "./choice-menu-state.js";
import { managementClient } from "./agents-client.js";
import { openAgentChat } from "./agents-commands.js";
import { emptyAgentsSnapshot, navigationRows, memberRows, renderAgents, clean } from "./agents-view.js";

export async function runAgentsPage({ launch, input = process.stdin, output = process.stdout, manageInput = true, signal, initialTeamId, openChat = openAgentChat }) {
  const tui = createTui({ input, output, manageInput });
  const view = { snapshot: emptyAgentsSnapshot(), nav: [], entries: [], navId: "new", selectedId: "add", teamId: "", focus: "nav", tab: "members", query: "", filter: "All", searching: false, searchEditor: createLineEditor(), dialog: null, detail: null, notice: "", connection: "Connecting…", busy: false };
  let client, connecting, closed = false, chatActive = false, initialized = false;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const close = () => { closed = true; if (!chatActive) finish(); };
  function redraw() { if (!closed) tui.requestRender(); }
  function project() {
    view.nav = navigationRows(view.snapshot);
    if (!view.nav.some(row => row.id === view.navId)) view.navId = "new";
    if (view.teamId && !view.snapshot.teams.some(team => team.id === view.teamId)) { view.teamId = ""; view.focus = "nav"; }
    view.entries = memberRows(view.snapshot, view.teamId, view.tab, view.query, view.filter);
    if (!view.entries.some(row => row.id === view.selectedId)) view.selectedId = view.entries[0]?.id;
    redraw();
  }
  const acceptSnapshot = snapshot => {
    if (closed) return;
    view.snapshot = snapshot;
    if (!initialized) {
      initialized = true;
      const first = snapshot.teams.find(t => t.id === initialTeamId) || snapshot.teams[0];
      if (first) { view.teamId = first.id; view.navId = first.id; }
    }
    project();
  };
  function connect() {
    if (connecting || closed) return connecting;
    connecting = (async () => {
      const replacement = await managementClient({ ...launch, onSnapshot: acceptSnapshot, onDisconnect() {
        if (closed) return;
        view.connection = "Disconnected · status unconfirmed"; redraw();
        void connect();
      } });
      if (closed) { replacement.close(); return; }
      client = replacement;
      acceptSnapshot(await client.request("subscribe", { afterSeq: view.snapshot.seq || 0 }));
      view.connection = "connected";
    })().catch(error => { view.connection = "Unavailable · R retry · Esc back"; view.notice = error.message; })
      .finally(() => { connecting = null; redraw(); });
    return connecting;
  }
  async function request(method, params) {
    if (connecting) await connecting;
    if (view.connection !== "connected") throw new Error("Management is disconnected. Press R to reconnect before making changes.");
    const result = await client.request(method, params);
    if (!closed) acceptSnapshot(await client.request("snapshot"));
    return result;
  }
  async function perform(action, dialog = view.dialog) {
    if (view.busy || closed) return;
    view.busy = true; view.notice = "";
    if (dialog) dialog.error = "";
    redraw();
    const detail = view.detail;
    try {
      await action();
      if (detail && view.detail === detail && detail.refresh) await detail.refresh();
      if (dialog && view.dialog === dialog) view.dialog = null;
    } catch (error) {
      if (dialog && view.dialog === dialog) dialog.error = error.message;
      else view.notice = error.message;
    } finally { view.busy = false; project(); }
  }
  const currentRow = () => (view.focus === "nav" ? view.nav.find(r => r.id === view.navId) : view.entries.find(r => r.id === view.selectedId));
  const team = () => view.snapshot.teams.find(t => t.id === view.teamId);
  function choose(title, items, description = [], selected = items[0]?.label) {
    view.dialog = { kind: "choice", title, items, description, selection: createChoiceMenuState(items.map(item => item.label), selected), error: "" }; redraw();
  }
  function form(title, fields, submit, description = []) {
    view.dialog = { kind: "form", title, fields: fields.map(field => ({ ...field, editor: createLineEditor(field.value || "") })), index: 0, description, submit, error: "" }; redraw();
  }
  function confirm(title, description, label, action) {
    choose(title, [{ label: "Cancel", description: "Return without changing anything", action() {} }, { label, description: "Confirm this action", action }], description);
  }
  function selectTeam(id) { view.teamId = id; view.navId = id; view.focus = "list"; view.selectedId = "add"; view.query = ""; view.searchEditor.setInput(""); view.filter = "All"; project(); }
  function createTeam() {
    form("Create team", [{ key: "name", label: "Team name", hint: "For example: Product or Finance" }], async values => {
      const created = await request("createTeam", values);
      selectTeam(created.id); view.notice = "Team created. Add its first member to choose a leader.";
    });
  }
  async function finishMember(teamId, member) {
    const agentId = member.agentId || member.id;
    if (!view.snapshot.teams.find(t => t.id === teamId)?.leaderAgentId) await request("setLeader", { teamId, agentId });
    if (view.teamId === teamId) { view.selectedId = agentId; view.tab = "members"; }
    view.notice = "Member added. Enter opens chat; Space shows actions.";
  }
  async function addExisting(teamId, values, share = false) {
    try {
      const member = await request("addMember", { teamId, ...values, share });
      await finishMember(teamId, member);
    } catch (error) {
      if (error.code !== "WORKSPACE_SHARED") throw error;
      choose("Workspace already in a team", [
        { label: "Create independent copy (recommended)", description: "Separate files and conversation", action: () => chooseCopy(teamId, values) },
        { label: "Share this workspace", description: "Same files; runs are serialized across teams", action: () => addExisting(teamId, values, true) },
        { label: "Cancel", description: "Keep the existing team unchanged", action() {} },
      ], ["Used by: " + error.details.teams.join(", "), values.workspace]);
    }
  }
  function chooseCopy(teamId, values) {
    choose("Independent workspace", [
      { label: "Git worktree", description: "A new branch in the same repository", action: () => createWorkspace(teamId, true, values) },
      { label: "Copy folder", description: "Preview included files; credentials and build folders are excluded", action() {
        form("Copy folder", [{ key: "name", label: "New folder name" }], async ({ name }) => {
          const preview = await request("previewCopy", { source: values.workspace });
          const destination = path.join(view.snapshot.teams.find(t => t.id === teamId).createRoot, name);
          choose("Review copy", [
            { label: "Copy these files", description: preview.files.length + " files · " + preview.bytes + " bytes", action: async () => finishMember(teamId, await request("copyWorkspace", { teamId, name, source: values.workspace, position: values.position, responsibility: values.responsibility, confirmation: preview.fingerprint })) },
            { label: "View file list", description: "Included files and exclusions", action() {
              const previous = view.dialog;
              view.dialog = null;
              view.detail = { lines: ["Copy to " + destination, "", "Included", ...preview.files, "", "Excluded", ...preview.excluded], offset: 0, back: () => { view.dialog = previous; } };
            } },
            { label: "Cancel", description: "Return without copying", action() {} },
          ], ["Destination: " + destination, "Excluded: " + (preview.excluded.slice(0, 4).join(", ") || "none")], "View file list");
        });
      } },
    ]);
  }
  function createWorkspace(teamId, worktree, source = {}) {
    const root = view.snapshot.teams.find(t => t.id === teamId)?.createRoot;
    const fields = [{ key: "name", label: "Folder name" }, ...(worktree ? [
      { key: "repository", label: "Repository path", value: source.workspace }, { key: "branch", label: "New branch" }, { key: "base", label: "Base reference", value: "HEAD" },
    ] : [])];
    form(worktree ? "Create worktree" : "New workspace", fields, async values => finishMember(teamId, await request(worktree ? "createWorktree" : "createWorkspace", { teamId, position: source.position, responsibility: source.responsibility, ...values })), ["Create inside: " + root]);
  }
  function addMember(teamId) {
    choose("Add member", [
      { label: "Use existing folder", description: "Keep its files, skills and working context", action: () => form("Add existing folder", [
        { key: "workspace", label: "Workspace path", hint: "Paste a folder path; files stay in place" },
        { key: "position", label: "Position", optional: true }, { key: "responsibility", label: "Responsibility", optional: true },
      ], values => addExisting(teamId, values)) },
      { label: "Create workspace", description: "An empty folder for a new role", action: () => createWorkspace(teamId, false) },
      { label: "Create Git worktree", description: "Develop a feature on its own branch", action: () => createWorkspace(teamId, true) },
    ]);
  }
  function assignTask(teamId, agentId) {
    const members = view.snapshot.memberships.filter(m => m.teamId === teamId);
    if (!agentId) {
      if (!members.length) { view.notice = "Add a member before assigning work."; return; }
      const leader = view.snapshot.teams.find(t => t.id === teamId)?.leaderAgentId;
      choose("Choose task owner", members.slice().sort((a, b) => Number(b.agentId === leader) - Number(a.agentId === leader)).map(m => ({ label: view.snapshot.agents.find(a => a.id === m.agentId).name + (m.agentId === leader ? " · Leader" : " · " + m.agentId.slice(0, 8)), description: m.responsibility || m.position || "Member", action: () => assignTask(teamId, m.agentId) })));
      return;
    }
    form("Assign task", [{ key: "brief", label: "Task and expected delivery", hint: "Shift+Enter adds a line" }], async values => {
      const task = await request("assignTask", { teamId, assigneeAgentId: agentId, ...values });
      view.tab = "tasks"; view.selectedId = task.id; view.notice = "Task queued. Track its progress here.";
    }, ["Owner: " + view.snapshot.agents.find(a => a.id === agentId)?.name]);
  }
  async function chat(manager = false, agentId) {
    const agent = view.snapshot.agents.find(a => a.id === agentId);
    if (!manager && !agent) throw new Error("Member is no longer available.");
    chatActive = true; tui.stop({ releaseInput: false });
    try { await openChat({ agent, teamId: view.teamId, manager, launch, input }); }
    finally { chatActive = false; if (closed) finish(); else { tui.start({ acquireInput: false }); tui.replayAll(); } }
  }
  async function delivery(taskId) {
    const task = await request("getTask", { taskId });
    const owner = view.snapshot.agents.find(a => a.id === task.assigneeAgentId)?.name || "Removed member";
    const responder = view.snapshot.agents.find(a => a.id === task.blockedOn?.responder)?.name || task.blockedOn?.responder;
    const artifacts = await Promise.all((task.report?.artifacts || []).map(async artifactId => { const artifact = await request("readArtifact", { artifactId }); return artifact.name + "\n" + artifact.path; }));
    const runs = view.snapshot.runs.filter(run => run.taskId === taskId);
    view.detail = { taskId, offset: 0, lines: [task.brief, "Owner: " + owner + " · " + task.status, "", ...(task.blockedOn ? ["Needs " + responder, task.blockedOn.action, ""] : []), ...(task.error ? [task.error, ""] : []), ...(task.report ? ["Outcome: " + task.report.outcome, task.report.summary, "", "Evidence", ...task.report.evidence, "", "Artifacts", ...artifacts, "", task.report.nextAction || ""] : ["No delivery report yet."]), "Notes", ...task.notes.map(note => note.createdAt + " · " + (view.snapshot.agents.find(a => a.id === note.author)?.name || note.author) + ": " + note.text), "", "Execution history", ...runs.map(run => run.startedAt + " · " + run.status + " · last observed " + run.lastObservedAt)] };
    view.detail.refresh = () => delivery(taskId);
  }
  async function briefing() {
    const result = await request("getTeam", { teamId: view.teamId });
    const titles = { needsAttention: "Needs your attention", inProgress: "In progress", waiting: "Waiting on members", delivered: "Delivered" };
    view.detail = { title: "Team briefing", offset: 0, lines: [result.team.name, "", ...Object.entries(result.briefing).flatMap(([key, items]) => [titles[key], ...(items.length ? items.flatMap(task => [task.owner + " · " + task.brief, (task.responder ? "Needs " + task.responder + ": " : "") + task.summary, ""]) : ["None", ""])])] };
    view.detail.refresh = briefing;
  }
  function taskActions(taskId) {
    const task = view.snapshot.tasks.find(t => t.id === taskId);
    if (!task) return;
    const run = view.snapshot.runs.find(r => r.taskId === taskId && ["starting", "running", "unknown"].includes(r.status));
    const answer = task.blockedOn?.responder === "user";
    choose("Task actions", [
      { label: "View delivery", description: "Summary, evidence, artifacts and notes", action: () => delivery(taskId) },
      { label: answer ? "Answer blocker" : "Add note", description: answer ? task.blockedOn.action : "Share progress with the task owner", action: () => form(answer ? "Answer and resume" : "Task note", [{ key: "text", label: answer ? "Your answer" : "Note" }], values => request("postTaskNote", { taskId, ...values, answer })) },
      ...(!run && ["queued", "blocked", "needs_attention"].includes(task.status) ? [{ label: "Start / retry task", description: "Run this task explicitly", action: () => request("startTask", { taskId }) }] : []),
      ...(task.status === "queued" ? [{ label: "Change queue priority", description: "High, normal or low; active work is not interrupted", action: () => choose("Queue priority", ["high", "normal", "low"].map(priority => ({ label: priority, description: priority === "high" ? "Run before other waiting tasks" : "Run after higher priority work", action: () => request("setTaskPriority", { taskId, priority }) })), [], task.priority || "normal") }] : []),
      ...(!run && !["done", "cancelled"].includes(task.status) ? [{ label: "Cancel task", description: "Remove this task from the queue", action: () => confirm("Cancel task?", [task.brief], "Cancel task", () => request("cancelTask", { taskId })) }] : []),
      ...(run?.status === "unknown" ? [{ label: "Resolve unknown run", description: "Confirm the old process stopped", action: () => resolveUnknown(run) }] : run ? [{ label: "Stop task", description: "Cancel its managed execution", action: () => confirm("Stop task?", [task.brief], "Stop execution", () => request("cancelRun", { runId: run.id })) }] : []),
    ]);
  }
  function resolveUnknown(run) { confirm("Release workspace?", ["Only continue after the old process has stopped. Its workspace is reserved until then."], "Process stopped · release", () => request("resolveRun", { runId: run.id, confirmStopped: true })); }
  function memberActions(agentId) {
    const teamId = view.teamId, member = view.snapshot.agents.find(a => a.id === agentId);
    const run = view.snapshot.runs.find(r => r.status === "unknown" && view.snapshot.sessions.some(s => s.id === r.sessionId && s.agentId === agentId && s.teamId === teamId));
    choose(member?.name || "Member", [
      { label: "Open chat", description: "Talk directly to this member", action: () => chat(false, agentId) },
      { label: "Assign task", description: "Track progress and delivery", action: () => assignTask(teamId, agentId) },
      { label: "Edit role and responsibility", description: "Clarify what this member owns", action() {
        const membership = view.snapshot.memberships.find(m => m.teamId === teamId && m.agentId === agentId);
        form("Member responsibility", [{ key: "position", label: "Position", optional: true, value: membership?.position }, { key: "responsibility", label: "Responsibility", optional: true, value: membership?.responsibility }], values => request("updateMember", { teamId, agentId, ...values }));
      } },
      ...(team()?.leaderAgentId !== agentId ? [{ label: "Make team leader", description: "Coordinate this team's members", action: () => request("setLeader", { teamId, agentId }) }] : []),
      ...(run ? [{ label: "Resolve unknown run", description: "Confirm the old process stopped", action: () => resolveUnknown(run) }] : []),
      { label: "Remove from team", description: "Preserve workspace and history", action: () => confirm("Remove member?", [member?.name || agentId, "The folder and history will be kept."], "Remove membership", () => request("removeMember", { teamId, agentId })) },
    ]);
  }
  function activate(actions = false) {
    const row = currentRow();
    if (!row) return;
    if (row.kind === "manager") return perform(() => chat(true));
    if (row.kind === "new") return createTeam();
    if (row.kind === "team") return selectTeam(row.id);
    if (row.kind === "summary") return perform(briefing);
    if (row.kind === "add") return view.tab === "members" ? addMember(view.teamId) : assignTask(view.teamId);
    if (row.kind === "task") return actions ? taskActions(row.id) : perform(() => delivery(row.id));
    return actions ? memberActions(row.id) : perform(() => chat(false, row.id));
  }
  function move(delta, absolute) {
    const rows = view.focus === "nav" ? view.nav : view.entries;
    const field = view.focus === "nav" ? "navId" : "selectedId";
    const index = Math.max(0, rows.findIndex(r => r.id === view[field]));
    view[field] = rows[Math.max(0, Math.min(rows.length - 1, absolute ?? index + delta))]?.id;
    if (view.focus === "nav") {
      const selected = view.nav.find(r => r.id === view.navId);
      view.teamId = selected?.kind === "team" ? selected.id : "";
      view.query = ""; view.searchEditor.setInput(""); view.filter = "All"; view.selectedId = "add";
    }
    project();
  }
  function dialogKey(key) {
    const dialog = view.dialog;
    if (key.name === "escape") { view.dialog = null; return; }
    if (dialog.kind === "choice") {
      if (key.name === "enter" || key.name === "return") { const selected = dialog.items[dialog.selection.selectedIndex()]; if (selected) void perform(selected.action, dialog); }
      else dialog.selection.handleKey(key);
      return;
    }
    if (key.name === "tab") { dialog.index = (dialog.index + (key.shift ? -1 : 1) + dialog.fields.length) % dialog.fields.length; dialog.error = ""; return; }
    const result = dialog.fields[dialog.index].editor.handleInput(key);
    if (result !== "submit") return;
    const field = dialog.fields[dialog.index];
    if (!field.optional && !field.editor.input().trim()) { dialog.error = field.label + " is required."; return; }
    if (dialog.index < dialog.fields.length - 1) { dialog.index++; dialog.error = ""; return; }
    const missing = dialog.fields.findIndex(field => !field.optional && !field.editor.input().trim());
    if (missing >= 0) { dialog.index = missing; dialog.error = dialog.fields[missing].label + " is required."; return; }
    const values = Object.fromEntries(dialog.fields.map(field => [field.key, field.editor.input().trim()]));
    void perform(() => dialog.submit(values), dialog);
  }
  function keyInput(key) {
    if (!key) return;
    if (key.ctrl && key.name === "c") { close(); return; }
    if (view.busy) { if (key.name === "escape" && !chatActive) close(); return; }
    if (view.dialog) { dialogKey(key); redraw(); return; }
    if (view.detail) {
      if (key.name === "escape" || key.name === "left") { const back = view.detail.back; view.detail = null; back?.(); }
      else if (key.text === " " && view.detail.taskId) taskActions(view.detail.taskId);
      else if (key.text?.toLowerCase() === "r" && view.detail.refresh) void perform(view.detail.refresh);
      else if (["up", "down", "pageup", "pagedown", "home"].includes(key.name)) view.detail.offset = key.name === "home" ? 0 : Math.max(0, view.detail.offset + ({ up: -1, down: 1, pageup: -8, pagedown: 8 }[key.name]));
      redraw(); return;
    }
    if (view.searching) {
      if (key.name === "escape") { view.searching = false; view.searchEditor.setInput(""); }
      else if (key.name === "enter") view.searching = false;
      else view.searchEditor.handleInput(key);
      view.query = view.searchEditor.input(); project(); return;
    }
    if (key.ctrl || key.alt || key.shift) return;
    if (key.name === "up" || key.name === "down") move(key.name === "up" ? -1 : 1);
    else if (key.name === "pageup" || key.name === "pagedown") move(key.name === "pageup" ? -5 : 5);
    else if (key.name === "home" || key.name === "end") move(0, key.name === "home" ? 0 : Infinity);
    else if (key.name === "escape" || key.name === "left") {
      if (view.focus === "list") { view.focus = "nav"; view.query = ""; view.filter = "All"; project(); }
      else close();
    } else if (key.name === "enter" || key.name === "right") activate();
    else if (key.name === "tab" && view.teamId) { view.focus = "list"; view.tab = view.tab === "members" ? "tasks" : "members"; view.selectedId = "add"; view.filter = "All"; view.query = ""; project(); }
    else if (key.text === " ") activate(true);
    else if (key.text === "/" && view.focus === "list") { view.searching = true; view.searchEditor.setInput(view.query); }
    else if (key.text?.toLowerCase() === "f" && view.focus === "list") choose("Filter " + view.tab, ["All", "Needs input", "Unconfirmed", "Working", "Waiting", "Queued", "Ready", "Done", "Inactive", "Cancelled"].map(status => ({ label: status, description: status === "All" ? "Show every item" : "Show " + status.toLowerCase(), action() { view.filter = status; view.selectedId = "add"; } })), [], view.filter);
    else if (key.text?.toLowerCase() === "n") createTeam();
    else if (key.text?.toLowerCase() === "r" && view.connection !== "connected") void connect();
    redraw();
  }
  tui.addChild({ render: width => renderAgents(view, width, tui.rows) });
  tui.onData(raw => keyInput(parseTerminalKey(raw)));
  tui.onPaste(value => {
    if (view.busy) return;
    const editor = view.dialog?.kind === "form" ? view.dialog.fields[view.dialog.index].editor : view.searching ? view.searchEditor : null;
    editor?.handleInput({ kind: "paste", text: clean(value) });
    if (view.searching) { view.query = view.searchEditor.input(); project(); } else redraw();
  });
  input.on?.("end", close); input.on?.("close", close); signal?.addEventListener("abort", close, { once: true });
  try {
    if (signal?.aborted) return;
    project(); tui.start(); void connect(); await finished;
  } finally {
    closed = true; client?.close(); tui.stop();
    input.off?.("end", close); input.off?.("close", close); signal?.removeEventListener("abort", close);
  }
}
