export type SlashCommand = {
  name: string
  description: string
  usage: string
  aliases: string[]
}

export type SlashCommandMenu = {
  query: string
  commands: SlashCommand[]
}

const DESKTOP_HIDDEN_COMMANDS = new Set(["sessions"])

export const fallbackSlashCommands: SlashCommand[] = [
  ["compact", "Compact current session context", "/compact"],
  ["config", "Show config guidance", "/config"],
  ["doctor", "Run local setup diagnostics", "/doctor"],
  ["draft", "Show, reuse, or clear saved input draft", "/draft | /draft use | /draft clear"],
  ["help", "Show commands", "/help [command]"],
  ["init", "Draft RIND.md", "/init [project|user]"],
  ["login", "Show login setup guidance", "/login"],
  ["model", "Show or change the active model", "/model | /model set <model>"],
  ["plan", "Show active plan summary", "/plan"],
  ["skill", "List skills", "/skill [list]"],
  ["status", "Show session status", "/status"],
  ["team", "Create a Team project", "/team create [project-id]"],
].map(([name, description, usage]) => ({ name, description, usage, aliases: [] }))

export function parseSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, SlashCommand>()
  for (const item of value) {
    const command = asSlashCommand(item)
    if (command && !isDesktopHiddenSlashCommand(command.name)) unique.set(command.name, command)
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function isDesktopHiddenSlashCommand(name: string) {
  return DESKTOP_HIDDEN_COMMANDS.has(name.trim().toLocaleLowerCase())
}

export function desktopSlashCommandNotice(input: string) {
  const command = input.trim()
  if (/^\/sessions(?:\s|$)/i.test(command)) return "Use the left sidebar to switch sessions."
  if (/^\/help\s+\/?sessions(?:\s|$)/i.test(command)) return "Use the left sidebar to switch sessions."
  return undefined
}

export function slashCommandMenu(commands: SlashCommand[], input: string): SlashCommandMenu | undefined {
  const match = input.match(/^\/([^\s]*)$/)
  if (!match) return undefined
  const query = match[1].toLocaleLowerCase()
  const matches = commands.filter((command) => matchesCommand(command, query))
  matches.sort((left, right) => commandRank(left, query) - commandRank(right, query) || left.name.localeCompare(right.name))
  return { query, commands: matches }
}

export function isExactSlashCommand(commands: SlashCommand[], input: string) {
  const match = input.match(/^\/([^\s]+)$/)
  if (!match) return false
  const name = match[1].toLocaleLowerCase()
  return commands.some((command) => command.name === name || command.aliases.includes(name))
}

export function commandPrefill(command: SlashCommand) {
  const usage = command.usage.trim()
  return usage && usage !== `/${command.name}` ? `/${command.name} ` : `/${command.name}`
}

function asSlashCommand(value: unknown): SlashCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const name = typeof item.name === "string" ? item.name.trim().toLocaleLowerCase() : ""
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return undefined
  const aliases = Array.isArray(item.aliases)
    ? item.aliases.flatMap((alias) => typeof alias === "string" && /^[a-z][a-z0-9_-]*$/i.test(alias.trim()) ? [alias.trim().toLocaleLowerCase()] : [])
    : []
  return {
    name,
    description: typeof item.description === "string" ? item.description.trim() : "",
    usage: typeof item.usage === "string" && item.usage.trim() ? item.usage.trim() : `/${name}`,
    aliases,
  }
}

function matchesCommand(command: SlashCommand, query: string) {
  return !query || command.name.includes(query) || command.aliases.some((alias) => alias.includes(query))
}

function commandRank(command: SlashCommand, query: string) {
  if (!query || command.name.startsWith(query)) return 0
  if (command.aliases.some((alias) => alias.startsWith(query))) return 1
  return 2
}
