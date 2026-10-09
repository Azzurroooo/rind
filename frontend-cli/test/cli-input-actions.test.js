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
});

test("prompt input restores persisted history and saves natural prompts only", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const saved = [];
  const output = {
    terminalUi: {},
    writeUserInput() {},
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

  const command = actions.ask("", "Ask Rind to do anything");
  await Promise.resolve();
  actions.handleTerminalInput("/help");
  actions.handleTerminalInput("\r");
  assert.equal(await command, "/help");
  assert.deepEqual(saved, [["new prompt", "previous prompt"]]);
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
