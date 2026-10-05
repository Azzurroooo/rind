import { paint, paintBackground } from "./theme.js";
import os from "node:os";
import { textWidth, truncateToWidth, wrapTextWithAnsi, middleClipCells } from "./text-width.js";
import { insertCursorMarker } from "./tui/cursor.js";
import { CURSOR_MARKER } from "./tui/frame.js";
import { prepareComposerFrame } from "./composer-terminal.js";
import { statusMeta, single, clean, selectable, memberState } from "./agents-model.js";
import { detailFor } from "./agents-detail.js";
import { HELP_GROUPS, hintsFor, formatHints } from "./agents-keys.js";

export const MIN_WIDTH = 40, MIN_ROWS = 12;
// The tree keeps at least ~60 columns before the detail pane moves beside it.
const SIDEBAR_AT = 84, DETAIL_AT = 90;

const HOME = os.homedir();
// Paths keep their final folder visible: "~/work/…/be-api".
// Only a whole home directory becomes ~; case is ignored where the file
// system ignores it.
export function shortPath(value, width, home = HOME, platform = process.platform) {
  const text = String(value);
  const fold = platform === "win32" || platform === "darwin" ? s => s.toLowerCase() : s => s;
  const atHome = home && fold(text).startsWith(fold(home)) && (text.length === home.length || /[\\/]/.test(text[home.length]));
  return middleClipCells(atHome ? "~" + text.slice(home.length) : text, Math.max(4, width));
}
const toned = (status, text) => (paint[statusMeta(status).tone] || paint.dim)(text);
const glyph = status => toned(status, statusMeta(status).glyph);

// Pads or truncates to exactly `width` cells, keeping a cursor marker in place.
export function fitLine(text, width) {
  const marker = text.indexOf(CURSOR_MARKER);
  const visible = marker < 0 ? text : text.replace(CURSOR_MARKER, "");
  const body = truncateToWidth(visible, width, "…");
  const line = body + " ".repeat(Math.max(0, width - textWidth(body)));
  return marker < 0 ? line : insertCursorMarker(line, Math.min(width - 1, textWidth(visible.slice(0, marker))));
}
const wrap = (lines, width) => lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
const fill = (lines, height) => [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")];

export function layout(view, width, rows) {
  const height = Math.max(1, rows - 1);
  const bodyHeight = Math.max(1, height - 3);
  const sidebar = width >= SIDEBAR_AT;
  const sidebarWidth = sidebar ? Math.max(22, Math.min(30, Math.floor(width * 0.22))) : width;
  const mainX = sidebar ? sidebarWidth + 1 : 0;
  const mainWidth = sidebar ? width - mainX : width;
  const side = mainWidth >= DETAIL_AT ? Math.max(28, Math.min(46, Math.floor(mainWidth * 0.32))) : 0;
  return { height, bodyHeight, sidebar, sidebarWidth, mainX, mainWidth, side };
}

// Keeps the selected row visible while scrolling as little as possible. The
// offset is remembered per list so returning to a page restores its position.
// A small margin keeps rows around the selection visible, so a selected
// member's first conversation is never hidden just below the fold.
const SCROLL_MARGIN = 2;
function windowFor(view, key, rows, selectedId, height) {
  const index = Math.max(0, rows.findIndex(row => row.id === selectedId));
  const max = Math.max(0, rows.length - height);
  const margin = Math.min(SCROLL_MARGIN, Math.floor((height - 1) / 2));
  let offset = Math.min(view.scroll?.[key] ?? 0, max);
  if (index - margin < offset) offset = Math.max(0, index - margin);
  if (index + margin >= offset + height) offset = Math.min(max, index + margin - height + 1);
  if (view.scroll) view.scroll[key] = offset;
  return { offset, index };
}

function rightColumns(row, width) {
  if (row.kind === "section") return "";
  if (["member", "session"].includes(row.kind) && row.status) {
    const word = width >= 52 ? toned(row.status, row.status.padEnd(11)) : "";
    const time = width >= 40 && row.kind === "session" ? paint.dim((row.time || "").padStart(4)) : width >= 40 ? "    " : "";
    return [word, time].filter(Boolean).join(" ");
  }
  if (row.kind === "task") return paint.dim(truncateToWidth(row.owner, 14, "…")) + (row.priority === "high" ? paint.warning(" ↑") : row.priority === "low" ? paint.dim(" ↓") : "  ");
  if (row.kind === "team" && row.summary) return row.summary.needs ? paint.warning("! " + row.summary.needs) : row.summary.working ? paint.accent("● " + row.summary.working) : "";
  if (row.kind === "inbox" && row.badge) return paint.warning(String(row.badge));
  if (row.kind === "background" && row.badge) return paint.accent("● " + row.badge);
  if (row.kind === "live") return paint.dim(truncateToWidth(row.context || "", 24, "…") + " · " + (row.time || "").padStart(3));
  if (row.kind === "service") return (row.stale ? paint.warning : paint.dim)(row.note);
  if (row.context) return paint.dim(row.context);
  return "";
}

function leadIcon(row) {
  if (row.kind === "member" || row.kind === "session" || row.kind === "task" || row.kind === "run") return glyph(row.status);
  if (["add-member", "new-session", "assign", "new-team"].includes(row.kind)) return paint.accent("+");
  if (row.kind === "more") return paint.dim("…");
  if (row.kind === "manager") return paint.notice("◆");
  if (row.kind === "independent") return paint.path("◇");
  if (row.kind === "background") return row.badge ? paint.accent("●") : paint.dim("○");
  if (row.kind === "live" || row.kind === "service") return glyph(row.status);
  if (row.kind === "stop-all") return paint.danger("■");
  if (row.kind === "team" || row.kind === "inbox") return row.status ? glyph(row.status) : paint.dim("○");
  return " ";
}

function memberChip(row, compact) {
  const { tone, label } = memberState(row.status, row.open);
  if (tone === "Inactive") return compact ? "" : paint.dim(label);
  return toned(tone, statusMeta(tone).glyph + (compact ? "" : " " + label));
}

const RIGHT = 16;
// Organization rows: tree guides carry the hierarchy, conversation glyphs sit
// at their own depth, members get an aligned role column and a summary chip.
function treeLine(row, width, nameColumn) {
  const compact = width < 56;
  const guide = paint.dim(row.guide);
  let left, right = "";
  if (row.kind === "workspace") {
    const name = paint.bold(single(row.title));
    right = row.working ? paint.accent("● " + row.working + " working") : paint.dim(row.sessionCount + (row.sessionCount === 1 ? " conversation" : " conversations"));
    const gap = Math.max(1, nameColumn - textWidth(name));
    const room = width - textWidth(name) - gap - Math.max(RIGHT, textWidth(right)) - 2;
    const where = !compact && room > 6 ? " ".repeat(gap) + paint.dim((row.teams?.length ? "in " + single(row.teams.join(", ")) + " · " : "") + shortPath(row.workspace, room - (row.teams?.length ? textWidth("in " + row.teams.join(", ") + " · ") : 0))) : "";
    left = name + where;
  } else if (row.kind === "member") {
    const fold = row.expanded === false ? paint.accent("▸ ") : "";
    const name = fold + paint.bold(single(row.title)) + (row.hidden ? paint.dim(" +" + row.hidden) : "");
    const used = textWidth(row.guide) + textWidth(name);
    const role = row.role && !compact ? " ".repeat(Math.max(1, nameColumn - used)) + paint.dim(row.role) : "";
    left = guide + name + role;
    right = memberChip(row, compact);
  } else if (row.kind === "session") {
    left = guide + glyph(row.status) + " " + single(row.title);
    // Untracked conversations have no live state, only their last save.
    const word = row.tracked === false ? paint.dim("saved") : toned(row.status, row.status);
    right = compact ? paint.dim(row.time || "") : word + " " + paint.dim((row.time || "").padStart(5));
  } else left = guide + paint.dim(single(row.title));
  const room = width - (right ? Math.max(RIGHT, textWidth(right)) + 1 : 0);
  if (room < 8) return fitLine(left, width);
  return fitLine(left, room) + (right ? " " + " ".repeat(Math.max(0, Math.max(RIGHT, textWidth(right)) - textWidth(right))) + right : "");
}

function rowLine(row, width, selected, focused, nameColumn) {
  if (row.kind === "section") {
    const label = " " + row.title.toUpperCase() + (row.count !== undefined ? " · " + row.count : "") + " ";
    return paint.dim("─" + label + "─".repeat(Math.max(0, width - textWidth(label) - 1)));
  }
  const marker = selected ? (focused ? paint.accent("›") : paint.dim("›")) : " ";
  if (row.guide !== undefined) return marker + " " + treeLine(row, width - 2, nameColumn);
  let name = single(row.title);
  if (row.kind === "member" || row.kind === "team") name = paint.bold(name);
  else if (["add-member", "new-session", "assign", "new-team", "more", "clear"].includes(row.kind)) name = paint.dim(name);
  else if (row.kind === "stop-all") name = paint.danger(name);
  const extra = (row.role ? paint.dim(" · " + row.role) : "") + (row.hidden ? paint.dim(" +" + row.hidden) : "") + (row.note && row.kind !== "service" && width >= 60 ? paint.dim(" — " + row.note) : "");
  const left = marker + " " + leadIcon(row) + " " + paint.dim(row.guide || "") + name + extra;
  const right = rightColumns(row, width);
  const room = width - textWidth(right) - 1;
  if (!right || room < 12) return fitLine(left, width);
  return fitLine(truncateToWidth(left, room, "…"), room) + " " + right;
}

function listLines(view, key, rows, selectedId, width, height, focused, empty) {
  if (!rows.length) return fill([paint.dim("  " + empty)], height);
  const { offset } = windowFor(view, key, rows, selectedId, height);
  // Roles line up in one column, capped so long names cannot push them off screen.
  const members = rows.filter(row => ["member", "workspace"].includes(row.kind) && row.guide !== undefined);
  const nameColumn = Math.min(Math.floor(width * 0.45), Math.max(0, ...members.map(row => textWidth(row.guide) + textWidth(single(row.title)) + (row.expanded === false ? 2 : 0) + (row.hidden ? String(row.hidden).length + 2 : 0))) + 2);
  return fill(rows.slice(offset, offset + height).map(row => {
    const selected = row.id === selectedId && selectable(row);
    const line = rowLine(row, width, selected, focused, nameColumn);
    return selected && focused ? paintBackground(line, "selection") : line;
  }), height);
}

function tabs(view, width) {
  const team = view.page.tab;
  const openTasks = view.snapshot.tasks.filter(t => t.teamId === view.page.teamId && !["done", "cancelled"].includes(t.status)).length;
  const tab = (id, label) => id === team ? paintBackground(paint.bold(" " + label + " "), "selection") : paint.dim(" " + label + " ");
  return truncateToWidth(tab("org", "Organization") + " " + tab("tasks", "Tasks" + (openTasks ? " " + openTasks : "")), width, "…");
}

function pageHeader(view, width) {
  const { snapshot, page } = view;
  const team = snapshot.teams.find(t => t.id === page.teamId);
  if (page.kind === "inbox") return [paint.bold("Inbox") + paint.dim(" · everything waiting on you")];
  if (page.kind === "manager") return [paint.bold("Manager") + paint.dim(" · conversations that coordinate every team")];
  if (page.kind === "independent") return [paint.bold("Independent") + paint.dim(" · conversations outside any team, by folder")];
  if (page.kind === "background") return [paint.bold("Background") + paint.dim(" · what keeps running after you leave Rind")];
  if (page.kind === "new-team") return [paint.bold("New team")];
  if (!team) return [paint.dim("Team removed")];
  if (page.kind === "member") {
    const agent = snapshot.agents.find(a => a.id === page.agentId);
    return [paint.dim(single(team.name) + " › ") + paint.bold(single(agent?.name) || "Member") + paint.dim(" · conversations in this team")];
  }
  const leader = snapshot.agents.find(a => a.id === team.leaderAgentId);
  const members = snapshot.memberships.filter(m => m.teamId === team.id).length;
  return [paint.bold(single(team.name)) + paint.dim(" · " + members + (members === 1 ? " member" : " members") + " · leader " + (single(leader?.name) || "not chosen")), tabs(view, width)];
}

function searchLine(view, width) {
  if (view.searching) return editorLines(view.searchEditor, width, 1, paint.accent("/ "))[0];
  if (!view.query && view.filter === "All") return null;
  return paint.dim([view.query && "/ " + single(view.query), view.filter !== "All" && "status: " + view.filter].filter(Boolean).join(" · ") + " · esc clears");
}

function emptyText(view) {
  if (view.query || view.filter !== "All") return "No matches · esc clears the search";
  if (view.page.kind === "new-team") return "Press enter to name your new team";
  return "Nothing here yet";
}

function mainLines(view, width, height) {
  const header = pageHeader(view, width);
  const search = searchLine(view, width);
  const top = [...header, ...(search ? [search] : []), ""];
  const focused = view.focus === "main";
  const listHeight = Math.max(1, height - top.length);
  const row = view.entries.find(r => r.id === view.selectedId);
  const position = view.entries.filter(selectable).length > listHeight ? paint.dim(" " + (view.entries.filter(selectable).findIndex(r => r.id === view.selectedId) + 1) + "/" + view.entries.filter(selectable).length) : "";
  if (position) top[0] = fitLine(top[0], width - textWidth(position)) + position;
  return { top, list: (w, h) => listLines(view, view.pageKey, view.entries, view.selectedId, w, h, focused, emptyText(view)), listHeight, row };
}

function renderMain(view, width, height) {
  const { top, list, listHeight, row } = mainLines(view, width, height);
  const detail = detailFor(view, row);
  const lay = view.layout;
  if (lay.side && width === lay.mainWidth) {
    const listWidth = width - lay.side - 3;
    const left = list(listWidth, listHeight);
    const right = fill(wrap(detail, lay.side), listHeight);
    return [...top.map(line => fitLine(line, width)), ...left.map((line, i) => fitLine(line, listWidth) + paint.dim(" │ ") + fitLine(right[i], lay.side))];
  }
  const below = listHeight >= 14 && detail.length ? Math.min(6, Math.floor(listHeight / 3)) : 0;
  const lines = list(width, listHeight - (below ? below + 1 : 0));
  const extra = below ? [paint.dim("─".repeat(width)), ...fill(wrap(detail, width).slice(0, below), below)] : [];
  return [...top, ...lines, ...extra].map(line => fitLine(line, width));
}

function renderSidebar(view, width, height) {
  return listLines(view, "sidebar", view.sidebar, view.navId, width, height, view.focus === "sidebar", "").map(line => fitLine(line, width));
}

function editorLines(editor, width, maxRows, prompt = "  ") {
  const frame = prepareComposerFrame({ prompt: "  ", inputText: editor.input(), cursor: editor.cursorPosition() }, Math.max(4, width));
  frame.lines[frame.cursorRow] = insertCursorMarker(frame.lines[frame.cursorRow] + " ", frame.cursorColumn);
  const offset = Math.max(0, frame.cursorRow - maxRows + 1);
  return frame.lines.slice(offset, offset + maxRows).map((line, index) => (index === 0 && offset === 0 ? prompt + line.slice(2) : line));
}

function box(title, lines, width, accent = paint.accent) {
  const heading = truncateToWidth(" " + single(title) + " ", Math.max(1, width - 4), "…");
  return [accent("╭─") + paint.bold(heading) + accent("─".repeat(Math.max(0, width - textWidth(heading) - 3)) + "╮"),
    ...lines.map(line => accent("│") + " " + fitLine(line, width - 4) + " " + accent("│")),
    accent("╰" + "─".repeat(Math.max(0, width - 2)) + "╯")].map(line => paintBackground(line, "surfaceActive"));
}

function dialogBox(dialog, width, maxHeight, busy) {
  const inner = width - 4;
  // Descriptions quote paths, errors and names: untrusted text is cleaned before painting.
  const described = wrap((dialog.description || []).map(clean), inner);
  // Choices always keep room for a few options; the description is clipped instead.
  const limit = dialog.kind === "choice" ? Math.max(1, maxHeight - 4 - Math.min(dialog.items.length, 5)) : described.length;
  const lines = described.slice(0, limit).map((line, i) => paint.dim(i === limit - 1 && described.length > limit ? truncateToWidth(line + "…", inner, "…") : line));
  if (lines.length) lines.push("");
  if (dialog.kind === "choice") {
    const capacity = Math.max(1, maxHeight - 2 - lines.length - (dialog.error ? 2 : 0));
    const offset = Math.max(0, Math.min(dialog.index - capacity + 1, dialog.items.length - capacity));
    dialog.items.slice(offset, offset + capacity).forEach((item, i) => {
      const index = offset + i, selected = index === dialog.index;
      const number = dialog.items.length > 1 && index < 9 ? String(index + 1) : " ";
      const label = item.danger ? paint.danger(item.label) : selected ? paint.bold(item.label) : item.label;
      const key = item.key ? paint.dim(item.key) : "";
      const room = inner - textWidth(key) - 1;
      const body = (selected ? paint.accent("›") : " ") + " " + paint.dim(number) + "  " + label + (item.description ? paint.dim("  " + single(item.description)) : "");
      const line = fitLine(truncateToWidth(body, room, "…"), room) + " " + key;
      lines.push(selected ? paintBackground(line, "selection") : line);
    });
  } else {
    const checkLine = check => ({ ok: paint.success("✓ "), error: paint.danger("✕ "), hint: paint.dim("  ") }[check.tone] || "") + (check.tone === "error" ? paint.danger : paint.dim)(shortPath(single(check.text), inner - 4));
    dialog.fields.forEach((item, index) => {
      const active = index === dialog.index;
      const mark = !active && item.check?.tone === "ok" ? paint.success(" ✓") : !active && item.check?.tone === "error" ? paint.danger(" ✕") : "";
      lines.push((active ? paint.accent("› " + item.label) : paint.dim("  " + item.label)) + (item.optional ? paint.dim("  optional") : "") + mark);
      if (active) {
        lines.push(...editorLines(item.editor, inner, 4, paint.accent("┃ ")));
        // Suggestions sit directly under the input, like a shell completion menu.
        const suggestions = item.suggestions || [];
        suggestions.slice(0, 6).forEach((suggestion, i) => lines.push((i === item.pick ? paint.accent("  › ") : "    ") + (i === item.pick ? paint.bold(suggestion.name) : paint.path(suggestion.name)) + paint.dim("/")));
        if (suggestions.length > 6) lines.push(paint.dim("    +" + (suggestions.length - 6) + " more · keep typing to narrow"));
        if (item.check) lines.push("  " + checkLine(item.check));
        if (item.hint) lines.push(...wrap([item.hint], inner - 2).map(line => paint.dim("  " + line)));
      } else lines.push("  " + (item.editor.input() ? truncateToWidth(single(item.editor.input()), inner - 2, "…") : paint.dim("—")));
      if (index < dialog.fields.length - 1) lines.push("");
    });
  }
  if (dialog.error) lines.push("", paint.danger("! " + single(dialog.error)));
  if (busy) lines.push("", paint.accent("… saving"));
  const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
  const room = Math.max(1, maxHeight - 2);
  const start = cursor >= room ? cursor - room + 2 : 0;
  return box(dialog.title, lines.slice(start, start + room), width, dialog.danger ? paint.danger : paint.accent);
}

// Groups stack in one column, or split into two when the box is wide enough.
function helpBox(width, maxHeight) {
  const keyWidth = Math.max(...HELP_GROUPS.flatMap(group => group.items.map(([key]) => textWidth(key)))) + 2;
  const group = (item, index) => [...(index ? [""] : []), paint.bold(item.title), ...item.items.map(([key, label]) => " " + paint.accent(key.padEnd(keyWidth)) + paint.dim(label))];
  const inner = width - 4, half = Math.floor((inner - 2) / 2);
  let lines;
  if (half >= 34) {
    const left = group(HELP_GROUPS[0], 0), right = HELP_GROUPS.slice(1).flatMap(group);
    lines = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => fitLine(left[i] || "", half) + "  " + (right[i] || ""));
  } else lines = HELP_GROUPS.flatMap(group);
  lines.push("", paint.dim("Shortcuts never fire while you are typing in a field."));
  return box("Keyboard", lines.slice(0, Math.max(1, maxHeight - 2)), width);
}

// Panels open at a fixed row so they do not jump while their content grows.
function overlay(base, panel, width) {
  const top = Math.max(0, Math.min(1, base.length - panel.length));
  const left = Math.max(0, Math.floor((width - textWidth(panel[0] || "")) / 2));
  return base.map((line, index) => {
    const content = panel[index - top];
    return content === undefined ? line : " ".repeat(left) + content + " ".repeat(Math.max(0, width - left - textWidth(content.replace(CURSOR_MARKER, ""))));
  });
}

function renderDelivery(view, width, height) {
  const lines = wrap(view.detail.lines.map(clean), Math.max(1, width - 2));
  const room = Math.max(1, height - 2);
  const offset = Math.min(view.detail.offset, Math.max(0, lines.length - room));
  view.detail.offset = offset;
  const position = lines.length > room ? paint.dim(" " + (offset + 1) + "–" + Math.min(lines.length, offset + room) + " of " + lines.length) : "";
  return [fitLine(paint.bold(view.detail.title), width - textWidth(position)) + position, "", ...fill(lines.slice(offset, offset + room).map(line => " " + line), room)].map(line => fitLine(line, width));
}

function headerLine(view, width) {
  const { snapshot, page } = view;
  const team = snapshot.teams.find(t => t.id === page.teamId);
  const crumbs = ["Agents", page.kind === "inbox" ? "Inbox" : page.kind === "manager" ? "Manager" : page.kind === "independent" ? "Independent" : page.kind === "background" ? "Background" : page.kind === "new-team" ? "New team" : single(team?.name) || ""];
  if (page.kind === "member") crumbs.push(single(snapshot.agents.find(a => a.id === page.agentId)?.name));
  else if (page.kind === "team") crumbs.push(page.tab === "tasks" ? "Tasks" : "Organization");
  const left = " " + paint.bold(crumbs[0]) + paint.dim(crumbs.slice(1).filter(Boolean).map(c => " › " + c).join(""));
  const working = snapshot.memberships.filter(m => m.status === "Working").length;
  const needs = view.sidebar[0]?.badge || 0;
  // Breadcrumbs win over status: drop to compact chips before truncating the path.
  const wide = [needs ? paint.warning("! " + needs + " need you") : "", working ? paint.accent("● " + working + " working") : "", paint.success("●") + paint.dim(" connected")];
  const compact = [needs ? paint.warning("! " + needs) : "", working ? paint.accent("● " + working) : "", paint.success("●")];
  const candidates = view.connection === "connected" ? [wide, compact].map(parts => parts.filter(Boolean).join("  ")) : [paint.warning("○ " + view.connection), paint.warning("○")];
  const status = candidates.find(item => width - textWidth(item) - 1 >= textWidth(left)) || candidates.at(-1);
  const room = width - textWidth(status) - 1;
  return room > 10 ? fitLine(left, room - 1) + " " + status + " " : fitLine(left, width);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function noticeLine(view, width, now) {
  if (view.busy) return paint.accent(" " + SPINNER[Math.floor(now / 100) % SPINNER.length] + " " + (view.busyLabel || "Working…"));
  if (!view.notice) return "";
  const badge = { error: paint.danger(" ✕ "), success: paint.success(" ✓ "), info: paint.accent(" • ") }[view.notice.tone] || " ";
  return badge + single(view.notice.text);
}

export function renderAgents(view, width, rows, now = Date.now()) {
  width = Math.max(1, width);
  const lay = layout(view, width, rows);
  view.layout = lay;
  if (width < MIN_WIDTH || rows < MIN_ROWS) return ["Agents", "Needs " + MIN_WIDTH + "×" + MIN_ROWS, "Esc: chat"].slice(0, lay.height).map(line => fitLine(line, width));
  const showSidebar = lay.sidebar || view.focus === "sidebar";
  const sidebarWidth = lay.sidebar ? lay.sidebarWidth : width;
  const mainWidth = lay.sidebar ? lay.mainWidth : width;
  const mainContent = view.detail ? renderDelivery(view, mainWidth, lay.bodyHeight) : renderMain(view, mainWidth, lay.bodyHeight);
  let main = view.dialog ? overlay(mainContent, dialogBox(view.dialog, Math.min(mainWidth - 2, 76), lay.bodyHeight, view.busy), mainWidth) : mainContent;
  main = main.map(line => fitLine(line, mainWidth));
  let body;
  if (lay.sidebar) {
    const side = renderSidebar(view, sidebarWidth, lay.bodyHeight);
    body = side.map((line, i) => line + paint.dim("│") + (main[i] || " ".repeat(mainWidth)));
  } else body = showSidebar && !view.dialog ? renderSidebar(view, width, lay.bodyHeight) : main;
  if (view.help) body = overlay(fill(body, lay.bodyHeight).map(line => fitLine(line, width)), helpBox(Math.min(width - 2, 84), lay.bodyHeight), width);
  const row = view.focus === "sidebar" ? view.sidebar.find(r => r.id === view.navId) : view.entries.find(r => r.id === view.selectedId);
  return [paintBackground(headerLine(view, width), "surfaceActive"), ...fill(body, lay.bodyHeight).map(line => fitLine(line, width)),
    paintBackground(fitLine(noticeLine(view, width, now), width), "surface"),
    paintBackground(fitLine(" " + formatHints(hintsFor(view, row), width - 2), width), "surface")].slice(0, lay.height);
}
