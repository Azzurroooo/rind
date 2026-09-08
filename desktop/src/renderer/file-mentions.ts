// @-file mentions in the composer: query extraction from the textarea, fuzzy
// ranking over the project file index, and insertion back into the text.
// Pure logic only — the index fetch and menu DOM stay in index.ts.

import { fuzzyScore } from "./fuzzy.ts"

export type FileMention = {
  path: string
  score: number
}

export type MentionQuery = {
  query: string
  start: number
}

// The "@ <query>" token the caret sits in, or undefined when the caret is not
// in one. "@" opens a mention only at a word boundary (line start or after
// whitespace), and the token cannot contain whitespace.
export function mentionQueryAt(text: string, caret: number): MentionQuery | undefined {
  let index = caret
  while (index > 0) {
    const character = text[index - 1]
    if (character === "@") {
      const start = index - 1
      const before = start > 0 ? text[start - 1] : ""
      if (before && !/\s/.test(before)) return undefined
      return { query: text.slice(index, caret), start }
    }
    if (/\s/.test(character)) return undefined
    index -= 1
  }
  return undefined
}

export function filterFiles(files: string[], query: string, limit = 8): FileMention[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return files.slice(0, limit).map((path) => ({ path, score: 0 }))
  const matches: FileMention[] = []
  for (const path of files) {
    const lower = path.toLocaleLowerCase()
    const name = lower.slice(lower.lastIndexOf("/") + 1)
    const nameScore = fuzzyScore(name, needle)
    const pathScore = fuzzyScore(lower, needle)
    if (nameScore === null && pathScore === null) continue
    const scores = [nameScore, pathScore === null ? null : pathScore + 60].filter((value): value is number => value !== null)
    matches.push({ path, score: Math.min(...scores) })
  }
  return matches
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, limit)
}

export function applyMention(text: string, caret: number, start: number, path: string): { value: string; caret: number } {
  const before = `${text.slice(0, start)}${path} `
  return { value: before + text.slice(caret), caret: before.length }
}
