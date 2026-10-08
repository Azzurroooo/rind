import { activeRun, type Run, type State } from "./model.js";

// Every transaction clones and diffs the whole state, so history that only
// grows (one receipt per request, one run per conversation turn) would make
// every write slower over time. These limits keep the state proportional to
// what is in use while preserving everything a user or retry can still need.
export const RECEIPT_LIMIT = 512;
// A client retries a timed-out request within minutes; younger receipts always stay.
export const RECEIPT_MIN_AGE_MS = 10 * 60 * 1000;
export const TASK_RUN_LIMIT = 10;
// The user reads and dismisses notices; ones never dismissed stop at the newest few.
export const NOTICE_LIMIT = 50;

export function retain(state: State, now = Date.now()) {
  // Receipts only make retries idempotent. Beyond the newest few hundred, old
  // ones are dropped, oldest first (object keys keep insertion order), but
  // never one recent enough to still be retried.
  const receipts = Object.keys(state.receipts);
  for (const key of receipts.slice(0, Math.max(0, receipts.length - RECEIPT_LIMIT))) {
    if (now - (state.receipts[key].at ?? 0) < RECEIPT_MIN_AGE_MS) break;
    delete state.receipts[key];
  }

  const notices = Object.keys(state.notices);
  for (const key of notices.slice(0, Math.max(0, notices.length - NOTICE_LIMIT))) delete state.notices[key];

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
