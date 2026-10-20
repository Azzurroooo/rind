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

function cleanTitleCandidate(value, sessionId = "", { ignoreGeneric = false, agentName = "" } = {}) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (sessionId && text === sessionId) return "";
  const lower = text.toLowerCase();
  if (lower === "new conversation" || lower === "untitled") return "";
  if (ignoreGeneric) {
    const agentLower = String(agentName || "").trim().toLowerCase();
    if (
      lower === "conversation" ||
      lower === "active conversation" ||
      lower === "delegated conversation" ||
      lower === "task conversation" ||
      lower === "task session" ||
      lower === "manager conversation" ||
      (agentLower && lower === `${agentLower} conversation`)
    ) {
      return "";
    }
  }
  return text;
}

function firstConversationSummary(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (const role of ["user", "assistant"]) {
    for (const entry of messages) {
      if (entry?.role === role && entry.content) {
        const firstLine = String(entry.content)
          .split(/\r?\n/)
          .map((line) => line.replace(/^[#>*`\s-]+/, "").trim())
          .find(Boolean);
        if (firstLine) {
          return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
        }
      }
    }
  }
  return "";
}

export function sessionTitle(sessions, sessionId, infoTitle = "", options = {}) {
  const { agentContext = null, agentSessions = [], messages = [] } = options || {};
  const isMember = agentContext?.kind === "member";
  const isManager = agentContext?.kind === "manager";
  const fallback = isMember
    ? `${agentContext.agentName || "Member"} conversation`
    : isManager
      ? "Manager conversation"
      : "New conversation";

  if (!sessionId) return fallback;

  const list = Array.isArray(sessions) ? sessions : [];
  const extra = Array.isArray(agentSessions) ? agentSessions : [];
  const match =
    extra.find((s) => String(s?.runtimeSessionId || sessionIdOf(s)).trim() === sessionId) ||
    list.find((s) => sessionIdOf(s) === sessionId);

  const resolved =
    cleanTitleCandidate(match?.name, sessionId) ||
    cleanTitleCandidate(infoTitle, sessionId) ||
    cleanTitleCandidate(match?.title, sessionId, {
      ignoreGeneric: true,
      agentName: agentContext?.agentName,
    }) ||
    cleanTitleCandidate(match?.taskBrief, sessionId) ||
    firstConversationSummary(messages) ||
    cleanTitleCandidate(match?.title, sessionId);

  return resolved || fallback;
}

export function lastUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role === "user" && entry.content) return String(entry.content);
  }
  return "";
}
