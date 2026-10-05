import { realpath } from "node:fs/promises";
import { createTui } from "./tui/tui.js";
import { parseTerminalKey } from "./terminal-key.js";
import { createLineEditor } from "./line-editor.js";
import { managementClient } from "./agents-client.js";
import { openAgentChat, managerWorkspace } from "./agents-commands.js";
import { emptyAgentsSnapshot, clean, sidebarRows, inboxRows, organizationRows, taskRows, memberSessionRows, managerRows, teamSessions, selectable } from "./agents-model.js";
import { renderAgents } from "./agents-view.js";
import { createActions } from "./agents-actions.js";

const CREATE_KINDS = new Set(["add-member", "assign", "new-session", "new-team"]);
const NOTICE_MS = 6000, CLOCK_MS = 30000, TYPE_AHEAD = 16;

export async function runAgentsPage({ launch, input = process.stdin, output = process.stdout, manageInput = true, signal, initialTeamId, openChat = openAgentChat }) {
  const tui = createTui({ input, output, manageInput, alternateScreen: true });
  const view = {
    snapshot: emptyAgentsSnapshot(), connection: "connecting…", busy: false, busyLabel: "", notice: null, help: false,
    sidebar: [], navId: "inbox", focus: "sidebar", member: null, page: { kind: "inbox" }, pageKey: "inbox", entries: [], selectedId: "",
    selections: {}, scroll: {}, tabs: {}, collapsed: {}, history: {}, managerHistory: null,
    query: "", filter: "All", searching: false, searchEditor: createLineEditor(), dialog: null, detail: null,
  };
  let client, connecting, closed = false, chatActive = false, initialized = false, noticeTimer, spinner, previousKey = "", chatCount = 0;
  // Keys typed while an action is saving are replayed afterwards instead of being lost.
  const typeAhead = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const close = () => { closed = true; if (!chatActive) finish(); };
  // Nothing may paint while a conversation owns the terminal.
  const redraw = () => { if (!closed && !chatActive) tui.requestRender(); };
  const clock = setInterval(() => project(), CLOCK_MS);
  clock.unref?.();

  function derivePage() {
    const nav = view.sidebar.find(row => row.id === view.navId);
    if (nav?.kind === "team") {
      if (view.member?.teamId === nav.teamId) return { kind: "member", teamId: nav.teamId, agentId: view.member.agentId };
      return { kind: "team", teamId: nav.teamId, tab: view.tabs[nav.teamId] || "org" };
    }
    return { kind: nav?.kind || "inbox" };
  }
  function entriesFor(page) {
    const options = { query: view.query, filter: view.filter };
    if (page.kind === "inbox") return inboxRows(view.snapshot);
    if (page.kind === "manager") return managerRows(view.managerHistory?.entries, options);
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
    view.pageKey = [view.page.kind, view.page.teamId, view.page.tab || view.page.agentId].filter(Boolean).join(":");
    const previous = view.pageKey === previousKey ? view.entries : [];
    previousKey = view.pageKey;
    view.entries = entriesFor(view.page);
    const remembered = view.selections[view.pageKey];
    if (!view.entries.some(row => row.id === remembered && selectable(row))) view.selections[view.pageKey] = fallbackSelection(previous, remembered);
    view.selectedId = view.selections[view.pageKey];
    ensureHistory();
    redraw();
  }

  // When the selected row disappears (sorted into "+N more", filtered out or
  // removed), stay near it instead of jumping to the top of the list.
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
    return (items.find(row => !CREATE_KINDS.has(row.kind)) || items[0])?.id;
  }

  function ensureHistory() {
    const teamId = view.page.teamId;
    if (teamId && view.connection === "connected") {
      const key = view.snapshot.sessions.filter(s => s.teamId === teamId && s.runtimeSessionId).map(s => s.runtimeSessionId).sort().join(",");
      const current = view.history[teamId];
      if (!current || (current.key !== key && !current.loading)) void loadHistory(teamId, key);
    }
    if (view.page.kind === "manager" && view.connection === "connected" && !view.managerHistory) void loadManagerHistory();
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
    view.snapshot = snapshot;
    if (!initialized) {
      initialized = true;
      if (snapshot.teams.some(t => t.id === initialTeamId)) { view.navId = initialTeamId; view.focus = "main"; }
    }
    project();
  };
  function connect() {
    if (connecting || closed) return connecting;
    connecting = (async () => {
      const replacement = await managementClient({ ...launch, onSnapshot: acceptSnapshot, onDisconnect() {
        if (closed) return;
        view.connection = "reconnecting · status unconfirmed"; redraw();
        void connect();
      } });
      if (closed) { replacement.close(); return; }
      client = replacement;
      view.connection = "connected";
      view.history = {}; view.managerHistory = null;
      acceptSnapshot(await client.request("subscribe", { afterSeq: view.snapshot.seq || 0 }));
    })().catch(error => { view.connection = "offline · r retries"; notify(error.message, "error"); })
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
    const detail = view.detail, chats = chatCount;
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
      // Keys typed for the old screen must never confirm a dialog the action
      // just opened, or reopen a conversation that already ran.
      const queued = typeAhead.splice(0);
      if (!view.dialog && chats === chatCount) for (const key of queued) keyInput(key);
    }
  }

  function choose(title, items, { description = [], selected, danger = false } = {}) {
    const index = Math.max(0, items.findIndex(item => (item.id ?? item.label) === selected));
    view.dialog = { kind: "choice", title, items, description, index, danger, error: "" }; redraw();
  }
  function form(title, fields, submit, { description = [] } = {}) {
    view.dialog = { kind: "form", title, fields: fields.map(field => ({ ...field, editor: createLineEditor(field.value || "") })), index: 0, description, submit, error: "" }; redraw();
  }
  function confirm(title, description, label, action) {
    choose(title, [{ label: "Cancel", key: "n", description: "Change nothing", action() {} }, { label, key: "y", danger: true, action }], { description, danger: true });
  }
  function showText(title, lines, { taskId, refresh, back } = {}) {
    view.dialog = null;
    view.detail = { title, lines, offset: view.detail?.title === title ? view.detail.offset : 0, taskId, refresh, back };
  }
  function reopen(dialog) { view.dialog = dialog; }
  function resetSearch() { view.query = ""; view.filter = "All"; view.searching = false; view.searchEditor.setInput(""); }
  function openTeam(teamId, tab = view.tabs[teamId] || "org", selectId) {
    view.navId = teamId; view.member = null; view.tabs[teamId] = tab; view.focus = "main"; view.detail = null; resetSearch();
    if (selectId) view.selections[["team", teamId, tab].join(":")] = selectId;
    project();
  }
  function openMember(teamId, agentId) {
    view.navId = teamId; view.member = { teamId, agentId }; view.focus = "main"; view.detail = null; resetSearch(); project();
  }
  function setFilter(status) { view.filter = status; project(); }

  async function chat({ agentId, teamId, runtimeSessionId, manager = false }) {
    const agent = view.snapshot.agents.find(a => a.id === agentId);
    if (agent && !manager) {
      const workspace = await realpath(managerWorkspace(launch));
      manager = agent.canonicalWorkspace === (process.platform === "win32" ? workspace.toLowerCase() : workspace);
    }
    if (!manager && !agent) throw new Error("This member is no longer available.");
    chatActive = true; chatCount++; tui.stop({ releaseInput: false });
    try { await openChat({ agent, teamId: manager ? undefined : teamId, runtimeSessionId, manager, launch, input }); }
    finally {
      chatActive = false;
      if (closed) finish();
      else {
        tui.start({ acquireInput: false });
        // A finished conversation may have created history that the lists should show.
        if (manager) view.managerHistory = null; else if (teamId) delete view.history[teamId];
        project();
      }
    }
  }

  const ui = { view, request, choose, form, confirm, notify, showText, reopen, openTeam, openMember, setFilter, // Menu actions already run inside perform(); nesting would be refused as busy.
    chat: options => (view.busy ? chat(options) : perform(() => chat(options), null, "Opening conversation…")) };
  const actions = createActions(ui);
  const currentRow = () => (view.focus === "sidebar" ? view.sidebar.find(r => r.id === view.navId) : view.entries.find(r => r.id === view.selectedId));

  function activate(row = currentRow()) {
    if (!row) return;
    if (view.focus === "sidebar") {
      if (row.kind === "new-team") return actions.createTeam();
      view.focus = "main"; return project();
    }
    switch (row.kind) {
      case "member":
      case "more": return openMember(row.teamId, row.agentId);
      case "session": return ui.chat({ agentId: row.agentId, teamId: row.teamId, runtimeSessionId: row.sessionId, manager: row.manager });
      case "new-session": return ui.chat({ agentId: row.agentId, teamId: row.teamId || view.page.teamId, manager: row.manager });
      case "add-member": return actions.addMember(row.teamId);
      case "assign": return actions.assignTask(row.teamId);
      case "task": return view.page.kind === "inbox" && row.answer ? actions.answer(row.taskId) : perform(() => actions.delivery(row.taskId), null, "Loading delivery…");
      case "run": { const run = view.snapshot.runs.find(r => r.id === row.runId); return run && actions.resolveRun(run); }
      case "team": return openTeam(row.teamId);
      case "new-team": return actions.createTeam();
      default: return undefined;
    }
  }
  function rowActions(row = currentRow()) {
    if (!row || view.focus === "sidebar") return;
    if (row.kind === "member") actions.memberActions(row.teamId, row.agentId);
    else if (row.kind === "session") actions.sessionActions(row);
    else if (row.kind === "task") actions.taskActions(row.taskId);
    else activate(row);
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
      if (next !== view.navId) { view.navId = next; view.member = null; resetSearch(); }
    } else view.selections[view.pageKey] = next;
    project();
  }
  function back() {
    if (view.focus === "main" && (view.query || view.filter !== "All")) { resetSearch(); project(); return; }
    if (view.page.kind === "member") {
      const { teamId, agentId } = view.page;
      view.member = null; view.selections[["team", teamId, view.tabs[teamId] || "org"].join(":")] = "m:" + agentId; resetSearch(); project(); return;
    }
    if (view.focus === "main") { view.focus = "sidebar"; resetSearch(); project(); return; }
    close();
  }
  function fold(open) {
    const row = currentRow();
    const teamId = view.page.teamId;
    const collapsed = view.collapsed[teamId] ||= new Set();
    if (row?.kind === "member" && row.expandable && row.expanded !== open && !view.query && view.filter === "All") {
      if (open) collapsed.delete(row.agentId); else collapsed.add(row.agentId);
      project(); return true;
    }
    if (!open && row && row.depth > 0) {
      const index = view.entries.indexOf(row);
      const parent = view.entries.slice(0, index).findLast(r => r.kind === "member" && r.depth < row.depth);
      if (parent) { view.selections[view.pageKey] = parent.id; project(); return true; }
    }
    if (open && row?.kind === "member" && row.expanded) { move(1); return true; }
    return false;
  }
  function switchTab(tab) {
    if (view.page.kind !== "team") return;
    view.tabs[view.page.teamId] = tab ?? (view.page.tab === "org" ? "tasks" : "org");
    view.focus = "main"; resetSearch(); project();
  }

  function dialogKey(key) {
    const dialog = view.dialog;
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
      return;
    }
    if (key.name === "tab") { dialog.index = (dialog.index + (key.shift ? -1 : 1) + dialog.fields.length) % dialog.fields.length; dialog.error = ""; return; }
    if ((key.name === "up" || key.name === "down") && !dialog.fields[dialog.index].editor.input().includes("\n")) {
      dialog.index = Math.max(0, Math.min(dialog.fields.length - 1, dialog.index + (key.name === "up" ? -1 : 1))); return;
    }
    const field = dialog.fields[dialog.index];
    if (field.editor.handleInput(key) !== "submit") return;
    if (!field.optional && !field.editor.input().trim()) { dialog.error = field.label + " is required."; return; }
    if (dialog.index < dialog.fields.length - 1) { dialog.index++; dialog.error = ""; return; }
    const missing = dialog.fields.findIndex(item => !item.optional && !item.editor.input().trim());
    if (missing >= 0) { dialog.index = missing; dialog.error = dialog.fields[missing].label + " is required."; return; }
    const values = Object.fromEntries(dialog.fields.map(item => [item.key, item.editor.input().trim()]));
    void perform(() => dialog.submit(values), dialog, "Saving…");
  }
  function detailKey(key) {
    const detail = view.detail;
    const page = Math.max(1, (view.layout?.bodyHeight || 10) - 3);
    if (key.name === "escape" || key.name === "left" || key.text === "h") { view.detail = null; detail.back?.(); }
    else if (key.text === " " && detail.taskId) actions.taskActions(detail.taskId);
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
    if (key.ctrl && key.name === "c") { close(); return; }
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
    else if (key.name === "left" || text === "h") { if (view.focus !== "main" || !fold(false)) back(); }
    else if (key.name === "right" || text === "l") { if (view.focus === "sidebar") activate(); else if (!fold(true) && ["member", "more", "team"].includes(row?.kind)) activate(); }
    else if (key.name === "enter") activate();
    else if (text === " ") rowActions();
    else if (key.name === "tab") switchTab();
    else if (text === "1" || text === "2") switchTab(text === "1" ? "org" : "tasks");
    else if (text === "?") view.help = true;
    else if (text === "/" && view.focus === "main" && view.page.kind !== "new-team") { view.searching = true; view.searchEditor.setInput(view.query); }
    else if (text === "f" && view.focus === "main" && ["team", "member"].includes(view.page.kind)) actions.chooseFilter();
    else if (text === "n" || text === "N") actions.createTeam();
    else if (text === "r") refresh();
    else if (text === "c" && contextMember()) { const m = contextMember(); ui.chat(m); }
    else if (text === "t" && view.focus === "main" && view.page.teamId) actions.assignTask(view.page.teamId, contextMember()?.agentId);
    else if (text === "a" && view.focus === "main" && view.page.kind === "team") actions.addMember(view.page.teamId, row?.kind === "member" ? row.agentId : undefined);
    else if (text === "e" && contextMember()) actions.editMember(contextMember().teamId, contextMember().agentId);
    redraw();
  }
  function refresh() {
    if (view.connection !== "connected") { void connect(); return; }
    if (view.page.teamId) delete view.history[view.page.teamId];
    if (view.page.kind === "manager") view.managerHistory = null;
    void perform(async () => acceptSnapshot(await client.request("snapshot")), null, "Refreshing…");
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
    closed = true; clearInterval(clock); clearInterval(spinner); clearTimeout(noticeTimer); client?.close(); tui.stop();
    input.off?.("end", close); input.off?.("close", close); signal?.removeEventListener("abort", close);
  }
}
