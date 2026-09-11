import { AssistantRenderer } from "./assistant-renderer.js";
import {
  assistantHeaderText,
  outputBlockText,
  promptText,
  startupText,
  toolRequestedLine,
  toolResultLine,
  toolStartedLine,
  userInputText,
  questionAnswerText,
  questionText,
} from "./rendering.js";
import { TextBlock } from "./components/text-block.js";
import { DynamicBlock } from "./components/dynamic-block.js";
import { AssistantMessage } from "./components/assistant-message.js";
import { ToolBlock } from "./components/tool-block.js";
import { argsFromResult } from "./tool-display.js";

export function createCliOutputController({ state, terminalUi, transcript }) {
  const legacyRenderer = new AssistantRenderer((text) => writeOutput(text));
  let assistantMessage = null;
  let blockCount = 0;
  const toolBlocks = new Map();
  const legacyBegunTools = new Set();
  let questionBlock = null;
  let turnContext = "";

  function redraw(force = false) {
    if (!terminalUi || state.runtime.status === "closing") {
      return;
    }
    terminalUi.requestRender(force);
  }

  function inputState() {
    const running = state.turn.active || state.display.activeCompact;
    const inputSession = state.input.session;
    return {
      running,
      label: state.display.activityLabel || (state.display.activeCompact
        ? "Compacting"
        : "Working"),
      frame: state.display.activityFrame,
      elapsedMs: running ? Date.now() - state.display.activityStartedAt : 0,
      pendingInputs: state.input.pending,
      inputMode: inputSession?.mode || "prompt",
      menuOpen: Boolean(inputSession?.menuState?.matches?.()?.length),
    };
  }

  function setActivityLabel(label = "") {
    const next = String(label || "");
    if (state.display.activityLabel === next) {
      return;
    }
    state.display.activityLabel = next;
    redraw();
  }

  function mainPromptText(frameWidth) {
    return promptText(state.session.info, state.display.stats, inputState(), frameWidth);
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
    if (state.display.activityTimer) {
      clearInterval(state.display.activityTimer);
    }
    state.display.activityTimer = null;
    state.display.activityFrame = 0;
    state.display.activityStartedAt = 0;
  }

  function appendBlock(component) {
    transcript.addChild(component);
    blockCount += 1;
    redraw();
  }

  function lazyLines(buildText, leading) {
    return new DynamicBlock(() => {
      const value = String(buildText() ?? "");
      const body = outputBlockText(value);
      if (!body.trim()) {
        return [];
      }
      const lines = body.split("\n");
      while (lines.length > 1 && lines.at(-1) === "") {
        lines.pop();
      }
      return leading ? ["", ...lines] : lines;
    });
  }

  // Accepts a string or a thunk so themed content restyles on full repaints.
  function log(text) {
    const build = typeof text === "function" ? text : () => String(text ?? "");
    if (!terminalUi) {
      const value = String(build() ?? "");
      if (!value.trim()) {
        return;
      }
      process.stdout.write(outputBlockText(value, state.display.outputStarted));
      state.display.outputStarted = true;
      return;
    }
    const leading = blockCount > 0;
    appendBlock(lazyLines(build, leading));
  }

  function writeOutput(text) {
    if (!terminalUi) {
      flushAssistantText(text);
    }
  }

  function flushAssistantText(text = "") {
    const output = String(text || "");
    if (!output) {
      return;
    }
    process.stdout.write(output);
  }

  function writeUserInput(text, source = "") {
    const value = String(text ?? "");
    if (!value.trim()) {
      return;
    }
    if (!terminalUi) {
      const line = userInputText(value, undefined, source);
      if (!line) {
        return;
      }
      process.stdout.write(outputBlockText(line, state.display.outputStarted));
      state.display.outputStarted = true;
      return;
    }
    const leading = blockCount > 0;
    appendBlock(new DynamicBlock((width) => {
      const rendered = userInputText(value, width, source);
      const lines = rendered ? rendered.split("\n") : [];
      if (leading && lines.length) {
        lines.unshift("");
      }
      while (lines.length > 1 && lines.at(-1) === "") {
        lines.pop();
      }
      return lines;
    }));
  }

  function writeError(text) {
    const value = String(text ?? "");
    if (!terminalUi || state.runtime.status === "closing") {
      process.stderr.write(value);
      return;
    }
    appendBlock(new TextBlock(outputBlockText(value), { leading: blockCount > 0 }));
  }

  function ensureAssistantBlocks() {
    if (!assistantMessage) {
      const leading = blockCount > 0;
      transcript.addChild(lazyLines(() => assistantHeaderText(), leading));
      blockCount += 1;
      assistantMessage = new AssistantMessage({ color: true });
      transcript.addChild(assistantMessage);
      blockCount += 1;
    }
    return assistantMessage;
  }

  function closeAssistant() {
    if (terminalUi) {
      if (assistantMessage) {
        assistantMessage.finish();
        assistantMessage = null;
      }
      state.display.assistantHeaderShown = false;
      return;
    }
    legacyRenderer.finish();
    state.display.assistantHeaderShown = false;
  }

  function beginQuestion(event) {
    if (!terminalUi) {
      log(() => questionText(event));
      return;
    }
    const state = { event, answer: null };
    const block = new DynamicBlock(() => {
      const text = state.answer === null
        ? questionText(state.event)
        : questionAnswerText(state.event, state.answer);
      return text.split("\n");
    });
    questionBlock = { state, block };
    appendBlock(block);
  }

  function finishQuestion(event, answer) {
    if (!terminalUi || !questionBlock) {
      log(() => questionAnswerText(event, answer));
      return;
    }
    questionBlock.state.event = event;
    questionBlock.state.answer = answer;
    questionBlock.block.invalidate();
    questionBlock = null;
    redraw();
  }

  function assistantAppend(text) {
    if (!terminalUi) {
      legacyRenderer.append(text);
      return;
    }
    const message = ensureAssistantBlocks();
    message.append(text);
    redraw();
  }

  function showStartup(info) {
    if (!terminalUi) {
      return;
    }
    const source = { ...info };
    appendBlock(new DynamicBlock((width) => {
      const rendered = startupText(source, width);
      return rendered ? rendered.split("\n") : [];
    }));
  }

  function beginTool(event) {
    const callId = String(event?.tool_call_id || "");
    if (!terminalUi) {
      if (!callId) {
        log(toolStartedLine(event));
        return;
      }
      if (legacyBegunTools.has(callId)) {
        return;
      }
      legacyBegunTools.add(callId);
      log(event?.args_preview ? toolRequestedLine(event) : toolStartedLine(event));
      return;
    }
    if (!callId) {
      return;
    }
    const key = toolBlockKey(callId);
    const existing = toolBlocks.get(key);
    if (existing) {
      existing.enrichArgs(event);
      return;
    }
    const block = new ToolBlock({
      event,
      onRequestRender: () => redraw(),
      leading: blockCount > 0,
    });
    toolBlocks.set(key, block);
    appendBlock(block);
  }

  function updateToolProgress(callId, message) {
    if (!terminalUi) {
      return;
    }
    toolBlocks.get(toolBlockKey(callId))?.setProgress(message);
  }

  function finishTool(event, fileChange) {
    if (!terminalUi) {
      log(toolResultLine(event, fileChange));
      return;
    }
    const callId = String(event?.tool_call_id || "");
    const key = toolBlockKey(callId);
    let block = toolBlocks.get(key);
    if (!block) {
      if (!callId) {
        return;
      }
      block = new ToolBlock({
        event,
        onRequestRender: () => redraw(),
        leading: blockCount > 0,
      });
      toolBlocks.set(key, block);
      appendBlock(block);
    }
    block.enrichArgs({ arguments: argsFromResult(event?.tool_name, event?.result) });
    block.finish(event, fileChange);
  }

  function setToolsExpanded(expanded) {
    if (!terminalUi) {
      return;
    }
    for (const block of toolBlocks.values()) {
      block.setExpanded(expanded);
    }
    redraw();
  }

  function setTurnContext(turnId = "") {
    turnContext = String(turnId || "");
  }

  function toolBlockKey(callId) {
    const value = String(callId || "");
    return value ? `${turnContext}:${value}` : "";
  }

  function renderHistory(messages) {
    const pendingTools = new Map();
    const flushPendingTools = () => {
      for (const [toolCallId, tool] of pendingTools.entries()) {
        beginTool({
          tool_call_id: toolCallId,
          tool_name: tool.name,
          args_preview: tool.arguments,
        });
        finishTool({
          tool_call_id: toolCallId,
          tool_name: tool.name,
          status: "completed",
          result: "",
        });
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
            pendingTools.set(toolCallId, {
              name: toolName,
              arguments: String(call?.function?.arguments || ""),
            });
          }
        }
        continue;
      }
      if (role === "tool") {
        const toolCallId = String(message?.tool_call_id || "");
        const tool = pendingTools.get(toolCallId) || { name: "tool", arguments: "" };
        pendingTools.delete(toolCallId);
        beginTool({
          tool_call_id: toolCallId,
          tool_name: tool.name,
          args_preview: tool.arguments,
        });
        finishTool({
          tool_call_id: toolCallId,
          tool_name: tool.name,
          status: "completed",
          result: messageText(message?.content),
        });
      }
    }
    flushPendingTools();
    closeAssistant();
    redraw(true);
  }

  return {
    terminalUi: Boolean(terminalUi),
    redraw,
    refreshInputState,
    clearActivityTimer,
    setActivityLabel,
    mainPromptText,
    log,
    writeUserInput,
    writeError,
    closeAssistant,
    assistantAppend,
    beginTool,
    updateToolProgress,
    finishTool,
    beginQuestion,
    finishQuestion,
    setToolsExpanded,
    setTurnContext,
    renderHistory,
    showStartup,
    replayAll: () => terminalUi?.replayAll?.(),
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
