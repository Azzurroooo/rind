import test from "node:test";
import assert from "node:assert/strict";
import { renderAgents } from "../lib/agents-view.js";
import { emptyAgentsSnapshot, sidebarRows, organizationRows, teamSessions, taskRows } from "../lib/agents-model.js";
import { formatHints, hintsFor } from "../lib/agents-keys.js";
import { createLineEditor } from "../lib/line-editor.js";
import { textWidth, stripAnsi } from "../lib/text-width.js";
import { CURSOR_MARKER } from "../lib/tui/frame.js";

function fixture() {
  const snapshot = emptyAgentsSnapshot();
  snapshot.teams.push({ id: "team", name: "产品开发", leaderAgentId: "lead", createRoot: "C:/projects/worktrees" });
  for (let i = 0; i < 20; i++) {
    const id = i === 0 ? "lead" : "member-" + i;
    snapshot.agents.push({ id, name: i === 0 ? "Lead" : "工程师 " + i, canonicalWorkspace: "C:/projects/feature-" + i });
    snapshot.memberships.push({ teamId: "team", agentId: id, reportsToAgentId: i > 10 ? "member-4" : undefined, responsibility: "实现功能、运行测试并汇总证据。",
      status: i === 4 ? "Needs input" : i === 7 ? "Unconfirmed" : i % 3 === 0 ? "Working" : "Ready" });
  }
  snapshot.sessions.push({ id: "s", agentId: "member-7", teamId: "team", runtimeSessionId: "r7", status: "Unconfirmed" });
  const sessions = teamSessions(snapshot, "team", [{ runtimeSessionId: "r7", agentId: "member-7", teamId: "team", title: "修复登录流程" }]);
  const entries = [{ id: "add-member", kind: "add-member", title: "Add member", teamId: "team" }, ...organizationRows(snapshot, "team", sessions)];
  return { snapshot, sidebar: sidebarRows(snapshot), navId: "team", focus: "main", page: { kind: "team", teamId: "team", tab: "org" }, pageKey: "team:team:org",
    entries, selectedId: "m:member-7", scroll: {}, query: "", filter: "All", searchEditor: createLineEditor(), connection: "connected" };
}
const text = lines => stripAnsi(lines.join("\n"));
const bounded = (lines, width, rows) => {
  assert.ok(lines.length <= rows - 1, "frame leaves the last row free");
  for (const line of lines) assert.ok(textWidth(line.replace(CURSOR_MARKER, "")) <= width, "line fits " + width + ": " + stripAnsi(line));
};

test("organization keeps the selection, its status and contextual keys visible at every size", () => {
  const view = fixture();
  for (const [width, rows] of [[40, 12], [60, 20], [84, 24], [120, 30], [160, 40]]) {
    const lines = renderAgents(view, width, rows);
    bounded(lines, width, rows);
    const screen = text(lines);
    assert.match(screen, /工程师 7/);
    assert.match(screen, /\? help/);
    assert.match(screen, /esc back/);
    if (width >= 52) assert.match(screen, /Unconfirmed/);
    if (width >= 84) assert.match(screen, /Inbox/);
    if (width >= 120) assert.match(screen, /Responsibility/, "wide layouts show the selection's details");
  }
});

test("sessions render beneath their member and collapsed branches show the hidden count", () => {
  const view = fixture();
  const screen = text(renderAgents(view, 120, 30));
  assert.match(screen, /工程师 7[\s\S]*└─ \? 修复登录流程/);
  view.entries = organizationRows(view.snapshot, "team", [], { collapsed: new Set(["member-4"]) });
  view.selectedId = "m:member-4";
  assert.match(text(renderAgents(view, 120, 30)), /▸ 工程师 4 \+9/);
});

test("tasks show sections and a delivery hint", () => {
  const view = fixture();
  view.snapshot.tasks.push({ id: "t", teamId: "team", assigneeAgentId: "lead", brief: "Approve release", status: "blocked", blockedOn: { responder: "user", action: "Pick a date" } });
  view.page = { kind: "team", teamId: "team", tab: "tasks" };
  view.entries = taskRows(view.snapshot, "team");
  view.selectedId = "t:t";
  const screen = text(renderAgents(view, 120, 30));
  assert.match(screen, /NEEDS YOU · 1/);
  assert.match(screen, /enter delivery/);
  assert.match(screen, /Tasks 1/);
});

test("form keeps one cursor in the active field and wraps CJK input", () => {
  const view = fixture();
  view.dialog = { kind: "form", title: "Role and responsibility", index: 1, description: ["工程师 7"], fields: [
    { label: "Position", editor: createLineEditor("Reviewer") },
    { label: "Responsibility", editor: createLineEditor("核对发票 🚀 ".repeat(20)) },
  ] };
  for (const [width, rows] of [[40, 14], [80, 24], [120, 30]]) {
    const lines = renderAgents(view, width, rows);
    bounded(lines, width, rows);
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1);
    assert.match(text(lines), /esc cancel/);
  }
});

test("long choice lists keep the selected item visible and untrusted text cannot emit control sequences", () => {
  const view = fixture();
  view.dialog = { kind: "choice", title: "Actions", index: 14, description: ["A very long workspace path ".repeat(30)], items: Array.from({ length: 15 }, (_, i) => ({ label: "Action " + i, description: "Description " + i })) };
  assert.match(text(renderAgents(view, 40, 16)), /Action 14/);
  view.dialog = null;
  view.detail = { title: "Receipt", offset: 0, lines: ["\x1b[2Jsecret\x1b]52;c;bad\x07", "Result " + "很长的证据".repeat(30)] };
  const output = renderAgents(view, 40, 16).join("\n");
  assert.doesNotMatch(output, /\x1b\[2J|\x1b\]52|\[object Object\]/);
  assert.match(output, /Receipt/);
});

test("help lists every shortcut group and the footer never cuts a hint in half", () => {
  const view = { ...fixture(), help: true };
  const screen = text(renderAgents(view, 120, 30));
  for (const label of ["Navigate", "Team", "View", "new conversation", "filter by status"]) assert.match(screen, new RegExp(label));
  view.help = false;
  const row = view.entries.find(r => r.id === view.selectedId);
  for (const width of [20, 36, 60]) {
    const footer = stripAnsi(formatHints(hintsFor(view, row), width));
    assert.ok(textWidth(footer) <= width);
    assert.match(footer, /\? help/);
    for (const part of footer.split("  ")) assert.match(part, /^\S+ \S/);
  }
});

test("offline state and tiny terminals stay bounded", () => {
  const view = { ...fixture(), connection: "reconnecting · status unconfirmed" };
  assert.match(text(renderAgents(view, 120, 30)), /reconnecting/);
  for (const [width, rows] of [[20, 8], [4, 3], [39, 11]]) bounded(renderAgents(view, width, rows), width, rows);
});

test("colored rows with long roles keep every line exactly the terminal width", t => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY"), noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env.NO_COLOR;
  t.after(() => { if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else delete process.stdout.isTTY; if (noColor !== undefined) process.env.NO_COLOR = noColor; });
  const view = fixture();
  view.snapshot.memberships.forEach((m, i) => { m.position = "Sub-agent | Frontend/State " + "x".repeat(i); });
  view.entries = [{ id: "add-member", kind: "add-member", title: "Add member", teamId: "team" }, ...organizationRows(view.snapshot, "team", teamSessions(view.snapshot, "team", []))];
  for (const [width, rows] of [[60, 20], [84, 24], [131, 34], [160, 40]]) {
    const lines = renderAgents(view, width, rows);
    assert.match(lines.join(""), /\x1b\[/, "colors are on");
    for (const line of lines) {
      assert.equal(textWidth(line), width, "exact width " + width + ": " + JSON.stringify(stripAnsi(line)));
      // A split escape (e.g. "\x1b[2") makes the terminal swallow the cells after it.
      assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b/, "only whole SGR sequences: " + JSON.stringify(line));
    }
  }
});
