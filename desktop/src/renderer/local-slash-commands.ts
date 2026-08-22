import type { DesktopSettings, RuntimeSnapshot } from "../preload/types"
import type { SlashCommand } from "./slash-commands"

export type LocalSlashResult = {
  text: string
  display?: Record<string, unknown>
}

type LocalSlashContext = {
  settings: DesktopSettings
  runtime: RuntimeSnapshot
  sessionId: string
  projectPath: string
  commands: SlashCommand[]
}

export function executeLocalSlashCommand(input: string, context: LocalSlashContext): LocalSlashResult | undefined {
  const parts = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!parts) return undefined
  const name = parts[1].toLocaleLowerCase()
  const argument = (parts[2] || "").trim()

  if (name === "config") return configResult(context.settings)
  if (name === "login") return { text: "Login/config setup is not implemented yet.\nSet apiKey in ~/.rind/settings.json." }
  if (name === "status") {
    if (context.runtime.status === "ready") return undefined
    return statusResult(context)
  }
  if (name === "doctor") return doctorResult(context)
  if (name === "help") return helpResult(argument, context.commands)
  return undefined
}

function configResult(settings: DesktopSettings): LocalSlashResult {
  const apiKey = settings.hasApiKey ? "set" : "unset"
  const reasoning = settings.reasoningEffort || "unset"
  const entries = [
    { label: "settings", value: "~/.rind/settings.json" },
    { label: "apiKey", value: apiKey },
    { label: "baseUrl", value: settings.baseUrl || "https://api.openai.com/v1" },
    { label: "model", value: settings.model || "unknown" },
    { label: "reasoningEffort", value: reasoning },
  ]
  return {
    text: [
      "Config:",
      "- settings: ~/.rind/settings.json",
      `- apiKey: ${apiKey}`,
      `- baseUrl: ${entries[2].value}`,
      `- model: ${entries[3].value}`,
      `- reasoningEffort: ${reasoning}`,
    ].join("\n"),
    display: { type: "config", entries },
  }
}

function statusResult(context: LocalSlashContext): LocalSlashResult {
  const session = context.sessionId || "none"
  const model = context.settings.model || "unknown"
  const runtime = context.runtime.status
  return {
    text: [
      "Status:",
      `Session: ${session}`,
      `Model: ${model}`,
      `Runtime: ${runtime}`,
      "Messages: unknown",
    ].join("\n"),
    display: { type: "status", session, model, debug: false, messages: "unknown", runtime },
  }
}

function doctorResult(context: LocalSlashContext): LocalSlashResult {
  const checks = [
    check(context.settings.hasApiKey, "API key", context.settings.hasApiKey ? "set" : "unset"),
    check(Boolean(context.settings.model), "Model", context.settings.model || "unset"),
    check(Boolean(context.projectPath), "Project", context.projectPath || "not selected"),
    check(context.runtime.status !== "error", "Runtime", context.runtime.status),
  ]
  const failures = checks.filter((item) => item.status === "fail").length
  const warnings = checks.filter((item) => item.status === "warn").length
  return {
    text: [
      "Doctor:",
      ...checks.map((item) => `- [${item.status}] ${item.name}: ${item.detail}`),
      `Overall: ${failures} failure(s), ${warnings} warning(s).`,
    ].join("\n"),
    display: { type: "doctor", checks, failures, warnings, next_steps: [] },
  }
}

function check(ok: boolean, name: string, detail: string) {
  return { status: ok ? "ok" : "fail", name, detail }
}

function helpResult(argument: string, commands: SlashCommand[]): LocalSlashResult {
  const name = argument.replace(/^\//, "").toLocaleLowerCase()
  const visible = commands.filter((command) => !name || command.name === name || command.aliases.includes(name))
  if (name && !visible.length) return { text: `Unknown command: /${name}\nRun /help to see available commands.` }
  const selected = name ? visible[0] : undefined
  const text = selected
    ? `/${selected.name}\n${selected.description}\nUsage: ${selected.usage}`
    : ["Commands:", ...visible.map((command) => `/${command.name} - ${command.description}`)].join("\n")
  return {
    text,
    display: {
      type: "help",
      ...(selected ? { command: selected } : { commands: visible }),
    },
  }
}
