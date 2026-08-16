import { runtimeMethods, turnInputMethod } from "./runtime-protocol.js";

export function createTurnController({ request, state, output, refreshGoalState = () => {}, onTurnStart = () => {} }) {
  function submit(text, extra = {}) {
    const method = turnInputMethod(state.activeTurn);
    if (method === runtimeMethods.sessionFollowUp) {
      output.logQueuedInput(text);
      void submitQueuedInput(method, text, text);
      return;
    }
    start(text, extra);
  }

  function submitSteering(text, originalInput) {
    void submitQueuedInput(runtimeMethods.sessionSteer, text, originalInput);
  }

  async function submitQueuedInput(method, text, originalInput) {
    try {
      await request(method, { input: text });
    } catch (error) {
      handleSubmissionError(error, originalInput);
    }
  }

  function handleSubmissionError(error, text) {
    output.restoreInputText(text);
    if (!state.runtimeClosing) {
      output.writeError(error instanceof Error ? error.message : String(error));
    }
  }

  function start(text, extra = {}) {
    if (state.runtimeClosing) {
      return;
    }
    state.activeTurn = true;
    state.interruptRequested = false;
    state.turnTools = { completed: 0, failed: 0 };
    onTurnStart();
    output.refreshInputState();
    void run(text, extra).catch((error) => handleSubmissionError(error, text));
  }

  async function run(text, extra = {}) {
    try {
      await request(runtimeMethods.sessionPrompt, { input: text, ...extra });
    } finally {
      void refreshGoalState();
      state.activeTurn = false;
      state.interruptRequested = false;
      output.closeAssistant();
      output.refreshInputState();
    }
  }

  function interrupt() {
    state.interruptRequested = true;
    output.cancelInput();
    output.closeAssistant();
    output.logInterrupt();
    void request(runtimeMethods.sessionCancel).catch(() => {});
  }

  function reset() {
    state.activeTurn = false;
    state.interruptRequested = false;
    output.resetTurnTools();
  }

  return {
    submit,
    submitSteering,
    interrupt,
    isActive: () => state.activeTurn,
    reset,
  };
}
