import { AssistantRenderer } from "./assistant-renderer.js";
import { createAssistantStreamBuffer } from "./assistant-stream-buffer.js";
import {
  assistantHeaderText,
  outputBlockText,
  promptText,
  userInputText,
} from "./rendering.js";

export function createCliOutputController({ state, terminalUi }) {
  const streamBuffer = createAssistantStreamBuffer();
  const assistantRenderer = new AssistantRenderer((text) => writeOutput(text));

  function suspendPrompt(action, options = {}) {
    if (!terminalUi || state.runtime.status === "closing") {
      return action();
    }
    return terminalUi.withSuspended(action, { render: options.redraw !== false });
  }

  function redraw(force = false) {
    if (!state.input.active || state.runtime.status === "closing" || !terminalUi) {
      return;
    }
    terminalUi.requestRender(force);
  }

  function inputState() {
    const running = state.turn.active || state.display.activeCompact;
    return {
      running,
      label: state.display.activeCompact ? "Compacting" : "Working",
      frame: state.display.activityFrame,
      elapsedMs: running ? Date.now() - state.display.activityStartedAt : 0,
      pendingInputs: state.input.pending,
    };
  }

  function mainPromptText() {
    return promptText(state.session.info, state.display.stats, inputState());
  }

  function refreshInputState() {
    updateActivityTimer();
    redraw();
  }

  function updateActivityTimer() {
    if (state.turn.active || state.display.activeCompact) {
      if (!state.display.activityStartedAt) {
        state.display.activityStartedAt = Date.now();
      }
      if (state.display.activityTimer) {
        return;
      }
      state.display.activityTimer = setInterval(() => {
        state.display.activityFrame += 1;
        redraw();
      }, 300);
      state.display.activityTimer.unref?.();
      return;
    }
    clearActivityTimer();
  }

  function clearActivityTimer() {
    if (!state.display.activityTimer) {
      return;
    }
    clearInterval(state.display.activityTimer);
    state.display.activityTimer = null;
    state.display.activityFrame = 0;
    state.display.activityStartedAt = 0;
  }

  function log(text) {
    flushAssistantText(streamBuffer.flush(), { redraw: true });
    suspendPrompt(() => {
      closeOpenAssistantOutputLine();
      process.stdout.write(outputBlockText(text, state.display.outputStarted));
      state.display.outputStarted = true;
    });
  }

  function writeOutput(text) {
    const holdPartialLine = state.input.active && Boolean(terminalUi);
    flushAssistantText(streamBuffer.push(text, holdPartialLine));
  }

  function flushAssistantText(text = "", options = {}) {
    const output = String(text || "");
    if (!output) {
      return;
    }
    suspendPrompt(() => {
      writeAssistantHeader();
      process.stdout.write(output);
      state.display.assistantOutputLineOpen = output
        ? !output.endsWith("\n")
        : state.display.assistantOutputLineOpen;
    }, { redraw: options.redraw !== false });
  }

  function writeUserInput(text) {
    const line = userInputText(text);
    if (!line) {
      return;
    }
    flushAssistantText(streamBuffer.flush(), { redraw: false });
    closeOpenAssistantOutputLine();
    process.stdout.write(outputBlockText(line, state.display.outputStarted));
    state.display.outputStarted = true;
  }

  function writeError(text) {
    flushAssistantText(streamBuffer.flush(), { redraw: true });
    const stream = terminalUi && state.runtime.status !== "closing" ? process.stdout : process.stderr;
    suspendPrompt(() => stream.write(String(text || "")));
  }

  function closeOpenAssistantOutputLine() {
    if (!state.display.assistantOutputLineOpen) {
      return;
    }
    process.stdout.write("\n");
    state.display.assistantOutputLineOpen = false;
  }

  function writeAssistantHeader() {
    if (state.display.assistantHeaderShown) {
      return;
    }
    process.stdout.write(outputBlockText(assistantHeaderText(), state.display.outputStarted));
    state.display.outputStarted = true;
    state.display.assistantHeaderShown = true;
  }

  function closeAssistant() {
    assistantRenderer.finish();
    flushAssistantText(streamBuffer.flush());
    state.display.assistantHeaderShown = false;
  }

  function clearAssistantLineForInput() {
    if (!state.display.assistantOutputLineOpen) {
      return;
    }
    suspendPrompt(closeOpenAssistantOutputLine, { redraw: false });
  }

  function assistantAppend(text) {
    assistantRenderer.append(text);
  }

  return {
    terminalUi: Boolean(terminalUi),
    suspendPrompt,
    redraw,
    refreshInputState,
    clearActivityTimer,
    mainPromptText,
    log,
    writeUserInput,
    writeError,
    closeAssistant,
    clearAssistantLineForInput,
    assistantAppend,
  };
}
