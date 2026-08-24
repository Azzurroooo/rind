#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { createCompactContextState } from "./compact-context-state.js";
import { prepareComposerFrame } from "./composer-terminal.js";
import { createRuntimeClient, runHelpVersion } from "./runtime-client.js";
import {
  requireRuntimeInitialization,
  runtimeMethods,
  sessionScopedMethods,
  turnScopedMethods,
  isRuntimeEventForTurn,
} from "./runtime-protocol.js";
import { executeLocalSlashCommand, loadLocalSettings } from "./local-slash-commands.js";
import { createTurnController } from "./turn-controller.js";
import { createCommandController } from "./command-controller.js";
import { createTaskMonitorController } from "./task-monitor-controller.js";
import { createEventController } from "./event-controller.js";
import { createInputController } from "./input-controller.js";
import { isInputClosed } from "./input-errors.js";
import { sigintAction } from "./interrupt-state.js";
import { CUSTOM_ANSWER_LABEL } from "./question-menu-state.js";
import { createCliState } from "./cli-state.js";
import { createCliRuntimeController } from "./cli-runtime-controller.js";
import { createCliOutputController } from "./cli-output-controller.js";
import { createCliInputActions } from "./cli-input-actions.js";
import { createTerminalUI } from "./terminal-ui.js";
import {
  inputHintText,
  interruptText,
  modelMenuText,
  questionMenuFrame,
  sessionMenuText,
  promptPlaceholderText,
  slashMenuText,
  startupText,
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

const cliState = createCliState();
const runtimeState = cliState.runtime;
const sessionState = cliState.session;
const turnStateData = cliState.turn;
const inputStateData = cliState.input;
const displayState = cliState.display;
let input = null;
const compactContextState = createCompactContextState();
const terminalUi = process.stdin.isTTY && process.stdout.isTTY
  ? createTerminalUI({ input: process.stdin, output: process.stdout, render: renderActiveInput })
  : null;
let inputActions;
let inputController;
let eventProcessing = Promise.resolve();

const outputController = createCliOutputController({
  state: cliState,
  terminalUi,
});
const {
  redraw: redrawInput,
  refreshInputState,
  clearActivityTimer,
  mainPromptText,
  log: logOutput,
  writeError: writeErrorOutput,
  closeAssistant,
  renderHistory,
} = outputController;

const runtimeClient = createRuntimeClient({
  python,
  repoRoot,
  runtimePath,
  cliArgs,
  onMessage: (message) => {
    eventProcessing = eventProcessing
      .then(() => renderEvent(message))
      .catch((error) => {
        if (runtimeState.status !== "closing") {
          writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
  },
  onStderr: (chunk) => writeErrorOutput(chunk),
  onExit: (code, signal, { error }) => {
    const wasClosing = runtimeState.status === "closing";
    runtimeState.status = "failed";
    runtimeState.initialization = null;
    turnStateData.id = "";
    displayState.lastEventSequence = 0;
    turnStateData.active = false;
    turnStateData.interruptRequested = false;
    inputActions?.clearPendingInputs();
    if (!wasClosing) {
      runtimeState.failure = error;
      writeErrorOutput(`Runtime stopped (${signal || (code ?? "startup failure")}): ${error.message}. Runtime commands are unavailable until it restarts.\n`);
    } else {
      process.exitCode = 0;
      scheduleProcessExit(0, 0);
    }
  },
});
const turnState = {
  get activeTurn() {
    return turnStateData.active;
  },
  set activeTurn(value) {
    turnStateData.active = Boolean(value);
  },
  get interruptRequested() {
    return turnStateData.interruptRequested;
  },
  set interruptRequested(value) {
    turnStateData.interruptRequested = Boolean(value);
  },
  get runtimeClosing() {
    return runtimeState.status === "closing";
  },
};
let turnController;
let commandController;
let taskMonitorController;
const runtimeController = createCliRuntimeController({
  client: runtimeClient,
  methods: runtimeMethods,
  sessionScopedMethods,
  turnScopedMethods,
  requireInitialization: requireRuntimeInitialization,
  state: cliState,
  getCommands: () => commandController,
  getTurnController: () => turnController,
  getTaskMonitor: () => taskMonitorController,
  getCompactContextState: () => compactContextState,
  askModelMenu: (...args) => inputActions.askModelMenu(...args),
  askSessionMenu: (...args) => inputActions.askSessionMenu(...args),
  restoreLiveTurn,
  renderHistory,
  clearPendingInputs: (...args) => inputActions.clearPendingInputs(...args),
  closeAssistant,
  refreshInputState,
  updateGoalState,
  log: logOutput,
  writeError: writeErrorOutput,
  redraw: redrawInput,
});
const request = runtimeController.request;
turnController = createTurnController({
  request,
  state: turnState,
  refreshGoalState: runtimeController.refreshGoalState,
  onTurnStart: () => {
    displayState.assistantHeaderShown = false;
  },
  output: {
    queueInput: (...args) => inputActions.addPendingInput(...args),
    restoreInputText: (...args) => inputActions.restoreInputText(...args),
    writeError: (text) => writeErrorOutput(`${text}\n`),
    refreshInputState,
    closeAssistant,
    cancelInput,
    logInterrupt: () => logOutput(interruptText()),
  },
});
commandController = createCommandController({
  request,
  turn: turnController,
  input: {
    isTerminal: Boolean(terminalUi),
    runGoalCommand: runtimeController.runGoalCommand,
    runModelSelector: runtimeController.runModelSelector,
    startCompactCommand: runtimeController.startCompactCommand,
    runSessionsSelector: runtimeController.runSessionsSelector,
    runLocalCommand: async (text) => {
      if (!Object.keys(sessionState.settings).length) {
        sessionState.settings = await loadLocalSettings(undefined, sessionState.info.workspace_root || sessionState.info.cwd || process.cwd());
      }
      return executeLocalSlashCommand(text, {
        settings: sessionState.settings,
        sessionInfo: sessionState.info,
        cwd: sessionState.info.workspace_root || sessionState.info.cwd || process.cwd(),
        runtimeStarted: runtimeState.status === "starting" || runtimeState.status === "ready",
        runtimeInitialized: runtimeState.status === "ready",
        interactive: Boolean(terminalUi),
        commands: sessionState.commands,
      });
    },
  },
  state: {
    get slashCommands() {
      return sessionState.commands;
    },
  },
  output: {
    log: logOutput,
    setInputPrefill: (value) => {
      inputStateData.prefill = String(value || "");
    },
    shutdown: shutdownRuntime,
    exit: () => process.exit(0),
  },
});
taskMonitorController = createTaskMonitorController({
  request,
  terminalUi: Boolean(terminalUi),
  state: {
    get runtimeClosing() {
      return runtimeState.status === "closing";
    },
    get sessionInfo() {
      return sessionState.info;
    },
    set sessionInfo(value) {
      sessionState.info = value;
    },
    get inputActive() {
      return inputStateData.active;
    },
    set inputActive(value) {
      inputStateData.active = Boolean(value);
    },
  },
  redraw: redrawInput,
  log: logOutput,
});
const eventController = createEventController({
  state: {
    get runtimeClosing() {
      return runtimeState.status === "closing";
    },
    get activeTurn() {
      return turnStateData.active;
    },
    debug: cliArgs.includes("--debug"),
  },
  input: { answerQuestion: (...args) => inputActions.answerQuestion(...args) },
  monitor: taskMonitorController,
  output: {
    assistantAppend: outputController.assistantAppend,
    handleContextBuilt: (event) => compactContextState.handleContextBuilt(event),
    resetContextUsage,
    closeAssistant,
    log: logOutput,
    debug: (text) => writeErrorOutput(`${text}\n`),
    updateGoal: updateGoalState,
    setStats: (stats) => {
      displayState.stats = stats;
    },
    redraw: redrawInput,
    clearCompactContext: () => compactContextState.clear(),
    deliverQueuedInput: (...args) => inputActions.deliverQueuedInput(...args),
    clearQueuedInputs: (...args) => inputActions.clearPendingInputs(...args),
  },
});
inputActions = createCliInputActions({
  state: cliState,
  request,
  output: outputController,
  getTurnController: () => turnController,
  getTaskMonitor: () => taskMonitorController,
  getLineInput: () => input,
  pausePrompt: () => inputController.pause(),
  resumePrompt: () => inputController.resume(),
  handleSigint,
});
inputController = createInputController({
  terminalUi,
  state: {
    get runtimeClosing() {
      return runtimeState.status === "closing";
    },
    get promptPaused() {
      return inputStateData.paused;
    },
    set promptPaused(value) {
      inputStateData.paused = Boolean(value);
    },
  },
  askInput: (...args) => inputActions.ask(...args),
  onSubmit: (text) => turnController.submit(text),
  onCommand: (text) => commandController.handle(text),
  onPaste: (...args) => inputActions.handleTerminalPaste(...args),
  onInput: (...args) => inputActions.handleTerminalInput(...args),
  cancelInput,
  prompt: mainPromptText,
  placeholder: promptPlaceholderText,
});

process.on("SIGINT", handleSigint);

try {
  sessionState.settings = await loadLocalSettings(undefined, process.cwd());
  sessionState.info = { cwd: process.cwd(), model: sessionState.settings.model };
  sessionState.commands = commandController.localCommands();
  await runtimeController.ensureRuntime();
  logOutput(startupText({ ...sessionState.info, resume_preview: "" }));
  await runtimeController.restoreSession();
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

function updateGoalState(goal) {
  sessionState.info = { ...sessionState.info, goal: goal && typeof goal === "object" ? goal : null };
  redrawInput();
}
function resetContextUsage() {
  displayState.stats = { context_usage_percent: 0 };
  redrawInput();
}

async function renderEvent(message) {
  const sequence = Number(message?.sequence);
  if (!Number.isInteger(sequence) || sequence <= displayState.lastEventSequence) {
    return;
  }
  displayState.lastEventSequence = sequence;
  if (!isRuntimeEventForTurn(message, sessionState.info.session_id, turnStateData.id)) {
    return;
  }
  if (message?.event?.type === "turn_started") {
    if (turnStateData.id && String(message.turn_id || "") !== turnStateData.id) {
      return;
    }
    turnStateData.id = String(message.turn_id || "");
    turnStateData.active = Boolean(turnStateData.id);
  }
  const result = await eventController.handle(message);
  if (["turn_completed", "turn_failed", "turn_cancelled"].includes(message?.event?.type)) {
    turnStateData.id = "";
  }
  return result;
}

function restoreLiveTurn(value) {
  if (!value || typeof value !== "object") return;
  const turnId = String(value.turn_id || "");
  if (!turnId) return;
  turnStateData.id = turnId;
  turnStateData.active = true;
  displayState.assistantHeaderShown = false;
  const text = String(value.assistant_text || "");
  if (text) outputController.assistantAppend(text);
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
  const session = inputStateData.session;
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
  if (session.mode === "question") {
    const editing = session.questionState.isEditing();
    const menu = questionMenuFrame(
      session.questionState.options(),
      session.questionState.selectedIndex(),
      editing ? session.editor.input() : "",
      editing,
      CUSTOM_ANSWER_LABEL,
      width,
    );
    return prepareComposerFrame({
      prompt: mainPromptText(),
      inputText: session.question,
      cursor: editing ? session.editor.cursorPosition() : { line: 0, column: session.question.length },
      menuText: menu.text.trimEnd(),
      menuCursor: editing ? menu.cursor : null,
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
  const matches = session.menuState
    ? (session.menuState.setInput(session.editor.input()), session.menuState.matches())
    : [];
  return prepareComposerFrame({
    prompt: typeof session.prompt === "function" ? session.prompt() : session.prompt,
    inputText: session.editor.input(),
    cursor: session.editor.cursorPosition(),
    placeholder: session.mode === "prompt" ? inputHintText(session.placeholder) : "",
    menuText: session.menuState ? slashMenuText(matches, session.menuState.selectedIndex()).trimEnd() : "",
  }, width);
}

function handleSigint() {
  const action = sigintAction({
    activeTurn: turnStateData.active || displayState.activeCompact,
    interruptRequested: turnStateData.interruptRequested,
    runtimeClosing: runtimeState.status === "closing",
  });
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
  if (runtimeState.status === "closing") {
    forceCloseRuntime();
    scheduleProcessExit(0, 0);
    return;
  }
  void shutdownRuntime();
}

function closeRuntime() {
  if (runtimeState.status === "closing") {
    return;
  }
  runtimeState.status = "closing";
  clearActivityTimer();
  taskMonitorController.stop();
  void runtimeClient.shutdown();
  closeInput();
}

function forceCloseRuntime() {
  runtimeState.status = "closing";
  clearActivityTimer();
  taskMonitorController.stop();
  closeInput();
  runtimeClient.forceShutdown();
}

function cancelInput() {
  inputActions?.cancel();
}

async function shutdownRuntime() {
  if (runtimeState.status === "closing") {
    return;
  }
  runtimeState.status = "closing";
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
  if (displayState.processExitTimer) {
    return;
  }
  process.exitCode = code;
  displayState.processExitTimer = setTimeout(() => {
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
