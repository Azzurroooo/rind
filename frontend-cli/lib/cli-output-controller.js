import { AssistantRenderer } from "./assistant-renderer.js";
import { createAssistantStreamBuffer } from "./assistant-stream-buffer.js";
import {
  assistantHeaderText,
  outputBlockText,
  promptText,
  toolResultLine,
  toolStartedLine,
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

  function renderHistory(messages) {
    suspendPrompt(() => {
      const pendingTools = new Map();
      const flushPendingTools = () => {
        for (const toolName of pendingTools.values()) {
          log(toolStartedLine({ tool_name: toolName }));
        }
        pendingTools.clear();
      };
      for (const message of Array.isArray(messages) ? messages : []) {
        const role = String(message?.role || "");
        if (role === "user") {
          flushPendingTools();
          closeAssistant();
          writeUserInput(messageText(message?.content));
          continue;
        }
        if (role === "assistant") {
          flushPendingTools();
          const content = messageText(message?.content);
          if (content) {
            assistantAppend(content);
            closeAssistant();
          }
          for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
            const toolCallId = String(call?.id || "");
            const toolName = String(call?.function?.name || "tool");
            if (toolCallId) {
              pendingTools.set(toolCallId, toolName);
            }
          }
          continue;
        }
        if (role === "tool") {
          const toolCallId = String(message?.tool_call_id || "");
          const toolName = pendingTools.get(toolCallId) || "tool";
          pendingTools.delete(toolCallId);
          log(toolResultLine({
            tool_call_id: toolCallId,
            tool_name: toolName,
            result: messageText(message?.content),
            status: "completed",
          }));
        }
      }
      flushPendingTools();
      closeAssistant();
    });
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
    renderHistory,
  };
}

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}
