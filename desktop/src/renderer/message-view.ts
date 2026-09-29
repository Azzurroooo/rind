import type { Entry } from "./timeline-model.ts"

/** Suggestion chips on the empty state. Picking one fills the composer; it never sends. */
export interface StarterPrompt {
  readonly label: string
  readonly prompt: string
}

export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  { label: "Explore this project", prompt: "Explain how this project is organized" },
  { label: "Review the code", prompt: "Review the code and suggest focused improvements" },
  { label: "Build a feature", prompt: "Help me plan and implement a new feature" },
  { label: "Fix a bug", prompt: "Help me find and fix a bug: " },
]

export type MessageAction = "copy" | "edit"

/** Spec section 4: assistant messages offer Copy; user messages offer Copy and Edit & resend. */
export function messageActions(kind: "user" | "assistant"): readonly MessageAction[] {
  return kind === "user" ? ["copy", "edit"] : ["copy"]
}

/** The last assistant message with visible text keeps its action bar visible. */
export function latestAssistantId(entries: readonly Entry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.kind === "assistant" && entry.content.trim()) return entry.id
  }
  return ""
}

/** The caret shows only on the assistant message that is still receiving text. */
export function isStreamingAssistant(entryId: string, openAssistantId: string, activeTurn: boolean): boolean {
  return activeTurn && Boolean(openAssistantId) && entryId === openAssistantId
}
