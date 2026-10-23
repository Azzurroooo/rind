import { activeRun, awaitingDelegation, type Run, type State } from "./model.js";

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
export const DELEGATION_LIMIT = 200;
export const COMPLETED_TASK_LIMIT = 100;
export const UNBOUND_SESSION_LIMIT = 20;

export function retain(state: State, now = Date.now()) {
  // Receipts only make retries idempotent. Beyond the newest few hundred, old
  // ones are dropped, oldest first (object keys keep insertion order), but
  // never one recent enough to still be retried.
  const receipts = Object.keys(state.receipts);
  for (const key of receipts.slice(0, Math.max(0, receipts.length - RECEIPT_LIMIT))) {
    if (now - (state.receipts[key].at ?? 0) < RECEIPT_MIN_AGE_MS) continue;
    delete state.receipts[key];
  }

  const notices = Object.keys(state.notices);
  for (const key of notices.slice(0, Math.max(0, notices.length - NOTICE_LIMIT))) delete state.notices[key];

  const activeRuns = Object.values(state.runs).filter(activeRun);
  for (const [id, team] of Object.entries(state.teams)) {
    if ((team as { archive?: unknown }).archive) delete state.teams[id];
  }
  for (const [id, task] of Object.entries(state.tasks)) {
    if (state.teams[task.teamId]) continue;
    delete state.tasks[id];
    for (const [noteId, note] of Object.entries(state.notes)) if (note.taskId === id) delete state.notes[noteId];
    for (const [artId, art] of Object.entries(state.artifacts)) if (art.taskId === id) delete state.artifacts[artId];
    for (const [runId, run] of Object.entries(state.runs)) if (run.taskId === id && !activeRun(run)) delete state.runs[runId];
  }

  const delegations = Object.keys(state.delegations);
  for (let drop = Math.max(0, delegations.length - DELEGATION_LIMIT), i = 0; drop > 0 && i < delegations.length; i++) {
    const d = state.delegations[delegations[i]];
    if (!d || awaitingDelegation(d) || (!d.returned && d.status !== "cancelled")) continue;
    if (Object.values(state.delegations).some(child => child.parentDelegationId === d.id)) continue;
    if (activeRuns.some(r => r.delegationId === d.id)) continue;
    delete state.delegations[d.id];
    for (const [runId, run] of Object.entries(state.runs)) if (run.delegationId === d.id && !activeRun(run)) delete state.runs[runId];
    drop--;
  }

  const finishedTasks = Object.values(state.tasks).filter(t => t.status === "done" || t.status === "cancelled");
  for (let drop = Math.max(0, finishedTasks.length - COMPLETED_TASK_LIMIT), i = 0; drop > 0 && i < finishedTasks.length; i++) {
    const task = finishedTasks[i];
    if (activeRuns.some(r => r.taskId === task.id)) continue;
    if (Object.values(state.delegations).some(d => d.taskId === task.id)) continue;
    delete state.tasks[task.id];
    for (const [noteId, note] of Object.entries(state.notes)) if (note.taskId === task.id) delete state.notes[noteId];
    for (const [artId, art] of Object.entries(state.artifacts)) if (art.taskId === task.id) delete state.artifacts[artId];
    for (const [runId, run] of Object.entries(state.runs)) if (run.taskId === task.id && !activeRun(run)) delete state.runs[runId];
    drop--;
  }

  const groups = new Map<string, Run[]>();
  for (const run of Object.values(state.runs)) {
    if (activeRun(run)) continue;
    // Task runs are the task's execution history; direct and delegated turns
    // only matter for the session's last activity.
    const key = run.taskId && !run.delegationId ? "task:" + run.taskId : "session:" + run.sessionId;
    const list = groups.get(key) || [];
    list.push(run);
    groups.set(key, list);
  }
  for (const [key, runs] of groups) {
    const keep = key.startsWith("task:") ? TASK_RUN_LIMIT : 1;
    runs.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || b.startedAt.localeCompare(a.startedAt));
    for (const run of runs.slice(keep)) delete state.runs[run.id];
  }

  const sessionsWithRuns = new Set(Object.values(state.runs).map(run => run.sessionId));
  for (const [id, session] of Object.entries(state.sessions)) {
    if (
      session.origin === "managed" &&
      !sessionsWithRuns.has(id) &&
      !(session.delegationId && state.delegations[session.delegationId]) &&
      !state.deliveries[id]
    ) {
      delete state.sessions[id];
    }
  }

  // Unbound direct attachments (created before a window sends its first message)
  // are dropped by detachSession on normal exit; cap any left behind by crashed
  // windows while preserving all bound conversation registrations.
  const unbound = Object.keys(state.sessions).filter(id => {
    const s = state.sessions[id];
    return s && !s.runtimeSessionId && !sessionsWithRuns.has(id) && !state.deliveries[id];
  });
  for (const id of unbound.slice(0, Math.max(0, unbound.length - UNBOUND_SESSION_LIMIT))) {
    delete state.sessions[id];
  }
}
