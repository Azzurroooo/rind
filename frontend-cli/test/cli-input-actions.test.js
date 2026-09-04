import assert from "node:assert/strict";
import test from "node:test";

import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";

test("question arrows leave custom editing and discard its draft", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.commands = [];
  const output = {
    terminalUi: {},
    clearAssistantLineForInput() {},
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
