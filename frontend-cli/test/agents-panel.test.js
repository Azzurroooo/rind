import test from "node:test";
import assert from "node:assert/strict";
import { renderPanel } from "../lib/agents-panel.js";
import { detailLines } from "../lib/agents-detail.js";
import { emptyAgentsSnapshot } from "../lib/agents-model.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

const plain = lines => lines.map(stripAnsi);
const PANEL = {
  title: "Write the launch notes for the v2 release and link every change", context: "Product › Lead · Builder",
  state: "● Working · 2m", callout: { text: "! deepseek is not configured · /login" },
  facts: [
    { label: "Runs on", value: ["deepseek / deepseek-flash · high", "folder default"] },
    { label: "Task", value: "Cover every change in the changelog and link each one to its pull request, then post a summary.", lines: 3 },
    { label: "Job", value: "" },
    { label: "Session", value: "20261008_abc" },
  ],
};

test("a panel draws title, context, state, callout and facts in that order, one blank line apart", () => {
  const lines = plain(renderPanel(PANEL, 46));
  assert.deepEqual(lines.slice(0, 7), [
    "Write the launch notes for the v2 release and",
    "link every change",
    "Product › Lead · Builder",
    "",
    "● Working · 2m",
    "",
    "! deepseek is not configured · /login",
  ]);
  const runs = lines.indexOf("Runs on  deepseek / deepseek-flash · high");
  assert.equal(lines[runs - 1], "", "facts start after one blank line");
  assert.equal(lines[runs + 1], " ".repeat(9) + "folder default", "a value's lines hang under it");
  assert.match(lines[runs + 2], /^Task {5}Cover every change/);
  assert.ok(!lines.some(line => line.startsWith("Job")), "an empty fact is left out");
  assert.ok(lines.every(line => textWidth(line) <= 46));
});

test("a long value keeps to its lines and a narrow panel puts labels above values", () => {
  const narrow = plain(renderPanel(PANEL, 28));
  const task = narrow.indexOf("Task");
  assert.ok(task > 0, "labels stack below 34 columns");
  assert.match(narrow[task + 1], /^ {2}Cover/);
  assert.match(narrow[task + 3], /…$/, "three lines at most, the last one cut");
  assert.notEqual(narrow[task + 4]?.startsWith("  "), true);
  assert.ok(narrow.every(line => textWidth(line) <= 28));
});

test("a short panel drops whole facts from the end instead of cutting one", () => {
  const lines = plain(renderPanel(PANEL, 46, 12));
  assert.ok(lines.length <= 12);
  assert.ok(lines.some(line => line.startsWith("Runs on")), "the most important fact stays");
  assert.ok(!lines.some(line => line.startsWith("Session")), "the least important goes first");
  assert.equal(lines.filter(line => line.startsWith("Task")).length, lines.some(line => line.startsWith("Task")) ? 1 : 0);
});

test("every kind of row draws inside the panel at 28 and 46 columns", () => {
  const s = emptyAgentsSnapshot();
  s.teams.push({ id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" });
  s.agents.push({ id: "lead", name: "Lead", canonicalWorkspace: "/w/lead" });
  s.memberships.push({ teamId: "team", agentId: "lead", status: "Working", position: "Builder", responsibility: "Owns release communication and the changelog." });
  s.tasks.push({ id: "t", teamId: "team", assigneeAgentId: "lead", brief: "Ship it ".repeat(20), status: "blocked", blockedOn: { responder: "user", action: "Pick the release date" }, report: { outcome: "partial", summary: "Most of it" } });
  const view = { snapshot: s, page: { kind: "team" }, folderDefaults: { "/w/lead": { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "high", model_source: "folder", effort_source: "settings", connection_ready: true } } };
  const rows = [
    { kind: "member", teamId: "team", agentId: "lead", title: "Lead", status: "Working", leader: true, sessionCount: 2 },
    { kind: "session", teamId: "team", agentId: "lead", sessionId: "r1", title: "Plan the release", status: "Needs input", time: "2m", taskId: "t" },
    { kind: "task", taskId: "t", owner: "Lead", status: "Needs input" },
    { kind: "workspace", title: "lead", workspace: "/w/lead", agentId: "lead", teams: ["Product"], sessionCount: 2, working: 1 },
    { kind: "live", title: "Lead", context: "Product", note: "Task: Ship it", taskId: "t", sessionId: "r1", status: "Working", time: "5m" },
    { kind: "team", teamId: "team", title: "Product", summary: { members: 1, working: 1, needs: 1, queued: 0, delivered: 2 } },
    { kind: "service", id: "svc:runtime", title: "Shared Runtime", note: "pid 8 · up 3h", stale: true },
    { kind: "stop-all", title: "Stop all agents…", working: 1 },
  ];
  for (const row of rows) for (const width of [28, 46]) {
    const lines = detailLines(view, row, width, 18);
    assert.ok(lines.length > 1 && lines.length <= 18, row.kind + " at " + width);
    assert.ok(lines.every(line => textWidth(line) <= width), row.kind + " fits " + width);
  }
  const member = plain(detailLines(view, rows[0], 46)).join("\n");
  assert.match(member, /^Lead\nLeader · Builder · reports to you\n\n● Working/);
  assert.match(member, /! Needs your answer · Pick the release date/, "what needs doing is the callout");
  assert.doesNotMatch(member, /Enter /, "keys are the footer's job");
});
