import { currentTheme, setTheme, themeNames, themeOptions } from "./theme.js";
import {
  currentSpinner,
  isBriefMode,
  setBriefMode,
  setSpinner,
  spinnerNames,
  spinnerOptions,
} from "./cli-state-store.js";

const SETTINGS_USAGE = "/settings [brief [on | off] | theme [<name>] | spinner [<name>] | import [<source>=on|off ...]]";

export const LOCAL_SLASH_COMMANDS = Object.freeze([
  { name: "compact", description: "Compact current session context", usage: "/compact" },
  { name: "context", description: "Show context composition and token usage", usage: "/context" },
  { name: "effort", description: "Show or change reasoning effort", usage: "/effort [low | medium | high | xhigh | max]" },
  { name: "fork", description: "Fork the current session", usage: "/fork" },
  { name: "goal", description: "View or control the active goal", usage: "/goal [pause | resume | clear | objective]" },
  { name: "help", description: "Show commands", usage: "/help [command]" },
  { name: "history", description: "Load earlier messages of this conversation", usage: "/history" },
  { name: "init", description: "Draft RIND.md", usage: "/init [project|user]" },
  { name: "login", description: "Configure a provider", usage: "/login [provider]" },
  { name: "logout", description: "Remove a stored provider credential", usage: "/logout [provider]" },
  { name: "model", description: "Show or change the active model", usage: "/model | /model set <model>" },
  { name: "remote", description: "Share this session with your phone or browser via QR code", usage: "/remote" },
  { name: "rename", description: "Name this conversation (otherwise it is shown by its first message)", usage: "/rename <name> | /rename --reset" },
  { name: "sessions", description: "List recent sessions", usage: "/sessions [limit]" },
  { name: "settings", description: "Configure brief output, color theme, working spinner, and skill imports", usage: SETTINGS_USAGE },
  { name: "skill", description: "List skills and where they come from", usage: "/skill" },
  { name: "status", description: "Show model, provider, conversation and context use", usage: "/status" },
  { name: "tour", description: "Interactive feature walkthrough", usage: "/tour [page]" },
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
  if (name === "settings") return settingsResult(argument, context);
  if (name === "model" && !argument && !context.interactive) return { text: `Model: ${currentModelLabel(context)}` };
  return null;
}

function usageResult(usage) {
  return { text: `Usage: ${usage}`, level: "warning" };
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
  const pendingName = !info.session_id && context.pendingName ? String(context.pendingName) : "";
  const entries = [
    { group: "model", label: "model", value: info.model || "unknown" },
    { group: "model", label: "effort", value: info.reasoning_effort || "unset" },
    { group: "provider", label: "provider", value: info.provider || "unknown" },
    configured.length
      ? { group: "provider", label: "signed in", value: configured.join(", ") }
      : { group: "provider", label: "signed in", value: "none", note: "/login", tone: "warning", actions: ["/login"] },
    info.session_id
      ? { group: "conversation", label: "session", value: info.session_id }
      : { group: "conversation", label: "session", value: "none", note: "the first message starts it" },
    // The Runtime's /status reads the saved name; this one runs before the Runtime is reachable.
    pendingName
      ? { group: "conversation", label: "name", value: pendingName, note: "applies when the conversation starts" }
      : { group: "conversation", label: "name", value: "unset", note: "shown by its first message" },
    ...(info.update_available ? [{ group: "settings", label: "update", value: `v${info.update_available} available`, note: "run rind update" }] : []),
  ];
  const selection = { provider: info.provider || "", model: info.model || "", reasoning_effort: info.reasoning_effort || "" };
  return {
    text: "Status",
    display: { type: "status", selection, entries, usage: [] },
  };
}

function helpResult(argument, commands) {
  const name = argument.replace(/^\//, "").toLowerCase();
  const visible = commands.filter((command) => (!name || command.name === name || command.aliases?.includes(name)));
  if (name && !visible.length) return { text: `Unknown command: /${name}\nRun /help to see available commands.`, level: "warning" };
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
      return { text: `Unknown theme "${requested}". Available: ${themeNames().join(", ")}.`, level: "warning" };
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

function spinnerResult(argument, context = {}) {
  const requested = argument.replace(/^\//, "").trim();
  if (requested) {
    const previous = currentSpinner();
    const applied = setSpinner(requested);
    if (!applied) {
      return { text: `Unknown spinner "${requested}". Available: ${spinnerNames().join(", ")}.`, level: "warning" };
    }
    context.persistSpinner?.(applied.name);
    return {
      text: `Working spinner: ${applied.name}`,
      display: {
        type: "spinner",
        changed: previous.name !== applied.name,
        previous: previous.name,
        current: applied.name,
        spinners: spinnerOptions(),
      },
    };
  }
  const current = currentSpinner();
  return {
    text: `Working spinner: ${current.name}`,
    display: {
      type: "spinner",
      changed: false,
      current: current.name,
      spinners: spinnerOptions(),
    },
  };
}

function settingsResult(argument, context = {}) {
  const parts = argument.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const enabled = isBriefMode();
    return {
      text: `Brief output: ${enabled ? "on" : "off"}`,
      display: { type: "brief", changed: false, enabled },
    };
  }
  const section = parts[0].toLowerCase();
  if (section === "import") return null;
  if (section === "theme") {
    if (parts.length > 2) return usageResult(SETTINGS_USAGE);
    return themeResult(parts[1] || "", context);
  }
  if (section === "spinner") {
    if (parts.length > 2) return usageResult(SETTINGS_USAGE);
    return spinnerResult(parts[1] || "", context);
  }
  if (section !== "brief" || parts.length > 2) {
    return usageResult(SETTINGS_USAGE);
  }
  const requested = (parts[1] || "").toLowerCase();
  if (!requested) {
    const enabled = isBriefMode();
    return {
      text: `Brief output: ${enabled ? "on" : "off"}`,
      display: { type: "brief", changed: false, enabled },
    };
  }
  if (requested !== "on" && requested !== "off") {
    return usageResult(SETTINGS_USAGE);
  }
  const previous = isBriefMode();
  const enabled = setBriefMode(requested === "on");
  context.persistBrief?.(enabled);
  return {
    text: `Brief output: ${enabled ? "on" : "off"}`,
    display: {
      type: "brief",
      changed: previous !== enabled,
      enabled,
    },
  };
}
