import { paint } from "./theme.js";
import { textWidth, truncateToWidth, wrapTextWithAnsi } from "./text-width.js";
import { insertCursorMarker } from "./tui/cursor.js";
import { CURSOR_MARKER } from "./tui/frame.js";
import { prepareComposerFrame } from "./composer-terminal.js";
import { agentStatus } from "./agents-client.js";

export const emptyAgentsSnapshot = () => ({ teams: [], memberships: [], agents: [], tasks: [], runs: [], sessions: [], notes: [], artifacts: [] });
export const clean = value => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const single = value => clean(value).replace(/\s+/g, " ");
const priority = status => ["Needs input", "Unconfirmed", "Working", "Waiting", "Queued", "Ready", "Done", "Inactive", "Cancelled"].indexOf(status);
const taskStatus = status => ({ running: "Working", queued: "Queued", blocked: "Needs input", needs_attention: "Needs input", done: "Done", cancelled: "Cancelled" }[status] || status);
export function statusText(status) {
  const style = { "Needs input": paint.warning, Unconfirmed: paint.danger, Working: paint.accent, Waiting: paint.notice, Done: paint.success, Ready: paint.success }[status] || paint.dim;
  const symbol = { "Needs input": "!", Unconfirmed: "?", Working: "●", Done: "✓", Ready: "○" }[status] || "·";
  return style(symbol + " " + status);
}
export function navigationRows(snapshot) {
  return [
    { id: "overview", kind: "overview", title: "Overview", caption: "All teams and live sessions", details: ["All teams", "See activity across every team and enter any member session."] },
    { id: "manager", kind: "manager", title: "Manager", caption: "Coordinate all teams", details: ["Manager", "Assemble teams, delegate to leaders, and review progress.", "", "The manager sees team status and published reports. Members' private conversations stay with them."] },
    { id: "new", kind: "new", title: "+ Create team", caption: "Start with any folder", details: ["Create a team", "Choose a name, then add folders as members. The first member becomes the leader."] },
    ...snapshot.teams.map(team => {
      const members = snapshot.memberships.filter(m => m.teamId === team.id);
      const tasks = snapshot.tasks.filter(t => t.teamId === team.id);
      const statuses = members.map(m => agentStatus(snapshot, m.agentId, team.id));
      const attention = statuses.filter(s => ["Needs input", "Unconfirmed"].includes(s)).length;
      const working = statuses.filter(s => s === "Working").length;
      const leader = snapshot.agents.find(a => a.id === team.leaderAgentId);
      return { id: team.id, kind: "team", title: team.name, caption: members.length + " members" + (attention ? " · " + attention + " need input" : working ? " · " + working + " working" : ""),
        details: [team.name, members.length + " members · " + tasks.filter(t => t.status === "done").length + " delivered", "", "Leader", leader?.name || "Choose a leader", "", "New workspaces", team.createRoot, "", "Enter to see members and tasks."] };
    }),
  ];
}
export function memberRows(snapshot, teamId, tab, query = "", filter = "All", collapsed = new Set()) {
  const team = snapshot.teams.find(t => t.id === teamId);
  const matches = text => single(text).toLowerCase().includes(query.toLowerCase());
  const members = snapshot.memberships.filter(m => m.teamId === teamId);
  if (tab === "overview") {
    const tasks = snapshot.tasks.filter(t => t.teamId === teamId);
    return [{ id: "summary", kind: "summary", title: "Team briefing", caption: "Decisions, progress and delivered results", details: [team?.name || "Team", "Main agent: " + (snapshot.agents.find(a => a.id === team?.leaderAgentId)?.name || "Choose a leader"), "", ...tasks.filter(t => t.status === "needs_attention" || t.blockedOn?.responder === "user").map(t => "! " + t.brief + " — " + (t.blockedOn?.action || t.error)), "", "Tab to organization / tasks"] }];
  }
  let rows = tab === "tasks" ? snapshot.tasks.filter(t => t.teamId === teamId).map(task => {
    const owner = snapshot.agents.find(a => a.id === task.assigneeAgentId);
    const responder = snapshot.agents.find(a => a.id === task.blockedOn?.responder)?.name || task.blockedOn?.responder;
    return { id: task.id, kind: "task", title: task.brief, status: task.status === "blocked" && responder === "children" ? "Waiting" : taskStatus(task.status), caption: (owner?.name || "Removed member") + (task.priority ? " · " + task.priority + " priority" : "") + (task.parentTaskId ? " · Subtask" : ""),
      details: [task.brief, "Owner: " + (owner?.name || "Removed member"), "", ...(task.queueReason ? [task.queueReason, ""] : []), ...(task.blockedOn ? [responder === "children" ? "Waiting for assigned members" : "Needs " + responder, task.blockedOn.action, ""] : []), ...(task.error ? [task.error, ""] : []), task.report?.summary || "No delivery yet. Open task actions to inspect or respond."] };
  }) : members.map(member => {
    const agent = snapshot.agents.find(a => a.id === member.agentId);
    const tasks = snapshot.tasks.filter(t => t.teamId === teamId && t.assigneeAgentId === member.agentId);
    const recent = tasks.find(t => t.status === "running") || tasks.findLast(t => ["blocked", "needs_attention"].includes(t.status)) || tasks.at(-1);
    const role = member.agentId === team?.leaderAgentId ? "Leader" : member.position || "Member";
    const sessions = snapshot.sessions.filter(s => s.agentId === member.agentId && s.teamId === teamId);
    const parent = member.reportsToAgentId || (member.agentId !== team?.leaderAgentId ? team?.leaderAgentId : undefined);
    return { id: member.agentId, parent, kind: "member", title: agent?.name || "Missing member", status: agentStatus(snapshot, member.agentId, teamId), caption: role + " · " + sessions.length + " sessions",
      details: [agent?.name || "Missing member", role, "Reports to: " + (snapshot.agents.find(a => a.id === parent)?.name || "User"), agent?.canonicalWorkspace || "Unavailable", "", "Responsibility", member.responsibility || "No responsibility assigned", ...(recent ? ["", "Latest task", recent.brief, recent.report?.summary || recent.blockedOn?.action || recent.error || taskStatus(recent.status)] : [])] };
  });
  if (tab === "members") {
    const ordered = [], visited = new Set();
    function visit(row, depth) {
      if (visited.has(row.id)) return;
      visited.add(row.id);
      const children = rows.filter(r => r.parent === row.id);
      ordered.push({ ...row, depth, hasChildren: children.length > 0, collapsed: collapsed.has(row.id), caption: row.caption + (children.length ? " · " + children.length + " direct reports" : "") });
      if (!collapsed.has(row.id) || query || filter !== "All") children.forEach(child => visit(child, depth + 1));
    }
    rows.filter(row => !row.parent || !rows.some(r => r.id === row.parent)).forEach(row => visit(row, 0));
    rows = ordered;
  }
  rows = rows.filter(row => matches([row.title, row.caption, ...row.details].join(" ")) && (filter === "All" || row.status === filter));
  if (tab === "tasks") rows.sort((a, b) => priority(a.status) - priority(b.status));
  return [{ id: "add", kind: "add", title: tab === "tasks" ? "+ Assign task" : "+ Add member", caption: tab === "tasks" ? "Choose an owner and expected delivery" : "Existing folder, new workspace or worktree" }, ...rows];
}
const pad = (text, width) => {
  const marker = text.indexOf(CURSOR_MARKER);
  const visible = text.replace(CURSOR_MARKER, "");
  const padded = truncateToWidth(visible, width) + " ".repeat(Math.max(0, width - textWidth(visible)));
  return marker < 0 ? padded : insertCursorMarker(padded, Math.min(width - 1, textWidth(text.slice(0, marker))));
};
const fit = (lines, height) => [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")];
const wrapped = (lines, width) => lines.flatMap(line => wrapTextWithAnsi(clean(line), Math.max(1, width)));
function box(title, lines, width, height, active = false) {
  if (height < 3 || width < 8) return fit(lines.map(line => truncateToWidth(line, width)), height);
  const border = active ? paint.accent : paint.dim;
  const heading = truncateToWidth(" " + single(title) + " ", width - 4);
  return [border("╭─" + heading + "─".repeat(Math.max(0, width - textWidth(heading) - 3)) + "╮"),
    ...fit(lines, height - 2).map(line => border("│") + " " + pad(line, width - 4) + " " + border("│")),
    border("╰" + "─".repeat(width - 2) + "╯")];
}
function listLines(rows, selectedId, width, height, active) {
  const selected = Math.max(0, rows.findIndex(r => r.id === selectedId));
  const perRow = height >= 6 ? 2 : 1;
  const count = Math.max(1, Math.floor((height - 1) / perRow));
  const offset = Math.min(Math.max(0, selected - Math.floor(count / 2)), Math.max(0, rows.length - count));
  const lines = [];
  for (const row of rows.slice(offset, offset + count)) {
    const focused = row.id === rows[selected]?.id;
    const marker = focused ? (active ? "› " : "▸ ") : "  ";
    const name = (row.depth !== undefined ? "  ".repeat(Math.min(row.depth, 6)) + (row.hasChildren ? row.collapsed ? "▸ " : "▾ " : row.depth ? "└ " : "") : "") + single(row.title);
    const status = row.status && width >= 28 ? statusText(row.status) : "";
    const available = width - textWidth(status) - (status ? 3 : 0) - 2;
    const title = truncateToWidth(name, Math.max(4, available));
    lines.push((focused ? paint.accent(marker) + paint.bold(title) : marker + title)
      + (status && width >= 28 ? " ".repeat(Math.max(1, width - textWidth(title) - textWidth(status) - 2)) + status : ""));
    if (perRow === 2) lines.push("  " + paint.dim(truncateToWidth(single(row.caption), width - 2)));
  }
  if (rows.length > count) lines.push(paint.dim("  " + (selected + 1) + "/" + rows.length + " · ↑↓ scroll"));
  return fit(lines, height);
}
function editorLines(editor, width, maxRows = 3) {
  const frame = prepareComposerFrame({ prompt: "  ", inputText: editor.input(), cursor: editor.cursorPosition() }, width);
  frame.lines[frame.cursorRow] = insertCursorMarker(frame.lines[frame.cursorRow] + " ", frame.cursorColumn);
  const offset = Math.max(0, frame.cursorRow - maxRows + 1);
  return frame.lines.slice(offset, offset + maxRows);
}
function renderDialog(dialog, width, height, busy) {
  const inner = Math.max(1, width - 4);
  const capacity = Math.max(1, height - 5);
  const footer = busy ? "Saving…" : dialog.kind === "form" ? "Enter next / save · Tab field · Esc cancel" : "↑↓ choose · Enter confirm · Esc cancel";
  const description = wrapped(dialog.description || [], inner);
  const lines = dialog.kind === "choice" ? description.slice(0, Math.max(0, Math.min(3, capacity - 3))) : description;
  if (lines.length && dialog.kind === "form") lines.push("");
  if (dialog.kind === "form") {
    const field = dialog.fields[dialog.index];
    lines.push(paint.dim("Field " + (dialog.index + 1) + " of " + dialog.fields.length));
    for (const [index, item] of dialog.fields.entries()) {
      if (index === dialog.index) {
        lines.push(paint.accent("› " + item.label) + (item.optional ? paint.dim(" (optional)") : ""));
        lines.push(...editorLines(item.editor, inner));
        if (item.hint) lines.push(...wrapped([item.hint], inner).map(paint.dim));
      } else lines.push(paint.dim("  " + item.label + ": ") + truncateToWidth(single(item.editor.input() || "—"), inner - textWidth(item.label) - 4));
    }
    if (!field) return [];
  } else {
    const rows = dialog.items.map(item => ({ id: item.label, title: item.label, caption: item.description }));
    lines.push(...listLines(rows, dialog.selection.selectedOption(), inner, capacity - lines.length, true));
  }
  const error = dialog.error ? paint.danger(truncateToWidth(single(dialog.error), inner)) : "";
  // Keep the current field and controls visible even on short terminals.
  let visible = lines.slice(0, capacity);
  const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
  if (cursor >= capacity) visible = lines.slice(Math.max(0, cursor - capacity + 2), Math.max(0, cursor - capacity + 2) + capacity);
  return box(dialog.title, [...fit(visible, capacity), error, paint.dim(truncateToWidth(footer, inner))], width, height, true);
}
export function renderAgents(view, width, rows) {
  width = Math.max(1, width); const height = Math.max(1, rows - 1);
  if (width < 32 || rows < 12) return ["Agents", "Enlarge terminal (32 × 12)", "Esc back"].slice(0, height).map(line => truncateToWidth(line, width));
  const { snapshot, nav, entries, navId, selectedId, teamId, focus, tab, query, filter, dialog, detail, notice, connection, busy } = view;
  const team = snapshot.teams.find(t => t.id === teamId);
  const current = (focus === "nav" ? nav.find(r => r.id === navId) : entries.find(r => r.id === selectedId));
  const attention = snapshot.tasks.filter(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder === "user")).length
    + snapshot.runs.filter(r => !r.taskId && r.status === "running" && r.needsInput).length;
  const active = snapshot.runs.filter(r => ["starting", "running"].includes(r.status)).length;
  const header = paint.bold("  Agents") + paint.dim(team ? " / " + single(team.name) : " / Overview");
  const summary = "  " + snapshot.teams.length + " teams · " + active + " running · " + attention + " need input";
  const top = [header, connection === "connected" ? paint.dim(summary) : paint.warning("  " + connection), ""];
  const bodyHeight = Math.max(3, height - top.length - 2);
  let body;
  if (dialog) body = renderDialog(dialog, width, bodyHeight, busy);
  else if (detail) {
    const lines = wrapped(detail.lines, Math.max(1, width - 4));
    const offset = Math.min(detail.offset, Math.max(0, lines.length - bodyHeight + 2));
    body = box((detail.title || "Delivery") + " · " + (offset + 1) + "/" + Math.max(1, lines.length), lines.slice(offset), width, bodyHeight, true);
  } else {
    const wide = width >= 96;
    const navWidth = wide ? Math.min(32, Math.floor(width * 0.27)) : width;
    const mainWidth = wide ? width - navWidth - 1 : width;
    const selected = entries.find(r => r.id === selectedId);
    const main = () => {
      const title = view.memberId ? "Sessions · " + (snapshot.agents.find(a => a.id === view.memberId)?.name || "Member") : view.navId === "overview" ? "All teams · Sessions" : ({ overview: "Team overview", members: "Organization", tasks: "Tasks" }[tab] || tab) + " · Tab switch";
      const interior = Math.max(1, mainWidth - 4);
      const search = view.searching ? editorLines(view.searchEditor, interior, 1) : [paint.dim("/ Search" + (query ? ": " + single(query) : "") + " · " + filter)];
      const available = bodyHeight - 4;
      if (interior >= 80) {
        const listWidth = Math.floor(interior * 0.55), previewWidth = interior - listWidth - 3;
        const list = listLines(entries, selectedId, listWidth, available, focus === "list");
        const preview = fit([paint.dim("DETAILS"), "", ...wrapped(selected?.details || [selected?.caption || ""], previewWidth)], available);
        const columns = list.map((line, index) => pad(line, listWidth) + paint.dim(" │ ") + preview[index]);
        return box(title, [...search, "", ...columns], mainWidth, bodyHeight, focus === "list");
      }
      const detailSize = bodyHeight >= 13 ? Math.min(7, Math.max(4, Math.floor(available / 3))) : 0;
      const list = listLines(entries, selectedId, interior, Math.max(1, available - detailSize - 1), focus === "list");
      if (!entries.length || (entries.length === 1 && entries[0].kind === "add")) list.splice(entries.length * 2, 0, paint.dim(query || filter !== "All" ? "No matches. Clear search or filter." : tab === "members" ? "Add a folder to start this team." : "Assign a goal to your team leader."));
      const preview = detailSize ? [paint.dim("─".repeat(interior)), ...wrapped(selected?.details || [selected?.caption || ""], interior).slice(0, detailSize - 1)] : [];
      return box(title, [...search, "", ...fit(list, Math.max(1, available - detailSize - 1)), ...preview], mainWidth, bodyHeight, focus === "list");
    };
    const left = box("Teams", listLines(nav, navId, navWidth - 4, bodyHeight - 2, focus === "nav"), navWidth, bodyHeight, focus === "nav");
    if (wide) {
      const right = team || view.navId === "overview" || view.memberId ? main() : box("Overview", wrapped(current?.details || ["Choose a team or open Manager."], mainWidth - 4), mainWidth, bodyHeight);
      body = left.map((line, i) => pad(line, navWidth) + " " + (right[i] || ""));
    } else body = focus === "nav" ? left : main();
  }
  const hint = dialog ? "Esc cancels · values stay editable"
    : detail ? (detail.taskId ? "↑↓ scroll · Space actions · R refresh · Esc back" : "↑↓ scroll · R refresh · Esc back")
    : focus === "nav" ? "↑↓ select · Enter open · Esc chat"
    : view.memberId || view.navId === "overview" ? "Enter session · Space actions · Esc back"
    : tab === "overview" ? "Enter briefing · Tab organization · ← teams"
    : tab === "members" ? "Enter sessions · Space actions · → fold"
    : "Enter delivery · Space actions · ← teams";
  const message = busy ? "Working…" : notice || (!dialog && !detail ? (focus === "nav" ? "Manager coordinates all teams · N new team" : view.memberId ? "R refresh history · / search · F filter" : view.navId === "overview" ? "All teams · / search · F filter" : "Tab overview / organization / tasks · / search · F filter") : "");
  return [...top.map(line => truncateToWidth(line, width)), ...fit(body, bodyHeight), paint.dim(truncateToWidth("  " + single(message), width)), paint.dim(truncateToWidth("  " + hint, width))].slice(0, height);
}
