import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../lib/text-width.js";
import { createTaskMonitorController } from "../lib/task-monitor-controller.js";

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("Ctrl+B opens monitor without implicit release; r promotes foreground task, c cancels background task, and completion evicts & auto-closes", async () => {
  const calls = [];
  let released = false;
  let status = "running";
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: true, input: "中文 pending" };
  const controller = createTaskMonitorController({
    terminalUi: true,
    state,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "rind/task/release_wait") {
        released = true;
        return { released: true };
      }
      if (method === "rind/task/cancel") {
        status = "cancelled";
        return { task_id: params.task_id, status, handoff: true };
      }
      if (method === "rind/task/list") {
        return {
          tasks: status === "running"
            ? [{ task_id: "task_1", command: "pytest -q", status, handoff: released, notify: "on_exit" }]
            : [],
        };
      }
      if (method === "rind/task/read") {
        return { task_id: params.task_id, command: "pytest -q", status, handoff: released, notify: "on_exit", stdout: "running tests" };
      }
      return {};
    },
  });

  // Opening Ctrl+B strictly opens monitor and lists foreground command without releasing it
  controller.enterMonitor();
  await settled();
  assert.equal(controller.isMonitoring(), true);
  assert.equal(calls.some(([method]) => method === "rind/task/release_wait"), false);
  assert.equal(state.sessionInfo.background_count, 0);
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /pytest -q.*foreground · r background/);
  assert.equal(state.input, "中文 pending");

  // Pressing c on a foreground command is ignored (Ctrl+C owns turn interruption)
  controller.handleInput({ text: "c" });
  await settled();
  assert.equal(calls.some(([method]) => method === "rind/task/cancel"), false);

  // Pressing r inside Ctrl+B promotes foreground wait to background
  controller.handleInput({ text: "r" });
  await settled();
  assert.ok(calls.some(([method]) => method === "rind/task/release_wait"));
  assert.equal(state.sessionInfo.background_count, 1);
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /Background \[1\]/);
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /pytest -q.*auto-resume/);

  // Pressing c stops the background task, evicts it immediately, and auto-closes the now-empty monitor
  controller.handleInput({ text: "c" });
  await settled();
  assert.ok(calls.some(([method]) => method === "rind/task/cancel"));
  assert.equal(state.sessionInfo.background_count, 0);
  assert.equal(controller.isMonitoring(), false);
  assert.equal(state.input, "中文 pending");
  controller.stop();
});

test("task monitor merges legacy background commands and results", () => {
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

test("completed and cancelled tasks are immediately evicted so dead tasks never accumulate", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  const live = new Map([
    ["bg-exit", { task_id: "bg-exit", command: "cargo test", status: "running", handoff: true, notify: "on_exit", started_at: 2 }],
    ["bg-svc", { task_id: "bg-svc", command: "npm run dev", status: "running", handoff: true, notify: "manual", started_at: 1 }],
  ]);
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [...live.values()] };
      if (method === "rind/task/read") return live.get(params.task_id) || {};
      return {};
    },
  });
  for (const t of live.values()) controller.recordTask({ session_id: "s1", task: t });
  assert.equal(state.sessionInfo.background_count, 2);

  controller.enterMonitor();
  await settled();
  const initialText = stripAnsi(controller.frame(90).lines.join("\n"));
  assert.match(initialText, /Background \[2\]/);
  assert.match(initialText, /cargo test.*auto-resume/);
  assert.match(initialText, /npm run dev.*service/);

  // Finish bg-exit: immediately evicted from list, bg-svc remains
  live.delete("bg-exit");
  controller.recordTask({ session_id: "s1", type: "task_updated", task: { task_id: "bg-exit", status: "completed", handoff: true } });
  await settled();
  assert.equal(state.sessionInfo.background_count, 1);
  assert.equal(controller.isMonitoring(), true);
  const afterFirst = stripAnsi(controller.frame(90).lines.join("\n"));
  assert.doesNotMatch(afterFirst, /cargo test/);
  assert.match(afterFirst, /› npm run dev.*service/);

  // Finish bg-svc: last active task gone -> monitor auto-closes
  live.delete("bg-svc");
  controller.recordTask({ session_id: "s1", type: "task_updated", task: { task_id: "bg-svc", status: "cancelled", handoff: true } });
  await settled();
  assert.equal(state.sessionInfo.background_count, 0);
  assert.equal(controller.isMonitoring(), false);
  controller.stop();
});

test("foreground selection releases only the chosen task and keeps selection on it", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  const releases = [];
  const items = new Map([
    ["front-1", { task_id: "front-1", command: "command-1", status: "running", handoff: false, started_at: 1 }],
    ["front-2", { task_id: "front-2", command: "command-2", status: "running", handoff: false, started_at: 2 }],
    ["front-3", { task_id: "front-3", command: "command-3", status: "running", handoff: false, started_at: 3 }],
  ]);
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [...items.values()] };
      if (method === "rind/task/release_wait") {
        releases.push(params.task_id);
        items.set(params.task_id, { ...items.get(params.task_id), handoff: true, notify: "on_exit" });
        return { released: true };
      }
      if (method === "rind/task/read") return { ...items.get(params.task_id), stdout: `out:${params.task_id}` };
      return {};
    },
  });
  controller.enterMonitor();
  await settled();
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /› command-3.*foreground/);
  controller.handleInput({ name: "down" });
  await settled();
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /› command-2.*foreground/);
  controller.handleInput({ text: "r" });
  await settled();
  assert.deepEqual(releases, ["front-2"]);
  assert.equal(state.sessionInfo.background_count, 1);
  const frameText = stripAnsi(controller.frame(80).lines.join("\n"));
  assert.match(frameText, /› command-2.*auto-resume/);
  assert.match(frameText, /out:front-2/);
  controller.stop();
});

test("arrow navigation crosses foreground waiting and handed-off background tasks in one unified list", async () => {
  const state = { sessionInfo: { capabilities: ["rind/tasks"] }, inputActive: false };
  const listed = [
    { task_id: "waiting-1", command: "wait one", status: "running", handoff: false, started_at: 2 },
    { task_id: "waiting-2", command: "wait two", status: "running", handoff: false, started_at: 1 },
    { task_id: "background-1", command: "background one", status: "running", handoff: true, notify: "on_exit", started_at: 3 },
  ];
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: listed };
      if (method === "rind/task/read") return listed.find((item) => item.task_id === params.task_id) || {};
      return {};
    },
  });
  controller.enterMonitor();
  await settled();
  assert.match(stripAnsi(controller.frame(100).lines.join("\n")), /› wait one.*foreground/);
  controller.handleInput({ name: "down" });
  assert.match(stripAnsi(controller.frame(100).lines.join("\n")), /› wait two.*foreground/);
  controller.handleInput({ name: "down" });
  assert.match(stripAnsi(controller.frame(100).lines.join("\n")), /› background one.*auto-resume/);
  controller.handleInput({ name: "down" });
  assert.match(stripAnsi(controller.frame(100).lines.join("\n")), /› wait one.*foreground/);
  controller.stop();
});

test("opening refresh does not reset a task selected with arrows", async () => {
  let finishList;
  const listed = [
    { task_id: "waiting", command: "wait cmd", status: "running", handoff: false },
    { task_id: "background", command: "bg cmd", status: "running", handoff: true },
  ];
  const state = { sessionInfo: { capabilities: ["rind/tasks"] } };
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return new Promise((resolve) => { finishList = resolve; });
      if (method === "rind/task/read") return listed.find((item) => item.task_id === params.task_id) || {};
      return {};
    },
  });
  for (const item of listed) controller.recordTask({ task: item });
  controller.enterMonitor();
  controller.handleInput({ name: "down" });
  finishList({ tasks: listed });
  await settled();
  assert.match(stripAnsi(controller.frame(100).lines.join("\n")), /› bg cmd/);
  controller.stop();
});

test("paged list merges active tasks and reports incomplete pages without pruning", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  let fail = false;
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method !== "rind/task/list") return {};
      if (params.page_token && fail) throw new Error("page unavailable");
      const start = Number(params.page_token || 0);
      return {
        tasks: Array.from({ length: start ? 1 : 50 }, (_, i) => ({
          task_id: `task-${start + i}`,
          command: `job-${start + i}`,
          status: "running",
          handoff: true,
          started_at: start + i,
        })),
        next_page_token: start ? null : "50",
      };
    },
  });
  await controller.refresh();
  assert.equal(state.sessionInfo.background_count, 51);
  controller.enterMonitor();
  await settled();
  fail = true;
  await controller.refresh();
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /Task list incomplete: page unavailable/);
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /Background \[51\]/);
  controller.stop();
});

test("selection stays on task ID across reorder and stale preview reads", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };
  const reads = [];
  const live = new Map([
    ["task-1", { task_id: "task-1", command: "cmd-1", status: "running", handoff: true, started_at: 1 }],
    ["task-2", { task_id: "task-2", command: "cmd-2", status: "running", handoff: true, started_at: 2 }],
  ]);
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [...live.values()] };
      if (method === "rind/task/read") return new Promise((resolve) => reads.push({ id: params.task_id, resolve }));
      return {};
    },
  });
  for (const item of live.values()) controller.recordTask({ session_id: "s1", task: item });
  controller.enterMonitor();
  await settled();
  assert.equal(reads[0].id, "task-2");
  controller.handleInput({ name: "down" });
  const third = { task_id: "task-3", command: "cmd-3", status: "running", handoff: true, started_at: 3 };
  live.set("task-3", third);
  controller.recordTask({ session_id: "s1", task: third });
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /› cmd-1/);
  reads[0].resolve({ task_id: "task-2", command: "cmd-2", stdout: "stale text", status: "running", handoff: true });
  await settled();
  assert.equal(reads[1].id, "task-1");
  assert.doesNotMatch(stripAnsi(controller.frame(80).lines.join("\n")), /stale text/);
  reads[1].resolve({ task_id: "task-1", command: "cmd-1", stdout: "current text", status: "running", handoff: true });
  await settled();
  assert.match(stripAnsi(controller.frame(80).lines.join("\n")), /current text/);
  controller.stop();
});

test("foreground tool_result evicts inline-completed command by origin_tool_call_id and blocks stale list resurrection", async () => {
  const state = { sessionInfo: { capabilities: ["rind/tasks"] } };
  let finishList;
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method) => method === "rind/task/list"
      ? new Promise((resolve) => { finishList = resolve; })
      : {},
  });
  controller.enterMonitor();
  // Foreground bash finishes inline (no task_id in result) while rind/task/list was in flight!
  controller.recordResult({
    tool_call_id: "call_quick",
    result: JSON.stringify({ ok: true, tool: "bash", data: { status: "completed", handoff: false, stdout: "hi" } }),
  });
  finishList({
    tasks: [{ task_id: "task_quick", origin_tool_call_id: "call_quick", command: "date", status: "running", handoff: false }],
  });
  await settled();
  assert.equal(controller.isMonitoring(), false);
  assert.equal(state.sessionInfo.background_count, 0);
  controller.stop();
});

test("session switch ignores a pending release and foreign events", async () => {
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] } };
  let release;
  let lists = 0;
  const controller = createTaskMonitorController({
    state,
    terminalUi: true,
    request: async (method) => {
      if (method === "rind/task/list") {
        lists += 1;
        return { tasks: [{ task_id: "front", command: "sleep 5", status: "running", handoff: false }] };
      }
      if (method === "rind/task/release_wait") {
        return new Promise((resolve) => { release = resolve; });
      }
      return {};
    },
  });
  controller.enterMonitor();
  await settled();
  controller.handleInput({ text: "r" });
  controller.clear();
  state.sessionInfo = { session_id: "s2", capabilities: ["rind/tasks"] };
  release({ released: true });
  controller.recordTask({ session_id: "s1", task: { task_id: "foreign", status: "running", handoff: true } });
  await settled();
  assert.equal(lists, 1);
  assert.doesNotMatch(stripAnsi(controller.frame(80).lines.join("\n")), /foreign|sleep 5/);
  controller.stop();
});

test("task monitor emits non-TUI notices only for handed-off tasks and reports empty/error states cleanly", async () => {
  const notices = [];
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: false };

  const nonTuiController = createTaskMonitorController({
    state,
    terminalUi: false,
    notify: (text, opts) => notices.push({ text, level: opts?.level ?? "info" }),
    request: async () => ({}),
  });
  // Foreground task updates never spam non-TUI output
  nonTuiController.recordTask({
    type: "task_updated",
    session_id: "s1",
    task: { task_id: "task_fg", status: "running", handoff: false },
  });
  assert.deepEqual(notices, []);
  // Handed-off background task emits concise notice
  nonTuiController.recordTask({
    type: "task_updated",
    session_id: "s1",
    task: { task_id: "task_42", status: "running", handoff: true, notify: "on_exit" },
  });
  assert.deepEqual(notices, [{ text: "Task task_42: running (on_exit)", level: "info" }]);
  nonTuiController.stop();

  notices.length = 0;
  let listTasks = [];
  const tuiController = createTaskMonitorController({
    state,
    terminalUi: true,
    notify: (text, opts) => notices.push({ text, level: opts?.level ?? "info" }),
    request: async (method) => {
      if (method === "rind/task/list") return { tasks: listTasks };
      if (method === "rind/task/cancel") throw new Error("cancel denied");
      return {};
    },
  });
  tuiController.enterMonitor();
  await settled();
  assert.deepEqual(notices, [
    { text: "No background tasks. Press Left from an empty prompt for team tasks.", level: "info" },
  ]);

  notices.length = 0;
  listTasks = [{ task_id: "bg-9", command: "sleep 30", status: "running", handoff: true }];
  tuiController.recordTask({ session_id: "s1", task: listTasks[0] });
  tuiController.enterMonitor();
  await settled();
  tuiController.handleInput({ text: "c" });
  await settled();
  assert.deepEqual(notices, [
    { text: "Task control failed: cancel denied", level: "error" },
  ]);
  tuiController.stop();
});
