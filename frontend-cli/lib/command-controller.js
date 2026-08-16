import {
  isReadonlySlashCommand,
  parseGoalCommand,
  steeringCommandText,
} from "./slash-command-mode.js";
import {
  helpText,
  slashResultText,
} from "./rendering.js";
import { runtimeMethods } from "./runtime-protocol.js";

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
    await runSlashCommand(text);
    return true;
  }

  async function runSlashCommand(text) {
    if (isBareModelCommand(text) && input.isTerminal) {
      await input.runModelSelector?.();
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
    if (isReadonlySlashCommand(text) && input.isTerminal) {
      input.startReadonlySlashCommand?.(text);
      return;
    }
    const result = await request(runtimeMethods.commandExecute, { input: text });
    await applyResult(result);
  }

  async function applyResult(result = {}) {
    if (result.clear_screen) {
      output.clearScreen?.();
    }
    const text = slashResultText(result, state.slashCommands || []);
    if (text) {
      output.log?.(text);
    }
    if (result.context_usage_reset) {
      output.resetContextUsage?.();
    }
    if (result.input_prefill) {
      output.setInputPrefill?.(result.input_prefill);
    }
    if (result.run_turn_input) {
      turn.submit(result.run_turn_input, {
        transient_system_messages: result.transient_system_messages,
      });
    }
    if (result.should_exit) {
      await output.shutdown?.();
      output.exit?.();
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

  return { handle, normalizeCommands, applyResult };
}

function singleWord(value) {
  const text = String(value || "").trim().toLowerCase();
  return text && !/\s/.test(text) ? text : "";
}

function isBareModelCommand(value) {
  return String(value || "").trim().toLowerCase() === "/model";
}

function isBareSessionsCommand(value) {
  return String(value || "").trim().toLowerCase() === "/sessions";
}

function isCompactCommand(value) {
  return String(value || "").trim().toLowerCase() === "/compact";
}
