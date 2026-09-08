// Composer prompt history (terminal-style): Alt+Up walks backwards through
// sent prompts, Alt+Down returns. The unsent draft is parked while browsing
// and restored when the user walks back past the newest entry.

export type InputHistory = {
  record: (value: string) => void
  older: (current: string) => string | undefined
  newer: () => string | undefined
}

export function createInputHistory(limit = 50): InputHistory {
  const entries: string[] = []
  let cursor = -1
  let draft = ""
  return {
    record(value) {
      const clean = value.trim()
      if (!clean) return
      if (entries[entries.length - 1] !== clean) {
        entries.push(clean)
        if (entries.length > limit) entries.shift()
      }
      cursor = -1
      draft = ""
    },
    older(current) {
      if (!entries.length) return undefined
      if (cursor === -1) {
        cursor = entries.length - 1
        draft = current
      } else if (cursor > 0) {
        cursor -= 1
      }
      return entries[cursor]
    },
    newer() {
      if (cursor === -1) return undefined
      if (cursor < entries.length - 1) {
        cursor += 1
        return entries[cursor]
      }
      cursor = -1
      return draft
    },
  }
}
