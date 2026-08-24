import { runtimeMethods } from "./runtime-protocol.js";

export function createTurnController({ request, state, output, refreshGoalState = () => {}, onTurnStart = () => {} }) {
  function submit(text, extra = {}) {
    if (state.activeTurn) {
      void submitQueuedInput(runtimeMethods.sessionSteer, text, text, "steering");
      return;
    }
    start(text, extra);
  }

  function submitFollowUp(text, originalInput = text) {
    void submitQueuedInput(runtimeMethods.sessionFollowUp, text, originalInput, "follow_up");
  }

  async function submitQueuedInput(method, text, originalInput, mode) {
    try {
      const result = await request(method, { input: text });
      output.queueInput?.(text, mode, result);
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

  return {
    submit,
    submitFollowUp,
    interrupt,
  };
}
