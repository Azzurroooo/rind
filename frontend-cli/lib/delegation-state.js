import { delegatedTask } from "./tool-display.js";

// Match the host's delivery headings, never task IDs mentioned in evidence.
export function settledDelegations(text) {
  return [...String(text || "").matchAll(/^- .+ · task (\S+) · (?:delivered:|failed:|blocked, needs |needs attention|cancelled)(?:.*)$/gm)]
    .map(match => match[1]);
}

export function rememberDelegation(pending, result, sessionId) {
  const task = delegatedTask(result);
  if (!task) return;
  if (task.status === "cancelled") pending.delete(task.taskId);
  else pending.set(task.taskId, { assignee: task.assignee || pending.get(task.taskId)?.assignee || "", sessionId: String(sessionId || "") });
}
