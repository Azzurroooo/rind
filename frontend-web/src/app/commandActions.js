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
      openContext: () => ctx.layout.openInspector("context"),
      compact: () => actions.compact(),
      stopTurn: () => actions.cancelTurn(),
      scrollToLatest: () => refs.conversation.current?.scrollToLatest(),
      toggleTheme: () => ctx.theme.toggle(),
      clearInput: () => ctx.setInput(""),
      focusComposer: () => refs.composer.current?.focus(),
      showHelp: () => showHelp(),
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
    const command = findCommandBySlash(commandList, parsed.name);
    if (command) {
      try {
        await command.run(commandCtx(), parsed.argument);
      } catch (error) {
        say("system", `Command failed: ${errorText(error)}`, "error");
      }
      return;
    }
    say("system", "Command unavailable here. Use /help for chat commands, or open Settings and the command palette.");
  }

  async function runServerSlash(name, argument) {
    if (!findCommandBySlash(commandList, name)) return;
    const text = argument ? `/${name} ${argument}` : `/${name}`;
    const client = refs.client.current;
    const sessionId = refs.info.current.session_id;
    const result = await client.request(methods.commandExecute, { session_id: sessionId, input: text });
    if (refs.client.current !== client || refs.info.current.session_id !== sessionId) return;
    ctx.dispatchConversation({ kind: "message", role: "system", content: result?.text || formatResult(result), display: result?.display });
  }

  function showHelp() {
    const lines = commandList
      .filter((command) => command.slash)
      .map((command) => `/${command.slash} — ${command.title}${command.keybind ? ` (${command.keybind})` : ""}`)
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
