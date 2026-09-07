// Browser notifications (web-ui.md §5 / master plan §6.4):
// only fire when the page is hidden AND permission was already granted; the
// request button lives in the SessionRail footer — never a prompt on load.

const BODY_LIMIT = 80;

export function notificationSupported() {
  return typeof window !== "undefined" && typeof window.Notification !== "undefined";
}

export function currentNotificationPermission() {
  return notificationSupported() ? window.Notification.permission : "unsupported";
}

export async function requestNotificationPermission() {
  if (!notificationSupported()) return "unsupported";
  try {
    return await window.Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// Returns true when a notification was actually shown.
export function showNotification({ title, body } = {}) {
  if (!notificationSupported()) return false;
  if (document.hidden !== true) return false;
  if (window.Notification.permission !== "granted") return false;
  try {
    const notification = new window.Notification(String(title || "Rind"), { body: truncateFirstLine(body) });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

// Notification body = first line of the reply, truncated to 80 characters.
export function truncateFirstLine(value, limit = BODY_LIMIT) {
  const firstLine = String(value || "").split(/\r?\n/).find((line) => line.trim()) || "";
  const clean = firstLine.trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

// Best-effort final assistant text for turn_completed notifications.
export function finalAssistantText(state) {
  if (!state || typeof state !== "object") return "";
  if (state.streaming && state.streaming.text) return state.streaming.text;
  const entries = Array.isArray(state.entries) ? state.entries : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === "assistant" && entry.content) return entry.content;
  }
  return "";
}
