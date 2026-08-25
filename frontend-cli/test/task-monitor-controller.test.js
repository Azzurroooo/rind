import test from "node:test";
import assert from "node:assert/strict";

import { createTaskMonitorController } from "../lib/task-monitor-controller.js";

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

  controller.recordCommand({
    tool_name: "bash",
    tool_call_id: "call-1",
    args_preview: '{"command":"sleep 1 &"}',
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

  controller.recordCommand({ tool_name: "edit", tool_call_id: "call-2", args_preview: "not json" });
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
