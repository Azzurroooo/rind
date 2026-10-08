// Background › Running now lists running conversations: Enter joins one, Space
// offers its task report and stopping its task.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot } from "../lib/agents-model.js";
import { createActions } from "../lib/agents-actions.js";
import { available } from "../lib/agents-keys.js";

test("a running conversation offers join, its task report and stopping the task", async () => {
  const snapshot = emptyAgentsSnapshot();
  snapshot.tasks.push({ id: "t1", teamId: "team", assigneeAgentId: "api", brief: "Migrate schema", status: "running" });
  const dialogs = [], requests = [], joined = [];
  const ui = { view: { snapshot }, choose: (title, items, options) => dialogs.push({ title, items, options }), join: row => joined.push(row.sessionId),
    confirm: (title, description, label, action) => action(), request: async (method, params) => requests.push([method, params]), notify() {} };
  const row = { kind: "live", title: "API", context: "Product", note: "Task: Migrate schema", taskId: "t1", runId: "w1", sessionId: "r-task", agentId: "api", teamId: "team" };
  assert.deepEqual(available({ focus: "main", page: { kind: "background" } }, row).slice(0, 2).map(a => a.label), ["join", "more actions"]);

  createActions(ui).liveActions(row);
  const [menu] = dialogs;
  assert.deepEqual(menu.items.map(item => item.label), ["Join conversation", "Task report", "Stop this task"]);
  assert.deepEqual(menu.options.description, ["Product · Task: Migrate schema"]);
  menu.items[0].action();
  assert.deepEqual(joined, ["r-task"]);
  await menu.items[2].action();
  assert.deepEqual(requests, [["cancelRun", { runId: "w1" }]]);

  createActions(ui).liveActions({ ...row, taskId: undefined, runId: undefined, note: "Conversation" });
  assert.deepEqual(dialogs[1].items.map(item => item.label), ["Join conversation"], "a plain conversation has no task to stop");
});
