import { requestNotificationPermission } from "../lib/notifications.js";

// Small state helpers shared by every action module.
export function createHelpers(ctx) {
  const { dispatchConversation, setUnreadIds, setRunningIds, setNotificationPermission } = ctx;

  function dispatchMessage(role, content, tone = "") {
    dispatchConversation({ kind: "message", role, content, tone });
  }

  function markUnread(sessionId) {
    setUnreadIds((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }

  function clearUnread(sessionId) {
    setUnreadIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }

  // session/list carries no running flag, so sidebar spinners follow the
  // turn lifecycle events of every subscribed session.
  function trackRunning(sessionId, type, turnId) {
    if (!sessionId) return;
    const starting = type === "turn_started";
    const ending = type === "turn_completed" || type === "turn_failed" || type === "turn_cancelled";
    if (!starting && !ending) return;
    const pending = ctx.refs.promptStarts.current.get(sessionId);
    if (pending) {
      pending.turnId = starting ? String(turnId || "") : "";
      pending.resolve();
    }
    setRunningIds((current) => {
      if (starting === current.has(sessionId)) return current;
      const next = new Set(current);
      if (starting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  async function enableNotifications() {
    const result = await requestNotificationPermission();
    setNotificationPermission(result);
  }

  function expireQuestion(key) {
    dispatchConversation({ kind: "question_expired", key: String(key || "") });
  }

  return { dispatchMessage, markUnread, clearUnread, trackRunning, enableNotifications, expireQuestion };
}
