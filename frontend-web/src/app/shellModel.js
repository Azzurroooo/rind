import { sessionIdOf } from "../methods.js";

// Pure derivations for the shell: panel accessibility attributes, the header
// status chip and the prompt the composer recalls with ArrowUp.

// Off-canvas and collapsed panels are hidden from assistive tech and inert.
export function panelAttrs({ narrow, visible }) {
  const hidden = !visible;
  const className = narrow ? (visible ? "drawer-open" : "drawer-closed") : (visible ? "" : "is-collapsed");
  return {
    className,
    "aria-hidden": hidden || undefined,
    inert: hidden ? "" : undefined,
  };
}

const PHASE_STATUS = Object.freeze({
  connecting: { label: "Connecting", tone: "muted" },
  reconnecting: { label: "Reconnecting", tone: "warning" },
  syncing: { label: "Syncing", tone: "muted" },
  offline: { label: "Offline", tone: "danger" },
});

export function headerStatus({ phase, active, compacting, waitingCount = 0 }) {
  if (PHASE_STATUS[phase]) return PHASE_STATUS[phase];
  if (compacting) return { label: "Compacting", tone: "accent" };
  if (active) return { label: "Working", tone: "accent" };
  if (waitingCount > 0) return { label: `Waiting · ${waitingCount}`, tone: "muted" };
  return { label: "Idle", tone: "muted" };
}

export function sessionTitle(sessions, sessionId) {
  if (!sessionId) return "New conversation";
  return sessions.find((session) => sessionIdOf(session) === sessionId)?.title || "New conversation";
}

export function lastUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role === "user" && entry.content) return String(entry.content);
  }
  return "";
}
