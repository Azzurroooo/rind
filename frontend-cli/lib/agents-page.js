import { realpath } from "node:fs/promises";
import { createTui } from "./tui/tui.js";
import { parseTerminalKey } from "./terminal-key.js";
import { createLineEditor } from "./line-editor.js";
import { createForm } from "./agents-form.js";
import { resolveInputPath } from "./path-input.js";
import { managementClient } from "./agents-client.js";
import { openAgentChat, managerWorkspace, followConversation } from "./agents-commands.js";
import { createLeaveLatch, LEAVE_HINT } from "./interrupt-state.js";
import { actionFor } from "./agents-keys.js";
import { emptyAgentsSnapshot, withoutDrafts, clean, sidebarRows, inboxRows, organizationRows, taskRows, memberSessionRows, managerRows, teamSessions, independentSessions, independentRows, folderRows, backgroundRows, archiveRows, workspaceKey, selectable } from "./agents-model.js";
import { renderAgents } from "./agents-view.js";
import { createActions } from "./agents-actions.js";

const CREATE_KINDS = new Set(["add-member", "assign", "new-session", "new-team"]);
const NOTICE_MS = 6000, CLOCK_MS = 30000, TYPE_AHEAD = 16;
// Unregistered folders cannot push updates, so their saved activity is polled.
const INDEPENDENT_REFRESH_MS = 30000;
// A list that failed to load is tried again after this pause.
const RETRY_MS = 10000;

// Resolves to { leave: true } when the user chose to leave Rind from here,
// so the window that opened the page closes as well.
// currentSessionId: the conversation of the window that opened this page; it
// stays listed even while it is still an empty draft.
export async function runAgentsPage({ launch, input = process.stdin, output = process.stdout, manageInput = true, signal, initialTeamId, openChat = openAgentChat, standalone = false, currentSessionId = "" }) {
  const tui = createTui({ input, output, manageInput, alternateScreen: true });
  const view = {
    snapshot: emptyAgentsSnapshot(), connection: "connecting…", busy: false, busyLabel: "", notice: null, help: false,
    sidebar: [], navId: "inbox", focus: "sidebar", member: null, folder: null, page: { kind: "inbox" }, pageKey: "inbox", entries: [], selectedId: "",
    selections: {}, scroll: {}, tabs: {}, collapsed: {}, history: {}, managerHistory: null, independent: null, managerPath: "", service: null, stopped: false,
    query: "", filter: "All", searching: false, searchEditor: createLineEditor(), dialog: null, detail: null, standalone, leaveArmed: false,
  };
  let client, connecting, closed = false, chatActive = false, initialized = false, noticeTimer, spinner, previousKey = "";
  // Keys typed while an action is saving are replayed afterwards instead of being lost.
  const typeAhead = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  let leaving = false;
  const close = () => { closed = true; if (!chatActive) finish(); };
  let leaveNotice = "";
  // notice: what to print once the windows have closed (e.g. after a stop).
  const leave = notice => { leaving = true; if (notice) { leaveNotice = notice; view.snapshot = { ...view.snapshot, runs: [] }; } close(); };
  const leaveLatch = createLeaveLatch({ onChange: () => {
    view.leaveArmed = leaveLatch.armed;
    if (!leaveLatch.armed && view.notice?.text === LEAVE_HINT) view.notice = null;
    redraw();
  } });
  // Nothing may paint while a conversation owns the terminal.
  const redraw = () => { if (!closed && !chatActive) tui.requestRender(); };
  const clock = setInterval(() => project(), CLOCK_MS);
  // project() also re-polls the Independent page once its data is stale.
  clock.unref?.();

  function derivePage() {
    const nav = view.sidebar.find(row => row.id === view.navId);
    if (nav?.kind === "team") {
      if (view.member?.teamId === nav.teamId) return { kind: "member", teamId: nav.teamId, agentId: view.member.agentId };
      return { kind: "team", teamId: nav.teamId, tab: view.tabs[nav.teamId] || "org" };
    }
    if (nav?.kind === "independent" && view.folder) return { kind: "folder", workspace: view.folder };
    return { kind: nav?.kind || "inbox" };
  }
  const independentGroups = () => independentSessions(view.snapshot, view.independent?.workspaces, view.managerPath);
  function entriesFor(page) {
    const options = { query: view.query, filter: view.filter };
    if (page.kind === "inbox") return inboxRows(view.snapshot);
    if (page.kind === "manager") return managerRows(view.managerHistory?.entries, { ...options, live: view.snapshot.live || [] });
    if (page.kind === "folder") return folderRows(independentGroups().find(group => workspaceKey(group.workspace) === workspaceKey(page.workspace)), options);
    if (page.kind === "background") return backgroundRows(view.snapshot, view.service);
    if (page.kind === "archive") return archiveRows(view.archive, options);
    if (page.kind === "independent") return independentRows(independentGroups(), { ...options, collapsed: view.collapsed.independent || new Set() });
    if (page.kind === "new-team") return [{ id: "new-team", kind: "new-team", title: "Name your new team" }];
    const sessions = teamSessions(view.snapshot, page.teamId, view.history[page.teamId]?.entries);
    if (page.kind === "member") return memberSessionRows(sessions, page.agentId, options);
    if (page.tab === "tasks") return taskRows(view.snapshot, page.teamId, options);
    const first = !view.snapshot.memberships.some(m => m.teamId === page.teamId);
    const tree = organizationRows(view.snapshot, page.teamId, sessions, { ...options, collapsed: view.collapsed[page.teamId] || new Set() });
    return [{ id: "add-member", kind: "add-member", title: first ? "Add the first member" : "Add member", teamId: page.teamId, firstMember: first }, ...tree];
  }
  function project() {
    if (closed || chatActive) return;
    view.sidebar = sidebarRows(view.snapshot);
    if (!view.sidebar.some(row => row.id === view.navId)) { view.navId = "inbox"; view.member = null; view.focus = "sidebar"; }
    if (view.member && !view.snapshot.memberships.some(m => m.teamId === view.member.teamId && m.agentId === view.member.agentId)) view.member = null;
    view.page = derivePage();
    view.pageKey = [view.page.kind, view.page.teamId, view.page.tab || view.page.agentId || view.page.workspace].filter(Boolean).join(":");
    const previous = view.pageKey === previousKey ? view.entries : [];
    previousKey = view.pageKey;
    view.entries = entriesFor(view.page);
    // The selection never moves by itself while its row exists, so Enter acts on
    // the highlighted row even as live rows arrive and re-sort around it.
    const remembered = view.selections[view.pageKey];
    if (!view.entries.some(row => row.id === remembered && selectable(row))) view.selections[view.pageKey] = fallbackSelection(previous, remembered);
    view.selectedId = view.selections[view.pageKey];
    ensureHistory();
    redraw();
  }

  // When the selected row disappears (sorted into "+N more", filtered out or
  // removed), stay near it instead of jumping to the top of the list.
  function firstItem() {
    const items = view.entries.filter(selectable);
    return (items.find(row => !CREATE_KINDS.has(row.kind)) || items[0])?.id;
  }
  function pick(key, id) { view.selections[key] = id; }
  function fallbackSelection(previous, id) {
    const items = view.entries.filter(selectable);
    const old = previous.find(row => row.id === id);
    const near = old?.agentId && (items.find(row => row.id === "more:" + old.agentId) || items.find(row => row.id === "m:" + old.agentId));
    if (near) return near.id;
    const index = previous.indexOf(old);
    if (index >= 0 && items.length) {
      const after = view.entries.slice(index).find(selectable) || items.at(-1);
      return after.id;
    }
    return firstItem();
  }

  function ensureHistory() {
    const teamId = view.page.teamId;
    if (teamId && view.connection === "connected") {
      const key = view.snapshot.sessions.filter(s => s.teamId === teamId && s.runtimeSessionId).map(s => s.runtimeSessionId).sort().join(",");
      const current = view.history[teamId];
      if (!current || (current.key !== key && !current.loading)) void loadHistory(teamId, key);
    }
    if (view.page.kind === "manager" && view.connection === "connected" && !view.managerHistory) void loadManagerHistory();
    // Deleted teams change rarely; the list is read again only when one is added.
    const archiveKey = (view.snapshot.archivedTeams || []).map(team => team.id + "@" + team.archivedAt).join(",");
    if (view.page.kind === "archive" && view.connection === "connected" && !view.archiveLoading && view.archive?.key !== archiveKey && Date.now() - (view.archive?.failedAt || 0) > RETRY_MS) void loadArchive(archiveKey);
    if (view.page.kind === "background" && view.connection === "connected" && !view.serviceLoading && Date.now() - (view.serviceAt || 0) > 5000) void loadService();
    if (["independent", "folder"].includes(view.page.kind) && view.connection === "connected" && !view.independent?.loading && Date.now() - (view.independent?.at || 0) > INDEPENDENT_REFRESH_MS) void loadIndependent();
  }
  async function loadArchive(key) {
    view.archiveLoading = true;
    try { view.archive = { key, teams: (await client.request("listArchive")).teams }; }
    // A failed load keeps no key, so it is tried again after a pause, or at once with r.
    catch (error) { view.archive = { key: null, failedAt: Date.now(), teams: view.archive?.teams || [] }; notify("Could not load the archive: " + error.message, "error"); }
    view.archiveLoading = false;
    project();
  }
  async function loadService() {
    view.serviceLoading = true;
    try { view.service = { ...(await client.request("serviceInfo")), stale: view.service?.stale }; } catch {}
    view.serviceLoading = false; view.serviceAt = Date.now();
    project();
  }
  async function loadIndependent() {
    view.independent = { ...view.independent, loading: true };
    try { view.independent = { workspaces: (await client.request("listSessions", { independent: true })).workspaces, at: Date.now() }; }
    catch (error) { view.independent = { workspaces: view.independent?.workspaces || [], at: Date.now() }; notify("Could not load independent conversations: " + error.message, "error"); }
    project();
  }
  async function loadHistory(teamId, key = view.history[teamId]?.key) {
    view.history[teamId] = { ...view.history[teamId], key, loading: true };
    try { view.history[teamId] = { key, entries: (await client.request("listSessions", { teamId })).sessions }; }
    catch (error) { view.history[teamId] = { key, entries: view.history[teamId]?.entries || [] }; notify("Could not load conversations: " + error.message, "error"); }
    project();
  }
  async function loadManagerHistory() {
    view.managerHistory = { entries: view.managerHistory?.entries || [] };
    try { view.managerHistory = { entries: (await client.request("listSessions", { manager: true })).sessions }; }
    catch (error) { notify("Could not load Manager conversations: " + error.message, "error"); }
    project();
  }

  const acceptSnapshot = snapshot => {
    if (closed) return;
    view.snapshot = withoutDrafts(snapshot, currentSessionId);
    if (!initialized) {
      initialized = true;
      if (snapshot.teams.some(t => t.id === initialTeamId)) { view.navId = initialTeamId; view.focus = "main"; }
    }
    project();
  };
  // Opening the page or pressing r may start the service; a lost connection
  // only reattaches, so a page never restarts services someone else stopped.
  function connect({ start = true } = {}) {
    if (connecting || closed) return connecting;
    connecting = (async () => {
      const options = { ...launch, onSnapshot: acceptSnapshot, onDisconnect() {
        if (closed) return;
        // After an explicit stop the services stay down until the user asks again.
        if (view.stopped) { view.connection = "stopped · r starts again"; view.service = null; redraw(); return; }
        view.connection = "reconnecting · status unconfirmed"; redraw();
        void connect({ start: false });
      } };
      let replacement;
      for (let attempt = 0; !replacement; attempt++) {
        try { replacement = await managementClient({ ...options, start }); }
        catch (error) { if (start || attempt >= 20 || closed) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (closed) { replacement.close(); return; }
      client = replacement;
      view.connection = "connected"; view.stopped = false;
      view.service = replacement.service ? { ...replacement.service, stale: replacement.stale } : null;
      if (replacement.stale) notify("A newer Rind is installed. Background services keep the old version until their agents finish.", "info");
      view.history = {}; view.managerHistory = null; view.independent = null;
      acceptSnapshot(await client.request("subscribe", { afterSeq: view.snapshot.seq || 0 }));
    })().catch(error => { view.connection = start ? "offline · r retries" : "stopped · r starts again"; if (start) notify(error.message, "error"); })
      .finally(() => { connecting = null; redraw(); });
    return connecting;
  }
  async function request(method, params) {
    if (connecting) await connecting;
    if (view.connection !== "connected") throw new Error("Agents management is offline. Press r to reconnect, then try again.");
    const result = await client.request(method, params);
    if (!closed) acceptSnapshot(await client.request("snapshot"));
    return result;
  }

  function notify(text, tone = "info") {
    clearTimeout(noticeTimer);
    view.notice = { text, tone };
    noticeTimer = setTimeout(() => { view.notice = null; redraw(); }, NOTICE_MS);
    noticeTimer.unref?.();
    redraw();
  }
  async function perform(action, dialog = view.dialog, label = "Working…") {
    if (view.busy || closed) return;
    view.busy = true; view.busyLabel = label;
    if (dialog) dialog.error = "";
    spinner = setInterval(redraw, 100);
    redraw();
    const detail = view.detail;
    try {
      await action();
      const followUp = view.dialog && view.dialog !== dialog;
      if (detail && view.detail === detail && detail.refresh && !followUp) await detail.refresh();
      if (dialog && view.dialog === dialog) view.dialog = null;
    } catch (error) {
      if (dialog && view.dialog === dialog) dialog.error = error.message;
      else notify(error.message, "error");
    } finally {
      clearInterval(spinner); view.busy = false; project();
      // Keys typed for the old screen must never confirm a dialog the action just opened.
      const queued = typeAhead.splice(0);
      if (!view.dialog) for (const key of queued) keyInput(key);
    }
  }

  function choose(title, items, { description = [], selected, danger = false } = {}) {
    const index = Math.max(0, items.findIndex(item => (item.id ?? item.label) === selected));
    view.dialog = { kind: "choice", title, items, description, index, danger, error: "" }; redraw();
  }
  function form(title, fields, submit, { description = [], danger = false } = {}) {
    view.dialog = createForm({ title, fields, submit, description, danger, onChange: redraw }); redraw();
  }
  function confirm(title, description, label, action) {
    choose(title, [{ label: "Cancel", key: "n", description: "Change nothing", action() {} }, { label, key: "y", danger: true, action }], { description, danger: true });
  }
  function showText(title, lines, { refresh, back } = {}) {
    view.dialog = null;
    view.detail = { title, lines, offset: view.detail?.title === title ? view.detail.offset : 0, refresh, back };
  }
  // A report declares its own keys; the footer is built from the same list.
  function showReport(title, { render, actions, refresh, back }) {
    const same = view.detail?.title === title;
    view.dialog = null;
    view.detail = { title, render, actions, refresh, back, offset: same ? view.detail.offset : 0, expanded: same && view.detail.expanded,
      hints: [...actions.map(action => ({ key: action.key, label: action.label })), { key: actions.some(action => action.key === "space") ? "↑↓" : "↑↓ space", label: "scroll" }, { key: "esc", label: "back" }] };
  }
  function reopen(dialog) { view.dialog = dialog; }
  function resetSearch() { view.query = ""; view.filter = "All"; view.searching = false; view.searchEditor.setInput(""); }
  function openTeam(teamId, tab = view.tabs[teamId] || "org", selectId) {
    view.navId = teamId; view.member = null; view.tabs[teamId] = tab; view.focus = "main"; view.detail = null; resetSearch();
    if (selectId) pick(["team", teamId, tab].join(":"), selectId);
    project();
  }
  function openFolder(workspace) {
    view.navId = "independent"; view.folder = workspace; view.focus = "main"; view.detail = null; resetSearch(); project();
  }
  function openMember(teamId, agentId) {
    view.navId = teamId; view.member = { teamId, agentId }; view.focus = "main"; view.detail = null; resetSearch(); project();
  }
  function setFilter(status) { view.filter = status; project(); }

  async function chat({ agentId, teamId, runtimeSessionId, manager = false, workspace }) {
    // Independent folders need not be registered; they open as a plain conversation there.
    const agent = view.snapshot.agents.find(a => a.id === agentId) || (workspace ? { canonicalWorkspace: workspace } : undefined);
    if (agent && !manager) {
      const workspace = await realpath(managerWorkspace(launch));
      manager = agent.canonicalWorkspace === (process.platform === "win32" ? workspace.toLowerCase() : workspace);
    }
    if (!manager && !agent) throw new Error("This member is no longer available.");
    // Keys pressed before the conversation opened were meant for this page
    // (a second Enter would reopen it); keys after it returns still count.
    typeAhead.length = 0;
    chatActive = true; tui.stop({ releaseInput: false });
    try {
      // Moving between conversations replaces the window; it never nests.
      const next = await followConversation({ agent, teamId: manager ? undefined : teamId, runtimeSessionId, manager }, { launch, input, open: openChat });
      if (next.action === "leave") leave();
    } finally {
      chatActive = false;
      if (closed) finish();
      else {
        tui.start({ acquireInput: false });
        // A finished conversation may have created history that the lists should show.
        if (manager) view.managerHistory = null; else if (teamId) delete view.history[teamId]; else view.independent = null;
        project();
      }
    }
  }

  // Stopping drops this connection on purpose; it is not a lost connection.
  async function stopServices(stopAgents) {
    view.stopped = true;
    try { return await client.request("serviceShutdown", { stopAgents }); }
    catch (error) { view.stopped = false; throw error; }
  }
  // Replace only the management service so it loads an update; conversations keep running.
  async function restartService() {
    view.stopped = true;
    try { await client.request("serviceShutdown", { restart: true }); }
    catch (error) { view.stopped = false; throw error; }
    for (let attempt = 0; attempt < 40 && client && !closed; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (view.connection !== "connected") break;
    }
    view.stopped = false;
    await connect();
    // connect() reports its own failures; only a live connection means it worked.
    if (view.connection !== "connected") throw new Error("Agents management did not come back. Press r to retry.");
  }
  // The one way every page opens a conversation: by its session (none for a new
  // one) and where it lives: a team member, a plain folder, or the Manager.
  // Menu actions already run inside perform(); nesting would be refused as busy.
  const open = options => (view.busy ? chat(options) : perform(() => chat(options), null, "Opening conversation…"));
  const where = row => ({ agentId: row.agentId, teamId: row.teamId, workspace: row.workspace, manager: row.manager });
  const ui = { view, request, choose, form, showReport, run: (action, label) => perform(action, null, label), restartService, launch, resolvePath: value => resolveInputPath(value), stopServices, leave, confirm, notify, showText, reopen, openTeam, openMember, setFilter,
    join: row => open({ ...where(row), runtimeSessionId: row.sessionId }), startNew: target => open(where(target)) };
  const actions = createActions(ui);
  const currentRow = () => (view.focus === "sidebar" ? view.sidebar.find(r => r.id === view.navId) : view.entries.find(r => r.id === view.selectedId));

  function activate(row = currentRow()) {
    if (!row) return;
    if (view.focus === "sidebar") {
      if (row.kind === "new-team") return actions.createTeam();
      view.focus = "main"; return project();
    }
    switch (row.kind) {
      case "member": return openMember(row.teamId, row.agentId);
      case "more": return row.workspace ? openFolder(row.workspace) : openMember(row.teamId, row.agentId);
      case "workspace": return openFolder(row.workspace);
      case "session": return ui.join(row);
      case "new-session": return ui.startNew({ ...row, teamId: row.teamId || view.page.teamId });
      case "add-member": return actions.addMember(row.teamId);
      case "assign": return actions.assignTask(row.teamId);
      case "task": return view.page.kind === "inbox" && row.answer ? actions.answer(row.taskId) : perform(() => actions.delivery(row.taskId), null, "Loading report…");
      case "approval": return actions.approval(row.approvalId);
      case "run": { const run = view.snapshot.runs.find(r => r.id === row.runId); return run && actions.resolveRun(run); }
      case "live": return row.taskId ? perform(() => actions.delivery(row.taskId), null, "Loading report…") : row.sessionId ? ui.join(row) : undefined;
      case "stop-all": return actions.stopAll(row.working);
      case "service": return perform(() => actions.serviceActions(row), null, "Loading…");
      case "team": return openTeam(row.teamId);
      case "new-team": return actions.createTeam();
      default: return undefined;
    }
  }
  function rowActions(row = currentRow()) {
    if (row?.kind === "team") actions.teamActions(row.teamId);
    else if (row?.kind === "member") actions.memberActions(row.teamId, row.agentId);
    else if (row?.kind === "session") actions.sessionActions(row);
    else if (row?.kind === "task") actions.taskActions(row.taskId);
    else if (row?.kind === "service") activate(row);
  }
  // The member a contextual shortcut (c, t, a, e) applies to.
  function contextMember(row = currentRow()) {
    if (view.focus !== "main" || !view.page.teamId) return null;
    const agentId = view.page.kind === "member" ? view.page.agentId : row?.agentId;
    return agentId ? { teamId: view.page.teamId, agentId } : null;
  }

  function move(delta, absolute) {
    const rows = view.focus === "sidebar" ? view.sidebar : view.entries;
    const items = rows.filter(selectable);
    if (!items.length) return;
    const current = Math.max(0, items.findIndex(r => r.id === (view.focus === "sidebar" ? view.navId : view.selectedId)));
    const next = items[Math.max(0, Math.min(items.length - 1, absolute ?? current + delta))].id;
    if (view.focus === "sidebar") {
      if (next !== view.navId) { view.navId = next; view.member = null; view.folder = null; resetSearch(); }
    } else pick(view.pageKey, next);
    project();
  }
  function back() {
    if (view.focus === "main" && (view.query || view.filter !== "All")) { resetSearch(); project(); return; }
    if (view.page.kind === "folder") {
      const { workspace } = view.page;
      view.folder = null; pick("independent", "w:" + workspace); resetSearch(); project(); return;
    }
    if (view.page.kind === "member") {
      const { teamId, agentId } = view.page;
      view.member = null; pick(["team", teamId, view.tabs[teamId] || "org"].join(":"), "m:" + agentId); resetSearch(); project(); return;
    }
    if (view.focus === "main") { view.focus = "sidebar"; resetSearch(); project(); return; }
    close();
  }
  // Conversation rows belong to the member row above them.
  const ownerRow = row => {
    if (["session", "more"].includes(row?.kind) && view.page.kind === "independent") return view.entries.find(r => r.id === "w:" + row.workspace);
    return ["session", "more"].includes(row?.kind) && view.page.kind === "team" ? view.entries.find(r => r.id === "m:" + row.agentId) : undefined;
  };
  const selectRow = id => { pick(view.pageKey, id); project(); };
  // Left always climbs: conversation -> its member -> sidebar. It never folds,
  // so leaving a deep tree takes at most two presses.
  function left() {
    const owner = ownerRow(currentRow());
    if (view.focus === "main" && owner) selectRow(owner.id);
    else back();
  }
  function right() {
    const row = currentRow();
    if (view.focus === "sidebar") return activate();
    if (row?.kind === "member" && row.expanded === false) return setFolded([row.agentId], false);
    if (["member", "more", "team"].includes(row?.kind)) return activate();
    return undefined;
  }
  function setFolded(agentIds, folded) {
    const collapsed = view.collapsed[view.page.teamId] ||= new Set();
    for (const id of agentIds) if (folded) collapsed.add(id); else collapsed.delete(id);
    project();
  }
  // Independent folders fold like team branches; their key is the folder.
  function toggleFolders(all) {
    const collapsed = view.collapsed.independent ||= new Set();
    const folders = view.entries.filter(r => r.kind === "workspace");
    if (all) {
      const anyOpen = folders.some(r => r.expanded);
      for (const r of folders) if (anyOpen) collapsed.add(r.workspace); else collapsed.delete(r.workspace);
    } else {
      const row = ownerRow(currentRow()) || currentRow();
      if (row?.kind !== "workspace") return;
      pick(view.pageKey, row.id);
      if (row.expanded) collapsed.add(row.workspace); else collapsed.delete(row.workspace);
    }
    project();
  }
  // [ and ] jump between folders (or top-level members) instead of row by row.
  // A group starts at a folder, a top-level member, or the first row after a section header.
  function jumpGroup(step) {
    const starts = view.entries.map((row, i) => {
      if (row.kind === "workspace" || (row.kind === "member" && row.depth === 0)) return i;
      if (row.kind !== "section") return -1;
      const next = view.entries.findIndex((other, j) => j > i && selectable(other));
      return next > i && !view.entries.slice(i + 1, next).some(other => other.kind === "section") ? next : -1;
    }).filter(i => i >= 0);
    const index = view.entries.indexOf(currentRow());
    const target = step > 0 ? starts.find(i => i > index) : starts.filter(i => i < index).at(-1);
    if (target !== undefined) { pick(view.pageKey, view.entries[target].id); project(); }
  }
  function toggleFold(all) {
    if (view.page.kind === "independent" && view.focus === "main") return toggleFolders(all);
    if (view.page.kind !== "team" || view.page.tab !== "org" || view.focus !== "main") return;
    if (view.query || view.filter !== "All") { notify("Clear the search to fold branches.", "info"); return; }
    const foldable = view.entries.filter(r => r.kind === "member" && r.expandable);
    if (all) {
      const anyOpen = foldable.some(r => r.expanded);
      // Collapsing everything keeps the roots visible so their branches stay reachable.
      setFolded(anyOpen ? foldable.filter(r => r.depth === 0 || r.expanded).map(r => r.agentId) : [...(view.collapsed[view.page.teamId] || [])], anyOpen);
      return;
    }
    const row = ownerRow(currentRow()) || currentRow();
    if (row?.kind !== "member" || !row.expandable) return;
    pick(view.pageKey, row.id);
    setFolded([row.agentId], row.expanded);
  }
  function switchTab(tab) {
    if (view.page.kind !== "team") return;
    view.tabs[view.page.teamId] = tab ?? (view.page.tab === "org" ? "tasks" : "org");
    view.focus = "main"; resetSearch(); project();
  }

  function dialogKey(key) {
    const dialog = view.dialog;
    if (dialog.kind === "form") { if (!dialog.handleKey(key, perform)) view.dialog = null; return; }
    if (key.name === "escape") { view.dialog = null; return; }
    if (dialog.kind === "choice") {
      const pick = index => { const item = dialog.items[index]; if (item) { dialog.index = index; void perform(item.action, dialog); } };
      if (key.name === "enter" || key.name === "return") pick(dialog.index);
      else if (key.name === "up" || key.text === "k") dialog.index = (dialog.index - 1 + dialog.items.length) % dialog.items.length;
      else if (key.name === "down" || key.text === "j") dialog.index = (dialog.index + 1) % dialog.items.length;
      else if (key.name === "home") dialog.index = 0;
      else if (key.name === "end") dialog.index = dialog.items.length - 1;
      else if (/^[1-9]$/.test(key.text || "")) pick(Number(key.text) - 1);
      else if (key.text) { const index = dialog.items.findIndex(item => item.key === key.text.toLowerCase()); if (index >= 0) pick(index); }
    }
  }
  function detailKey(key) {
    const detail = view.detail;
    const page = Math.max(1, (view.layout?.bodyHeight || 10) - 3);
    const action = detail.actions?.find(item => item.key === "space" ? key.text === " " : item.key === key.text);
    if (key.name === "escape" || key.name === "left" || key.text === "h") { view.detail = null; detail.back?.(); }
    else if (action) action.run(detail);
    else if (key.text === "r" && detail.refresh) void perform(detail.refresh, null, "Refreshing…");
    else if (key.name === "up" || key.text === "k") detail.offset = Math.max(0, detail.offset - 1);
    else if (key.name === "down" || key.text === "j") detail.offset += 1;
    else if (key.name === "pageup" || (key.ctrl && key.name === "u")) detail.offset = Math.max(0, detail.offset - page);
    else if (key.name === "pagedown" || key.text === " " || (key.ctrl && key.name === "d")) detail.offset += page;
    else if (key.name === "home" || key.text === "g") detail.offset = 0;
    else if (key.name === "end" || key.text === "G") detail.offset = Infinity;
  }
  function searchKey(key) {
    if (key.name === "escape") { view.searching = false; view.searchEditor.setInput(""); }
    else if (key.name === "enter" || key.name === "down" || key.name === "up") view.searching = false;
    else view.searchEditor.handleInput(key);
    view.query = view.searchEditor.input().replace(/\n/g, " ");
    project();
  }

  function keyInput(key) {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      if (leaveLatch.armed) { leave(); return; }
      leaveLatch.arm(); notify(LEAVE_HINT, "info"); return;
    }
    // While leaving is armed, Esc only means "stay".
    if (leaveLatch.armed && key.name === "escape") { leaveLatch.disarm(); return; }
    leaveLatch.disarm();
    if (view.busy) { if (!chatActive && typeAhead.length < TYPE_AHEAD) typeAhead.push(key); return; }
    if (view.help) { if (key.name === "escape" || key.text === "?" || key.text === "q" || key.name === "enter") view.help = false; redraw(); return; }
    if (view.dialog) { dialogKey(key); redraw(); return; }
    if (view.detail) { detailKey(key); redraw(); return; }
    if (view.searching) { searchKey(key); return; }
    if (key.ctrl && !key.alt && (key.name === "u" || key.name === "d")) { move(key.name === "u" ? -10 : 10); return; }
    if (key.ctrl || key.alt) return;
    const text = key.text || "";
    const row = currentRow();
    if (key.name === "up" || text === "k") move(-1);
    else if (key.name === "down" || text === "j") move(1);
    else if (key.name === "pageup" || key.name === "pagedown") move(key.name === "pageup" ? -10 : 10);
    else if (key.name === "home" || text === "g") move(0, 0);
    else if (key.name === "end" || text === "G") move(0, Infinity);
    else if (key.name === "escape") back();
    else if (key.name === "left" || text === "h") left();
    else if (key.name === "right" || text === "l") right();
    else runAction(actionFor(view, row, key)?.id, row, key);
    redraw();
  }
  // Only actions the selected row offers (agents-keys.js#available) ever run.
  function runAction(name, row, key) {
    const member = contextMember(row);
    switch (name) {
      case "open": return activate(row);
      case "actions": return rowActions(row);
      case "chat": return ["independent", "folder"].includes(view.page.kind) ? ui.startNew({ agentId: row?.agentId, workspace: row?.workspace || view.page.workspace }) : member && ui.startNew(member);
      case "edit": return member && actions.editMember(member.teamId, member.agentId);
      case "task": return actions.assignTask(view.page.teamId, member?.agentId);
      case "add": return actions.addMember(view.page.teamId, row?.kind === "member" ? row.agentId : undefined);
      case "tabs": return switchTab(key.text === "1" ? "org" : key.text === "2" ? "tasks" : undefined);
      case "newTeam": return actions.createTeam();
      case "search": view.searching = true; view.searchEditor.setInput(view.query); return undefined;
      case "filter": return actions.chooseFilter();
      case "fold": return toggleFold(false);
      case "foldAll": return toggleFold(true);
      case "group": return jumpGroup(key.text === "]" ? 1 : -1);
      case "refresh": return refresh();
      case "stop": return actions.stopAll(view.entries.filter(r => r.kind === "live").length);
      case "help": view.help = true; return undefined;
      default: return undefined;
    }
  }
  function refresh() {
    if (view.connection !== "connected") { void connect(); return; }
    if (view.page.teamId) delete view.history[view.page.teamId];
    if (view.page.kind === "manager") view.managerHistory = null;
    if (["independent", "folder"].includes(view.page.kind)) view.independent = null;
    if (view.page.kind === "background") view.serviceAt = 0;
    if (view.page.kind === "archive") view.archive = null;
    void perform(async () => acceptSnapshot(await client.request("snapshot")), null, "Refreshing…");
  }

  tui.addChild({ render: width => renderAgents(view, width, tui.rows) });
  tui.onData(raw => keyInput(parseTerminalKey(raw)));
  tui.onPaste(value => {
    if (view.busy) return;
    if (view.dialog?.kind === "form") { view.dialog.paste(clean(value)); redraw(); return; }
    if (!view.searching) return;
    view.searchEditor.handleInput({ kind: "paste", text: clean(value) });
    view.query = view.searchEditor.input(); project();
  });
  input.on?.("end", close); input.on?.("close", close); signal?.addEventListener("abort", close, { once: true });
  try {
    if (signal?.aborted) return { leave: false, working: 0 };
    realpath(managerWorkspace(launch)).then(value => { view.managerPath = process.platform === "win32" ? value.toLowerCase() : value; project(); }, () => {});
    project(); tui.start(); void connect(); await finished;
    return { leave: leaving, notice: leaveNotice, working: view.snapshot.runs.filter(run => ["starting", "running"].includes(run.status)).length };
  } finally {
    closed = true; leaveLatch.disarm(); clearInterval(clock); clearInterval(spinner); clearTimeout(noticeTimer); client?.close(); tui.stop();
    input.off?.("end", close); input.off?.("close", close); signal?.removeEventListener("abort", close);
  }
}
