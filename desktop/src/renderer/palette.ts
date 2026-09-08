import { fuzzyScore } from "./fuzzy.ts"

// Command palette model (Ctrl+K): pure filter/rank logic kept out of the DOM
// so the registry behaves like the web surface's command registry — one
// command per action, menus and palette sharing the same handlers.

export type PaletteCommand = {
  id: string
  title: string
  detail?: string
  shortcut?: string
  keywords?: string
  disabled?: boolean
  run: () => void
}

export type PaletteMatch = {
  command: PaletteCommand
  /** Lower is better; matched subsequence index for highlighting. */
  score: number
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  const matches: PaletteMatch[] = []
  for (const command of commands) {
    if (!needle) {
      matches.push({ command, score: 0 })
      continue
    }
    const score = scoreCommand(command, needle)
    if (score !== null) matches.push({ command, score })
  }
  return matches.sort((left, right) => left.score - right.score || left.command.title.localeCompare(right.command.title))
}

// Exact prefix matches on the title rank best; detail/keywords are usable but
// weaker. An empty haystack never matches a non-empty query.
function scoreCommand(command: PaletteCommand, needle: string): number | null {
  const title = command.title.toLocaleLowerCase()
  const titleScore = fuzzyScore(title, needle)
  const extra = `${command.detail || ""} ${command.keywords || ""}`.toLocaleLowerCase()
  const extraScore = extra.trim() ? fuzzyScore(extra, needle) : null
  if (titleScore === null && extraScore === null) return null
  if (titleScore !== null && title.startsWith(needle)) return titleScore
  const best = [titleScore, extraScore === null ? null : extraScore + 60]
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0]
  return best ?? null
}

export function moveActiveIndex(index: number, offset: number, length: number) {
  if (length <= 0) return 0
  return (index + offset + length) % length
}
