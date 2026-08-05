import { turnInputMethod } from "./runtime-protocol.js";

export function createTurnController({ request, state, output, refreshGoalState = () => {}, onTurnStart = () => {} }) {
  function submit(text, extra = {}) {
    const method = turnInputMethod(state.activeTurn);
    if (method === "turn.follow_up") {
      output.logQueuedInput(text);
      void submitQueuedInput(method, text, text);
      return;
    }
    start(text, extra);
  }

  function submitSteering(text, originalInput) {
    void submitQueuedInput("turn.steer", text, originalInput);
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
      await request("turn.start", { input: text, ...extra });
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
    void request("turn.interrupt").catch(() => {});
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
