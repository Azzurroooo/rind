import test from "node:test";
import assert from "node:assert/strict";
import { retain, RECEIPT_LIMIT, RECEIPT_MIN_AGE_MS, TASK_RUN_LIMIT, DELEGATION_LIMIT, COMPLETED_TASK_LIMIT } from "../dist/retention.js";
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
  assert.deepEqual(sessionStatus(index, "s"), { status: "Open", lastActivity: at(4) });
  assert.equal(memberStatus(index, "a", "t"), "Open");
  state.runs.x = run("x", "s", 9, { status: "running", needsInput: true });
  assert.equal(memberStatus(projectionIndex(state, new Set()), "a", "t"), "Needs input");
});

test("shared conversations take their state from the Runtime: open only while a window shows them", () => {
  const state = emptyState();
  state.agents.a = { id: "a", name: "A", canonicalWorkspace: "/w/a", adapter: "rind" };
  state.sessions.s = { id: "s", agentId: "a", teamId: "t", runtimeSessionId: "r", origin: "direct", shared: true };
  const connected = new Set(["s"]);
  const live = (turn, watchers) => new Map([["r", { id: "r", workspace: "/w/a", turn, startedAt: "", updatedAt: at(5), watchers }]]);
  assert.equal(sessionStatus(projectionIndex(state, connected, live("idle", 0)), "s").status, "Idle", "a hosted session nobody shows is idle");
  assert.equal(sessionStatus(projectionIndex(state, connected, live("idle", 2)), "s").watchers, 2);
  assert.equal(sessionStatus(projectionIndex(state, connected, live("running", 0)), "s").status, "Working", "a turn keeps running after its window closes");
  assert.equal(memberStatus(projectionIndex(state, connected, live("question", 0)), "a", "t"), "Needs input");
  assert.equal(memberStatus(projectionIndex(state, connected, live("idle", 1)), "a", "t"), "Open");
  assert.equal(memberStatus(projectionIndex(state, connected), "a", "t"), "Idle", "without a Runtime report a shared session is not assumed open");
});

test("orphaned managed sessions without runs, delegations, or pending deliveries are pruned while direct and active managed sessions stay", () => {
  const state = emptyState();
  state.sessions.direct = { id: "direct", agentId: "a", teamId: "t", runtimeSessionId: "r-direct", origin: "direct" };
  state.sessions.orphan = { id: "orphan", agentId: "a", teamId: "t", runtimeSessionId: "r-orphan", origin: "managed", delegationId: "gone" };
  state.sessions.withRun = { id: "withRun", agentId: "a", teamId: "t", runtimeSessionId: "r-run", origin: "managed" };
  state.sessions.withDelegation = { id: "withDelegation", agentId: "a", teamId: "t", runtimeSessionId: "r-del", origin: "managed", delegationId: "d1" };
  state.delegations.d1 = { id: "d1", teamId: "t", fromAgentId: "lead", assigneeAgentId: "a", originSessionId: "direct", brief: "Work", status: "done" };
  state.runs.r1 = run("r1", "withRun", 1, { taskId: "task-1" });
  retain(state);
  assert.equal(state.sessions.orphan, undefined);
  assert.ok(state.sessions.direct);
  assert.ok(state.sessions.withRun);
  assert.ok(state.sessions.withDelegation);
});

test("retain handles parent/child delegation protection, active run protection, and cascading cleanup", () => {
  const state = emptyState();
  state.teams.t1 = { id: "t1", name: "Team", createRoot: "/w", leaderAgentId: "lead" };

  // Completed tasks beyond limit, plus one pinned by an active run and one pinned by a surviving delegation.
  for (let i = 0; i < COMPLETED_TASK_LIMIT + 5; i++) {
    const id = "task_" + i;
    state.tasks[id] = { id, teamId: "t1", assigneeAgentId: "lead", createdBy: "user", brief: "b", status: "done" };
    state.notes["note_" + id] = { id: "note_" + id, taskId: id, author: "user", text: "n", createdAt: at(0) };
    state.artifacts["art_" + id] = { id: "art_" + id, taskId: id, teamId: "t1", recipient: "user", name: "f", path: "/f", size: 1, sha256: "0", createdAt: at(0) };
    state.runs["run_" + id] = run("run_" + id, "sess_" + id, i, { taskId: id });
  }
  state.runs.run_task_0.status = "running"; // Pins task_0 even though it is oldest.
  state.delegations.pin_task_1 = { id: "pin_task_1", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "w", status: "queued", taskId: "task_1" };

  // Delegations beyond limit: parent_first appears before child_first; child_first is dropped first so parent_first cannot drop until next pass.
  // Also create child_before_parent where child is older and drops, decrementing parent's child count so parent can also drop in the same pass.
  state.delegations.child_before_parent = { id: "child_before_parent", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "c", status: "completed", returned: true, parentDelegationId: "parent_later" };
  state.delegations.parent_later = { id: "parent_later", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "p", status: "completed", returned: true };
  state.delegations.parent_first = { id: "parent_first", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "pf", status: "completed", returned: true };
  state.delegations.active_del = { id: "active_del", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "a", status: "completed", returned: true };
  state.runs.run_active_del = run("run_active_del", "sess_del", 1, { status: "running", delegationId: "active_del" });
  for (let i = 0; i < DELEGATION_LIMIT + 5; i++) {
    state.delegations["d_" + i] = { id: "d_" + i, teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "w", status: "completed", returned: true };
    state.runs["rd_" + i] = run("rd_" + i, "sd_" + i, i, { delegationId: "d_" + i });
  }
  state.delegations.child_of_parent_first = { id: "child_of_parent_first", teamId: "t1", fromAgentId: "lead", assigneeAgentId: "sub", brief: "cf", status: "queued", parentDelegationId: "parent_first" };

  retain(state);

  // task_0 (active run) and task_1 (surviving delegation) stay; oldest unpinned tasks (task_2..task_6) and their notes/artifacts/runs drop.
  assert.ok(state.tasks.task_0 && state.notes.note_task_0 && state.artifacts.art_task_0 && state.runs.run_task_0);
  assert.ok(state.tasks.task_1 && state.notes.note_task_1 && state.artifacts.art_task_1 && state.runs.run_task_1);
  for (let i = 2; i <= 6; i++) {
    assert.equal(state.tasks["task_" + i], undefined);
    assert.equal(state.notes["note_task_" + i], undefined);
    assert.equal(state.artifacts["art_task_" + i], undefined);
    assert.equal(state.runs["run_task_" + i], undefined);
  }
  assert.ok(state.tasks.task_7);

  // Delegation retention checks:
  assert.equal(state.delegations.child_before_parent, undefined);
  assert.equal(state.delegations.parent_later, undefined);
  assert.ok(state.delegations.parent_first, "parent_first is protected while child_of_parent_first exists");
  assert.ok(state.delegations.active_del, "active_del is protected by active run");
  assert.equal(state.delegations.d_0, undefined);
  assert.equal(state.runs.rd_0, undefined);
});

