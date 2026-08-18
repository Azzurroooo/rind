import { isReadonlySlashCommand, parseGoalCommand, steeringCommandText } from "./slash-command-mode.js";
import {
  helpText,
  slashResultText,
} from "./rendering.js";
import { isRemovedSlashCommand, LOCAL_SLASH_COMMANDS } from "./local-slash-commands.js";
import { runtimeMethods } from "./runtime-protocol.js";

const LOCAL_COMMANDS = Object.freeze([
  { name: "clear", description: "Clear terminal output" },
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
    const localResult = await input.runLocalCommand?.(text);
    if (localResult) {
      await applyResult(localResult);
      return true;
    }
    if (isRemovedSlashCommand(text)) {
      output.log?.(`Unknown command: ${String(text).trim().split(/\s+/, 1)[0]}\nRun /help to see available commands.`);
      return true;
    }
    const goal = parseGoalCommand(text);
    if (goal) {
      await input.runGoalCommand?.(goal);
      return true;
    }
    const steering = steeringCommandText(text);
    if (steering !== null) {
      turn.submitSteering(steering, text);
      return true;
    }
    if (isLocalCommand(text, "clear")) {
      output.clearScreen?.();
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
    if (isReadonlySlashCommand(text) && input.isTerminal && input.startReadonlySlashCommand) {
      input.startReadonlySlashCommand(text);
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
    if (result.prompt_prefill) {
      output.setInputPrefill?.(result.prompt_prefill);
    }
    if (result.next_prompt?.input) {
      turn.submit(result.next_prompt.input, {
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
      if (!name || isRemovedSlashCommand(name)) {
        continue;
      }
      const description = String(command.description || "").trim();
      items.push({ name, description });
      for (const alias of command.aliases || []) {
        const aliasName = singleWord(alias);
        if (aliasName && !isRemovedSlashCommand(aliasName)) {
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

function isLocalCommand(value, name) {
  return String(value || "").trim().toLowerCase() === `/${name}`;
}

function isBareSessionsCommand(value) {
  return String(value || "").trim().toLowerCase() === "/sessions";
}

function isCompactCommand(value) {
  return String(value || "").trim().toLowerCase() === "/compact";
}
