#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { createCompactContextState } from "./compact-context-state.js";
import { createRuntimeClient, runHelpVersion } from "./runtime-client.js";
import {
  requireRuntimeInitialization,
  runtimeMethods,
  sessionScopedMethods,
  turnScopedMethods,
  isRuntimeEventForTurn,
} from "./runtime-protocol.js";
import { executeLocalSlashCommand } from "./local-slash-commands.js";
import { loadCliState, saveCliState } from "./cli-state-store.js";
import { loadPromptHistory, savePromptHistory } from "./prompt-history-store.js";
import { setTheme } from "./theme.js";
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
import { cliHelp, oneShotHelp, runOneShot, tourHelp } from "./one-shot.js";
import { runSend, sendHelp } from "./send.js";
import { listenIpc } from "./ipc.js";
import { runTour } from "./tour/run-tour.js";
import { createTui } from "./tui/tui.js";
import { Container } from "./tui/component.js";
import { ComposerArea } from "./components/composer-area.js";
import { MonitorStack } from "./components/monitor-stack.js";
import {
  inputHintText,
  interruptText,
  authChoiceFrame,
  authSecretFrame,
  modelMenuText,
  themeMenuText,
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

if (cliArgs[0] === "run" && cliArgs.some((arg) => arg === "--help" || arg === "-h")) {
  process.stdout.write(`${oneShotHelp}\n`);
  return;
}
if (cliArgs[0] === "send" && cliArgs.some((arg) => arg === "--help" || arg === "-h")) {
  process.stdout.write(`${sendHelp}\n`);
  return;
}
if (cliArgs[0] === "send") {
  try {
    process.exitCode = await runSend({ args: cliArgs });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  return;
}
if (cliArgs[0] === "tour") {
  if (cliArgs.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${tourHelp}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("rind tour requires an interactive terminal.\n");
    process.exitCode = 2;
    return;
  }
  if (cliArgs.length > 2) {
    process.stderr.write(`${tourHelp}\n`);
    process.exitCode = 2;
    return;
  }
  const started = await runTour({ input: process.stdin, output: process.stdout, startPageId: cliArgs[1] || "", onPageComplete: () => saveCliState({ tourSeen: true }) });
  if (!started) process.exitCode = 2;
  return;
}
// "rind help" is an alias for --help, not a session command.
if (cliArgs[0] === "help") {
  cliArgs = ["--help"];
}

if (cliArgs.some((arg) => arg === "--version" || arg === "--help" || arg === "-h")) {
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${cliHelp}\n\n`);
  }
  process.exit(runHelpVersion({ python, repoRoot, runtimePath, cliArgs }));
}

if (cliArgs[0] === "run") {
  try {
    await runOneShot({
      args: cliArgs,
      python,
      repoRoot,
      runtimePath,
      stderr: (text) => process.stderr.write(text),
      stdout: (text) => process.stdout.write(`${text}${String(text).endsWith("\n") ? "" : "\n"}`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  return;
}

const cliState = createCliState();
const runtimeState = cliState.runtime;
const sessionState = cliState.session;
const turnStateData = cliState.turn;
const inputStateData = cliState.input;
const displayState = cliState.display;
const promptHistory = loadPromptHistory();
let input = null;
let ipcServer = null;
const compactContextState = createCompactContextState();
const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const tui = isTty
  ? createTui({ input: process.stdin, output: process.stdout })
  : null;
const transcriptContainer = new Container();
const composerArea = new ComposerArea((width) => composeFrame(width));
const monitorStack = new MonitorStack({
  composer: composerArea,
  monitor: {
    isMonitoring: () => Boolean(taskMonitorController?.isMonitoring()),
    frame: (width) => taskMonitorController?.frame(width),
  },
  rows: () => (tui ? tui.rows : 24),
});
if (tui) {
  tui.addChild(transcriptContainer);
  tui.addChild(monitorStack);
}
let inputActions;
let inputController;
let eventProcessing = Promise.resolve();

tui?.onData((sequence) => inputActions?.handleTerminalInput(sequence));
tui?.onPaste((text) => inputActions?.handleTerminalPaste(text));

const outputController = createCliOutputController({
  state: cliState,
  terminalUi: tui,
  transcript: transcriptContainer,
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
  setTurnContext,
} = outputController;

const runtimeClient = createRuntimeClient({
  python,
  repoRoot,
  runtimePath,
  cliArgs,
  onMessage: (message) => {
    eventProcessing = eventProcessing
      .then(() => message?.method === runtimeMethods.authUpdate ? renderAuthUpdate(message) : renderEvent(message))
      .catch((error) => {
        if (runtimeState.status !== "closing") {
          writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
  },
  onRequest: (message) => inputActions?.handleAuthPrompt(message),
  onStderr: (chunk) => writeErrorOutput(chunk),
  onExit: (code, signal, { error }) => {
    const wasClosing = runtimeState.status === "closing";
    runtimeState.status = "failed";
    runtimeState.initialization = null;
    turnStateData.id = "";
    displayState.lastEventSequence = 0;
    turnStateData.active = false;
    turnStateData.interruptRequested = false;
    displayState.activityLabel = "";
    displayState.lastTurnId = "";
    setTurnContext("");
    clearActivityTimer();
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
    return turnStateData.active || displayState.activeCompact;
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
  getTaskMonitor: () => taskMonitorController,
  getCompactContextState: () => compactContextState,
  askModelMenu: (...args) => inputActions.askModelMenu(...args),
  askEffortMenu: (...args) => inputActions.askEffortMenu(...args),
  askSessionMenu: (...args) => inputActions.askSessionMenu(...args),
  askForkPointMenu: (...args) => inputActions.askForkPointMenu(...args),
  askTeamBlueprint: (...args) => inputActions.askTeamBlueprint(...args),
  askContextBoard: (...args) => inputActions.askContextBoard(...args),
  restoreLiveTurn,
  renderHistory,
  onSessionRestored: rebindSendEndpoint,
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
    logInterrupt: () => logOutput(() => interruptText()),
  },
});
commandController = createCommandController({
  request,
  turn: turnController,
  input: {
    isTerminal: Boolean(tui),
    runGoalCommand: runtimeController.runGoalCommand,
    runModelSelector: runtimeController.runModelSelector,
    runEffortCommand: (value) => runtimeController.runEffortCommand(value),
    runLogin: (providerId) => runLogin(providerId),
    runLogout: (providerId) => runLogout(providerId),
    runThemeSelector: async () => {
      const selected = await inputActions.askThemeMenu();
      if (selected) {
        await commandController.handle(`/theme ${selected}`);
      }
    },
    runTour: (pageId) => enterInSessionTour(pageId),
    startCompactCommand: runtimeController.startCompactCommand,
    runSessionsSelector: runtimeController.runSessionsSelector,
    runForkSelector: runtimeController.runForkSelector,
    runContextBoard: runtimeController.runContextBoard,
    printContextReport: runtimeController.printContextReport,
    runLocalCommand: async (text) => {
      const result = await executeLocalSlashCommand(text, {
        sessionInfo: sessionState.info,
        cwd: sessionState.info.workspace_root || sessionState.info.cwd || process.cwd(),
        runtimeStarted: runtimeState.status === "starting" || runtimeState.status === "ready",
        runtimeInitialized: runtimeState.status === "ready",
        interactive: Boolean(tui),
        commands: sessionState.commands,
        persistTheme: (name) => saveCliState({ theme: name }),
      });
      if (result?.display?.type === "theme" && result.display.changed) {
        outputController.replayAll();
      }
      return result;
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
  terminalUi: Boolean(tui),
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
    get activeGoal() {
      return sessionState.info.goal;
    },
    debug: cliArgs.includes("--debug"),
  },
  input: { answerQuestion: (...args) => inputActions.answerQuestion(...args) },
  monitor: taskMonitorController,
  output: {
    assistantAppend: outputController.assistantAppend,
    beginTool: (...args) => outputController.beginTool(...args),
    updateToolProgress: (...args) => outputController.updateToolProgress(...args),
    finishTool: (...args) => outputController.finishTool(...args),
    handleContextBuilt: (event) => compactContextState.handleContextBuilt(event),
    resetContextUsage,
    closeAssistant,
    log: logOutput,
    debug: (text) => writeErrorOutput(`${text}\n`),
    updateGoal: updateGoalState,
    setStats: (stats) => {
      displayState.stats = stats;
    },
    setActivityLabel: outputController.setActivityLabel,
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
  promptHistory,
  onPromptHistory: (history) => savePromptHistory(history),
  getTurnController: () => turnController,
  getCommandController: () => commandController,
  getTaskMonitor: () => taskMonitorController,
  getLineInput: () => input,
  getEffortLevels: () => runtimeController.currentModelEfforts(),
  pausePrompt: () => inputController.pause(),
  resumePrompt: () => inputController.resume(),
  handleSigint,
});
inputController = createInputController({
  terminalUi: tui,
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
  const persistedState = loadCliState();
  if (persistedState.theme) {
    setTheme(persistedState.theme);
  }
  sessionState.info = { cwd: process.cwd() };
  sessionState.commands = commandController.localCommands();
  await runtimeController.ensureRuntime();
  const startupInfo = { ...sessionState.info, resume_preview: "" };
  const tourHint = persistedState.tourSeen ? [] : ["new to Rind? /tour walks you through it"];
  if (tui) {
    outputController.showStartup(startupInfo, tourHint);
  } else {
    logOutput(startupText(startupInfo));
  }
  await runtimeController.restoreSession();
  if (tui) {
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

async function rebindSendEndpoint() {
  try {
    await ipcServer?.close();
    ipcServer = null;
    const sessionId = String(sessionState.info.session_id || "");
    if (!sessionId) {
      return;
    }
    ipcServer = await listenIpc({
      sessionId,
      getSessionId: () => sessionState.info.session_id,
      dispatch: (text) => inputActions.dispatchExternal(text),
      onUnavailable: () => logOutput(`Send endpoint unavailable: another rind process owns session ${sessionId}.`),
    });
  } catch (error) {
    ipcServer = null;
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
function resetContextUsage() {
  displayState.stats = { context_usage_percent: 0 };
  redrawInput();
}

// In-session tour: suspend the main TUI (and its SIGINT handler, since raw
// mode is released while the tour owns the terminal), play, then restore.
async function enterInSessionTour(pageId) {
  if (turnStateData.active || displayState.activeCompact) {
    logOutput("/tour is available between turns.");
    return;
  }
  inputController.pause();
  tui.stop();
  process.off("SIGINT", handleSigint);
  try {
    await runTour({ input: process.stdin, output: process.stdout, startPageId: pageId || "", onPageComplete: () => saveCliState({ tourSeen: true }) });
  } catch (error) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    process.on("SIGINT", handleSigint);
    tui.start();
    tui.replayAll();
    inputController.resume();
  }
}

async function runLogin(providerId = "") {
  try {
    const providersResult = await request(runtimeMethods.authList);
    const providers = Array.isArray(providersResult?.providers) ? providersResult.providers : [];
    let selected = String(providerId || "").trim();
    if (!selected) {
      const options = providers.map((item) => `${item.id} · ${item.name} · ${item.configured ? item.source : "not configured"}`);
      const choice = await inputActions.askAuthChoice("Provider", options);
      selected = String(choice || "").split(" · ")[0].trim();
    }
    if (!selected) return;
    const result = await request(runtimeMethods.authLogin, { provider_id: selected, method: "api_key" });
    const selection = result?.selection && typeof result.selection === "object" ? result.selection : null;
    if (selection?.provider_id && selection.model_id) {
      sessionState.info = { ...sessionState.info, provider: selection.provider_id, model: selection.model_id };
      logOutput(`Logged in to ${result?.provider_id || selected}. Switched to ${selection.provider_id} / ${selection.model_id}.`);
    } else {
      logOutput(`Logged in to ${result?.provider_id || selected}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOutput(/cancel/i.test(message) ? "Login canceled." : `Login failed: ${message}`);
  }
}

async function runLogout(providerId = "") {
  try {
    const providersResult = await request(runtimeMethods.authList);
    const stored = (providersResult?.providers || []).filter((item) => item.source === "stored");
    let selected = String(providerId || "").trim();
    if (!selected && stored.length === 1) {
      selected = String(stored[0].id || "");
    }
    if (!selected && !stored.length) {
      logOutput("No stored provider credentials.");
      return;
    }
    if (!selected) {
      const choice = await inputActions.askAuthChoice("Provider", stored.map((item) => `${item.id} · ${item.name}`));
      selected = String(choice || "").split(" · ")[0].trim();
    }
    const result = await request(runtimeMethods.authLogout, { provider_id: selected });
    if (!result?.deleted) {
      logOutput(`No stored credential for ${selected}.`);
      return;
    }
    const suffix = result?.source === "environment"
      ? " It is still configured through an environment variable."
      : "";
    logOutput(`Logged out of ${selected}.${suffix}`);
  } catch (error) {
    logOutput(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderAuthUpdate(message) {
  const event = message?.event || {};
  const type = String(event.type || "info");
  const value = String(event.message || event.text || event.url || event.code || "").trim();
  if (value) logOutput(`[${type}] ${value}`);
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
    const nextTurnId = String(message.turn_id || "");
    if (!nextTurnId || (!turnStateData.id && displayState.lastTurnId === nextTurnId)
      || (turnStateData.id && nextTurnId !== turnStateData.id)) {
      return;
    }
    clearActivityTimer();
    turnStateData.id = nextTurnId;
    displayState.lastTurnId = nextTurnId;
    setTurnContext(nextTurnId);
    turnStateData.active = Boolean(turnStateData.id);
    turnStateData.interruptRequested = false;
    displayState.activeCompact = message.event.operation === "compact";
    displayState.activityLabel = displayState.activeCompact ? "Compacting" : "Working";
    displayState.assistantHeaderShown = false;
    refreshInputState();
  }
  if (message?.event?.type === "context_compacted") {
    if (displayState.activeCompact) logOutput("Compact complete.");
    displayState.activeCompact = false;
    displayState.activityLabel = "Working";
    compactContextState.clear();
    resetContextUsage();
  }
  const result = await eventController.handle(message);
  if (["turn_completed", "turn_failed", "turn_cancelled"].includes(message?.event?.type)) {
    turnStateData.id = "";
    displayState.activeCompact = false;
    setTurnContext("");
    displayState.activityLabel = "";
    await runtimeController.refreshGoalState();
    turnStateData.active = false;
    turnStateData.interruptRequested = false;
    clearActivityTimer();
    refreshInputState();
  }
  return result;
}

function restoreLiveTurn(value) {
  if (!value || typeof value !== "object" || String(value.status || "") !== "running") {
    displayState.lastTurnId = "";
    setTurnContext("");
    return;
  }
  const turnId = String(value.turn_id || "");
  if (!turnId) {
    displayState.lastTurnId = "";
    setTurnContext("");
    return;
  }
  clearActivityTimer();
  turnStateData.id = turnId;
  turnStateData.active = true;
  turnStateData.interruptRequested = false;
  displayState.activityLabel = "Working";
  displayState.lastTurnId = turnId;
  setTurnContext(turnId);
  displayState.assistantHeaderShown = false;
  const text = String(value.assistant_text || "");
  if (text) outputController.assistantAppend(text);
}

function composeFrame(width = process.stdout.columns || 80) {
  const session = inputStateData.session;
  if (!session) {
    return null;
  }
  const choiceMenu = ["model", "theme", "sessions", "team-blueprints", "fork", "auth-choice"].includes(session.mode);
  if (session.mode === "prompt" && session.menuState) {
    session.menuState.setInput(session.editor.input());
  }
  const slashMenuOpen = session.mode === "prompt"
    && session.menuState
    && session.menuState.matches().length > 0;
  const showCaret = (!choiceMenu && !slashMenuOpen)
    || (session.mode === "question" && session.questionState.isEditing());
  if (session.mode === "model") {
    return {
      showCaret,
      prompt: mainPromptText(width),
      inputText: session.inputText,
      cursor: { line: 0, column: session.inputText.length },
      menuText: modelMenuText(session.modelState.items(), session.modelState.selectedIndex()).trimEnd(),
    };
  }
  if (session.mode === "auth-choice") {
    const menuText = authChoiceFrame({
      title: session.authTitle || "Provider",
      options: session.choiceState.options(),
      selectedIndex: session.choiceState.selectedIndex(),
      width,
    });
    return {
      showCaret: false,
      prompt: "",
      inputText: "",
      cursor: { line: 0, column: 0 },
      menuText: menuText.trimEnd(),
    };
  }
  if (session.mode === "auth") {
    const frame = authSecretFrame({
      title: session.authTitle,
      message: session.authMessage,
      kind: session.authKind,
      value: session.editor.input(),
      width,
      cursor: session.editor.cursorPosition(),
    });
    return {
      showCaret: true,
      prompt: "",
      inputText: "",
      cursor: { line: 0, column: 0 },
      menuText: frame.text.trimEnd(),
      menuCursor: frame.cursor,
    };
  }
  if (session.mode === "theme") {
    return {
      showCaret,
      prompt: mainPromptText(width),
      inputText: session.inputText,
      cursor: { line: 0, column: session.inputText.length },
      menuText: themeMenuText(session.themeState.items(), session.themeState.selectedIndex()).trimEnd(),
    };
  }
  if (session.mode === "question") {
    const editing = session.questionState.isEditing();
    session.editor.setViewportWidth(width);
    const editorCursor = editing ? session.editor.cursorPosition() : null;
    const menu = questionMenuFrame(
      session.questionState.options(),
      session.questionState.selectedIndex(),
      editing ? session.editor.input() : "",
      editing,
      CUSTOM_ANSWER_LABEL,
      width,
      editorCursor,
    );
    return {
      showCaret,
      prompt: mainPromptText(width),
      inputText: session.question,
      cursor: editorCursor ?? { line: 0, column: session.question.length },
      menuText: menu.text.trimEnd(),
      menuCursor: editing ? menu.cursor : null,
    };
  }
  if (session.mode === "sessions" || session.mode === "team-blueprints" || session.mode === "fork") {
    return {
      showCaret,
      prompt: mainPromptText(width),
      inputText: session.inputText,
      cursor: { line: 0, column: session.inputText.length },
      menuText: sessionMenuText(session.choiceState.options(), session.choiceState.selectedIndex()).trimEnd(),
    };
  }
  if (session.mode === "context-board") {
    return {
      showCaret: false,
      prompt: "",
      inputText: "",
      cursor: { line: 0, column: 0 },
      menuText: typeof session.board?.render === "function"
        ? session.board.render(session.pageIndex, width)
        : "",
    };
  }
  const matches = session.menuState
    ? (session.menuState.setInput(session.editor.input()), session.menuState.matches())
    : [];
  if (typeof session.editor.setViewportWidth === "function") {
    session.editor.setViewportWidth(width);
  }
  return {
    showCaret,
    prompt: typeof session.prompt === "function" ? session.prompt(width) : session.prompt,
    inputText: session.editor.input(),
    cursor: session.editor.cursorPosition(),
    placeholder: session.mode === "prompt" ? inputHintText(session.placeholder) : "",
    menuText: session.menuState ? slashMenuText(matches, session.menuState.selectedIndex()).trimEnd() : "",
  };
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
  void ipcServer?.close();
  void runtimeClient.shutdown();
  closeInput();
}

function forceCloseRuntime() {
  runtimeState.status = "closing";
  clearActivityTimer();
  taskMonitorController.stop();
  void ipcServer?.close();
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
  if (!tui) {
    process.stdin.pause();
  }
}
}
