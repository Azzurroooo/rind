import type { DesktopSettings, RuntimeSnapshot } from "../preload/types"
import { parseSlashInput, type SlashCommand } from "./slash-commands.ts"

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
  const parsed = parseSlashInput(input)
  if (!parsed) return undefined
  const { name, argument } = parsed

  if (name === "status") {
    if (context.runtime.status === "ready") return undefined
    return statusResult(context)
  }
  if (name === "help") return helpResult(argument, context.commands)
  return undefined
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
      `Reasoning effort: ${context.settings.reasoningEffort || "unset"}`,
      `Workspace: ${context.projectPath || "not selected"}`,
      "No completed sampling yet.",
    ].join("\n"),
    display: { type: "status", entries: [
      { label: "session", value: session }, { label: "model", value: model },
      { label: "reasoningEffort", value: context.settings.reasoningEffort || "unset" },
      { label: "runtime", value: runtime }, { label: "workspace", value: context.projectPath || "not selected" },
    ], usage: [] },
  }
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
