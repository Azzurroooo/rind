import test from "node:test";
import assert from "node:assert/strict";

import { createTaskMonitorController } from "../lib/task-monitor-controller.js";

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("task events preserve input and use release/cancel without model polling", async () => {
  const calls = [];
  let released = false;
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: true, input: "中文 pending" };
  const controller = createTaskMonitorController({ terminalUi: true, state,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "rind/task/release_wait") { released = true; return { released }; }
      return method === "rind/task/list" ? { tasks: [{ task_id: "task_1", status: "running", handoff: released }] } : {};
    },
  });
  controller.recordTask({ type: "task_updated", session_id: "s1", task: { task_id: "task_1", status: "running", notify: "on_exit" } });
  assert.equal(state.input, "中文 pending");
  assert.equal(state.inputActive, true);
  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleInput({ text: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleInput({ text: "c" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some(([method]) => method === "rind/task/release_wait"));
  assert.ok(calls.some(([method]) => method === "rind/task/cancel"));
  controller.recordTask({ type: "task_updated", session_id: "s1", task: { task_id: "task_1", status: "completed" } });
  assert.equal(state.sessionInfo.background_count, 0);
  assert.equal(state.input, "中文 pending");
  controller.stop();
});

test("task monitor merges background commands and results", () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: { background_count: 0 },
    inputActive: false,
  };
  const redraws = [];
  const controller = createTaskMonitorController({
    request: async () => ({ tasks: [] }),
    terminalUi: true,
    state,
    redraw: (force) => redraws.push(Boolean(force)),
  });

  controller.recordResult({
    tool_call_id: "call-1",
    result: '{"bg_id":"bg-1","status":"running","output":""}',
  });

  assert.equal(state.sessionInfo.background_count, 1);
  assert.equal(redraws.length > 0, true);
  controller.clear();
  assert.equal(state.sessionInfo.background_count, 0);
  controller.stop();
});

test("task monitor unwraps normalized background data", () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: { background_count: 0 },
    inputActive: false,
  };
  const controller = createTaskMonitorController({
    request: async () => ({ tasks: [] }),
    terminalUi: true,
    state,
  });

  controller.recordResult({
    tool_call_id: "call-3",
    result: JSON.stringify({
      ok: true,
      tool: "bash",
      data: { bg_id: "bg-2", status: "running", output: "" },
    }),
  });

  assert.equal(state.sessionInfo.background_count, 1);
  controller.stop();
});

test("task monitor ignores malformed events and handles monitor keys", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  const controller = createTaskMonitorController({
    request: async (method) => method === "rind/background/list" ? { tasks: [] } : {},
    terminalUi: true,
    state,
  });

  controller.recordResult({ tool_call_id: "call-2", result: "not json" });
  await controller.refresh();
  assert.equal(controller.isMonitoring(), false);
  assert.equal(controller.handleInput({ name: "escape" }), true);
  controller.stop();
});

test("task monitor tracks delegate status and renders its page", () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  const redraws = [];
  const controller = createTaskMonitorController({
    request: async () => ({ tasks: [] }),
    terminalUi: true,
    state,
    redraw: (force) => redraws.push(Boolean(force)),
  });

  controller.recordDelegateRequest({
    tool_name: "delegate",
    tool_call_id: "delegate-1",
    args_preview: JSON.stringify({ agent_id: "weather-agent", task: "check the forecast" }),
  });
  assert.equal(state.sessionInfo.delegate_count, 1);
  assert.equal(redraws.at(-1), false);
  controller.recordDelegateResult({
    tool_name: "delegate",
    tool_call_id: "delegate-1",
    status: "completed",
    result: JSON.stringify({ data: { status: "completed", summary: "sunny" } }),
  });
  assert.equal(state.sessionInfo.delegate_count, 0);

  const frame = controller.frame(80);
  assert.match(frame.lines.join("\n"), /Delegates/);
  assert.match(frame.lines.join("\n"), /weather-agent/);
  assert.match(frame.lines.join("\n"), /sunny/);
  controller.clearDelegates();
  assert.doesNotMatch(controller.frame(80).lines.join("\n"), /weather-agent/);
  controller.stop();
});

test("task monitor switches pages with horizontal keys", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  const controller = createTaskMonitorController({
    request: async (method) => method === "rind/background/list"
      ? { tasks: [{ bg_id: "bg-1", status: "running", command: "server" }] }
      : {},
    terminalUi: true,
    state,
  });
  controller.recordDelegateRequest({
    tool_name: "delegate",
    tool_call_id: "delegate-2",
    args_preview: '{"agent_id":"builder-agent","task":"build it"}',
  });

  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines.join("\n"), /Background \[1\]/);
  assert.match(controller.frame(80).lines[0], /› Background \[1\]/);
  assert.match(controller.frame(80).lines[0], /Delegates \[1\]/);
  controller.handleInput({ name: "right", ctrl: false, alt: false, shift: false });
  assert.match(controller.frame(80).lines.join("\n"), /Delegates/);
  assert.match(controller.frame(80).lines[0], /› Delegates \[1\]/);
  controller.handleInput({ name: "left", ctrl: false, alt: false, shift: false });
  assert.match(controller.frame(80).lines.join("\n"), /Background \[1\]/);
  controller.stop();
});

test("task monitor keeps Delegates selected when Background appears during refresh", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  let listed = [];
  const controller = createTaskMonitorController({
    request: async () => ({ tasks: listed }),
    terminalUi: true,
    state,
  });
  controller.recordDelegateRequest({
    tool_name: "delegate",
    tool_call_id: "delegate-live",
    args_preview: '{"agent_id":"researcher","task":"inspect"}',
  });

  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  listed = [{ bg_id: "bg-1", status: "running", command: "server" }];
  await controller.refresh();

  assert.match(controller.frame(80).lines[0], /› Delegates/);
  controller.stop();
});

test("task monitor keeps Background selected when Delegates changes during refresh", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  let listed = [{ bg_id: "bg-1", status: "running", command: "server" }];
  const controller = createTaskMonitorController({
    request: async () => ({ tasks: listed }),
    terminalUi: true,
    state,
  });
  controller.recordDelegateRequest({
    tool_name: "delegate",
    tool_call_id: "delegate-live",
    args_preview: '{"agent_id":"researcher","task":"inspect"}',
  });

  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines[0], /› Background/);
  controller.clearDelegates();
  await controller.refresh();

  assert.match(controller.frame(80).lines[0], /› Background/);
  controller.stop();
});

test("task monitor ignores responses from a cleared session", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  let resolveList;
  const controller = createTaskMonitorController({
    request: async () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    terminalUi: true,
    state,
  });

  const pending = controller.refresh();
  controller.clear();
  resolveList({ tasks: [{ bg_id: "stale", status: "running" }] });
  await pending;

  assert.equal(state.sessionInfo.background_count, 0);
  controller.stop();
});

test("only handed-off tasks enter Background and completed results remain", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  let released = false;
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method) => {
      if (method === "rind/task/release_wait") { released = true; return { released }; }
      return method === "rind/task/list" ? { tasks: released ? [{ task_id: "front", status: "running", handoff: true }] : [] } : {};
    },
  });
  controller.recordTask({ session_id: "s1", task: { task_id: "front", command: "slow command", status: "running", handoff: false } });
  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines.join("\n"), /Background \[0\]/);
  assert.match(controller.frame(80).lines.join("\n"), /Waiting 1\/1.*r background.*slow command/);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.handleInput({ text: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines.join("\n"), /Background \[1\]/);
  assert.equal(state.sessionInfo.background_count, 1);
  controller.recordTask({ session_id: "s1", task: { task_id: "front", status: "completed", finished_at: 2, handoff: true } });
  assert.match(controller.frame(80).lines.join("\n"), /Background \[1\]/);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.recordTask({ session_id: "s1", task: { task_id: "quick", status: "completed", handoff: false } });
  assert.match(controller.frame(80).lines.join("\n"), /Background \[1\]/);
  controller.stop();
});

test("foreground selection releases only the chosen task", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  const releases = [];
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: releases.map((task_id) => ({ task_id, status: "running", handoff: true })) };
      if (method === "rind/task/release_wait") releases.push(params.task_id);
      return { released: true };
    },
  });
  for (let i = 1; i <= 3; i += 1) controller.recordTask({ session_id: "s1",
    task: { task_id: `front-${i}`, command: `command-${i}`, status: "running", started_at: i } });
  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines.join("\n"), /1\/3.*command-3/);
  controller.handleInput({ name: "down" });
  controller.handleInput({ text: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, ["front-2"]);
  assert.match(controller.frame(80).lines.join("\n"), /› front-2/);
  controller.stop();
});

test("paged list merges all tasks and reports incomplete pages", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  let fail = false;
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method, params) => {
      if (method !== "rind/task/list") return {};
      if (params.page_token && fail) throw new Error("page unavailable");
      const start = Number(params.page_token || 0);
      return { tasks: Array.from({ length: start ? 1 : 50 }, (_, i) => ({
        task_id: `task-${start + i}`, status: "completed", handoff: true, started_at: start + i,
      })), next_page_token: start ? null : "50" };
    },
  });
  await controller.refresh();
  assert.match(controller.frame(80).lines.join("\n"), /Background \[51\]/);
  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  fail = true;
  await controller.refresh();
  assert.match(controller.frame(80).lines.join("\n"), /Task list incomplete: page unavailable/);
  assert.match(controller.frame(80).lines.join("\n"), /Background \[51\]/);
  controller.stop();
});

test("selection stays on task ID across reorder and stale preview reads", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  const reads = [];
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [] };
      if (method === "rind/task/read") return new Promise((resolve) => reads.push({ id: params.task_id, resolve }));
      return {};
    },
  });
  for (let i = 1; i <= 2; i += 1) controller.recordTask({ session_id: "s1",
    task: { task_id: `task-${i}`, status: "running", handoff: true, started_at: i } });
  controller.enterMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads[0].id, "task-2");
  controller.handleInput({ name: "down" });
  controller.recordTask({ session_id: "s1", task: { task_id: "task-3", status: "running", handoff: true, started_at: 3 } });
  assert.match(controller.frame(80).lines.join("\n"), /› task-1/);
  reads[0].resolve({ task_id: "task-2", stdout: "stale text", status: "running", handoff: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads[1].id, "task-1");
  assert.doesNotMatch(controller.frame(80).lines.join("\n"), /stale text/);
  reads[1].resolve({ task_id: "task-1", stdout: "current text", status: "running", handoff: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.frame(80).lines.join("\n"), /current text/);
  controller.stop();
});

test("release waits for Runtime handoff confirmation and follows the same task", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] } };
  let confirm;
  let released = false;
  const reads = [];
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return released ? new Promise((resolve) => { confirm = resolve; }) : { tasks: [] };
      if (method === "rind/task/release_wait") { released = true; return { released: true }; }
      if (method === "rind/task/read") { reads.push(params.task_id); return { task_id: params.task_id, status: "completed", handoff: true, stdout: "released output" }; }
      return {};
    },
  });
  controller.recordTask({ task: { task_id: "front", status: "running", handoff: false } });
  controller.enterMonitor();
  await settled();
  controller.handleInput({ text: "r" });
  await settled();
  assert.equal(state.sessionInfo.background_count, 0);
  assert.match(controller.frame(80).lines.join("\n"), /Loading tasks/);
  assert.deepEqual(reads, []);
  confirm({ tasks: [{ task_id: "front", status: "completed", handoff: true }] });
  await settled();
  assert.match(controller.frame(80).lines.join("\n"), /› front/);
  assert.match(controller.frame(80).lines.join("\n"), /released output/);
  assert.deepEqual(reads, ["front"]);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.stop();
});

test("terminal events invalidate pending reads and reject late running output", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] } };
  const reads = [];
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method) => method === "rind/task/list" ? { tasks: [] }
      : new Promise((resolve) => reads.push(resolve)),
  });
  controller.recordTask({ task: { task_id: "bg", status: "running", handoff: true } });
  controller.enterMonitor();
  await settled();
  controller.recordTask({ type: "task_updated", task: { task_id: "bg", status: "completed", handoff: true } });
  assert.equal(reads.length, 1, "only one output request in flight");
  reads[0]({ task_id: "bg", status: "running", handoff: true, stdout: "stale" });
  await settled();
  assert.equal(reads.length, 2);
  reads[1]({ task_id: "bg", status: "completed", handoff: true, stdout: "finished" });
  await settled();
  controller.recordTask({ type: "task_output", task: { task_id: "bg", status: "running", handoff: true, stdout: "late stale" } });
  const text = controller.frame(80).lines.join("\n");
  assert.match(text, /completed/);
  assert.match(text, /finished/);
  assert.doesNotMatch(text, /stale/);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.exitMonitor();
  controller.recordTask({ type: "task_updated", task: { task_id: "other", status: "completed", handoff: true } });
  await settled();
  assert.equal(reads.length, 2, "closed monitor does not fetch previews");
  controller.stop();
});

test("session switch ignores a pending release and foreign events", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] } };
  let release;
  let lists = 0;
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method) => {
      if (method === "rind/task/list") { lists += 1; return { tasks: [] }; }
      return new Promise((resolve) => { release = resolve; });
    },
  });
  controller.recordTask({ session_id: "s1", task: { task_id: "front", status: "running" } });
  controller.enterMonitor();
  await settled();
  controller.handleInput({ text: "r" });
  controller.clear();
  state.sessionInfo = { session_id: "s2", capabilities: ["rind/tasks"] };
  release({ released: true });
  controller.recordTask({ session_id: "s1", task: { task_id: "foreign", status: "running", handoff: true } });
  await settled();
  assert.equal(lists, 1);
  assert.doesNotMatch(controller.frame(80).lines.join("\n"), /foreign|front/);
  controller.stop();
});

test("natural completion leaves no foreground row and automatic yield loads its preview", async () => {
  const state = { sessionInfo: { capabilities: ["rind/tasks"] } };
  const reads = [];
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [] };
      reads.push(params.task_id);
      return { task_id: params.task_id, status: "running", handoff: true, stdout: "auto yielded" };
    },
  });
  controller.recordTask({ task: { task_id: "quick", status: "running" } });
  controller.enterMonitor();
  await settled();
  controller.recordTask({ task: { task_id: "quick", status: "completed", handoff: false } });
  assert.doesNotMatch(controller.frame(80).lines.join("\n"), /quick|r background/);
  controller.recordTask({ task: { task_id: "slow", status: "running", handoff: true } });
  await settled();
  assert.deepEqual(reads, ["slow"]);
  assert.match(controller.frame(80).lines.join("\n"), /auto yielded/);
  controller.stop();
});

test("delegate selection survives insertion and detail matches the selected row", async () => {
  const state = { sessionInfo: { capabilities: ["rind/tasks"] } };
  const controller = createTaskMonitorController({ state, terminalUi: true, request: async () => ({ tasks: [] }) });
  for (let i = 0; i < 8; i += 1) controller.recordDelegateRequest({ tool_name: "delegate", tool_call_id: `d${i}`,
    args_preview: JSON.stringify({ agent_id: `worker-${i}`, task: `task-${i}` }) });
  controller.enterMonitor();
  await settled();
  controller.moveSelection(6);
  controller.recordDelegateRequest({ tool_name: "delegate", tool_call_id: "new", args_preview: '{"agent_id":"new"}' });
  assert.match(controller.frame(80).lines.join("\n"), /7\/9/);
  assert.match(controller.frame(80).lines.join("\n"), /› worker-6/);
  assert.match(controller.frame(80).lines.join("\n"), /task: task-6/);
  controller.stop();
});

test("a stale list cannot resurrect a synchronously completed command", async () => {
  const state = { sessionInfo: { capabilities: ["rind/tasks"] } };
  let finishList;
  const controller = createTaskMonitorController({ state, terminalUi: true,
    request: async () => new Promise((resolve) => { finishList = resolve; }),
  });
  const listing = controller.refresh();
  controller.recordTask({ task: { task_id: "quick", status: "completed", handoff: false } });
  finishList({ tasks: [{ task_id: "quick", status: "running", handoff: false }] });
  await listing;
  assert.doesNotMatch(controller.frame(80).lines.join("\n"), /quick|r background/);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.stop();
});
