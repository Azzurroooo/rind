import { fallbackSlashCommands, parseSlashCommands, parseSlashInput, type SlashCommand } from "./slash-commands.ts"

// Settings and navigation stay in their dedicated UI and the command palette.
export const desktopSlashCommands: SlashCommand[] = [
  ["fork", "Fork this session into a new one", "/fork"],
  ["goal", "Show the goal, or set a new objective", "/goal [objective]"],
].map(([name, description, usage]) => ({ name, description, usage, aliases: [] }))

export type DesktopSlashAction =
  | { type: "fork" }
  | { type: "goal"; objective: string }

export function desktopSlashAction(input: string): DesktopSlashAction | undefined {
  const parsed = parseSlashInput(input)
  if (parsed?.name === "fork") return { type: "fork" }
  if (parsed?.name === "goal") return { type: "goal", objective: parsed.argument }
  return undefined
}

/** One filtered catalog for the menu, execution and /help. */
export function mergeSlashCatalog(runtime: readonly SlashCommand[], local: readonly SlashCommand[] = desktopSlashCommands): SlashCommand[] {
  const commands = parseSlashCommands([...fallbackSlashCommands, ...runtime, ...local])
  const names = new Set(commands.map((command) => command.name))
  return commands.map((command) => ({ ...command, aliases: command.aliases.filter((alias) => !names.has(alias)) }))
}
