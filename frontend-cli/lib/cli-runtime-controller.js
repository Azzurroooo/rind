import { modelListErrorText, commandResultText, goalCommandText, sessionSwitchedText } from "./rendering.js";

export function createCliRuntimeController({
  client,
  methods,
  sessionScopedMethods,
  turnScopedMethods,
  requireInitialization,
  state,
  getCommands,
  getTurnController,
  getTaskMonitor,
  getCompactContextState,
  askModelMenu,
  askSessionMenu,
  restoreLiveTurn,
  renderHistory = () => {},
  clearPendingInputs,
  closeAssistant,
  refreshInputState,
  updateGoalState,
  log,
  writeError,
  redraw,
}) {
  let switchGeneration = 0;

  async function request(method, params = {}) {
    await ensureRuntime();
    const requestParams = { ...params };
    const sessionScoped = sessionScopedMethods.has(method) || method === methods.modelList;
    if (sessionScoped && state.session.info.session_id && !requestParams.session_id) {
      requestParams.session_id = state.session.info.session_id;
    }
    if (turnScopedMethods.has(method) && state.turn.id && !requestParams.turn_id) {
      requestParams.turn_id = state.turn.id;
    }
    return client.request(method, requestParams);
  }

  async function ensureRuntime() {
    if (state.runtime.status === "ready") {
      return state.session.info;
    }
    if (state.runtime.failure) {
      throw state.runtime.failure;
    }
    if (state.runtime.initialization) {
      return state.runtime.initialization;
    }
    state.runtime.initialization = (async () => {
      client.start();
      state.runtime.status = "starting";
      const info = requireInitialization(await client.request(methods.initialize));
      state.session.info = { ...state.session.info, ...(info || {}) };
      state.display.lastEventSequence = 0;
      state.runtime.status = "ready";
      const commandController = getCommands();
      state.session.commands = mergeSlashCommands(
        commandController.normalizeCommands(info?.commands),
        commandController.localCommands(),
      );
      redraw(true);
      void getTaskMonitor()?.refresh().catch(() => {});
      return state.session.info;
    })().catch((error) => {
      state.runtime.status = client.child ? "starting" : "failed";
      state.runtime.initialization = null;
      throw error;
    });
    return state.runtime.initialization;
  }

  async function runGoalCommand(command) {
    const turnController = getTurnController();
    if (command.action === "set" && state.turn.active) {
      log(() => commandResultText("Goal not started", "pause or finish the active turn first"));
      return;
    }
    try {
      if (command.action === "set") {
        const result = await request(methods.goalSet, { objective: command.objective });
        updateGoalState(result?.goal);
        log(() => goalCommandText(result?.goal, "set"));
        turnController.submit(command.objective);
        return;
      }
      if (command.action === "clear") {
        const result = await request(methods.goalClear);
        updateGoalState(result?.goal || null);
        log(() => goalCommandText(null, "clear"));
        return;
      }
      if (command.action === "pause" || command.action === "resume") {
        const result = await request(methods.goalStatus, { status: command.action === "resume" ? "active" : "paused" });
        updateGoalState(result?.goal);
        log(() => goalCommandText(result?.goal, command.action));
        if (command.action === "resume" && !state.turn.active) {
          turnController.submit("", { goal_continuation: true });
        }
        return;
      }
      const result = await request(methods.goalGet);
      updateGoalState(result?.goal || null);
      log(() => goalCommandText(result?.goal || null));
    } catch (error) {
      log(`Goal command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function refreshGoalState() {
    if (state.runtime.status !== "ready" || !Array.isArray(state.session.info.capabilities) || !state.session.info.capabilities.includes("rind/goals")) {
      return;
    }
    try {
      const result = await request(methods.goalGet);
      updateGoalState(result?.goal || null);
    } catch {
      // A late refresh is not allowed to invalidate a completed turn.
    }
  }

  async function restoreSession(sessionId = state.session.info.session_id, options = {}) {
    const targetId = String(sessionId || "").trim();
    if (!targetId) {
      throw new Error("Session ID is required.");
    }
    const switching = options.switchSession === true;
    const switchToken = switching ? ++switchGeneration : 0;
    const update = switching
      ? await request(methods.sessionSwitch, { session_id: targetId })
      : state.session.info;
    if (switching && (switchToken !== switchGeneration || state.runtime.status === "closing")) {
      return false;
    }
    const switchedId = String(update?.session_id || targetId);
    if (switchedId !== targetId) {
      throw new Error("Runtime returned a different session.");
    }
    const replay = await request(methods.sessionReplay, { session_id: switchedId });
    if (switching && (switchToken !== switchGeneration || state.runtime.status === "closing")) {
      return false;
    }
    if (replay?.session_id && String(replay.session_id) !== switchedId) {
      throw new Error("Runtime replay returned a different session.");
    }

    const liveTurn = replay?.live_turn || update?.live_turn || null;
    const turnState = replay?.turn_state || update?.turn_state || null;
    const usage = update?.usage && typeof update.usage === "object" ? update.usage : {};
    const workspaceRoot = String(update?.workspace_root || options.workspaceRoot || "").trim();
    closeAssistant();
    getTaskMonitor()?.clear();
    clearPendingInputs();
    state.session.info = {
      ...state.session.info,
      session_id: switchedId,
      cwd: workspaceRoot || state.session.info.cwd,
      workspace_root: workspaceRoot || state.session.info.workspace_root,
      model: replay?.model || update?.model || state.session.info.model,
      resume_preview: "",
      goal: update?.goal || null,
      live_turn: liveTurn,
      turn_state: turnState,
      usage,
      background_count: 0,
      delegate_count: 0,
    };
    state.turn.id = "";
    state.turn.active = false;
    state.turn.interruptRequested = false;
    options.announce?.(state.session.info);
    renderHistory(replay?.messages);
    restoreLiveTurn(liveTurn);
    state.display.stats = usage;
    getCompactContextState().clear();
    refreshInputState();
    redraw();
    void getTaskMonitor()?.refresh().catch(() => {});
    return true;
  }

  async function runSessionsSelector() {
    if (state.turn.active || state.display.activeCompact) {
      log("Cannot switch sessions while a turn is running.");
      return;
    }
    let result;
    try {
      result = await request(methods.commandExecute, { input: "/sessions 100" });
    } catch (error) {
      log(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const sessions = Array.isArray(result?.display?.sessions) ? result.display.sessions : [];
    if (!sessions.length) {
      await getCommands().applyResult(result);
      return;
    }
    const currentId = String(result?.display?.current_session_id || state.session.info.session_id || "");
    const options = sessions.map(sessionMenuOption);
    const currentIndex = sessions.findIndex((session) => String(session?.id || "") === currentId);
    const selected = await askSessionMenu(options, sessions, currentIndex);
    const selectedId = String(selected?.id || "");
    if (!selectedId || state.runtime.status === "closing" || selectedId === currentId) {
      return;
    }
    try {
      await restoreSession(selectedId, {
        switchSession: true,
        workspaceRoot: selected?.workspace_root,
        announce: (info) => log(() => sessionSwitchedText(info)),
      });
    } catch (error) {
      log(`Session switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function startCompactCommand() {
    if (state.display.activeCompact) {
      log("Compact is already running.");
      return;
    }
    state.display.activeCompact = true;
    state.turn.interruptRequested = false;
    refreshInputState();
    void runCompactCommand().catch((error) => {
      if (state.runtime.status !== "closing") {
        writeError(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
  }

  async function runCompactCommand() {
    try {
      const result = await request(methods.commandExecute, { input: "/compact" });
      await getCommands().applyResult(result);
    } finally {
      state.display.activeCompact = false;
      state.turn.interruptRequested = false;
      refreshInputState();
    }
  }

  async function runModelSelector() {
    let result;
    try {
      result = await request(methods.modelList);
    } catch (error) {
      log(() => modelListErrorText(error instanceof Error ? error.message : String(error), state.session.info.model));
      return;
    }
    const currentModel = result?.current_model || state.session.info.model || result?.default_model || "";
    const selected = await askModelMenu(result?.models || [], currentModel);
    if (!selected || state.runtime.status === "closing") {
      return;
    }
    try {
      const update = await request(methods.modelSet, { model: selected });
      state.session.info = { ...state.session.info, model: update?.model || selected };
      log(() => modelSetResultText(update, selected));
    } catch (error) {
      log(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    request,
    ensureRuntime,
    restoreSession,
    runGoalCommand,
    refreshGoalState,
    runSessionsSelector,
    startCompactCommand,
    runModelSelector,
  };
}

function mergeSlashCommands(...groups) {
  const byName = new Map();
  for (const group of groups) {
    for (const command of group || []) {
      if (command?.name && !byName.has(command.name)) {
        byName.set(command.name, command);
      }
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function sessionMenuOption(session) {
  const values = [singleLineText(session?.id), singleLineText(session?.title), singleLineText(session?.updated_at)];
  if (session?.current) values.push("current");
  return values.filter(Boolean).join(" · ");
}

function modelSetResultText(result, model) {
  const sessionModel = singleLineText(result?.session_model || result?.model || model);
  const defaultModel = singleLineText(result?.default_model);
  const lines = ["Session model updated."];
  if (sessionModel) lines.push(`- session model: ${sessionModel}`);
  if (defaultModel) lines.push(`- default model: ${defaultModel} (unchanged)`);
  lines.push(result?.active_updated || result?.runtime || result?.session
    ? "- active session: updated"
    : "- active session: unchanged; start a new session to use this model");
  return commandResultText(lines[0], lines.slice(1).join(" · "));
}

function singleLineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
