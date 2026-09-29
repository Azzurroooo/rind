// Desktop-owned slash commands (spec sections 6 and 8). They drive local UI
// (menus, panels, theme, sidebar) instead of round-tripping to the runtime.

import { fallbackSlashCommands, parseSlashInput, type SlashCommand } from "./slash-commands.ts"

export const desktopSlashCommands: SlashCommand[] = [
  ["context", "Inspect the context window", "/context"],
  ["effort", "Choose reasoning effort", "/effort [low|medium|high|xhigh|max]"],
  ["fork", "Fork this session into a new one", "/fork"],
  ["goal", "Show the goal, or set a new objective", "/goal [objective]"],
  ["login", "Sign in to a provider in Settings", "/login"],
  ["logout", "Sign out of a provider in Settings", "/logout"],
  ["model", "Choose a model", "/model [name]"],
  ["sessions", "Search sessions in the sidebar", "/sessions [query]"],
  ["theme", "Switch theme", "/theme [system|dark|light]"],
].map(([name, description, usage]) => ({ name, description, usage, aliases: [] }))

const THEMES = ["system", "dark", "light"] as const
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type DesktopSlashAction =
  | { type: "context" }
  | { type: "effort"; effort: string }
  | { type: "fork" }
  | { type: "goal"; objective: string }
  | { type: "providers"; intent: "login" | "logout" }
  | { type: "model"; model: string }
  | { type: "sessions"; query: string }
  | { type: "theme"; theme: (typeof THEMES)[number] | "" }
  | { type: "error"; message: string }

/** Maps input to a desktop action. An empty argument means "open the picker". */
export function desktopSlashAction(input: string): DesktopSlashAction | undefined {
  const parsed = parseSlashInput(input)
  if (!parsed) return undefined
  const { name, argument } = parsed
  if (name === "context") return { type: "context" }
  if (name === "fork") return { type: "fork" }
  if (name === "goal") return { type: "goal", objective: argument }
  if (name === "login" || name === "logout") return { type: "providers", intent: name }
  if (name === "model") return { type: "model", model: argument }
  if (name === "sessions") return { type: "sessions", query: argument }
  if (name === "effort") {
    const effort = argument.toLocaleLowerCase()
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) return { type: "error", message: `Unknown effort "${argument}". Use ${EFFORTS.join(", ")}.` }
    return { type: "effort", effort }
  }
  if (name === "theme") {
    const theme = argument.toLocaleLowerCase()
    if (!theme) return { type: "theme", theme: "" }
    const match = THEMES.find((item) => item === theme)
    return match ? { type: "theme", theme: match } : { type: "error", message: `Unknown theme "${argument}". Use system, dark or light.` }
  }
  return undefined
}

/**
 * One catalog for the menu and /help: fallback commands, then the runtime
 * catalog, then desktop commands. Later groups win on a name clash, and an
 * alias that shadows another command name is dropped.
 */
export function mergeSlashCatalog(runtime: readonly SlashCommand[], local: readonly SlashCommand[] = desktopSlashCommands): SlashCommand[] {
  const byName = [...fallbackSlashCommands, ...runtime, ...local]
    .reduce((merged, command) => new Map([...merged, [command.name, command]]), new Map<string, SlashCommand>())
  const names = new Set(byName.keys())
  return [...byName.values()]
    .map((command) => ({ ...command, aliases: command.aliases.filter((alias) => !names.has(alias)) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
