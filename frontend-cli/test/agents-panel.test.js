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
    { kind: "workspace", title: "solo", workspace: "/w/solo", agentId: "solo", sessionCount: 2, working: 1 },
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
  assert.match(member, /^Lead\nLeader · Builder\nreports to you\n\n● Working/);
  assert.match(member, /! Needs your answer · Pick the release date/, "what needs doing is the callout");
  assert.doesNotMatch(member, /Enter /, "keys are the footer's job");

  s.agents.push({ id: "be", name: "be-api", canonicalWorkspace: "/w/be" });
  s.memberships.push({ teamId: "team", agentId: "be", reportsToAgentId: "lead", status: "Idle", position: "Sub-agent | Backend/API" });
  view.folderDefaults["/w/be"] = { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "high", model_source: "folder", effort_source: "folder", connection_ready: true };
  const sub = plain(detailLines(view, { kind: "member", teamId: "team", agentId: "be", title: "be-api", status: "Idle" }, 36)).join("\n");
  assert.match(sub, /^be-api\nSub-agent \| Backend\/API\nreports to Lead\n\n· Idle/);
  assert.match(sub, /Runs on {2}deepseek \/ deepseek-flash ·\n {9}high\n {9}this folder/);
  assert.doesNotMatch(sub, /high …/);
});

test("task detail panel renders structured Delivery, Evidence, Files and Next with ANSI styling in unreviewed, accepted, rework and archived states", () => {
  const s = emptyAgentsSnapshot();
  s.teams.push({ id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" });
  s.agents.push({ id: "lead", name: "Lead", canonicalWorkspace: "/w/lead" });
  s.artifacts.push({ id: "art-1", taskId: "t1", name: "report.md", size: 2048 });
  const baseTask = {
    id: "t1", teamId: "team", assigneeAgentId: "lead", createdBy: "user",
    brief: "Deliver the one-page summary", status: "done", deliveredAt: "2026-10-06T11:00:00Z",
    report: {
      outcome: "completed",
      summary: "1) Built `report.md` with **clean** sections\n2) Verified all links",
      evidence: ["`npm test` passed", "Manual check ok"],
      artifacts: ["art-1"],
      nextAction: "Share with the team",
    },
  };
  const states = [
    { task: { ...baseTask }, row: { kind: "task", taskId: "t1", owner: "Lead", status: "Done" }, callout: /● New delivery · open it to accept or send\s+back/ },
    { task: { ...baseTask, review: { decision: "accepted", at: "2026-10-06T11:10:00Z" } }, row: { kind: "task", taskId: "t1", owner: "Lead", status: "Done" }, callout: /✓ Accepted/ },
    { task: { ...baseTask, review: { decision: "rework", at: "2026-10-06T11:10:00Z", feedback: "Add metrics" } }, row: { kind: "task", taskId: "t1", owner: "Lead", status: "Done" }, callout: /↺ Sent back for rework · Add metrics/ },
    { task: { ...baseTask, review: { decision: "accepted", at: "2026-10-06T11:10:00Z" } }, row: { kind: "task", taskId: "t1", owner: "Lead", status: "Done", archived: true }, callout: null },
  ];
  const prevTty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    for (const { task, row, callout } of states) {
      s.tasks = row.archived ? [] : [task];
      const archive = row.archived ? { teams: [{ id: "team", name: "Product", tasks: [task] }] } : undefined;
      const raw = detailLines({ snapshot: s, archive }, row, 46, 28);
      const text = plain(raw).join("\n");
      if (callout) assert.match(text, callout);
      assert.match(text, /Delivery {1}Completed\n {9}1\) Built report\.md with clean/);
      assert.match(text, /Evidence {1}• npm test passed\n {9}• Manual check ok/);
      assert.match(text, /Files {4}report\.md {2}2\.0 KiB/);
      assert.match(text, /Next {5}Share with the team/);
      // Ensure SGR colors inside facts are preserved by renderPanel.
      const deliveryLine = raw.find(line => stripAnsi(line).startsWith("Delivery "));
      assert.ok(/\x1b\[[0-9;]*mCompleted/.test(deliveryLine), "Outcome keeps its SGR styling in the panel");
    }

    // Even on a short terminal (height 10), the first fact (Delivery) is clamped to fit rather than dropped.
    s.tasks = [{ ...baseTask, review: { decision: "accepted", at: "2026-10-06T11:10:00Z" } }];
    const shortLines = plain(detailLines({ snapshot: s }, { kind: "task", taskId: "t1", owner: "Lead", status: "Done" }, 46, 10)).join("\n");
    assert.match(shortLines, /✓ Accepted/);
    assert.match(shortLines, /Delivery {1}Completed/);
  } finally {
    process.stdout.isTTY = prevTty;
  }
});
