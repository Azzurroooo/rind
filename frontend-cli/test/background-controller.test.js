import test from "node:test";
import assert from "node:assert/strict";

import { createBackgroundController } from "../lib/background-controller.js";

test("background controller merges task commands and results", () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: { background_count: 0 },
    inputActive: false,
  };
  const redraws = [];
  const controller = createBackgroundController({
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

test("background controller unwraps normalized tool data", () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: { background_count: 0 },
    inputActive: false,
  };
  const controller = createBackgroundController({
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

test("background controller ignores malformed events and handles monitor keys", async () => {
  const state = {
    runtimeClosing: false,
    sessionInfo: {},
    inputActive: false,
  };
  const controller = createBackgroundController({
    request: async (method) => method === "background.list" ? { tasks: [] } : {},
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
