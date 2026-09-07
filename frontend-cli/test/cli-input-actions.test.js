import assert from "node:assert/strict";
import test from "node:test";

import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";
import { createLineEditor } from "../lib/line-editor.js";

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
