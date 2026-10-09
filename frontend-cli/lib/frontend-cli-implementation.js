#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runAgentsCommand, followConversation, leaveSummary, returnTarget } from "./agents-commands.js";
import { takeHandoffPath, writeHandoff, writeHandoffSync } from "./agents-handoff.js";
import { runAgentsPage } from "./agents-page.js";
import { prepareManagement, observeRuntime } from "./agents-session.js";

import { createCompactContextState } from "./compact-context-state.js";
import { createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
import { createRuntimeClient, runHelpVersion } from "./runtime-client.js";
import {
  requireRuntimeInitialization,
  runtimeMethods,
  sessionScopedMethods,
  turnScopedMethods,
  isRuntimeEventForTurn,
} from "./runtime-protocol.js";
import { executeLocalSlashCommand } from "./local-slash-commands.js";
import { applySavedTheme, loadCliState, saveCliState } from "./cli-state-store.js";
import { loadPromptHistory, savePromptHistory } from "./prompt-history-store.js";
import { setTheme } from "./theme.js";
import { createTurnController } from "./turn-controller.js";
import { createCommandController } from "./command-controller.js";
import { createTaskMonitorController } from "./task-monitor-controller.js";
import { createEventController } from "./event-controller.js";
import { createInputController } from "./input-controller.js";
import { isInputClosed } from "./input-errors.js";
import { sigintAction, createLeaveLatch } from "./interrupt-state.js";
import { CUSTOM_ANSWER_LABEL } from "./question-menu-state.js";
import { createCliState } from "./cli-state.js";
import { createCliRuntimeController } from "./cli-runtime-controller.js";
import { createCliOutputController } from "./cli-output-controller.js";
import { createCliInputActions } from "./cli-input-actions.js";
import { cliHelp, oneShotHelp, runOneShot, tourHelp } from "./one-shot.js";
import { runSend, sendHelp } from "./send.js";
import { configHelp, runConfig } from "./config-command.js";
import { createWindowLog, guardStartup } from "./window-startup.js";
import { listenIpc } from "./ipc.js";
import { runTour } from "./tour/run-tour.js";
import { createTui } from "./tui/tui.js";
import { createTranscript } from "./tui/transcript.js";
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
  slashNoMatchText,
  welcomeText,
  resumeLineText,
  startupText,
} from "./rendering.js";

// The /login choice that adds a named OpenAI-compatible endpoint with its own key.
const ADD_CONNECTION = "+ Add a named endpoint · OpenAI-compatible URL and key";
// How a provider that offers more than an API key is signed in to.
const LOGIN_METHODS = { oauth: "Sign in with ChatGPT", api_key: "API key" };

export async function runFrontendCliApp(cliArgs = process.argv.slice(2)) {
// A conversation opened from Agents hands navigation back to the window that
// opened it instead of nesting another window inside itself.
const handoffFile = takeHandoffPath();
const handoffWindow = Boolean(handoffFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const python = process.env.RIND_PYTHON || "python";
const runtimePath = process.env.RIND_RUNTIME_PATH || resolveInstalledRuntime();
const managementLaunch = { python, repoRoot, runtimePath };
if (cliArgs[0] === "agents") {
  applySavedTheme();
  try { await runAgentsCommand(cliArgs.slice(1), managementLaunch); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 2; }
  return;
}

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
if (cliArgs[0] === "config") {
  if (cliArgs.length === 1 || cliArgs.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${configHelp}\n`);
    return;
  }
  try { await runConfig({ args: cliArgs.slice(1), launch: managementLaunch }); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
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

const windowLog = createWindowLog();
windowLog.step("start " + JSON.stringify(cliArgs));
// A window opened from Agents is still starting until it reads keys itself:
// Esc or Ctrl+C gives up and goes back to Agents. (A window started from a
// shell may still ask which team to use, so it reads its own keys.)
const startupGuard = handoffWindow ? guardStartup({ onCancel(key) {
  windowLog.step("cancelled with " + key);
  writeHandoffSync({ action: "agents" }, handoffFile);
  process.exit(0);
} }) : { stop() {} };
let management;
try { management = await prepareManagement(cliArgs, managementLaunch); cliArgs = management.args; windowLog.step("management ready"); }
catch (error) {
  startupGuard.stop();
  windowLog.step("failed: " + error.message);
  // A window opened from Agents tells its opener why it could not start.
  if (handoffWindow) await writeHandoff({ action: "failed", error: error.message }, handoffFile);
  process.stderr.write(error.message + "\n"); process.exitCode = 2; return;
}
const cliState = createCliState();
const runtimeState = cliState.runtime;
const sessionState = cliState.session;
const turnStateData = cliState.turn;
const inputStateData = cliState.input;
// Created before any handler can run: SIGINT may arrive during startup.
const leaveLatch = createLeaveLatch({ onChange: () => { cliState.display.leaveArmed = leaveLatch.armed; redrawInput(); } });
const displayState = cliState.display;
const promptHistory = loadPromptHistory();
let input = null;
let ipcServer = null;
const compactContextState = createCompactContextState();
const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const tui = isTty
  ? createTui({ input: process.stdin, output: process.stdout })
  : null;
const transcriptContainer = createTranscript();
const composerArea = new ComposerArea((width) => composeFrame(width));
const monitorStack = new MonitorStack({
  composer: composerArea,
  monitor: {
    isMonitoring: () => Boolean(taskMonitorController?.isMonitoring()),
    frame: (width, height) => taskMonitorController?.frame(width, height),
  },
  rows: () => (tui ? tui.rows : 24),
});
if (tui) {
  tui.addChild(transcriptContainer);
  tui.addChild(monitorStack);
}
let inputActions;
let inputController;
let agentsPageAbort = null;
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

const runtimeClient = observeRuntime((management.shared ? createSharedRuntimeClient : createRuntimeClient)({
  python,
  repoRoot,
  runtimePath,
  cliArgs,
  externalTools: management.externalTools,
  // `rind send` input, routed here by the shared Runtime because this window shows the session.
  onDeliver: ({ session_id: target, input }) => { if (target === sessionState.info.session_id) inputActions.dispatchExternal(input); },
  onMessage: (message) => {
    // Events are rendered one at a time, and an open question holds that queue
    // until it is answered; an answer from another window must jump the queue.
    if (message?.event?.type === "user_question_answered") { inputActions.questionAnswered(message.event); return; }
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
    runtimeState.status = wasClosing ? "closing" : "failed";
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
      void management.close?.().catch(error => writeErrorOutput(error.message + "\n"));
      runtimeState.failure = error;
      writeErrorOutput(`Runtime stopped (${signal || (code ?? "startup failure")}): ${error.message}. Runtime commands are unavailable until it restarts.\n`);
    }
  },
}), management);
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
  askChoice: tui ? (...args) => inputActions.askAuthChoice(...args) : null,
  askSessionMenu: (...args) => inputActions.askSessionMenu(...args),
  askForkPointMenu: (...args) => inputActions.askForkPointMenu(...args),
  askContextBoard: (...args) => inputActions.askContextBoard(...args),
  restoreLiveTurn,
  renderHistory,
  onSessionRestored: rebindSendEndpoint,
  openManagedSession: management.chatContext ? (runtimeSessionId, prefill) => enterManagement({ ...management.chatContext, runtimeSessionId, prefill }) : null,
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
    runRename: (argument) => runtimeController.runRename(argument),
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
        pendingName: sessionState.pendingName,
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
    // /exit leaves Rind from any window; background agents keep running.
    shutdown: () => leaveRind(),
    exit: () => process.exit(process.exitCode ?? 0),
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
    get sessionInfo() {
      return sessionState.info;
    },
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
    setBackgroundWait: outputController.setBackgroundWait,
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
  pausePrompt: () => { agentsPageAbort?.abort(); inputController.pause(); },
  resumePrompt: () => inputController.resume(),
  handleSigint,
  openAgents: () => enterManagement(),
  disarmLeave: () => leaveLatch.disarm(),
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
  sessionState.info = { cwd: process.cwd(), management_label: management.label };
  sessionState.commands = commandController.localCommands();
  await runtimeController.ensureRuntime();
  windowLog.step("runtime ready");
  const startupInfo = { ...sessionState.info, resume_preview: "" };
  if (management.label) logOutput(management.label);
  // A new conversation is greeted; one opened again says what it resumes.
  const opening = (width) => sessionState.info.session_id
    ? resumeLineText(sessionState.info, Date.now(), width)
    : welcomeText(sessionState.info, persistedState, width);
  if (tui) {
    outputController.showStartup(startupInfo, opening);
  } else {
    logOutput([startupText(startupInfo), opening()].filter(Boolean).join("\n\n"));
  }
  // A window opened on an existing conversation shows its history; a new one has none yet.
  if (sessionState.info.session_id) { await runtimeController.restoreSession(); windowLog.step("history restored"); }
  if (management.prefill) inputStateData.prefill = management.prefill;
  startupGuard.stop();
  windowLog.step("reading keys");
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
  if (sessionState.info.live_turn?.question) void inputActions.answerQuestion({ ...sessionState.info.live_turn.question, type: "user_question_requested" });
  await inputController.promptLoop();
} catch (error) {
  startupGuard.stop();
  windowLog.step("ended: " + (error instanceof Error ? error.message : String(error)));
  closeAssistant();
  if (!isInputClosed(error)) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  if (!tui && management.shared) await turnController.waitForIdle();
  void shutdownRuntime();
}

function updateGoalState(goal) {
  sessionState.info = { ...sessionState.info, goal: goal && typeof goal === "object" ? goal : null };
  refreshInputState();
}

// A private worker has no shared Runtime to route `rind send`; it listens itself.
async function rebindSendEndpoint() {
  if (management.shared && runtimeClient.child?.acceptsInput) return;
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
  tui.stop({ releaseInput: false });
  process.off("SIGINT", handleSigint);
  try {
    await runTour({ input: process.stdin, output: process.stdout, startPageId: pageId || "", manageInput: false, onPageComplete: () => saveCliState({ tourSeen: true }) });
  } catch (error) {
    writeErrorOutput(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    process.on("SIGINT", handleSigint);
    tui.start({ acquireInput: false });
    tui.replayAll();
    inputController.resume();
  }
}

async function enterManagement(chat) {
  if (!tui) { await runAgentsCommand(["list"], managementLaunch); return; }
  if (handoffWindow) {
    // A shared conversation keeps running after this window closes; one that
    // runs in this window's own worker would be killed with it.
    if (!management.shared && (turnStateData.active || displayState.activeCompact)) {
      logOutput("This conversation runs in this window. Wait for it, or press ctrl+c to stop it, before leaving.");
      return;
    }
    const from = { runtimeSessionId: sessionState.info.session_id || "", workspace: sessionState.info.workspace_root || sessionState.info.cwd || "" };
    await writeHandoff(chat ? { action: "open", chat: { ...chat, agent: chat.agent && { id: chat.agent.id, canonicalWorkspace: chat.agent.canonicalWorkspace } } } : { action: "agents", from }, handoffFile);
    await shutdownRuntime();
    return;
  }
  if (agentsPageAbort) return;
  const abort = new AbortController(); agentsPageAbort = abort;
  const draft = inputStateData.session?.mode === "prompt" ? inputStateData.session.editor.input() : inputStateData.prefill;
  inputController.pause();
  tui.stop({ releaseInput: false });
  process.off("SIGINT", handleSigint);
  // This window's conversation stays here but is no longer on screen.
  void runtimeClient.setVisible?.(false);
  let next = { action: "agents" };
  try {
    if (chat) next = await followConversation(chat, { launch: managementLaunch, input: process.stdin });
    if (next.action === "agents") {
      const page = await runAgentsPage({ launch: managementLaunch, manageInput: false, signal: abort.signal, initialTeamId: management.chatContext?.teamId, currentSessionId: sessionState.info.session_id, returnTo: chat ? returnTarget(next) : undefined });
      if (page.leave) next = { action: "leave", working: page.working, notice: page.notice };
    }
  } finally {
    agentsPageAbort = null;
    if (next.action !== "leave") void runtimeClient.setVisible?.(true);
    process.on("SIGINT", handleSigint);
    tui.start({ acquireInput: false });
    tui.replayAll();
    if (!inputStateData.session) { inputStateData.prefill = draft || ""; inputController.resume(); }
  }
  if (next.action === "leave") await leaveRind(next.working, next.notice);
}

// Leaving closes this window and every window it was opened from. It only
// detaches: background agents, tasks and the shared Runtime keep running.
async function leaveRind(working = 0, notice = "") {
  leaveLatch.disarm();
  if (handoffWindow) await writeHandoff({ action: "leave" }, handoffFile);
  else logOutput(leaveSummary({ working, notice }));
  await shutdownRuntime();
}

async function chooseLoginMethod(methods) {
  const choice = await inputActions.askAuthChoice("Sign in", methods.map((key) => LOGIN_METHODS[key] || key));
  return methods.find((key) => (LOGIN_METHODS[key] || key) === choice) || "";
}

async function runLogin(providerId = "") {
  try {
    const providersResult = await request(runtimeMethods.authList);
    const providers = Array.isArray(providersResult?.providers) ? providersResult.providers : [];
    let selected = String(providerId || "").trim();
    if (!selected) {
      const options = [...providers.map((item) => `${item.id} · ${item.name} · ${item.configured ? item.source : "not configured"}`), ADD_CONNECTION];
      const choice = await inputActions.askAuthChoice("Provider", options);
      selected = choice === ADD_CONNECTION ? ADD_CONNECTION : String(choice || "").split(" · ")[0].trim();
    }
    if (!selected) return;
    const methods = providers.find((item) => item.id === selected)?.methods || [];
    const method = methods.length > 1
      ? await chooseLoginMethod(methods)
      : "api_key";
    if (!method) return;
    const result = await request(runtimeMethods.authLogin, selected === ADD_CONNECTION
      ? { method: "connection" }
      : { provider_id: selected, method });
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
  if (event.type === "prompt_closed") { inputActions.closeAuthPrompt(event.request_id); return; }
  const text = String(event.message || "").trim();
  if (text) logOutput(text);
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
  const settled = ["turn_completed", "turn_failed", "turn_cancelled"].includes(message?.event?.type);
  if (settled) {
    turnStateData.id = "";
    displayState.activeCompact = false;
    setTurnContext("");
    displayState.activityLabel = "";
    turnStateData.active = false;
    turnStateData.interruptRequested = false;
    clearActivityTimer();
    refreshInputState();
  }
  const result = await eventController.handle(message);
  if (settled) await runtimeController.refreshGoalState();
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
  const choiceMenu = ["model", "theme", "sessions", "fork", "auth-choice"].includes(session.mode);
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
  if (session.mode === "sessions" || session.mode === "fork") {
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
    menuText: !session.menuState ? "" : session.menuState.unmatched() ? slashNoMatchText(session.editor.input()) : slashMenuText(matches, session.menuState.selectedIndex()).trimEnd(),
  };
}

function handleSigint() {
  const idle = !(turnStateData.active || displayState.activeCompact);
  // Like a shell, Ctrl+C first clears what is being typed.
  const editor = inputStateData.session?.mode === "prompt" ? inputStateData.session.editor : null;
  if (idle && editor?.input() && runtimeState.status !== "closing") {
    editor.setInput("");
    leaveLatch.disarm();
    redrawInput();
    return;
  }
  const action = sigintAction({
    activeTurn: !idle,
    interruptRequested: turnStateData.interruptRequested,
    runtimeClosing: runtimeState.status === "closing",
    // Without a terminal there is no hint to see, so a single signal leaves (as scripts expect).
    leaveArmed: leaveLatch.armed || !tui,
  });
  if (action === "interrupt") interruptTurn();
  else if (action === "arm-leave") leaveLatch.arm();
  else if (action === "leave") void leaveRind().catch(error => { writeErrorOutput(error.message + "\n"); exitFromSignal(); });
  else exitFromSignal();
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
  // ctrl+c only ever leaves. A forced close says so too, or the window that
  // opened this one would read "no decision" and show Agents again.
  if (handoffWindow) writeHandoffSync({ action: "leave" }, handoffFile);
  if (runtimeState.status === "closing") {
    forceCloseRuntime();
    scheduleProcessExit(0, 0);
    return;
  }
  void shutdownRuntime();
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
  void ipcServer?.close();
  try {
    await runtimeClient.shutdown();
  } catch (error) {
    writeErrorOutput(`Runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    closeInput();
    scheduleProcessExit(process.exitCode ?? 0, 0);
  }
}

function scheduleProcessExit(code, delayMs) {
  if (displayState.processExitTimer) {
    return;
  }
  process.exitCode = code;
  displayState.processExitTimer = setTimeout(async () => {
    // Read a terminal answer that is still on its way, or the shell would print it.
    await tui?.drainKeyboardQuery?.();
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
