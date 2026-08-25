import { parseGoalCommand } from "./slash-command-mode.js";
import {
  helpText,
  slashResultText,
} from "./rendering.js";
import { LOCAL_SLASH_COMMANDS } from "./local-slash-commands.js";
import { runtimeMethods } from "./runtime-protocol.js";

const LOCAL_COMMANDS = Object.freeze([
  { name: "exit", description: "Exit Rind", aliases: ["quit"] },
]);

export function createCommandController({
  request,
  turn,
  input = {},
  state = {},
  output = {},
}) {
  async function handle(text) {
    if (text === "?") {
      output.log?.(helpText(state.slashCommands || []));
      return true;
    }
    if (!String(text || "").startsWith("/")) {
      return false;
    }
    if (isBareThemeCommand(text) && input.isTerminal && input.runThemeSelector) {
      await input.runThemeSelector();
      return true;
    }
    const localResult = await input.runLocalCommand?.(text);
    if (localResult) {
      await applyResult(localResult);
      return true;
    }
    const goal = parseGoalCommand(text);
    if (goal) {
      await input.runGoalCommand?.(goal);
      return true;
    }
    if (isLocalCommand(text, "exit") || isLocalCommand(text, "quit")) {
      output.log?.("Goodbye.");
      await output.shutdown?.();
      output.exit?.();
      return true;
    }
    await runSlashCommand(text);
    return true;
  }

  async function runSlashCommand(text) {
    if (isBareModelCommand(text) && input.isTerminal && input.runModelSelector) {
      await input.runModelSelector();
      return;
    }
    if (isCompactCommand(text) && input.isTerminal) {
      input.startCompactCommand?.();
      return;
    }
    if (isBareSessionsCommand(text) && input.isTerminal) {
      await input.runSessionsSelector?.();
      return;
    }
    const result = await request(runtimeMethods.commandExecute, { input: text });
    await applyResult(result);
  }

  async function applyResult(result = {}) {
    const text = slashResultText(result, state.slashCommands || []);
    if (text) {
      output.log?.(text);
    }
    if (result.display?.type === "team_blueprints" && input.askTeamBlueprint) {
      const blueprints = Array.isArray(result.display.blueprints) ? result.display.blueprints : [];
      const selected = await input.askTeamBlueprint(blueprints);
      if (selected?.id) {
        await runSlashCommand(`/team blueprint ${selected.id}`);
      }
      return;
    }
    if (result.prompt_prefill) {
      output.setInputPrefill?.(result.prompt_prefill);
    }
    const nextPromptInput = result.next_prompt?.input;
    if (typeof nextPromptInput === "string" && nextPromptInput.trim()) {
      turn.submit(nextPromptInput, {
        transient_system_messages: result.next_prompt.transient_system_messages,
      });
    }
  }

  function normalizeCommands(commands) {
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

  return {
    handle,
    normalizeCommands,
    localCommands: () => [
      ...LOCAL_COMMANDS,
      ...LOCAL_SLASH_COMMANDS,
    ].flatMap((command) => normalizeCommands([command])),
    applyResult,
  };
}

function singleWord(value) {
  const text = String(value || "").trim().toLowerCase();
  return text && !/\s/.test(text) ? text : "";
}

function isBareModelCommand(value) {
  return String(value || "").trim().toLowerCase() === "/model";
}

function isBareThemeCommand(value) {
  return String(value || "").trim().toLowerCase() === "/theme";
}

function isLocalCommand(value, name) {
  return String(value || "").trim().toLowerCase() === `/${name}`;
}

function isBareSessionsCommand(value) {
  return String(value || "").trim().toLowerCase() === "/sessions";
}

function isCompactCommand(value) {
  return String(value || "").trim().toLowerCase() === "/compact";
}
