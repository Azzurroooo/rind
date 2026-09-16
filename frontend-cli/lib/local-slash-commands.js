import { currentTheme, setTheme, themeNames, themeOptions } from "./theme.js";

export const LOCAL_SLASH_COMMANDS = Object.freeze([
  { name: "compact", description: "Compact current session context", usage: "/compact" },
  { name: "context", description: "Show context composition and token usage", usage: "/context" },
  { name: "effort", description: "Show or change reasoning effort", usage: "/effort [low | medium | high | xhigh | max]" },
  { name: "fork", description: "Fork the current session", usage: "/fork" },
  { name: "goal", description: "View or control the active goal", usage: "/goal [pause | resume | clear | objective]" },
  { name: "help", description: "Show commands", usage: "/help [command]" },
  { name: "init", description: "Draft RIND.md", usage: "/init [project|user]" },
  { name: "login", description: "Configure a provider", usage: "/login [provider]" },
  { name: "logout", description: "Remove a stored provider credential", usage: "/logout [provider]" },
  { name: "model", description: "Show or change the active model", usage: "/model | /model set <model>" },
  { name: "sessions", description: "List recent sessions", usage: "/sessions [limit]" },
  { name: "skill", description: "List skills", usage: "/skill [list]" },
  { name: "status", description: "Show session and provider status", usage: "/status" },
  { name: "team", description: "Manage the current Team", usage: "/team create [project-id] | /team init | /team list | /team blueprint [id] | /team add <description>" },
  { name: "theme", description: "Switch the CLI color theme", usage: "/theme [latte | frappe | macchiato | mocha]" },
]);

export async function executeLocalSlashCommand(input, context = {}) {
  const match = String(input || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const argument = String(match[2] || "").trim();
  if (name === "status") {
    if (!argument && context.runtimeInitialized) return null;
    return statusResult(context, argument);
  }
  if (name === "help") return helpResult(argument, context.commands || []);
  if (name === "theme") return themeResult(argument, context);
  if (name === "model" && !argument && !context.interactive) return { text: `Model: ${currentModelLabel(context)}` };
  return null;
}

function usageResult(usage) {
  return { text: `Usage: ${usage}` };
}

function currentModelLabel(context) {
  const info = context.sessionInfo || {};
  const provider = String(info.provider || "").trim();
  const model = String(info.model || "").trim() || "unknown";
  return provider ? `${provider} / ${model}` : model;
}

function statusResult(context, argument) {
  if (argument) return usageResult("/status");
  const info = context.sessionInfo || {};
  const providers = Array.isArray(info.providers) ? info.providers : [];
  const configured = providers.filter((item) => item?.configured).map((item) => String(item.id || ""));
  const entries = [
    { label: "session", value: info.session_id || "none" },
    { label: "provider", value: info.provider || "unknown" },
    { label: "model", value: info.model || "unknown" },
    { label: "reasoningEffort", value: info.reasoning_effort || "unset" },
    { label: "configured", value: configured.join(", ") || "none — run /login" },
  ];
  return {
    text: "Status",
    display: { type: "status", entries, usage: [] },
  };
}

function helpResult(argument, commands) {
  const name = argument.replace(/^\//, "").toLowerCase();
  const visible = commands.filter((command) => (!name || command.name === name || command.aliases?.includes(name)));
  if (name && !visible.length) return { text: `Unknown command: /${name}\nRun /help to see available commands.` };
  const selected = name ? visible[0] : null;
  const text = selected
    ? `/${selected.name}\n${selected.description}\nUsage: ${selected.usage || `/${selected.name}`}`
    : ["Commands:", ...visible.map((command) => `/${command.name} - ${command.description}`)].join("\n");
  return {
    text,
    display: { type: "help", ...(selected ? { command: selected } : { commands: visible }) },
  };
}

function themeResult(argument, context = {}) {
  const requested = argument.replace(/^\//, "").trim();
  if (requested) {
    const previous = currentTheme();
    const applied = setTheme(requested);
    if (!applied) {
      return { text: `Unknown theme "${requested}". Available: ${themeNames().join(", ")}.` };
    }
    context.persistTheme?.(applied.name);
    return {
      text: `Theme: ${applied.name}`,
      display: {
        type: "theme",
        changed: true,
        previous: previous.name,
        current: applied.name,
        flavors: themeOptions(),
      },
    };
  }
  const current = currentTheme();
  return {
    text: `Theme: ${current.name}`,
    display: {
      type: "theme",
      changed: false,
      current: current.name,
      flavors: themeOptions(),
    },
  };
}
