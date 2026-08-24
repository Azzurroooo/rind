export function createInputController({
  terminalUi = null,
  state = {},
  askInput,
  onSubmit = () => {},
  onCommand = async () => false,
  onPaste = () => {},
  onInput = () => {},
  cancelInput = () => {},
  prompt = () => "",
  placeholder = () => "",
}) {
  const promptResumeWaiters = [];

  function start() {
    terminalUi?.start();
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

  function close() {
    cancel();
    terminalUi?.stop();
  }

  return {
    start,
    promptLoop,
    pause,
    resume,
    close,
  };
}
