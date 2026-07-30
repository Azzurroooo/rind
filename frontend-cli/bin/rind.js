#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AssistantRenderer } from "../lib/assistant-renderer.js";
import { createAssistantStreamBuffer } from "../lib/assistant-stream-buffer.js";
import { createCompactContextState } from "../lib/compact-context-state.js";
import { prepareComposerFrame } from "../lib/composer-terminal.js";
import { createLineEditor } from "../lib/line-editor.js";
import { buildRuntimeEnv } from "../lib/runtime-env.js";
import { createRuntimeRequest, runtimeEventType, runtimeRequestId, turnInputMethod } from "../lib/runtime-protocol.js";
import { isInputClosed } from "../lib/input-errors.js";
import { sigintAction } from "../lib/interrupt-state.js";
import { isReadonlySlashCommand, steeringCommandText } from "../lib/slash-command-mode.js";
import { createModelMenuState } from "../lib/model-menu-state.js";
import { createChoiceMenuState } from "../lib/choice-menu-state.js";
import { createSlashMenuState } from "../lib/slash-menu-state.js";
import { parseTerminalKey } from "../lib/terminal-key.js";
import { createTerminalUI } from "../lib/terminal-ui.js";
import {
  answerPromptText,
  answerPlaceholderText,
  cancelledText,
  commandResultText,
  contextBuiltLine,
  errorLine,
  helpText,
  assistantHeaderText,
  inputHintText,
  interruptText,
  modelListErrorText,
  modelMenuText,
  choiceMenuText,
  sessionMenuText,
  sessionSwitchedText,
  outputBlockText,
  promptPlaceholderText,
  promptText,
  questionText,
  queuedInputText,
  slashResultText,
  slashMenuText,
  skillLine,
  startupText,
  toolProgressLine,
  toolRequestedLine,
  toolResultLine,
  toolStartedLine,
  turnCompletedLine,
  userInputText,
} from "../lib/rendering.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const python = process.env.RIND_PYTHON || "python";
const cliArgs = process.argv.slice(2);

if (cliArgs.some((arg) => arg === "--version" || arg === "--help" || arg === "-h")) {
  const result = spawnSync(python, [path.join(repoRoot, "main.py"), ...cliArgs], {
    cwd: process.cwd(),
    env: buildRuntimeEnv(repoRoot),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const runtimeBootstrap = [
  "import os, runpy, sys",
  `repo = os.path.abspath(${JSON.stringify(repoRoot)})`,
  "cwd = os.path.abspath(os.getcwd())",
  "blocked = {os.path.normcase(repo), os.path.normcase(cwd)}",
  "sys.path = [repo] + [p for p in sys.path if p and os.path.normcase(os.path.abspath(p)) not in blocked]",
  "runpy.run_module('agent.interfaces.runtime_server.stdio', run_name='__main__')",
].join("; ");

let nextId = 1;
let activeTurn = false;
let activeCompact = false;
let interruptRequested = false;
let input = null;
let inputActive = false;
let runtimeClosing = false;
let runtimeKillTimer = null;
let processExitTimer = null;
let cancelActiveInput = null;
const pending = new Map();
const announcedTools = new Set();
const pendingFileChanges = new Map();
let sessionInfo = {};
let latestStats = {};
let slashCommands = [];
let turnTools = { completed: 0, failed: 0 };
let promptPaused = false;
let pendingInputPrefill = "";
let assistantOutputLineOpen = false;
let assistantHeaderShown = false;
let outputStarted = false;
let activityFrame = 0;
let activityTimer = null;
let activityStartedAt = 0;
const promptResumeWaiters = [];
const assistantStreamBuffer = createAssistantStreamBuffer();
const assistantRenderer = new AssistantRenderer((text) => writeOutput(text));
const compactContextState = createCompactContextState();
const terminalUi = process.stdin.isTTY && process.stdout.isTTY
  ? createTerminalUI({ input: process.stdin, output: process.stdout, render: renderActiveInput })
  : null;
const promptEditor = createLineEditor();
let activeInputSession = null;
let runtimeStdoutBuffer = "";

const runtime = spawn(
  python,
  ["-c", runtimeBootstrap, ...cliArgs],
  {
    cwd: process.cwd(),
    env: buildRuntimeEnv(repoRoot),
    stdio: ["pipe", "pipe", "pipe"],
  },
);

runtime.stdout.setEncoding("utf8");
runtime.stdout.on("data", (chunk) => {
  runtimeStdoutBuffer += chunk;
  const lines = runtimeStdoutBuffer.split(/\r?\n/);
  runtimeStdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    if (line) {
      receive(line);
    }
  }
});

runtime.stderr.on("data", (chunk) => {
  writeErrorOutput(chunk);
});

runtime.on("exit", (code, signal) => {
  clearRuntimeKillTimer();
  for (const { reject } of pending.values()) {
    reject(new Error(`Runtime exited with ${signal || code}`));
  }
  pending.clear();
  process.exitCode = runtimeClosing ? 0 : code ?? 1;
  closeInput();
  if (runtimeClosing) {
    scheduleProcessExit(process.exitCode ?? 0, 0);
  }
});

process.on("SIGINT", handleSigint);

try {
  const info = await request("initialize");
  sessionInfo = { cwd: process.cwd(), ...(info || {}) };
  slashCommands = normalizeSlashCommands([
    ...(Array.isArray(info?.slash_commands) ? info.slash_commands : []),
    { name: "steer", description: "Redirect the active turn", usage: "/steer <text>" },
  ]);
  if (terminalUi) {
    terminalUi.start({
      onInput: handleTerminalInput,
      onPaste: handleTerminalPaste,
    });
  } else {
    input = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 100,
      removeHistoryDuplicates: true,
    });
    process.stdin.on("data", handleStdinData);
  }
  logOutput(startupText(info));
  await promptLoop();
} catch (error) {
  closeAssistant();
  if (!isInputClosed(error)) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  closeRuntime();
}

async function promptLoop() {
  while (!runtimeClosing) {
    await waitForPromptResume();
    if (runtimeClosing) {
      return;
    }
    const text = (await ask(mainPromptText, promptPlaceholderText())).trim();
    if (runtimeClosing) {
      return;
    }
    if (!text) {
      continue;
    }
    if (await handleCommand(text)) {
      continue;
    }
    submitTurn(text);
  }
}

async function handleCommand(text) {
  if (text === "?") {
    logOutput(helpText(slashCommands));
    return true;
  }
  if (!text.startsWith("/")) {
    return false;
  }
  const steering = steeringCommandText(text);
  if (steering !== null) {
    submitSteering(steering, text);
    return true;
  }
  await runSlashCommand(text);
  return true;
}

async function runSlashCommand(text) {
  if (isBareModelCommand(text) && terminalUi) {
    await runModelSelector();
    return;
  }
  if (isCompactCommand(text) && terminalUi) {
    startCompactCommand();
    return;
  }
  if (isBareSessionsCommand(text) && terminalUi) {
    await runSessionsSelector();
    return;
  }
  if (isReadonlySlashCommand(text) && terminalUi) {
    startReadonlySlashCommand(text);
    return;
  }
  const result = await request("slash.execute", { input: text });
  await applySlashResult(result);
}

async function runSessionsSelector() {
  let result;
  try {
    result = await request("slash.execute", { input: "/sessions" });
  } catch (error) {
    logOutput(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const sessions = Array.isArray(result?.display?.sessions) ? result.display.sessions : [];
  if (!sessions.length) {
    await applySlashResult(result);
    return;
  }
  const currentId = String(result?.display?.current_session_id || sessionInfo.session_id || "");
  const options = sessions.map((session) => sessionMenuOption(session));
  const currentIndex = sessions.findIndex((session) => String(session?.id || "") === currentId);
  const selected = await askSessionMenu(options, sessions, currentIndex);
  if (!selected || runtimeClosing || selected.id === currentId) {
    return;
  }
  try {
    const update = await request("session.switch", { session_id: selected.id });
    sessionInfo = {
      ...sessionInfo,
      session_id: update?.session_id || selected.id,
      model: update?.model || sessionInfo.model,
      resume_preview: update?.resume_preview || "",
    };
    latestStats = update?.usage && typeof update.usage === "object" ? update.usage : {};
    compactContextState.clear();
    logOutput(sessionSwitchedText(sessionInfo));
    redrawInput();
  } catch (error) {
    logOutput(`Session switch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionMenuOption(session) {
  const id = singleLineText(session?.id) || "unknown";
  const title = singleLineText(session?.title);
  const updated = singleLineText(session?.updated_at);
  const marker = session?.current ? "current" : "";
  return [id, title, updated, marker].filter(Boolean).join(" · ");
}

async function applySlashResult(result) {
  if (result.clear_screen) {
    withSuspendedPrompt(() => console.clear());
  }
  const text = slashResultText(result, slashCommands);
  if (text) {
    logOutput(text);
  }
  if (result.context_usage_reset) {
    resetContextUsage();
  }
  if (result.input_prefill) {
    pendingInputPrefill = result.input_prefill;
  }
  if (result.run_turn_input) {
    submitTurn(result.run_turn_input, {
      transient_system_messages: result.transient_system_messages,
    });
  }
  if (result.should_exit) {
    await shutdownRuntime();
    process.exit(0);
  }
}

function startReadonlySlashCommand(text) {
  void runReadonlySlashCommand(text).catch((error) => {
    if (!runtimeClosing) {
      writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}

async function runReadonlySlashCommand(text) {
  const result = await request("slash.execute", { input: text });
  await applySlashResult(result);
}

function startCompactCommand() {
  if (activeCompact) {
    logOutput("Compact is already running.");
    return;
  }
  activeCompact = true;
  interruptRequested = false;
  refreshInputState();
  void runCompactCommand().catch((error) => {
    if (!runtimeClosing) {
      writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}

async function runCompactCommand() {
  try {
    const result = await request("slash.execute", { input: "/compact" });
    await applySlashResult(result);
  } finally {
    activeCompact = false;
    interruptRequested = false;
    refreshInputState();
  }
}

async function runModelSelector() {
  let result;
  try {
    result = await request("models.list");
  } catch (error) {
    logOutput(modelListErrorText(error instanceof Error ? error.message : String(error), sessionInfo.model));
    return;
  }

  const currentModel = result?.current_model || sessionInfo.model || result?.default_model || "";
  const selected = await askModelMenu(result?.models || [], currentModel);
  if (!selected || runtimeClosing) {
    return;
  }

  try {
    const update = await request("model.set", { model: selected });
    sessionInfo = { ...sessionInfo, model: update?.model || selected };
    logOutput(modelSetResultText(update, selected));
  } catch (error) {
    logOutput(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function modelSetResultText(result, model) {
  const sessionModel = singleLineText(result?.session_model || result?.model || model);
  const defaultModel = singleLineText(result?.default_model);
  const lines = ["Session model updated."];
  if (sessionModel) {
    lines.push(`- session model: ${sessionModel}`);
  }
  if (defaultModel) {
    lines.push(`- default model: ${defaultModel} (unchanged)`);
  }
  if (result?.active_updated || result?.runtime || result?.session) {
    lines.push("- active session: updated");
  } else {
    lines.push("- active session: unchanged; start a new session to use this model");
  }
  return commandResultText(lines[0], lines.slice(1).join(" · "));
}

function submitTurn(text, extra = {}) {
  const method = turnInputMethod(activeTurn);
  if (method === "turn.follow_up") {
    logOutput(queuedInputText(text));
    void submitQueuedInput(method, text, text);
    return;
  }
  startTurn(text, extra);
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
  restoreInputText(text);
  if (!runtimeClosing) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function restoreInputText(text) {
  pendingInputPrefill = String(text || "");
  if (activeInputSession?.editor) {
    activeInputSession.editor.setInput(pendingInputPrefill);
    pendingInputPrefill = "";
    redrawInput();
  }
}

function inputState() {
  const running = activeTurn || activeCompact;
  return {
    running,
    label: activeCompact ? "Compacting" : "Working",
    frame: activityFrame,
    elapsedMs: running ? Date.now() - activityStartedAt : 0,
  };
}

function mainPromptText() {
  return promptText(sessionInfo, latestStats, inputState());
}

function refreshInputState() {
  updateActivityTimer();
  redrawInput();
}

function resetContextUsage() {
  latestStats = { context_usage_percent: 0 };
  redrawInput();
}

function redrawInput(force = false) {
  if (!inputActive || runtimeClosing || !terminalUi) {
    return;
  }
  terminalUi.requestRender(force);
}

function updateActivityTimer() {
  if (activeTurn || activeCompact) {
    if (!activityStartedAt) {
      activityStartedAt = Date.now();
    }
    if (activityTimer) {
      return;
    }
    activityTimer = setInterval(() => {
      activityFrame += 1;
      redrawInput();
    }, 300);
    activityTimer.unref?.();
    return;
  }
  clearActivityTimer();
}

function clearActivityTimer() {
  if (!activityTimer) {
    return;
  }
  clearInterval(activityTimer);
  activityTimer = null;
  activityFrame = 0;
  activityStartedAt = 0;
}

function startTurn(text, extra = {}) {
  if (runtimeClosing) {
    return;
  }
  activeTurn = true;
  assistantHeaderShown = false;
  resetTurnTools();
  refreshInputState();
  void runTurn(text, extra).catch((error) => handleSubmissionError(error, text));
}

async function runTurn(text, extra = {}) {
  try {
    await request("turn.start", { input: text, ...extra });
  } finally {
    activeTurn = false;
    interruptRequested = false;
    closeAssistant();
    refreshInputState();
  }
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (!runtime.stdin.writable || runtime.destroyed) {
      reject(new Error("Runtime stdin is closed"));
      return;
    }
    pending.set(id, { resolve, reject });
    runtime.stdin.write(JSON.stringify(createRuntimeRequest(id, method, params)) + "\n", (error) => {
      if (!error) {
        return;
      }
      pending.delete(id);
      reject(error);
    });
  });
}

function logOutput(text) {
  flushAssistantText(assistantStreamBuffer.flush(), { redraw: true });
  withSuspendedPrompt(() => {
    closeOpenAssistantOutputLine();
    process.stdout.write(outputBlockText(text, outputStarted));
    outputStarted = true;
  });
}

function writeOutput(text) {
  const holdPartialLine = inputActive && Boolean(terminalUi);
  flushAssistantText(assistantStreamBuffer.push(text, holdPartialLine));
}

function flushAssistantText(text = "", options = {}) {
  const output = String(text || "");
  if (!output) {
    return;
  }
  withSuspendedPrompt(() => {
    writeAssistantHeader();
    process.stdout.write(output);
    assistantOutputLineOpen = output ? !output.endsWith("\n") : assistantOutputLineOpen;
  }, { redraw: options.redraw !== false });
}

function writeUserInput(text) {
  const line = userInputText(text);
  if (!line) {
    return;
  }
  flushAssistantText(assistantStreamBuffer.flush(), { redraw: false });
  closeOpenAssistantOutputLine();
  process.stdout.write(outputBlockText(line, outputStarted));
  outputStarted = true;
}

function writeErrorOutput(text) {
  flushAssistantText(assistantStreamBuffer.flush(), { redraw: true });
  withSuspendedPrompt(() => process.stderr.write(String(text || "")));
}

function withSuspendedPrompt(action, options = {}) {
  if (!terminalUi || !inputActive || runtimeClosing) {
    action();
    return;
  }
  terminalUi.withSuspended(action, { render: options.redraw !== false });
}

function closeOpenAssistantOutputLine() {
  if (!assistantOutputLineOpen) {
    return;
  }
  process.stdout.write("\n");
  assistantOutputLineOpen = false;
}

function writeAssistantHeader() {
  if (assistantHeaderShown) {
    return;
  }
  process.stdout.write(outputBlockText(assistantHeaderText(), outputStarted));
  outputStarted = true;
  assistantHeaderShown = true;
}

function receive(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.kind === "response") {
    finishRequest(message);
    return;
  }
  if (message.kind === "event") {
    void renderEvent(message).catch((error) => {
      if (!runtimeClosing) {
        writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
  }
}

function finishRequest(message) {
  const callbacks = pending.get(runtimeRequestId(message));
  if (!callbacks) {
    return;
  }
  pending.delete(runtimeRequestId(message));
  if (message.error) {
    callbacks.reject(new Error(message.error.message || "Runtime request failed"));
  } else {
    callbacks.resolve(message.result);
  }
}

async function renderEvent(message) {
  if (runtimeClosing) {
    return;
  }
  const event = message?.event;
  const eventType = runtimeEventType(message);
  if (!event || typeof event !== "object") {
    if (cliArgs.includes("--debug")) {
      writeErrorOutput(`Ignoring runtime event without payload: ${eventType || "unknown"}\n`);
    }
    return;
  }
  switch (eventType) {
    case "assistant_delta":
      assistantRenderer.append(event.text || "");
      return;
    case "context_built": {
      if (compactContextState.handleContextBuilt(event)) {
        resetContextUsage();
      }
      const line = contextBuiltLine(event);
      if (line) {
        closeAssistant();
        logOutput(line);
      }
      return;
    }
    case "tool_input_started":
      closeAssistant();
      if (event.tool_call_id) {
        if (announcedTools.has(event.tool_call_id)) {
          return;
        }
        announcedTools.add(event.tool_call_id);
      }
      logOutput(toolStartedLine(event));
      return;
    case "tool_input_delta":
    case "tool_input_ended":
      return;
    case "tool_requested":
      closeAssistant();
      if (event.tool_call_id) {
        if (announcedTools.has(event.tool_call_id)) {
          return;
        }
        announcedTools.add(event.tool_call_id);
      }
      logOutput(toolRequestedLine(event));
      return;
    case "tool_call_started":
      closeAssistant();
      if (event.tool_call_id && announcedTools.has(event.tool_call_id)) {
        return;
      }
      logOutput(toolStartedLine(event));
      return;
    case "tool_result":
      closeAssistant();
      const fileChange = pendingFileChanges.get(event.tool_call_id);
      pendingFileChanges.delete(event.tool_call_id);
      recordToolResult(event);
      logOutput(toolResultLine(event, fileChange));
      return;
    case "file_change":
      if (event.tool_call_id) {
        pendingFileChanges.set(event.tool_call_id, event);
      }
      return;
    case "tool_progress": {
      closeAssistant();
      const line = toolProgressLine(event);
      if (line) {
        logOutput(line);
      }
      return;
    }
    case "token_stats_updated":
      closeAssistant();
      latestStats = event.stats && typeof event.stats === "object" ? event.stats : {};
      if (!activeTurn) {
        redrawInput();
      }
      return;
    case "skill_activated":
      closeAssistant();
      logOutput(skillLine(event));
      return;
    case "user_question_requested":
      await answerQuestion(event);
      return;
    case "turn_failed":
      compactContextState.clear();
      closeAssistant();
      logOutput(errorLine(event.error));
      resetTurnTools();
      return;
    case "turn_cancelled":
      compactContextState.clear();
      closeAssistant();
      logOutput(cancelledText());
      resetTurnTools();
      return;
    case "turn_completed":
      compactContextState.clear();
      closeAssistant();
      logOutput(turnCompletedLine(event, turnTools));
      resetTurnTools();
      return;
    default:
      if (cliArgs.includes("--debug")) {
        writeErrorOutput(`Ignoring unknown runtime event: ${eventType || "unknown"}\n`);
      }
  }
}

function recordToolResult(event) {
  if (event.status === "failed") {
    turnTools.failed += 1;
    return;
  }
  turnTools.completed += 1;
}

function resetTurnTools() {
  turnTools = { completed: 0, failed: 0 };
  announcedTools.clear();
  pendingFileChanges.clear();
}

async function answerQuestion(event) {
  pausePrompt();
  closeAssistant();
  logOutput(questionText(event));
  try {
    const options = Array.isArray(event.options) ? event.options : [];
    const answer = terminalUi && options.length
      ? await askChoiceMenu(event)
      : selectAnswer((await ask(answerPromptText(), answerPlaceholderText())).trim(), options);
    if (interruptRequested || runtimeClosing) {
      return;
    }
    await request("user_question.respond", {
      tool_call_id: event.tool_call_id,
      answer,
    });
  } finally {
    resumePrompt();
  }
}

function selectAnswer(raw, options) {
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1];
  }
  return raw;
}

function ask(prompt, placeholder = "") {
  if (!terminalUi) {
    if (!input) {
      return Promise.reject(new Error("Input is not available"));
    }
    return askLine(promptValue(prompt));
  }
  return askTtyInput(prompt, placeholder);
}

function askLine(prompt) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      inputActive = false;
      input.off("close", onClose);
      if (cancelActiveInput === onCancel) {
        cancelActiveInput = null;
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Input closed"));
    };
    const onCancel = () => {
      cleanup();
      resolve("");
    };
    input.once("close", onClose);
    cancelActiveInput = onCancel;
    inputActive = true;
    input.question(prompt, (answer) => {
      cleanup();
      resolve(answer);
    });
    applyInputPrefill();
  });
}

function askTtyInput(prompt, placeholder) {
  return new Promise((resolve) => {
    clearAssistantLineForInput();
    const mode = placeholder && placeholder !== answerPlaceholderText() ? "prompt" : "line";
    const initialInput = pendingInputPrefill;
    const editor = mode === "prompt" ? promptEditor : createLineEditor(initialInput);
    if (mode === "prompt") {
      editor.setInput(initialInput);
    }
    editor.setViewportWidth(process.stdout.columns || 80);
    const menuState = mode === "prompt" ? createSlashMenuState(slashCommands) : null;
    pendingInputPrefill = "";
    const session = { mode, prompt, placeholder, editor, menuState, resolve };
    activeInputSession = session;
    inputActive = true;
    cancelActiveInput = () => completeTtyInput(session, "", false);
    redrawInput(true);
  });
}

function clearAssistantLineForInput() {
  if (!assistantOutputLineOpen) {
    return;
  }
  if (terminalUi) {
    terminalUi.withSuspended(closeOpenAssistantOutputLine, { render: false });
  } else {
    closeOpenAssistantOutputLine();
  }
}

function renderActiveInput(width = process.stdout.columns || 80) {
  const session = activeInputSession;
  if (!session) {
    return { lines: [], cursorRow: 0, cursorColumn: 0 };
  }
  if (session.mode === "model") {
    return prepareComposerFrame({
      prompt: mainPromptText(),
      inputText: session.inputText,
      cursor: { line: 0, column: session.inputText.length },
      menuText: modelMenuText(session.modelState.items(), session.modelState.selectedIndex()).trimEnd(),
    }, width);
  }
  if (session.mode === "choice") {
    return prepareComposerFrame({
      prompt: mainPromptText(),
      inputText: session.question,
      cursor: { line: 0, column: session.question.length },
      menuText: choiceMenuText(session.choiceState.options(), session.choiceState.selectedIndex(), session.recommended).trimEnd(),
    }, width);
  }
  if (session.mode === "sessions") {
    return prepareComposerFrame({
      prompt: mainPromptText(),
      inputText: session.inputText,
      cursor: { line: 0, column: session.inputText.length },
      menuText: sessionMenuText(session.choiceState.options(), session.choiceState.selectedIndex()).trimEnd(),
    }, width);
  }
  session.editor.setViewportWidth(width);
  const matches = session.menuState ? syncSlashMenu(session) : [];
  return prepareComposerFrame({
    prompt: promptValue(session.prompt),
    inputText: session.editor.input(),
    cursor: session.editor.cursorPosition(),
    placeholder: session.mode === "prompt" ? inputHintText(session.placeholder) : "",
    menuText: session.menuState ? slashMenuText(matches, session.menuState.selectedIndex()).trimEnd() : "",
  }, width);
}

function syncSlashMenu(session) {
  session.menuState.setInput(session.editor.input());
  return session.menuState.matches();
}

function handleTerminalInput(raw = "") {
  const event = parseTerminalKey(raw);
  if (!event) {
    return;
  }
  if (event.ctrl && event.name === "c") {
    handleSigint();
    return;
  }
  const session = activeInputSession;
  if (!session) {
    return;
  }
  if (session.mode === "model") {
    handleModelInput(session, event);
    return;
  }
  if (session.mode === "choice") {
    handleChoiceInput(session, event);
    return;
  }
  if (session.mode === "sessions") {
    handleSessionInput(session, event);
    return;
  }
  const key = event;
  const matches = session.menuState ? syncSlashMenu(session) : [];
  const menuKey = !key.ctrl && !key.alt && !key.shift && ["escape", "up", "down"].includes(key.name);
  if (session.menuState && matches.length && menuKey) {
    if (session.menuState.handleKey("", key)) {
      redrawInput();
      return;
    }
  }
  const result = session.editor.handleInput(key);
  if (result === "submit") {
    submitTtyInput(session);
    return;
  }
  if (result) {
    redrawInput();
  }
}

function handleTerminalPaste(text) {
  const session = activeInputSession;
  if (!session || session.mode === "model" || session.mode === "choice" || session.mode === "sessions") {
    return;
  }
  session.editor.handleInput({ kind: "paste", text });
  redrawInput();
}

function handleModelInput(session, key) {
  const modified = key.ctrl || key.alt || key.shift;
  if (!modified && (key.name === "enter" || key.name === "return")) {
    const model = session.modelState.selectedModel()?.name || "";
    completeTtyInput(session, model, Boolean(model), "", model ? `/model set ${model}` : "");
    return;
  }
  if (!modified && key.name === "escape") {
    completeTtyInput(session, "", false);
    return;
  }
  if (!modified && session.modelState.handleKey(key)) {
    redrawInput();
  }
}

function submitTtyInput(session) {
  if (session.menuState) {
    syncSlashMenu(session);
  }
  const command = session.menuState?.selectedCommand();
  const value = command ? `/${command.name}` : session.editor.input();
  if (session.mode === "prompt") {
    session.editor.addToHistory(value);
  }
  completeTtyInput(session, value, session.mode === "prompt", session.mode === "line" ? "\n" : "");
}

function completeTtyInput(session, value, writeUser, lineText = "", displayValue = value) {
  if (activeInputSession !== session) {
    return;
  }
  activeInputSession = null;
  inputActive = false;
  if (cancelActiveInput) {
    cancelActiveInput = null;
  }
  const writeAction = () => {
    if (writeUser) {
      writeUserInput(displayValue);
    } else if (lineText && String(value || "").trim()) {
      process.stdout.write("\n");
    }
  };
  if (terminalUi) {
    terminalUi.withSuspended(writeAction, { render: false });
  } else {
    writeAction();
  }
  session.resolve(value);
}

function askModelMenu(models, currentModel) {
  return new Promise((resolve) => {
    clearAssistantLineForInput();
    const state = createModelMenuState(models, currentModel);
    if (!state.items().length) {
      resolve("");
      return;
    }
    const session = {
      mode: "model",
      inputText: "/model",
      modelState: state,
      resolve,
    };
    activeInputSession = session;
    inputActive = true;
    cancelActiveInput = () => completeTtyInput(session, "", false);
    redrawInput(true);
  });
}

function askChoiceMenu(event) {
  return new Promise((resolve) => {
    clearAssistantLineForInput();
    const state = createChoiceMenuState(event.options, event.recommended);
    const session = {
      mode: "choice",
      question: String(event.question || "Input required"),
      choiceState: state,
      recommended: event.recommended || "",
      resolve,
    };
    activeInputSession = session;
    inputActive = true;
    cancelActiveInput = () => completeTtyInput(session, "", false);
    redrawInput(true);
  });
}

function askSessionMenu(options, sessions, currentIndex) {
  return new Promise((resolve) => {
    clearAssistantLineForInput();
    const state = createChoiceMenuState(options, options[currentIndex] || "");
    const session = {
      mode: "sessions",
      inputText: "/sessions",
      choiceState: state,
      sessions,
      resolve,
    };
    activeInputSession = session;
    inputActive = true;
    cancelActiveInput = () => completeTtyInput(session, null, false);
    redrawInput(true);
  });
}

function handleChoiceInput(session, key) {
  const modified = key.ctrl || key.alt || key.shift;
  if (!modified && (key.name === "enter" || key.name === "return")) {
    completeTtyInput(session, session.choiceState.selectedOption(), false);
    return;
  }
  if (!modified && key.name === "escape") {
    completeTtyInput(session, "", false);
    return;
  }
  if (!modified && session.choiceState.handleKey(key)) {
    redrawInput();
  }
}

function handleSessionInput(session, key) {
  const modified = key.ctrl || key.alt || key.shift;
  if (!modified && (key.name === "enter" || key.name === "return")) {
    const index = session.choiceState.selectedIndex();
    completeTtyInput(session, session.sessions[index] || null, false);
    return;
  }
  if (!modified && key.name === "escape") {
    completeTtyInput(session, null, false);
    return;
  }
  if (!modified && session.choiceState.handleKey(key)) {
    redrawInput();
  }
}

function normalizeSlashCommands(commands) {
  if (!Array.isArray(commands)) {
    return [];
  }
  const items = [];
  for (const command of commands) {
    const name = singleWord(command?.name);
    if (!name) {
      continue;
    }
    const description = String(command.description || "").trim();
    items.push({ name, description });
    for (const alias of command.aliases || []) {
      const aliasName = singleWord(alias);
      if (aliasName) {
        items.push({ name: aliasName, description: `alias for /${name}` });
      }
    }
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

function singleWord(value) {
  const text = String(value || "").trim().toLowerCase();
  return text && !/\s/.test(text) ? text : "";
}

function isBareModelCommand(value) {
  return String(value || "").trim().toLowerCase() === "/model";
}

function isBareSessionsCommand(value) {
  return String(value || "").trim().toLowerCase() === "/sessions";
}

function isCompactCommand(value) {
  return String(value || "").trim().toLowerCase() === "/compact";
}

function singleLineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pausePrompt() {
  promptPaused = true;
  cancelInput();
}

function resumePrompt() {
  promptPaused = false;
  while (promptResumeWaiters.length) {
    promptResumeWaiters.shift()();
  }
}

function waitForPromptResume() {
  if (!promptPaused) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    promptResumeWaiters.push(resolve);
  });
}

function applyInputPrefill() {
  if (!pendingInputPrefill) {
    return;
  }
  const text = pendingInputPrefill;
  pendingInputPrefill = "";
  input.write(text);
}

function promptValue(prompt) {
  return typeof prompt === "function" ? prompt() : prompt;
}



function handleSigint() {
  const action = sigintAction({ activeTurn: activeTurn || activeCompact, interruptRequested, runtimeClosing });
  if (action === "interrupt") {
    interruptTurn();
  } else {
    exitFromSignal();
  }
}

function interruptTurn() {
  interruptRequested = true;
  cancelInput();
  closeAssistant();
  logOutput(interruptText());
  void request("turn.interrupt").catch(() => {});
}

function handleStdinData(chunk) {
  if (Buffer.from(chunk).includes(3)) {
    handleSigint();
  }
}

function exitFromSignal() {
  forceCloseRuntime();
  scheduleProcessExit(0, 0);
}

function closeAssistant() {
  assistantRenderer.finish();
  flushAssistantText(assistantStreamBuffer.flush());
  assistantHeaderShown = false;
}

function closeRuntime() {
  if (runtimeClosing) {
    return;
  }
  runtimeClosing = true;
  clearActivityTimer();
  if (runtime.exitCode === null && !runtime.killed) {
    if (runtime.stdin.writable) {
      runtime.stdin.end(JSON.stringify({ id: nextId++, method: "shutdown", params: {} }) + "\n");
    }
    scheduleRuntimeKill();
  }
  closeInput();
}

function forceCloseRuntime() {
  runtimeClosing = true;
  clearActivityTimer();
  clearRuntimeKillTimer();
  closeInput();
  killRuntime();
}

function cancelInput() {
  const cancel = cancelActiveInput;
  cancelActiveInput = null;
  cancel?.();
}

function killRuntime() {
  if (runtime.killed || runtime.exitCode !== null) {
    return;
  }
  try {
    runtime.kill("SIGKILL");
  } catch {
    // Ignore kill races; the process may already be exiting.
  }
}

async function shutdownRuntime() {
  if (runtimeClosing) {
    return;
  }
  runtimeClosing = true;
  clearActivityTimer();
  scheduleRuntimeKill();
  try {
    await request("shutdown");
  } catch {
    killRuntime();
  } finally {
    if (runtime.stdin.writable) {
      runtime.stdin.end();
    }
    closeInput();
  }
}

function scheduleRuntimeKill() {
  clearRuntimeKillTimer();
  runtimeKillTimer = setTimeout(() => {
    killRuntime();
  }, 1500);
  runtimeKillTimer.unref?.();
}

function clearRuntimeKillTimer() {
  if (!runtimeKillTimer) {
    return;
  }
  clearTimeout(runtimeKillTimer);
  runtimeKillTimer = null;
}

function scheduleProcessExit(code, delayMs) {
  if (processExitTimer) {
    return;
  }
  process.exitCode = code;
  processExitTimer = setTimeout(() => {
    try {
      closeInput();
    } finally {
      process.exit(code);
    }
  }, delayMs);
}

function closeInput() {
  cancelInput();
  process.stdin.off("data", handleStdinData);
  if (input) {
    const current = input;
    input = null;
    try {
      current.close();
    } catch {
      // Ignore readline close races during signal shutdown.
    }
  }
  if (terminalUi) {
    terminalUi.stop();
  } else {
    process.stdin.pause();
  }
}
