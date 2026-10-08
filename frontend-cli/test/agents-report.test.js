import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, inboxRows, sidebarRows, archiveRows } from "../lib/agents-model.js";
import { renderReport, briefTitle, mayFoldBrief } from "../lib/agents-report.js";
import { actionFor, available } from "../lib/agents-keys.js";
import { textWidth } from "../lib/text-width.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const strip = value => value.replace(/\x1b\[[0-9;]*m/g, "");
const done = (id, extra = {}) => ({ id, teamId: "team", assigneeAgentId: "lead", brief: "Task " + id, status: "done", createdBy: "user", deliveredAt: "2026-10-06T11:0" + id.length + ":00Z",
  report: { outcome: "completed", summary: "Summary " + id, evidence: [], artifacts: [] }, ...extra });

function snapshot() {
  const s = emptyAgentsSnapshot();
  s.teams.push({ id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" });
  s.agents.push({ id: "lead", name: "Lead", canonicalWorkspace: "/w/lead" });
  s.memberships.push({ teamId: "team", agentId: "lead", status: "Idle" });
  return s;
}

test("the Inbox puts Manager approvals first and marks deliveries not reviewed yet", () => {
  const s = snapshot();
  s.approvals.push({ id: "p", kind: "deleteTeam", teamId: "team", title: "Delete team Product", requestedBy: "manager", createdAt: "2026-10-06T11:00:00Z" });
  s.tasks.push(done("a", { review: { decision: "accepted", at: "x" } }), done("bb"), done("ccc", { review: { decision: "rework", at: "x", feedback: "more" } }));
  const rows = inboxRows(s);
  assert.equal(rows[1].kind, "approval");
  assert.equal(rows[1].title, "Approve: Delete team Product");
  const delivered = rows.filter(row => row.id.startsWith("d:"));
  assert.deepEqual(delivered.map(row => [row.taskId, Boolean(row.fresh), Boolean(row.reworked)]), [["bb", true, false], ["ccc", false, true], ["a", false, false]], "new deliveries first, then the newest reviewed");
  assert.match(rows.find(row => row.id === "section:delivered").title, /1 new/);
  s.tasks.push(done("dddd", { createdBy: "lead", parentTaskId: "bb" }), done("eeeee", { deliveredAt: undefined }));
  assert.deepEqual(inboxRows(s).filter(row => row.fresh).map(row => row.taskId), ["bb"], "delegated work and deliveries from before reviews are not new");
  assert.equal(sidebarRows(s)[0].badge, 1, "an approval needs the user");
  assert.equal(available({ focus: "main", page: { kind: "inbox" } }, rows[1])[0].label, "decide");
});

test("deleted teams appear under Archive, read-only", () => {
  const s = snapshot();
  assert.ok(!sidebarRows(s).some(row => row.kind === "archive"), "no Archive until a team is deleted");
  s.archivedTeams.push({ id: "old", name: "Old", archivedAt: "2026-10-04T12:00:00Z" });
  assert.equal(sidebarRows(s).at(-1).kind, "archive");
  const rows = archiveRows({ teams: [{ id: "old", name: "Old", archive: { at: "2026-10-04T12:00:00Z", members: { lead: "Lead" } }, tasks: [done("a", { teamId: "old" })] }] });
  assert.match(rows[0].title, /Old · deleted/);
  assert.deepEqual([rows[1].owner, rows[1].archived], ["Lead", true]);
  const view = { focus: "main", page: { kind: "archive" } };
  assert.equal(available(view, rows[1])[0].label, "open report");
  assert.equal(actionFor(view, rows[1], { text: " " }), undefined, "archived work has no actions");
});

test("a report aligns its blocks, says what needs deciding and folds its history", () => {
  const task = { ...done("a"), priority: "high", notes: [{ id: "n", author: "lead", text: "Started", createdAt: "2026-10-06T10:00:00Z" }],
    report: { outcome: "completed", summary: "Shipped the new login page with a much longer summary that has to wrap onto a second line", evidence: ["unit tests pass", "screenshot attached"], artifacts: ["f"], nextAction: "Announce it" } };
  const report = { task, team: "Product", owner: "Lead", artifacts: [{ name: "login.png", path: "/a/login.png" }], runs: [{ startedAt: "2026-10-06T10:00:00Z", status: "succeeded" }], subtasks: [], archived: false, decide: "a accept · b send back for rework", name: id => id === "lead" ? "Lead" : id };
  const lines = renderReport(report, 60, { now: NOW }).map(strip);
  assert.match(lines[0], /✓ Done · Product › Lead · delivered 59m ago · high priority/);
  assert.match(lines.join("\n"), /New delivery · a accept · b send back for rework/);
  const at = label => lines.findIndex(line => line.startsWith(label));
  for (const label of ["Outcome", "Summary", "Evidence", "Files", "Next"]) assert.ok(at(label) > 0, label);
  assert.match(lines[at("Summary") + 1], /^ {10}\S/, "wrapped lines hang under the value");
  assert.match(lines[at("Evidence") + 1], /^ {10}• screenshot attached/);
  assert.ok(lines.every(line => textWidth(line) <= 60));
  assert.match(lines.at(-1), /▸ History · Notes 1 · Runs 1 {3}z to show/);
  assert.doesNotMatch(lines.join("\n"), /Started/);
  assert.match(renderReport(report, 60, { now: NOW, expanded: true }).map(strip).join("\n"), /Lead: Started/);

  const accepted = renderReport({ ...report, task: { ...task, review: { decision: "accepted", at: "2026-10-06T11:30:00Z" } } }, 60, { now: NOW }).map(strip);
  assert.match(accepted.join("\n"), /✓ Accepted 30m ago/);
  assert.doesNotMatch(accepted.join("\n"), /a accept/);
  const archived = renderReport({ ...report, archived: true }, 60, { now: NOW }).map(strip).join("\n");
  assert.match(archived, /Product was deleted. This report is kept read-only./);
  const rework = renderReport({ ...report, task: { ...task, review: { decision: "rework", at: "2026-10-06T11:00:00Z", feedback: "Add the dark theme" } } }, 60, { now: NOW }).map(strip).join("\n");
  assert.match(rework, /↺ Sent back for rework 1h ago\nFeedback {2}Add the dark theme/);
});

test("report keys accept a delivery or send it back with feedback", async () => {
  const { createReviewActions } = await import("../lib/agents-review.js");
  const s = snapshot();
  const task = { ...done("a"), notes: [] };
  s.tasks.push(task);
  const calls = [];
  let shown, form;
  const ui = {
    view: { snapshot: s },
    request: async (method, params) => { calls.push([method, params]); return method === "getTask" ? task : {}; },
    showReport: (title, detail) => { shown = detail; },
    run: action => action(), notify: () => {},
    form: (title, fields, submit) => { form = { fields, submit }; },
  };
  const review = createReviewActions(ui, { agentName: () => "Lead", display: id => (id === "lead" ? "Lead" : id), teamOf: () => s.teams[0], assignTask() {}, taskActions() {}, answer() {} });
  await review.delivery("a");
  assert.deepEqual(shown.actions.map(action => action.key), ["a", "b", "n", "o", "space", "r"]);
  await shown.actions.find(action => action.key === "a").run(shown);
  assert.deepEqual(calls.find(([method]) => method === "reviewTask"), ["reviewTask", { taskId: "a", decision: "accept" }]);
  shown.actions.find(action => action.key === "b").run(shown);
  assert.match(form.fields[0].hint, /Lead gets a new task with this feedback/);
  await form.submit({ feedback: "Add screenshots" });
  assert.deepEqual(calls.at(-1), ["reviewTask", { taskId: "a", decision: "rework", feedback: "Add screenshots" }]);

  await review.delivery("a");
  s.archivedTeams.push({ id: "team", name: "Product", archivedAt: "x" });
  await review.delivery("a");
  assert.deepEqual(shown.actions.map(action => action.key), ["r"], "archived reports are read-only");

  s.archivedTeams.length = 0;
  s.memberships.length = 0;
  await review.delivery("a");
  assert.deepEqual(shown.actions.map(action => action.key), ["a", "n", "space", "r"], "no rework once the owner left the team");
});

test("Stop all names jobs that will stop, and a running job is explained in words", async () => {
  const { createActions } = await import("../lib/agents-actions.js");
  const { detailLines } = await import("../lib/agents-detail.js");
  let dialog;
  const ui = { view: { snapshot: snapshot() }, choose: (title, items, options) => { dialog = { title, items, ...options }; } };
  const actions = createActions(ui);
  actions.stopAll([{ kind: "live", status: "Running job", title: "notes", context: "Independent", note: "Conversation · npm test" }]);
  assert.equal(dialog.title, "Stop all agents?");
  assert.match(dialog.description.join("\n"), /• notes · Independent — Conversation · npm test/);
  assert.match(dialog.description.join("\n"), /Jobs they started are stopped too/);

  const s = snapshot();
  s.live = [{ id: "r", turn: "idle", watchers: 0, background: { count: 3, commands: ["npm test", "cargo build"], startedAt: "x" } }];
  const lines = detailLines({ snapshot: s }, { kind: "live", title: "notes", context: "Independent", note: "Conversation · npm test", status: "Running job", sessionId: "r", time: "2m" }, 46).map(strip).join("\n");
  assert.match(lines, /Job {6}npm test \+2 · continues by itself/);
});

test("a long brief reads in full under Task, folds past six lines, and titles the page with its first line", () => {
  const brief = "Write the launch notes for v2\n" + "Cover every change in the changelog and link each one to its pull request. ".repeat(8) + "\nThen post a summary.";
  const task = { ...done("a"), brief, notes: [] };
  const report = { task, team: "Product", owner: "Lead", artifacts: [], runs: [], subtasks: [], archived: false, decide: "", name: id => id };
  assert.equal(briefTitle(brief), "Write the launch notes for v2");
  assert.equal(mayFoldBrief(brief), true);
  assert.equal(mayFoldBrief("Fix the typo"), false);
  const folded = renderReport(report, 60, { now: NOW }).map(strip);
  const at = folded.findIndex(line => line.startsWith("Task"));
  assert.equal(at, 2, "the brief comes right after the status line");
  assert.match(folded[at], /^Task {6}Write the launch notes for v2/);
  assert.match(folded[at + 6], /^ {10}▸ \d+ more lines · z to show/);
  assert.ok(folded.every(line => textWidth(line) <= 60), "every line wraps within the width");
  const full = renderReport(report, 60, { now: NOW, expanded: true }).map(strip).join("\n");
  assert.match(full, /Then post a summary\./);
  assert.doesNotMatch(full, /more lines/);
});
