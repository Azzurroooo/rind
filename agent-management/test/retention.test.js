import test from "node:test";
import assert from "node:assert/strict";
import { retain, RECEIPT_LIMIT, RECEIPT_MIN_AGE_MS, TASK_RUN_LIMIT } from "../dist/retention.js";
import { projectionIndex, sessionStatus, memberStatus } from "../dist/projection.js";
import { emptyState } from "../dist/model.js";

const at = minute => new Date(Date.UTC(2026, 9, 6, 0, minute)).toISOString();
const run = (id, sessionId, minute, extra = {}) => ({ id, sessionId, status: "succeeded", startedAt: at(minute), lastObservedAt: at(minute), hostSequence: 0, ...extra });

test("old receipts beyond the limit are pruned in request order, but recent ones survive any burst", () => {
  const now = Date.now();
  const burst = emptyState();
  for (let i = 0; i < RECEIPT_LIMIT + 20; i++) burst.receipts["user/m/" + i] = { input: "{}", result: i, at: now - 1000 };
  retain(burst, now);
  assert.equal(Object.keys(burst.receipts).length, RECEIPT_LIMIT + 20, "a retry within minutes stays idempotent");
  const state = emptyState();
  for (let i = 0; i < RECEIPT_LIMIT + 20; i++) state.receipts["user/m/" + i] = { input: "{}", result: i, at: i < 30 ? now - RECEIPT_MIN_AGE_MS - 1 : now };
  retain(state, now);
  const keys = Object.keys(state.receipts);
  assert.equal(keys.length, RECEIPT_LIMIT);
  assert.equal(keys[0], "user/m/20");
  assert.equal(keys.at(-1), "user/m/" + (RECEIPT_LIMIT + 19));
});

test("finished direct turns keep the latest per session; task runs keep their recent history; active runs stay", () => {
  const state = emptyState();
  for (let i = 0; i < 30; i++) state.runs["d" + i] = run("d" + i, "chat", i);
  for (let i = 0; i < TASK_RUN_LIMIT + 5; i++) state.runs["t" + i] = run("t" + i, "worker", i, { taskId: "task" });
  state.runs.live = run("live", "chat", 1, { status: "running" });
  state.runs.unknown = run("unknown", "worker", 0, { status: "unknown", taskId: "task" });
  retain(state);
  const ids = Object.keys(state.runs);
  assert.deepEqual(ids.filter(id => id.startsWith("d")), ["d29"]);
  assert.equal(ids.filter(id => id.startsWith("t")).length, TASK_RUN_LIMIT);
  assert.ok(ids.includes("t14") && !ids.includes("t0"));
  assert.ok(ids.includes("live") && ids.includes("unknown"));
});

test("indexed projections report the same statuses after pruning", () => {
  const state = emptyState();
  state.agents.a = { id: "a", name: "A", canonicalWorkspace: "/w/a", adapter: "rind" };
  state.sessions.s = { id: "s", agentId: "a", teamId: "t", runtimeSessionId: "r", origin: "direct" };
  for (let i = 0; i < 5; i++) state.runs["r" + i] = run("r" + i, "s", i);
  retain(state);
  const index = projectionIndex(state, new Set(["s"]));
  assert.deepEqual(sessionStatus(index, "s"), { status: "Ready", lastActivity: at(4) });
  assert.equal(memberStatus(index, "a", "t"), "Ready");
  state.runs.x = run("x", "s", 9, { status: "running", needsInput: true });
  assert.equal(memberStatus(projectionIndex(state, new Set()), "a", "t"), "Needs input");
});
