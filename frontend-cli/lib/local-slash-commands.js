import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { currentTheme, setTheme, themeNames, themeOptions } from "./theme.js";

export const LOCAL_SLASH_COMMANDS = Object.freeze([
  { name: "compact", description: "Compact current session context", usage: "/compact" },
  { name: "config", description: "Show config guidance", usage: "/config" },
  { name: "doctor", description: "Run local setup diagnostics", usage: "/doctor" },
  { name: "effort", description: "Show or change reasoning effort", usage: "/effort [low | medium | high | xhigh | max]" },
  { name: "goal", description: "View or control the active goal", usage: "/goal [pause | resume | clear | objective]" },
  { name: "help", description: "Show commands", usage: "/help [command]" },
  { name: "init", description: "Draft RIND.md", usage: "/init [project|user]" },
  { name: "login", description: "Show login setup guidance", usage: "/login" },
  { name: "model", description: "Show or change the active model", usage: "/model | /model set <model>" },
  { name: "sessions", description: "List recent sessions", usage: "/sessions [limit]" },
  { name: "skill", description: "List skills", usage: "/skill [list]" },
  { name: "status", description: "Show surface status", usage: "/status" },
  { name: "team", description: "Manage the current Team", usage: "/team create [project-id] | /team init | /team list | /team blueprint [id] | /team add <description>" },
  { name: "theme", description: "Switch the CLI color theme", usage: "/theme [latte | frappe | macchiato | mocha]" },
]);

export async function loadLocalSettings(
  rindHome = process.env.RIND_HOME || path.join(homedir(), ".rind"),
  workspaceRoot = process.cwd(),
) {
  const userSettingsPath = path.join(rindHome, "settings.json");
  const projectSettingsPath = path.resolve(workspaceRoot, ".rind", "settings.json");
  const project = await readSettingsFile(projectSettingsPath);
  if (project.exists && isCompleteProjectSettings(project.data)) {
    return buildLocalSettings(projectSettingsPath, project.data, project.error, project.exists);
  }
  const settings = await readSettingsFile(userSettingsPath);
  return buildLocalSettings(userSettingsPath, settings.data, settings.error, settings.exists);
}

async function readSettingsFile(settingsPath) {
  let data = {};
  let settingsExists = false;
  let error = "";
  try {
    data = JSON.parse(await readFile(settingsPath, "utf8"));
    settingsExists = true;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("settings.json must contain a JSON object");
    }
  } catch (cause) {
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    if (cause?.code !== "ENOENT") {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return { data, exists: settingsExists, error };
}

function buildLocalSettings(settingsPath, data, error, exists) {
  return {
    path: settingsPath,
    exists,
    error,
    model: stringValue(data.model) || "gpt-4o-mini",
    baseUrl: stringValue(data.baseUrl) || "https://api.openai.com/v1",
    reasoningEffort: stringValue(data.reasoningEffort) || "",
    hasApiKey: Boolean(stringValue(data.apiKey)),
  };
}

function isCompleteProjectSettings(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const apiKey = stringValue(data.apiKey);
  const baseUrl = stringValue(data.baseUrl);
  const model = stringValue(data.model);
  try {
    const url = new URL(baseUrl);
    return Boolean(apiKey && model && url.hostname && (url.protocol === "http:" || url.protocol === "https:"));
  } catch {
    return false;
  }
}

export async function executeLocalSlashCommand(input, context = {}) {
  const match = String(input || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const argument = String(match[2] || "").trim();
  if (name === "config") return configResult(context.settings, argument);
  if (name === "login") return argument ? usageResult("/login") : { text: "Login/config setup is not implemented yet.\nSet apiKey in ~/.rind/settings.json." };
  if (name === "status") {
    if (!argument && context.runtimeInitialized) return null;
    return statusResult(context, argument);
  }
  if (name === "doctor") return doctorResult(context, argument);
  if (name === "help") return helpResult(argument, context.commands || []);
  if (name === "theme") return themeResult(argument, context);
  if (name === "model" && !argument && !context.interactive) return { text: `Model: ${context.settings?.model || "unknown"}` };
  return null;
}

function usageResult(usage) {
  return { text: `Usage: ${usage}` };
}

function configResult(settings = {}, argument) {
  if (argument) return usageResult("/config");
  const apiKey = settings.hasApiKey ? "set" : "unset";
  const reasoning = settings.reasoningEffort || "unset";
  const entries = [
    { label: "settings", value: settings.path || "~/.rind/settings.json", state: settings.exists ? "found" : "missing" },
    { label: "apiKey", value: apiKey },
    { label: "baseUrl", value: settings.baseUrl || "https://api.openai.com/v1" },
    { label: "model", value: settings.model || "unknown" },
    { label: "reasoningEffort", value: reasoning },
  ];
  return {
    text: [
      "Config:",
      `- settings: ${entries[0].value} (${entries[0].state})`,
      `- apiKey: ${apiKey}`,
      `- baseUrl: ${entries[2].value}`,
      `- model: ${entries[3].value}`,
      `- reasoningEffort: ${reasoning}`,
    ].join("\n"),
    display: { type: "config", entries },
  };
}

function statusResult(context, argument) {
  if (argument) return usageResult("/status");
  const session = String(context.sessionInfo?.session_id || "none");
  const model = String(context.settings?.model || context.sessionInfo?.model || "unknown");
  const runtime = context.runtimeInitialized ? "ready" : context.runtimeStarted ? "starting" : "not started";
  return {
    text: [
      "Status:",
      `Session: ${session}`,
      `Model: ${model}`,
      `Runtime: ${runtime}`,
      "Messages: unknown",
    ].join("\n"),
    display: { type: "status", session, model, debug: false, messages: "unknown", runtime },
  };
}

function doctorResult(context, argument) {
  if (argument) return usageResult("/doctor");
  const settings = context.settings || {};
  const checks = [
    check(!settings.error, "Settings", settings.error || (settings.exists ? "found" : "missing")),
    check(settings.hasApiKey, "API key", settings.hasApiKey ? "set" : "unset"),
    check(Boolean(settings.model), "Model", settings.model || "unset"),
    check(Boolean(context.cwd), "Working directory", context.cwd || "unknown"),
  ];
  const failures = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warn").length;
  return {
    text: [
      "Doctor:",
      ...checks.map((item) => `- [${item.status}] ${item.name}: ${item.detail}`),
      `Overall: ${failures} failure(s), ${warnings} warning(s).`,
    ].join("\n"),
    display: { type: "doctor", checks, failures, warnings, next_steps: [] },
  };
}

function check(ok, name, detail) {
  return { status: ok ? "ok" : "fail", name, detail };
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

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
