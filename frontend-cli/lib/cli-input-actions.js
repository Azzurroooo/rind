import { createLineEditor } from "./line-editor.js";
import { createChoiceMenuState } from "./choice-menu-state.js";
import { createModelMenuState } from "./model-menu-state.js";
import { createThemeMenuState } from "./theme-menu-state.js";
import { createQuestionMenuState } from "./question-menu-state.js";
import { createSlashMenuState } from "./slash-menu-state.js";
import { runtimeMethods } from "./runtime-protocol.js";
import { parseTerminalKey } from "./terminal-key.js";
import {
  answerPromptText,
  answerPlaceholderText,
  questionText,
} from "./rendering.js";

export function createCliInputActions({
  state,
  request,
  output,
  getTurnController,
  getTaskMonitor,
  getLineInput,
  pausePrompt,
  resumePrompt,
  handleSigint,
}) {
  let cancelActiveInput = null;
  const promptEditor = createLineEditor();

  function restoreInputText(text) {
    state.input.prefill = String(text || "");
    if (state.input.session?.editor) {
      state.input.session.editor.setInput(state.input.prefill);
      state.input.prefill = "";
      output.redraw();
    }
  }

  function addPendingInput(input, mode, result = {}) {
    const inputId = String(result?.input_id || "").trim();
    if (!inputId) {
      throw new Error("Runtime accepted queued input without input_id.");
    }
    state.input.pending.push({ inputId, input, mode });
    output.redraw();
  }

  function deliverQueuedInput(input, _mode, inputId) {
    const index = state.input.pending.findIndex((entry) => entry.inputId === inputId);
    if (index === -1) {
      return;
    }
    state.input.pending.splice(index, 1);
    output.suspendPrompt(() => output.writeUserInput(input));
  }

  async function retrievePendingInput(mode, session) {
    if (state.input.retrievingModes.has(mode)) {
      return;
    }
    const entry = [...state.input.pending].reverse().find((item) => item.mode === mode);
    if (!entry) {
      return;
    }
    state.input.retrievingModes.add(mode);
    const method = mode === "steering"
      ? runtimeMethods.sessionUnsteer
      : runtimeMethods.sessionDequeueFollowUp;
    try {
      const result = await request(method);
      const inputId = String(result?.input_id || "").trim();
      const input = String(result?.input || "");
      if (result?.retrieved !== true || result?.mode !== mode || inputId !== entry.inputId || !input) {
        throw new Error("Runtime returned an invalid queued input retrieval.");
      }
      const index = state.input.pending.findIndex((item) => item.inputId === inputId);
      if (index === -1) {
        throw new Error("Retrieved input is not present in the local queue.");
      }
      state.input.pending.splice(index, 1);
      const current = session.editor.input();
      session.editor.setInput([input, current].filter((value) => value.trim()).join("\n\n"));
      output.redraw();
    } catch (error) {
      if (state.runtime.status !== "closing") {
        output.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    } finally {
      state.input.retrievingModes.delete(mode);
    }
  }

  function clearPendingInputs() {
    if (!state.input.pending.length) {
      return;
    }
    state.input.pending.length = 0;
    output.redraw();
  }

  async function answerQuestion(event) {
    pausePrompt();
    output.closeAssistant();
    output.log(questionText(event));
    try {
      const options = Array.isArray(event.options) ? event.options : [];
      const answer = output.terminalUi
        ? await askQuestionMenu(event)
        : selectAnswer((await ask(answerPromptText(), answerPlaceholderText())).trim(), options);
      if (state.turn.interruptRequested || state.runtime.status === "closing") {
        return;
      }
      await request(runtimeMethods.userQuestionRespond, {
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
      const option = options[index - 1];
      return typeof option === "string" ? option : String(option?.label || "");
    }
    return raw;
  }

  function ask(prompt, placeholder = "") {
    if (!output.terminalUi) {
      if (!getLineInput()) {
        return Promise.reject(new Error("Input is not available"));
      }
      return askLine(promptValue(prompt));
    }
    return askTtyInput(prompt, placeholder);
  }

  function askLine(prompt) {
    return new Promise((resolve, reject) => {
      const lineInput = getLineInput();
      const cleanup = () => {
        state.input.active = false;
        lineInput.off("close", onClose);
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
      lineInput.once("close", onClose);
      cancelActiveInput = onCancel;
      state.input.active = true;
      lineInput.question(prompt, (answer) => {
        cleanup();
        resolve(answer);
      });
      applyInputPrefill(lineInput);
    });
  }

  function askTtyInput(prompt, placeholder) {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const mode = placeholder && placeholder !== answerPlaceholderText() ? "prompt" : "line";
      const initialInput = state.input.prefill;
      const editor = mode === "prompt" ? promptEditor : createLineEditor(initialInput);
      if (mode === "prompt") {
        editor.setInput(initialInput);
      }
      editor.setViewportWidth(process.stdout.columns || 80);
      const menuState = mode === "prompt" ? createSlashMenuState(state.session.commands) : null;
      state.input.prefill = "";
      state.input.session = { mode, prompt, placeholder, editor, menuState, resolve };
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(state.input.session, "", false);
      output.redraw(true);
    });
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
    if (event.ctrl && !event.alt && !event.shift && event.name === "o") {
      state.display.toolDetailsExpanded = !state.display.toolDetailsExpanded;
      output.setToolsExpanded?.(state.display.toolDetailsExpanded);
      return;
    }
    const monitor = getTaskMonitor();
    if (monitor?.isMonitoring()) {
      monitor.handleInput(event);
      return;
    }
    if (event.ctrl && event.name === "b") {
      monitor?.enterMonitor();
      return;
    }
    const session = state.input.session;
    if (!session) {
      return;
    }
    if (session.mode === "model") {
      handleModelInput(session, event);
      return;
    }
    if (session.mode === "theme") {
      handleThemeInput(session, event);
      return;
    }
    if (session.mode === "question") {
      handleQuestionInput(session, event);
      return;
    }
    if (session.mode === "sessions") {
      handleSessionInput(session, event);
      return;
    }
    if (session.mode === "team-blueprints") {
      handleTeamBlueprintInput(session, event);
      return;
    }
    const key = event;
    const matches = session.menuState ? syncSlashMenu(session) : [];
    const menuKey = !key.ctrl && !key.alt && !key.shift && ["escape", "up", "down"].includes(key.name);
    if (session.menuState && matches.length && menuKey && session.menuState.handleKey("", key)) {
      output.redraw();
      return;
    }
    if (session.mode === "prompt" && state.turn.active && !key.ctrl && !key.alt && !key.shift && key.name === "tab") {
      queueTtyInput(session);
      return;
    }
    if (session.mode === "prompt" && key.alt && !key.ctrl && !key.shift && key.name === "up" && state.input.pending.some((item) => item.mode === "follow_up")) {
      void retrievePendingInput("follow_up", session);
      return;
    }
    if (session.mode === "prompt" && key.alt && !key.ctrl && !key.shift && key.name === "down" && state.input.pending.some((item) => item.mode === "steering")) {
      void retrievePendingInput("steering", session);
      return;
    }
    const result = session.editor.handleInput(key);
    if (result === "submit") {
      submitTtyInput(session);
      return;
    }
    if (result) {
      output.redraw();
    }
  }

  function handleTerminalPaste(text) {
    const monitor = getTaskMonitor();
    if (monitor?.isMonitoring()) {
      return;
    }
    const session = state.input.session;
    if (!session || session.mode === "model" || session.mode === "theme" || session.mode === "sessions") {
      return;
    }
    if (session.mode === "question" && !session.questionState.isEditing()) {
      return;
    }
    session.editor.handleInput({ kind: "paste", text });
    output.redraw();
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
    if (!modified && session.modelState.handleKey(key)) output.redraw();
  }

  function askThemeMenu() {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const themeState = createThemeMenuState();
      if (!themeState.items().length) {
        resolve("");
        return;
      }
      const session = { mode: "theme", inputText: "/theme", themeState, resolve };
      state.input.session = session;
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(session, "", false);
      output.redraw(true);
    });
  }

  function handleThemeInput(session, key) {
    const modified = key.ctrl || key.alt || key.shift;
    if (!modified && (key.name === "enter" || key.name === "return")) {
      const theme = session.themeState.selectedTheme()?.name || "";
      completeTtyInput(session, theme, Boolean(theme), "", theme ? `/theme ${theme}` : "");
      return;
    }
    if (!modified && key.name === "escape") {
      completeTtyInput(session, "", false);
      return;
    }
    if (!modified && session.themeState.handleKey(key)) output.redraw();
  }

  function submitTtyInput(session) {
    if (session.menuState) syncSlashMenu(session);
    const command = session.menuState?.selectedCommand();
    const value = command ? `/${command.name}` : session.editor.input();
    if (session.mode === "prompt") session.editor.addToHistory(value);
    completeTtyInput(session, value, session.mode === "prompt" && !state.turn.active, session.mode === "line" ? "\n" : "");
  }

  function queueTtyInput(session) {
    const value = session.editor.input();
    if (!value.trim()) return;
    session.editor.addToHistory(value);
    completeTtyInput(session, "", false);
    getTurnController().submitFollowUp(value);
  }

  function completeTtyInput(session, value, writeUser, lineText = "", displayValue = value) {
    if (state.input.session !== session) return;
    state.input.session = null;
    state.input.active = false;
    cancelActiveInput = null;
    if (writeUser) {
      output.writeUserInput(displayValue);
    } else if (!output.terminalUi && lineText && String(value || "").trim()) {
      process.stdout.write("\n");
    }
    session.resolve(value);
  }

  function askModelMenu(models, currentModel) {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const modelState = createModelMenuState(models, currentModel);
      if (!modelState.items().length) {
        resolve("");
        return;
      }
      const session = { mode: "model", inputText: "/model", modelState, resolve };
      state.input.session = session;
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(session, "", false);
      output.redraw(true);
    });
  }

  function askQuestionMenu(event) {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const options = (Array.isArray(event.options) ? event.options : [])
        .map((option) => ({ label: String(option?.label || "").trim(), description: String(option?.description || "").trim() }))
        .filter((option) => option.label);
      const questionState = createQuestionMenuState(options);
      state.input.session = {
        mode: "question",
        question: String(event.question || "Input required"),
        questionState,
        editor: null,
        resolve,
      };
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(state.input.session, "", false);
      output.redraw(true);
    });
  }

  function askSessionMenu(options, sessions, currentIndex) {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const choiceState = createChoiceMenuState(options, options[currentIndex] || "");
      const session = { mode: "sessions", inputText: "/sessions", choiceState, sessions, resolve };
      state.input.session = session;
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(session, null, false);
      output.redraw(true);
    });
  }

  function askTeamBlueprint(blueprints) {
    return new Promise((resolve) => {
      output.clearAssistantLineForInput();
      const items = (Array.isArray(blueprints) ? blueprints : []).map((item) => ({
        id: String(item?.id || ""),
        label: [item?.id, item?.name, item?.description].filter(Boolean).join(" · "),
      })).filter((item) => item.id);
      if (!items.length) {
        resolve(null);
        return;
      }
      const choiceState = createChoiceMenuState(items.map((item) => item.label), items[0].label);
      const session = { mode: "team-blueprints", inputText: "/team blueprint", choiceState, items, resolve };
      state.input.session = session;
      state.input.active = true;
      cancelActiveInput = () => completeTtyInput(session, null, false);
      output.redraw(true);
    });
  }

  function handleQuestionInput(session, key) {
    const modified = key.ctrl || key.alt || key.shift;
    if (session.questionState.isEditing()) {
      if (!modified && key.name === "escape") return completeTtyInput(session, "", false);
      if (!modified && session.questionState.handleNavigation(key)) {
        session.editor = null;
        output.redraw();
        return;
      }
      const result = session.editor.handleInput(key);
      if (result === "submit") {
        const answer = session.editor.input().trim();
        if (answer) completeTtyInput(session, answer, false);
        else output.redraw();
        return;
      }
      if (result) output.redraw();
      return;
    }
    if (!modified && (key.name === "enter" || key.name === "return" || key.name === "tab")) {
      if (session.questionState.enterEditing()) {
        session.editor = createLineEditor();
        session.editor.setViewportWidth(process.stdout.columns || 80);
        output.redraw();
        return;
      }
      if (key.name === "tab") return;
      completeTtyInput(session, session.questionState.selectedOption()?.label || "", false);
      return;
    }
    if (!modified && key.name === "escape") return completeTtyInput(session, "", false);
    if (!modified && session.questionState.handleNavigation(key)) {
      session.editor = null;
      output.redraw();
    }
  }

  function handleSessionInput(session, key) {
    const modified = key.ctrl || key.alt || key.shift;
    if (!modified && (key.name === "enter" || key.name === "return")) {
      completeTtyInput(session, session.sessions[session.choiceState.selectedIndex()] || null, false);
      return;
    }
    if (!modified && key.name === "escape") return completeTtyInput(session, null, false);
    if (!modified && session.choiceState.handleKey(key)) output.redraw();
  }

  function handleTeamBlueprintInput(session, key) {
    const modified = key.ctrl || key.alt || key.shift;
    if (!modified && (key.name === "enter" || key.name === "return")) {
      completeTtyInput(session, session.items[session.choiceState.selectedIndex()] || null, false);
      return;
    }
    if (!modified && key.name === "escape") return completeTtyInput(session, null, false);
    if (!modified && session.choiceState.handleKey(key)) output.redraw();
  }

  function syncSlashMenu(session) {
    session.menuState.setInput(session.editor.input());
    return session.menuState.matches();
  }

  function applyInputPrefill(lineInput) {
    if (!state.input.prefill) return;
    const text = state.input.prefill;
    state.input.prefill = "";
    lineInput.write(text);
  }

  function promptValue(prompt) {
    return typeof prompt === "function" ? prompt() : prompt;
  }

  return {
    ask,
    answerQuestion,
    restoreInputText,
    addPendingInput,
    deliverQueuedInput,
    clearPendingInputs,
    handleTerminalInput,
    handleTerminalPaste,
    askModelMenu,
    askThemeMenu,
    askSessionMenu,
    askTeamBlueprint,
    cancel: () => cancelActiveInput?.(),
  };
}
