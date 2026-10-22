import assert from "node:assert/strict";
import test from "node:test";

import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";
import { createLineEditor } from "../lib/line-editor.js";

test("manual compact keeps Enter and Tab input editable without premature echo", async () => {
  const state = createCliState();
  state.display.activeCompact = true;
  const queued = [], echoes = [];
  const actions = createCliInputActions({
    state, request: async () => ({}),
    output: {terminalUi: {}, redraw() {}, writeUserInput: (text) => echoes.push(text)},
    getTurnController: () => ({submitFollowUp: (text) => queued.push(text)}),
    getTaskMonitor: () => null, getLineInput: () => null,
    pausePrompt() {}, resumePrompt() {}, handleSigint() {},
  });
  const follow = actions.ask("", "Ask Rind to do anything");
  actions.handleTerminalInput("queued task");
  actions.handleTerminalInput("\t");
  assert.equal(await follow, "");
  assert.deepEqual(queued, ["queued task"]);
  const steer = actions.ask("", "Ask Rind to do anything");
  actions.handleTerminalInput("redirect");
  actions.handleTerminalInput("\r");
  assert.equal(await steer, "redirect");
  assert.deepEqual(echoes, []);
});

test("empty prompt left arrow opens agents management without dispatching text", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  const opened = [];
  const actions = createCliInputActions({
    state, request: async () => ({}), output: { terminalUi: {}, redraw() {}, writeError() {} },
    getTurnController: () => ({ submit() { throw new Error("must not submit"); } }),
    getTaskMonitor: () => null, getLineInput: () => null,
    pausePrompt() {}, resumePrompt() {}, handleSigint() {}, openAgents: async () => opened.push(true),
  });
  actions.ask("", "Ask Rind to do anything");
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[D");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [true]);
  state.input.session.editor.setInput("draft");
  actions.handleTerminalInput("\x1b[D");
  assert.equal(state.input.session.editor.cursorPosition().column, 4);
  actions.handleTerminalInput("\x1b[1;5D");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [true]);
  state.input.session.editor.setInput(" ");
  actions.handleTerminalInput("\x1b[D");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [true]);
  state.input.session.editor.setInput(""); state.turn.active = true;
  actions.handleTerminalInput("\x1b[D");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 2);
  actions.cancel();
});

test("question arrows leave custom editing and discard its draft", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const output = {
    terminalUi: {},
    writeUserInput() {},
    closeAssistant() {},
    beginQuestion() {},
    finishQuestion() {},
    redraw() {},
    writeError() {},
  };
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    getTurnController: () => null,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  const pending = actions.answerQuestion({
    tool_call_id: "question-1",
    question: "What should I do?",
    options: [{ label: "Continue" }],
  });
  await Promise.resolve();

  const session = state.input.session;
  assert.equal(session.mode, "question");
  const editor = session.editor;

  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("\t");
  actions.handleTerminalInput("discarded");
  actions.handleTerminalInput("\x1b[A");
  assert.equal(state.input.session.questionState.isEditing(), false);
  assert.equal(state.input.session.questionState.selectedIndex(), 0);
  assert.equal(editor.input(), "");

  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("\t");
  actions.handleTerminalInput("also discarded");
  actions.handleTerminalInput("\x1b[B");
  assert.equal(state.input.session.questionState.isEditing(), false);
  assert.equal(state.input.session.questionState.selectedIndex(), 0);
  assert.equal(editor.input(), "");

  assert.equal(state.input.session.editor, editor);

  actions.cancel();
  await pending;
});

test("a question answered in another window closes here without answering twice", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const requests = [], finished = [];
  const actions = createCliInputActions({
    state, request: async (method, params) => { requests.push([method, params]); return {}; },
    output: { terminalUi: {}, writeUserInput() {}, closeAssistant() {}, beginQuestion() {}, finishQuestion: (event, answer) => finished.push(answer), redraw() {}, writeError() {} },
    getTurnController: () => null, getTaskMonitor: () => null, getLineInput: () => null,
    pausePrompt() {}, resumePrompt() {}, handleSigint() {},
  });
  const question = { tool_call_id: "q-1", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] };
  const pending = actions.answerQuestion(question);
  await Promise.resolve();
  actions.questionAnswered({ tool_call_id: "other", answer: "ignored" });
  assert.equal(state.input.session.mode, "question", "an answer to another question changes nothing");
  actions.questionAnswered({ tool_call_id: "q-1", answer: "Yes" });
  await pending;
  assert.equal(state.input.session, null, "the question menu is closed");
  assert.deepEqual(requests, [], "the answer is not sent a second time");
  assert.deepEqual(finished, ["Yes (answered in another window)"]);

  // Answering here: this window's own broadcast arrives while the answer is being sent.
  const local = actions.answerQuestion({ ...question, tool_call_id: "q-2" });
  await Promise.resolve();
  actions.handleTerminalInput("\r");
  // The Runtime broadcasts only after it received this window's answer.
  await new Promise(resolve => setImmediate(resolve));
  actions.questionAnswered({ tool_call_id: "q-2", answer: "Yes" });
  await local;
  assert.deepEqual(requests.map(([, params]) => params), [{ tool_call_id: "q-2", answer: "Yes" }]);
  assert.deepEqual(finished.at(-1), "Yes");

  const skippedElsewhere = actions.answerQuestion({ ...question, tool_call_id: "q-3" });
  await Promise.resolve();
  actions.questionAnswered({ tool_call_id: "q-3", answer: "" });
  await skippedElsewhere;
  assert.equal(finished.at(-1), "(no answer) (answered in another window)");
});

test("Esc on a question leaves custom editing first and skips the question without interrupting the turn", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const requests = [], finished = [];
  let interrupted = false;
  const actions = createCliInputActions({
    state, request: async (method, params) => { requests.push([method, params]); return {}; },
    output: { terminalUi: {}, writeUserInput() {}, closeAssistant() {}, beginQuestion() {}, finishQuestion: (_event, answer) => finished.push(answer), redraw() {}, writeError() {} },
    getTurnController: () => ({ interrupt() { interrupted = true; } }),
    getTaskMonitor: () => null, getLineInput: () => null,
    pausePrompt() {}, resumePrompt() {}, handleSigint() {},
  });
  const pending = actions.answerQuestion({ tool_call_id: "q-1", question: "Ship it?", options: [{ label: "Yes (Recommended)" }] });
  await Promise.resolve();

  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("\t");
  actions.handleTerminalInput("draft answer");
  assert.equal(state.input.session.questionState.isEditing(), true);
  assert.equal(state.input.session.editor.input(), "draft answer");

  actions.handleTerminalInput("\x1b");
  assert.equal(state.input.session.questionState.isEditing(), false);
  assert.equal(state.input.session.editor.input(), "");
  assert.equal(interrupted, false);

  actions.handleTerminalInput("\x1b");
  await pending;
  assert.equal(interrupted, false);
  assert.equal(state.input.session, null);
  assert.deepEqual(requests, [["rind/user-question/respond", { tool_call_id: "q-1", answer: "" }]]);
  assert.deepEqual(finished, [""]);
});

test("prompt input restores persisted history, saves natural prompts only, and omits user echo for slash commands", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const saved = [];
  const echoed = [];
  const output = {
    terminalUi: {},
    writeUserInput: (text) => echoed.push(text),
    redraw() {},
    writeError() {},
  };
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    promptHistory: ["previous prompt"],
    onPromptHistory: (history) => saved.push(history),
    getTurnController: () => ({ submitFollowUp() {} }),
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  const prompt = actions.ask("", "Ask Rind to do anything");
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[A");
  assert.equal(state.input.session.editor.input(), "previous prompt");
  state.input.session.editor.setInput("new prompt");
  actions.handleTerminalInput("\r");
  assert.equal(await prompt, "new prompt");
  assert.deepEqual(saved, [["new prompt", "previous prompt"]]);
  assert.deepEqual(echoed, ["new prompt"]);

  const command = actions.ask("", "Ask Rind to do anything");
  await Promise.resolve();
  actions.handleTerminalInput("/help");
  actions.handleTerminalInput("\r");
  assert.equal(await command, "/help");
  assert.deepEqual(saved, [["new prompt", "previous prompt"]]);
  assert.deepEqual(echoed, ["new prompt"], "slash commands must not echo as user prompt bubbles");

  const shortcutHelp = actions.ask("", "Ask Rind to do anything");
  await Promise.resolve();
  actions.handleTerminalInput("?");
  actions.handleTerminalInput("\r");
  assert.equal(await shortcutHelp, "?");
  assert.deepEqual(saved, [["new prompt", "previous prompt"]]);
  assert.deepEqual(echoed, ["new prompt"], "? help shortcut must not echo as user prompt bubble");
});

test("alt+right promotes a queued follow-up to steering", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  const requests = [];
  const output = {
    redraw() {},
    writeError() {},
  };
  const actions = createCliInputActions({
    state,
    request: async (method, params = {}) => {
      requests.push({ method, params });
      return { accepted: true, input_id: params.input_id, mode: "steering", pending: 1 };
    },
    output,
    getTurnController: () => null,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });
  state.input.pending.push({ inputId: "input-9", input: "follow up text", mode: "follow_up" });
  state.input.session = {
    mode: "prompt",
    editor: createLineEditor(""),
    menuState: null,
    resolve: () => {},
  };

  actions.handleTerminalInput("\x1b[1;3C");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "rind/session/promote_follow_up");
  assert.deepEqual(requests[0].params, { input_id: "input-9" });
  assert.equal(state.input.pending[0].mode, "steering");
});

test("the Runtime closes a sign-in prompt it no longer waits for, and only that prompt", async () => {
  const state = createCliState();
  const actions = createCliInputActions({
    state, request: async () => ({}), output: { terminalUi: {}, redraw() {}, closeAssistant() {} },
    getTurnController: () => ({}), getTaskMonitor: () => null, getLineInput: () => null,
    pausePrompt() {}, resumePrompt() {}, handleSigint() {},
  });
  const answer = actions.handleAuthPrompt({ request_id: "auth-1", params: { kind: "text", message: "Waiting for your browser… or paste the redirect URL here" } });
  await Promise.resolve();
  assert.equal(state.input.session.mode, "auth");
  actions.closeAuthPrompt("auth-other");
  assert.equal(state.input.session?.mode, "auth", "another prompt's close leaves this one open");
  actions.closeAuthPrompt("auth-1");
  assert.equal(await answer, "");
  assert.notEqual(state.input.session?.mode, "auth");
  actions.closeAuthPrompt("auth-1");
});

test("askEffortMenu and askModelMenu resolve selections without echoing duplicate user bubbles", async () => {
  const state = createCliState();
  const echoed = [];
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output: { terminalUi: {}, writeUserInput: (text) => echoed.push(text), redraw() {}, writeError() {} },
    getTurnController: () => ({}),
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });
  const selected = actions.askEffortMenu("medium", ["low", "medium", "high", "xhigh"]);
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("\r");
  assert.equal(await selected, "high");
  assert.deepEqual(echoed, []);

  const modelSelected = actions.askModelMenu(
    [{ provider_id: "deepseek", id: "deepseek-flash" }, { provider_id: "deepseek", id: "deepseek-v4-pro" }],
    "deepseek-flash",
  );
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("\r");
  assert.deepEqual(await modelSelected, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    current: false,
    image_input: null,
    scope: "session",
  });
  assert.deepEqual(echoed, []);
});

test("askModelMenu and askEffortMenu resolve scope when f or g is pressed", async () => {
  const state = createCliState();
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output: { terminalUi: {}, writeUserInput() {}, redraw() {}, writeError() {} },
    getTurnController: () => ({}),
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });
  const modelSelected = actions.askModelMenu(
    [{ provider_id: "zai", id: "glm-4.7" }, { provider_id: "zai", id: "glm-4.6" }],
    "glm-4.7",
  );
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("f");
  const modelItem = await modelSelected;
  assert.equal(modelItem.modelId, "glm-4.6");
  assert.equal(modelItem.scope, "folder");

  const effortSelected = actions.askEffortMenu("low", ["low", "medium", "high"]);
  await Promise.resolve();
  actions.handleTerminalInput("\x1b[B");
  actions.handleTerminalInput("g");
  assert.deepEqual(await effortSelected, { effort: "medium", scope: "global" });
});

test("cycleReasoningEffort and error paths emit system notices with appropriate levels", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.info = { session_id: "sess-1", reasoning_effort: "low" };
  const notices = [];
  let effortLevels = [];
  let shouldFailSet = false;
  const actions = createCliInputActions({
    state,
    request: async () => {
      if (shouldFailSet) throw new Error("effort set failed");
      return {};
    },
    output: {
      terminalUi: {},
      writeUserInput() {},
      redraw() {},
      notify: (text, opts) => notices.push({ text, level: opts?.level ?? "info" }),
    },
    getEffortLevels: async () => effortLevels,
    getCommandController: () => ({ handle: async () => { throw new Error("dispatch failed"); } }),
    getTurnController: () => ({}),
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  // Ctrl+T with empty levels -> warning
  actions.handleTerminalInput("\x14");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, [
    { text: "The current model does not declare reasoning effort levels.", level: "warning" },
  ]);

  // Ctrl+T with valid levels -> info
  notices.length = 0;
  effortLevels = ["low", "medium", "high"];
  actions.handleTerminalInput("\x14");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, [
    { text: "Reasoning effort: medium", level: "info" },
  ]);

  // Ctrl+T when request fails -> error
  notices.length = 0;
  shouldFailSet = true;
  actions.handleTerminalInput("\x14");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, [
    { text: "effort set failed", level: "error" },
  ]);

  // dispatchExternal error -> error
  notices.length = 0;
  actions.dispatchExternal("/boom");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, [
    { text: "dispatch failed", level: "error" },
  ]);
});


