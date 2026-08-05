export function createInputController({
  terminalUi = null,
  state = {},
  askInput,
  onSubmit = () => {},
  onCommand = async () => false,
  onSigint = () => {},
  onPaste = () => {},
  onInput = () => {},
  cancelInput = () => {},
  renderPrompt = () => {},
  prompt = () => "",
  placeholder = () => "",
}) {
  const promptResumeWaiters = [];

  function start() {
    terminalUi?.start({
      onInput,
      onPaste,
    });
  }

  async function promptLoop() {
    while (!state.runtimeClosing) {
      await waitForResume();
      if (state.runtimeClosing) {
        return;
      }
      // Keep the prompt callback intact so TTY redraws reflect live runtime state.
      const text = (await askInput(prompt, placeholder())).trim();
      if (state.runtimeClosing) {
        return;
      }
      if (!text) {
        continue;
      }
      if (await onCommand(text)) {
        continue;
      }
      onSubmit(text);
    }
  }

  function ask(promptText, placeholderText) {
    return askInput(promptText, placeholderText);
  }

  function pause() {
    state.promptPaused = true;
    cancelInput();
  }

  function resume() {
    state.promptPaused = false;
    while (promptResumeWaiters.length) {
      promptResumeWaiters.shift()();
    }
  }

  function waitForResume() {
    if (!state.promptPaused) {
      return Promise.resolve();
    }
    return new Promise((resolve) => promptResumeWaiters.push(resolve));
  }

  function cancel() {
    cancelInput();
  }

  function redraw(force = false) {
    renderPrompt(force);
  }

  function close() {
    cancel();
    terminalUi?.stop();
  }

  return {
    start,
    promptLoop,
    ask,
    pause,
    resume,
    cancel,
    redraw,
    close,
    handleInput: onInput,
    handlePaste: onPaste,
    handleSigint: onSigint,
  };
}
