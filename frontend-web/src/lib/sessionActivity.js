import { readPreference, writePreference } from "./sessionPreferences.js";
import { toDate } from "./sessionTime.js";
import { sessionIdOf } from "../methods.js";

export function interactionTime(session) {
  return Math.max(toDate(session?.updated_at)?.getTime() || 0, toDate(session?.last_interacted_at)?.getTime() || 0);
}

function interactions(endpoint) {
  try {
    const value = JSON.parse(readPreference(`recent:${endpoint}`, "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function rememberInteraction(endpoint, sessionId, now = Date.now()) {
  if (!sessionId) return;
  const recent = { ...interactions(endpoint), [sessionId]: now };
  writePreference(`recent:${endpoint}`, JSON.stringify(Object.fromEntries(Object.entries(recent)
    .filter(([, value]) => Number.isFinite(value)).sort((a, b) => b[1] - a[1]).slice(0, 200))));
}

export function applyInteractions(sessions, endpoint) {
  const recent = interactions(endpoint);
  return sessions.map((session) => {
    const time = toDate(recent[sessionIdOf(session)])?.getTime() || 0;
    return time > interactionTime(session) ? { ...session, last_interacted_at: new Date(time).toISOString() } : session;
  }).sort((a, b) => interactionTime(b) - interactionTime(a));
}
