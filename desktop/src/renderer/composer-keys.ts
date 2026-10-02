// Composer keyboard rules (spec section 6). Pure so the rules are testable.

export type ComposerKey = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">

export type ComposerKeyContext = {
  /** A turn is running in the viewed session. */
  running: boolean
  /** The textarea holds only whitespace. */
  empty: boolean
  /** A previous prompt exists to recall. */
  canRecall: boolean
}

export type ComposerKeyAction = "send" | "queue" | "steer" | "recall" | "default"

export function composerKeyAction(event: ComposerKey, context: ComposerKeyContext): ComposerKeyAction {
  // keyCode 229 marks IME composition on engines that drop isComposing.
  if (event.isComposing || event.keyCode === 229) return "default"
  if (event.key === "Enter") {
    if (event.shiftKey) return "default"
    if (!context.running) return "send"
    return event.altKey ? "steer" : "queue"
  }
  if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    return context.empty && context.canRecall ? "recall" : "default"
  }
  return "default"
}
