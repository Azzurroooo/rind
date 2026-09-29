import { methods, parseSlashCommand } from "../methods.js";
import { findCommandBySlash } from "../lib/commands.js";
import { errorText, formatResult } from "./constants.js";

// Slash commands and the palette: one registry (lib/commands.js) resolved
// against one ctx, whether the command came from "/" or Ctrl/Cmd+K.
export function createCommandActions(ctx) {
  const { refs, commandList } = ctx;
  const call = () => ctx.call.current;
  const say = (...args) => call().dispatchMessage(...args);

  function commandCtx() {
    const actions = call();
    return {
      newSession: () => actions.createSession(),
      forkSession: () => actions.forkSession(),
      focusSessions: () => {
        ctx.layout.showSidebar();
        requestAnimationFrame(() => {
          const search = document.getElementById("sidebar-search-input");
          search?.focus();
          search?.select?.();
        });
      },
      focusModel: () => focusChip("model"),
      focusEffort: () => focusChip("effort"),
      focusGoal: () => ctx.layout.openInspector("activity"),
      openContext: () => ctx.layout.openInspector("context"),
      compact: () => actions.compact(),
      stopTurn: () => actions.cancelTurn(),
      scrollToLatest: () => refs.conversation.current?.scrollToLatest(),
      toggleTheme: () => ctx.theme.toggle(),
      setTheme: (value) => ctx.theme.set(String(value || "").trim().toLowerCase()),
      clearInput: () => ctx.setInput(""),
      focusComposer: () => refs.composer.current?.focus(),
      showHelp: () => showHelp(),
      setModel: (model) => actions.setModel(model),
      setEffort: (effort) => actions.setEffort(effort),
      runGoal: (argument) => actions.runGoalCommand(argument),
      runServerSlash: (name, argument) => runServerSlash(name, argument),
    };
  }

  function focusChip(kind) {
    requestAnimationFrame(() => document.querySelector(`[data-composer-chip='${kind}']`)?.click());
  }

  async function runSlashCommand(text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) return;
    // CLI-compat quirk: `/model set gpt-x` normalizes to the plain model name.
    const argument = parsed.name === "model" && parsed.argument.toLowerCase().startsWith("set ")
      ? parsed.argument.slice(4).trim()
      : parsed.argument;
    const command = findCommandBySlash(commandList, parsed.name);
    if (command) {
      try {
        await command.run(commandCtx(), argument);
      } catch (error) {
        say("system", `Command failed: ${errorText(error)}`, "error");
      }
      return;
    }
    try {
      const result = await refs.client.current.request(methods.commandExecute, { session_id: refs.info.current.session_id, input: text });
      say("system", result?.text || formatResult(result));
    } catch (error) {
      say("system", `Command failed: ${errorText(error)}`, "error");
    }
  }

  async function runServerSlash(name, argument) {
    const text = argument ? `/${name} ${argument}` : `/${name}`;
    const result = await refs.client.current.request(methods.commandExecute, { session_id: refs.info.current.session_id, input: text });
    say("system", result?.text || formatResult(result));
  }

  function showHelp() {
    const lines = commandList
      .map((command) => `/${command.slash || command.id} — ${command.title}${command.keybind ? ` (${command.keybind})` : ""}`)
      .join("\n");
    say("system", `Available commands (Ctrl+K opens the command palette):\n${lines}`);
  }

  function closePalette() {
    ctx.setPaletteOpen(false);
    refs.composer.current?.focus();
  }

  async function runCommand(command) {
    ctx.setPaletteOpen(false);
    try {
      await command.run(commandCtx(), "");
    } catch (error) {
      say("system", `Command failed: ${errorText(error)}`, "error");
    } finally {
      refs.composer.current?.focus();
    }
  }

  function disarmInterrupt() {
    if (refs.interruptTimer.current) {
      window.clearTimeout(refs.interruptTimer.current);
      refs.interruptTimer.current = null;
    }
    ctx.setInterruptArmed(false);
  }

  return { runSlashCommand, runServerSlash, showHelp, closePalette, runCommand, disarmInterrupt };
}
