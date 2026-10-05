import { activeRun, type Run, type State } from "./model.js";

// Every transaction clones and diffs the whole state, so history that only
// grows (one receipt per request, one run per conversation turn) would make
// every write slower over time. These limits keep the state proportional to
// what is in use while preserving everything a user or retry can still need.
export const RECEIPT_LIMIT = 512;
export const TASK_RUN_LIMIT = 10;

export function retain(state: State) {
  // Receipts only make retries idempotent; retries happen within moments, so
  // the newest few hundred are enough. Object keys keep insertion order.
  const receipts = Object.keys(state.receipts);
  for (const key of receipts.slice(0, Math.max(0, receipts.length - RECEIPT_LIMIT))) delete state.receipts[key];

  const groups = new Map<string, Run[]>();
  for (const run of Object.values(state.runs)) {
    if (activeRun(run)) continue;
    // Task runs are the task's execution history; direct turns only matter
    // for the session's last activity.
    const key = run.taskId ? "task:" + run.taskId : "session:" + run.sessionId;
    const list = groups.get(key) || [];
    list.push(run);
    groups.set(key, list);
  }
  for (const [key, runs] of groups) {
    const keep = key.startsWith("task:") ? TASK_RUN_LIMIT : 1;
    runs.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || b.startedAt.localeCompare(a.startedAt));
    for (const run of runs.slice(keep)) delete state.runs[run.id];
  }
}
