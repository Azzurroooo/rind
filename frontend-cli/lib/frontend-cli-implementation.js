#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { AssistantRenderer } from "./assistant-renderer.js";
import { createAssistantStreamBuffer } from "./assistant-stream-buffer.js";
import { createCompactContextState } from "./compact-context-state.js";
import { prepareComposerFrame } from "./composer-terminal.js";
import { createLineEditor } from "./line-editor.js";
import { createRuntimeClient, runHelpVersion } from "./runtime-client.js";
import { createTurnController } from "./turn-controller.js";
import { createCommandController } from "./command-controller.js";
import { createTaskMonitorController } from "./task-monitor-controller.js";
import { createEventController } from "./event-controller.js";
import { createInputController } from "./input-controller.js";
import { isInputClosed } from "./input-errors.js";
import { sigintAction } from "./interrupt-state.js";
import { createModelMenuState } from "./model-menu-state.js";
import { createChoiceMenuState } from "./choice-menu-state.js";
import { createSlashMenuState } from "./slash-menu-state.js";
import { parseTerminalKey } from "./terminal-key.js";
import { createTerminalUI } from "./terminal-ui.js";
import {
  answerPromptText,
  answerPlaceholderText,
  commandResultText,
  goalCommandText,
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
  slashMenuText,
  startupText,
  userInputText,
} from "./rendering.js";

export async function runFrontendCliApp(cliArgs = process.argv.slice(2)) {
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const python = process.env.RIND_PYTHON || "python";
const runtimePath = process.env.RIND_RUNTIME_PATH || resolveInstalledRuntime();

function resolveInstalledRuntime() {
  const packageNames = {
    win32: "@rind-ai/runtime-win32-x64",
    linux: "@rind-ai/runtime-linux-x64",
    darwin: process.arch === "arm64" ? "@rind-ai/runtime-darwin-arm64" : "@rind-ai/runtime-darwin-x64",
  };
  const packageName = packageNames[process.platform];
  if (!packageName) return "";
  try {
    const packageRoot = path.dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`));
    return path.join(packageRoot, "bin", process.platform === "win32" ? "rind-runtime.exe" : "rind-runtime");
  } catch {
    return "";
  }
}

if (cliArgs.some((arg) => arg === "--version" || arg === "--help" || arg === "-h")) {
  process.exit(runHelpVersion({ python, repoRoot, runtimePath, cliArgs }));
}

let activeTurn = false;
let activeCompact = false;
let interruptRequested = false;
let input = null;
let inputActive = false;
let runtimeClosing = false;
let processExitTimer = null;
let cancelActiveInput = null;
let sessionInfo = {};
let latestStats = {};
let slashCommands = [];
let turnTools = { completed: 0, failed: 0 };
let pendingInputPrefill = "";
let assistantOutputLineOpen = false;
let assistantHeaderShown = false;
let outputStarted = false;
let promptPaused = false;
let activityFrame = 0;
let activityTimer = null;
let activityStartedAt = 0;
const assistantStreamBuffer = createAssistantStreamBuffer();
const assistantRenderer = new AssistantRenderer((text) => writeOutput(text));
const compactContextState = createCompactContextState();
const terminalUi = process.stdin.isTTY && process.stdout.isTTY
  ? createTerminalUI({ input: process.stdin, output: process.stdout, render: renderActiveInput })
  : null;
const promptEditor = createLineEditor();
let activeInputSession = null;

function suspendPrompt(action, options = {}) {
  if (!terminalUi || runtimeClosing) {
    return action();
  }
  return terminalUi.withSuspended(action, { render: options.redraw !== false });
}

const runtimeClient = createRuntimeClient({
  python,
  repoRoot,
  runtimePath,
  cliArgs,
  onMessage: (message) => void renderEvent(message).catch((error) => {
    if (!runtimeClosing) {
      writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }),
  onStderr: (chunk) => writeErrorOutput(chunk),
  onExit: (code, signal, { error }) => {
    if (!runtimeClosing) {
      writeErrorOutput(`Runtime stopped (${signal || (code ?? "startup failure")}): ${error.message}. Restart Rind to continue.\n`);
    }
    process.exitCode = runtimeClosing ? 0 : (code || 1);
    closeInput();
    if (runtimeClosing) {
      scheduleProcessExit(process.exitCode ?? 0, 0);
    }
  },
});
const request = runtimeClient.request;
const turnState = {
  get activeTurn() {
    return activeTurn;
  },
  set activeTurn(value) {
    activeTurn = Boolean(value);
  },
  get interruptRequested() {
    return interruptRequested;
  },
  set interruptRequested(value) {
    interruptRequested = Boolean(value);
  },
  get turnTools() {
    return turnTools;
  },
  set turnTools(value) {
    turnTools = value;
  },
  get runtimeClosing() {
    return runtimeClosing;
  },
};
const turnController = createTurnController({
  request,
  state: turnState,
  refreshGoalState,
  onTurnStart: () => {
    assistantHeaderShown = false;
  },
  output: {
    logQueuedInput: (text) => logOutput(queuedInputText(text)),
    restoreInputText,
    writeError: (text) => writeErrorOutput(`${text}\n`),
    refreshInputState,
    resetTurnTools,
    closeAssistant,
    cancelInput,
    logInterrupt: () => logOutput(interruptText()),
  },
});
const commandController = createCommandController({
  request,
  turn: turnController,
  input: {
    isTerminal: Boolean(terminalUi),
    runGoalCommand,
    runModelSelector,
    startCompactCommand,
    runSessionsSelector,
    startReadonlySlashCommand,
  },
  state: {
    get slashCommands() {
      return slashCommands;
    },
  },
  output: {
    log: logOutput,
    clearScreen: () => suspendPrompt(() => console.clear()),
    resetContextUsage,
    setInputPrefill: (value) => {
      pendingInputPrefill = value;
    },
    shutdown: shutdownRuntime,
    exit: () => process.exit(0),
  },
});
const taskMonitorController = createTaskMonitorController({
  request,
  terminalUi: Boolean(terminalUi),
  state: {
    get runtimeClosing() {
      return runtimeClosing;
    },
    get sessionInfo() {
      return sessionInfo;
    },
    set sessionInfo(value) {
      sessionInfo = value;
    },
    get inputActive() {
      return inputActive;
    },
    set inputActive(value) {
      inputActive = Boolean(value);
    },
  },
  redraw: redrawInput,
  log: logOutput,
});
const eventController = createEventController({
  state: {
    get runtimeClosing() {
      return runtimeClosing;
    },
    get activeTurn() {
      return activeTurn;
    },
    debug: cliArgs.includes("--debug"),
  },
  input: { answerQuestion },
  monitor: taskMonitorController,
  output: {
    assistantAppend: (text) => assistantRenderer.append(text),
    handleContextBuilt: (event) => compactContextState.handleContextBuilt(event),
    resetContextUsage,
    closeAssistant,
    log: logOutput,
    debug: (text) => writeErrorOutput(`${text}\n`),
    updateGoal: updateGoalState,
    setStats: (stats) => {
      latestStats = stats;
    },
    redraw: redrawInput,
    clearCompactContext: () => compactContextState.clear(),
    resetTurnTools,
  },
});
const inputController = createInputController({
  terminalUi,
  state: {
    get runtimeClosing() {
      return runtimeClosing;
    },
    get promptPaused() {
      return Boolean(promptPaused);
    },
    set promptPaused(value) {
      promptPaused = Boolean(value);
    },
  },
  askInput: ask,
  onSubmit: (text) => turnController.submit(text),
  onCommand: (text) => commandController.handle(text),
  onSigint: handleSigint,
  onPaste: handleTerminalPaste,
  onInput: handleTerminalInput,
  cancelInput,
  renderPrompt: redrawInput,
  prompt: mainPromptText,
  placeholder: promptPlaceholderText,
});

process.on("SIGINT", handleSigint);

try {
  const info = await request("initialize");
  sessionInfo = { cwd: process.cwd(), ...(info || {}) };
  slashCommands = commandController.normalizeCommands(info?.slash_commands);
  if (terminalUi) {
    inputController.start();
  } else {
    input = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 100,
      removeHistoryDuplicates: true,
    });
    process.stdin.on("data", handleStdinData);
  }
  if (terminalUi) {
    void taskMonitorController.refresh().catch(() => {});
  }
  logOutput(startupText(info));
  await inputController.promptLoop();
} catch (error) {
  closeAssistant();
  if (!isInputClosed(error)) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  closeRuntime();
}

async function runGoalCommand(command) {
  if (command.action === "set" && turnState.activeTurn) {
    logOutput(commandResultText("Goal not started", "pause or finish the active turn first"));
    return;
  }
  try {
    if (command.action === "set") {
      const result = await request("goal.set", { objective: command.objective });
      updateGoalState(result?.goal);
      logOutput(goalCommandText(result?.goal, "set"));
      turnController.submit(command.objective);
      return;
    }
    if (command.action === "clear") {
      const result = await request("goal.clear");
      updateGoalState(result?.goal || null);
      logOutput(goalCommandText(null, "clear"));
      return;
    }
    if (command.action === "pause" || command.action === "resume") {
      const result = await request("goal.status", { status: command.action === "resume" ? "active" : "paused" });
      updateGoalState(result?.goal);
      logOutput(goalCommandText(result?.goal, command.action));
      if (command.action === "resume" && !turnState.activeTurn) {
        turnController.submit("", { goal_continuation: true });
      }
      return;
    }
    const result = await request("goal.get");
    updateGoalState(result?.goal || null);
    logOutput(goalCommandText(result?.goal || null));
  } catch (error) {
    logOutput(`Goal command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function updateGoalState(goal) {
  sessionInfo = { ...sessionInfo, goal: goal && typeof goal === "object" ? goal : null };
  redrawInput();
}

async function refreshGoalState() {
  if (!Array.isArray(sessionInfo.capabilities) || !sessionInfo.capabilities.includes("goals")) {
    return;
  }
  try {
    const result = await request("goal.get");
    updateGoalState(result?.goal || null);
  } catch {
    // The turn result remains usable when a late state refresh races shutdown.
  }
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
    await commandController.applyResult(result);
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
    taskMonitorController.clear();
    sessionInfo = {
      ...sessionInfo,
      session_id: update?.session_id || selected.id,
      model: update?.model || sessionInfo.model,
      resume_preview: update?.resume_preview || "",
      goal: update?.goal || null,
      background_count: 0,
      delegate_count: 0,
    };
    latestStats = update?.usage && typeof update.usage === "object" ? update.usage : {};
    compactContextState.clear();
    logOutput(sessionSwitchedText(sessionInfo));
    redrawInput();
    void taskMonitorController.refresh().catch(() => {});
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

function startReadonlySlashCommand(text) {
  void runReadonlySlashCommand(text).catch((error) => {
    if (!runtimeClosing) {
      writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}

async function runReadonlySlashCommand(text) {
  const result = await request("slash.execute", { input: text });
  await commandController.applyResult(result);
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
    await commandController.applyResult(result);
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

function logOutput(text) {
  flushAssistantText(assistantStreamBuffer.flush(), { redraw: true });
  suspendPrompt(() => {
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
  suspendPrompt(() => {
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
  const stream = terminalUi && !runtimeClosing ? process.stdout : process.stderr;
  suspendPrompt(() => stream.write(String(text || "")));
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

async function renderEvent(message) {
  return eventController.handle(message);
}

function resetTurnTools() {
  turnTools = { completed: 0, failed: 0 };
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
  suspendPrompt(closeOpenAssistantOutputLine, { redraw: false });
}

function renderActiveInput(width = process.stdout.columns || 80) {
  const inputFrame = renderInputSession(width);
  if (!taskMonitorController.isMonitoring()) {
    return inputFrame;
  }
  const monitorFrame = taskMonitorController.frame(width);
  const monitorOffset = inputFrame.lines.length;
  const focusRow = monitorFrame.focusRow === undefined
    ? monitorOffset
    : monitorOffset + monitorFrame.focusRow;
  return {
    lines: [...inputFrame.lines, ...monitorFrame.lines],
    cursorRow: inputFrame.cursorRow,
    cursorColumn: inputFrame.cursorColumn,
    focusRow,
    fixedPrefixRows: monitorOffset,
  };
}

function renderInputSession(width) {
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
  if (taskMonitorController.isMonitoring()) {
    taskMonitorController.handleInput(event);
    return;
  }
  if (event.ctrl && event.name === "b") {
    taskMonitorController.enterMonitor();
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
  if (taskMonitorController.isMonitoring()) {
    return;
  }
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
  suspendPrompt(writeAction, { redraw: false });
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

function singleLineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pausePrompt() {
  inputController.pause();
}

function resumePrompt() {
  inputController.resume();
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
  turnController.interrupt();
}

function handleStdinData(chunk) {
  if (Buffer.from(chunk).includes(3)) {
    handleSigint();
  }
}

function exitFromSignal() {
  if (runtimeClosing) {
    forceCloseRuntime();
    scheduleProcessExit(0, 0);
    return;
  }
  void shutdownRuntime();
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
  taskMonitorController.stop();
  void runtimeClient.shutdown();
  closeInput();
}

function forceCloseRuntime() {
  runtimeClosing = true;
  clearActivityTimer();
  taskMonitorController.stop();
  closeInput();
  runtimeClient.forceShutdown();
}

function cancelInput() {
  const cancel = cancelActiveInput;
  cancelActiveInput = null;
  cancel?.();
}

async function shutdownRuntime() {
  if (runtimeClosing) {
    return;
  }
  runtimeClosing = true;
  clearActivityTimer();
  taskMonitorController.stop();
  try {
    await runtimeClient.shutdown();
  } catch {
    runtimeClient.forceShutdown();
  } finally {
    runtimeClient.closeInput();
    closeInput();
  }
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
  inputController.close();
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
  if (!terminalUi) {
    process.stdin.pause();
  }
}
}
