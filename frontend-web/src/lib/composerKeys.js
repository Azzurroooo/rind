// Composer keyboard contract (spec section 6), kept pure so it is testable
// without a DOM:
//   Enter            send (idle) or queue a follow-up (turn running)
//   Alt+Enter        send as steering while a turn runs (plain send when idle)
//   Shift+Enter      newline
//   ArrowUp          recall the last prompt when the composer is empty
//   slash menu open  ArrowUp/ArrowDown move, Enter/Tab accept, Escape closes
// IME composition never triggers an action.

export const COMPOSER_ACTIONS = Object.freeze({
  none: "none",
  send: "send",
  followUp: "follow_up",
  steer: "steer",
  recall: "recall",
  menuNext: "menu_next",
  menuPrev: "menu_prev",
  menuAccept: "menu_accept",
  menuClose: "menu_close",
});

export function isComposing(event) {
  return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229);
}

export function composerKeyAction(event, state = {}) {
  if (!event || isComposing(event)) return COMPOSER_ACTIONS.none;
  const { value = "", active = false, menuOpen = false, lastPrompt = "" } = state;
  const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;

  if (menuOpen) {
    if (event.key === "ArrowDown") return COMPOSER_ACTIONS.menuNext;
    if (event.key === "ArrowUp") return COMPOSER_ACTIONS.menuPrev;
    if ((event.key === "Enter" && plain) || (event.key === "Tab" && !event.shiftKey)) return COMPOSER_ACTIONS.menuAccept;
    if (event.key === "Escape") return COMPOSER_ACTIONS.menuClose;
  }

  if (event.key === "Enter") {
    if (event.shiftKey) return COMPOSER_ACTIONS.none;
    if (event.altKey) return active ? COMPOSER_ACTIONS.steer : COMPOSER_ACTIONS.send;
    if (event.ctrlKey || event.metaKey) return active ? COMPOSER_ACTIONS.followUp : COMPOSER_ACTIONS.send;
    return active ? COMPOSER_ACTIONS.followUp : COMPOSER_ACTIONS.send;
  }

  if (event.key === "ArrowUp" && plain && !String(value) && lastPrompt) return COMPOSER_ACTIONS.recall;
  return COMPOSER_ACTIONS.none;
}

// Slash menu state for the current draft: open only while the first token is
// being typed ("/mo" but not "/model gpt").
export function slashQuery(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  return text.slice(1).toLowerCase();
}
