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
      output.log?.(() => helpText(state.slashCommands || []));
      return true;
    }
    if (!String(text || "").startsWith("/")) {
      return false;
    }
    const { name, arg } = parseSlashInput(text);
    if (name === "settings") {
      const subMatch = arg.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
      const sub = subMatch ? subMatch[1].toLowerCase() : "";
      const subArg = subMatch ? String(subMatch[2] || "").trim() : "";
      if (!sub && input.isTerminal && input.runSettingsSelector) {
        await input.runSettingsSelector();
        return true;
      }
      if ((sub === "theme" || sub === "spinner") && !subArg && input.isTerminal && input.runSettingsSelector) {
        await input.runSettingsSelector(sub);
        return true;
      }
      if (sub === "import") {
        if (!subArg && input.isTerminal && input.runSettingsSelector) {
          await input.runSettingsSelector("import");
          return true;
        }
        const result = await request(runtimeMethods.commandExecute, {
          input: subArg ? `/import ${subArg}` : "/import",
        });
        await applyResult(result);
        return true;
      }
    }
    if (name === "tour") {
      if (input.isTerminal && input.runTour) {
        await input.runTour(arg);
      } else {
        output.log?.("/tour requires an interactive terminal.");
      }
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
    if (name === "exit" || name === "quit") {
      if (arg) {
        output.log?.(`Usage: /${name}`);
        return true;
      }
      output.log?.("Goodbye.");
      await output.shutdown?.();
      output.exit?.();
      return true;
    }
    if (name === "login" || name === "logout") {
      if (/\s/.test(arg)) {
        output.log?.(`Usage: /${name} [provider]`);
        return true;
      }
      await (name === "login" ? input.runLogin : input.runLogout)?.(arg);
      return true;
    }
    await runSlashCommand(text, name, arg);
    return true;
  }

  async function runSlashCommand(text, name, arg) {
    if (name === "import" || name === "brief" || name === "theme") {
      output.log?.(`Unknown command: /${name}\nRun /help to see available commands.`);
      return;
    }
    if (name === "rename" && input.runRename) {
      await applyResult(await input.runRename(arg));
      return;
    }
    if (name === "model") {
      if (!arg && input.isTerminal && input.runModelSelector) {
        await input.runModelSelector();
        return;
      }
      if (input.runModelCommand) {
        await input.runModelCommand(arg);
        return;
      }
    }
    if (name === "effort") {
      await input.runEffortCommand?.(arg);
      return;
    }
    if (name === "compact" && !arg && input.startCompactCommand) {
      input.startCompactCommand?.();
      return;
    }
    if (name === "sessions" && !arg && input.isTerminal) {
      await input.runSessionsSelector?.();
      return;
    }
    if (name === "history") {
      if (arg) {
        output.log?.("Usage: /history");
      } else if (input.isTerminal && input.runHistoryLoader) {
        await input.runHistoryLoader();
      } else {
        output.log?.("/history requires an interactive terminal.");
      }
      return;
    }
    if (name === "fork") {
      if (arg) {
        output.log?.("Usage: /fork");
      } else if (input.isTerminal && input.runForkSelector) {
        await input.runForkSelector();
      } else {
        output.log?.("/fork requires an interactive terminal.");
      }
      return;
    }
    if (name === "context") {
      if (arg) {
        output.log?.("Custom ranges are not supported yet; showing the last 5 days.");
      }
      if (input.isTerminal && input.runContextBoard) {
        await input.runContextBoard();
      } else if (input.printContextReport) {
        await input.printContextReport();
      } else {
        output.log?.("/context requires a connected runtime.");
      }
      return;
    }
    const result = await request(runtimeMethods.commandExecute, { input: text });
    await applyResult(result);
  }

  async function applyResult(result = {}) {
    const text = () => slashResultText(result, state.slashCommands || []);
    output.log?.(text);
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
      if (!name || name === "import") {
        continue;
      }
      const description = String(command.description || "").trim();
      items.push({ name, description });
      for (const alias of command.aliases || []) {
        const aliasName = singleWord(alias);
        if (aliasName && aliasName !== "import") {
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

function parseSlashInput(value) {
  const match = String(value || "").trim().match(/^\/([^\s]*)(?:\s+([\s\S]*))?$/);
  return {
    name: String(match?.[1] || "").toLowerCase(),
    arg: String(match?.[2] || "").trim(),
  };
}

function singleWord(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[^\s/]+$/.test(normalized) ? normalized : "";
}
