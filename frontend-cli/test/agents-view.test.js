import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, navigationRows, memberRows, renderAgents } from "../lib/agents-view.js";
import { createLineEditor } from "../lib/line-editor.js";
import { textWidth, stripAnsi } from "../lib/text-width.js";
import { CURSOR_MARKER } from "../lib/tui/frame.js";
import { createChoiceMenuState } from "../lib/choice-menu-state.js";

function fixture() {
  const snapshot = emptyAgentsSnapshot();
  snapshot.teams.push({ id: "team", name: "产品开发", leaderAgentId: "lead", createRoot: "C:/projects/worktrees" });
  for (let i = 0; i < 20; i++) {
    const id = i === 0 ? "lead" : "member-" + i;
    snapshot.agents.push({ id, name: i === 0 ? "Lead" : "工程师 " + i, canonicalWorkspace: "C:/projects/feature-" + i });
    snapshot.memberships.push({ teamId: "team", agentId: id, status: i === 4 ? "Needs input" : i === 7 ? "Unconfirmed" : i % 3 === 0 ? "Working" : "Ready", responsibility: "实现功能、运行测试并汇总证据。" });
  }
  return { snapshot, nav: navigationRows(snapshot), entries: memberRows(snapshot, "team", "members"), navId: "team", selectedId: "member-7", teamId: "team", focus: "list", tab: "members", query: "", filter: "All", searchEditor: createLineEditor(), connection: "connected" };
}
test("agents layout preserves selection, status and controls at narrow and wide terminal sizes", () => {
  const view = fixture();
  for (const [width, rows] of [[36, 14], [60, 20], [80, 24], [120, 30], [160, 40]]) {
    const rendered = renderAgents(view, width, rows);
    assert.ok(rendered.length <= rows - 1);
    assert.ok(rendered.every(line => textWidth(line) <= width), rendered.join("\n"));
    const text = stripAnsi(rendered.join("\n"));
    assert.match(text, /工程师 7/);
    assert.match(text, /Unconfirmed/);
    assert.match(text, /Space actions/);
    if (width >= 96) { assert.match(text, /Manager/); assert.match(text, /Teams/); }
  }
});
test("form uses the shared editor cursor, wraps CJK and keeps the active field visible", () => {
  const view = fixture();
  view.dialog = { kind: "form", title: "Member responsibility", index: 2, fields: [
    { label: "Workspace", editor: createLineEditor("C:/projects/project-name") },
    { label: "Position", editor: createLineEditor("Reviewer") },
    { label: "Responsibility", editor: createLineEditor("核对发票 🚀 ".repeat(20)) },
  ] };
  for (const [width, height] of [[36, 14], [80, 24], [120, 30]]) {
    const lines = renderAgents(view, width, height);
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1);
    assert.ok(lines.every(line => textWidth(line.replace(CURSOR_MARKER, "")) <= width));
    assert.match(stripAnsi(lines.join("\n")), /Esc cancel/);
  }
});
test("choices retain visible selection and delivery text cannot emit terminal control sequences", () => {
  const view = fixture();
  view.dialog = { kind: "choice", title: "Actions", items: Array.from({ length: 15 }, (_, i) => ({ label: "Action " + i, description: "Description " + i })), selection: createChoiceMenuState(Array.from({ length: 15 }, (_, i) => "Action " + i), "Action 14") };
  view.dialog.description = ["A very long workspace path ".repeat(30)];
  assert.match(stripAnsi(renderAgents(view, 40, 16).join("\n")), /Action 14/);
  view.dialog = null;
  view.detail = { offset: 0, lines: ["Receipt", "\x1b[2Jsecret\x1b]52;c;bad\x07", "Result " + "很长的证据".repeat(30)] };
  const output = renderAgents(view, 40, 16).join("\n");
  assert.doesNotMatch(output, /\x1b\[2J|\x1b\]52|\[object Object\]/);
  assert.match(output, /Receipt/);
});

test("waiting for children does not request human attention and tiny terminals stay bounded", () => {
  const view = fixture();
  view.snapshot.tasks.push({ id: "parent", teamId: "team", assigneeAgentId: "lead", status: "blocked", blockedOn: { responder: "children", action: "Waiting" } });
  assert.match(stripAnsi(renderAgents(view, 120, 30).join("\n")), /0 need input/);
  for (const [width, rows] of [[20, 8], [4, 3], [32, 10]]) {
    const lines = renderAgents(view, width, rows);
    assert.ok(lines.length < rows);
    assert.ok(lines.every(line => textWidth(line) <= width));
  }
});
