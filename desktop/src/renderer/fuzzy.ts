// Fuzzy subsequence scoring shared by the command palette and @-file
// mentions: the sum of gap distances between consecutive matched characters.
// Lower is better; null when the needle is not a subsequence of the haystack.

export function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return Number.POSITIVE_INFINITY
  let cursor = 0
  let score = 0
  let previous = -1
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor)
    if (index < 0) return null
    score += previous < 0 ? index : Math.min(index - previous - 1, 40)
    previous = index
    cursor = index + 1
  }
  return score
}
