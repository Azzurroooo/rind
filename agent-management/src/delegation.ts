import { activeRun, awaitingDelegation, memberKey, type Delegation, type Session, type State, type Task } from "./model.js";
import { supervisor } from "./organization.js";
import { directReports } from "./tools.js";

export const DELEGATE_NEXT = "Keep working in parallel, call delegate({wait: true}) only if this turn is blocked on the result right now, or tell the user what was started and end your turn to receive results when they settle.";

export const nameOf = (state: State, id: string) => id === "user" ? "the user" : state.agents[id]?.name || id;
export const taskDelegations = (state: State, taskId: string) => Object.values(state.delegations).filter(d => d.taskId === taskId && !d.parentDelegationId);
export const childDelegations = (state: State, delegationId: string) => Object.values(state.delegations).filter(d => d.parentDelegationId === delegationId);
export const sessionDelegations = (state: State, sessionId: string) => Object.values(state.delegations).filter(d => d.originSessionId === sessionId && !d.parentDelegationId);

export function ownDelegations(state: State, session: Session) {
  const run = Object.values(state.runs).find(r => activeRun(r) && r.sessionId === session.id);
  if (run?.delegationId) return childDelegations(state, run.delegationId);
  if (run?.taskId) return taskDelegations(state, run.taskId);
  return sessionDelegations(state, session.id);
}

export function resultsText(state: State, delegations: Delegation[]) {
  return ["Delegated work settled:", ...delegations.map(d => {
    const head = "- " + nameOf(state, d.assigneeAgentId) + " · task " + d.id + " · ";
    if (d.status === "done") return head + "delivered: " + (d.reply || "");
    return head + d.status + (d.error ? ": " + d.error : "");
  })].join("\n");
}

export function returnDelegations(state: State, delegations: Delegation[], send: (text: string) => void) {
  const fresh = delegations.filter(d => !d.returned && !awaitingDelegation(d));
  if (!fresh.length) return;
  for (const d of fresh) d.returned = true;
  send(resultsText(state, fresh));
}

// The task or delegation runs again, told why.
export function resumeWork(work: Task | Delegation, message: string) {
  work.resume = work.resume ? work.resume + "\n\n" + message : message;
  work.status = "queued"; work.dispatch = true;
  if ("blockedOn" in work) delete work.blockedOn;
  delete work.error;
}

// Whoever delegated the work hears back once all of it has settled: a parent
// task or delegation runs again, a conversation gets a delivery. While the
// delegator is still running its own turn (or actively waiting in-turn),
// results remain unreturned so delegate({wait: true}) can claim them first.
export function wakeDelegator(state: State, d: Delegation, waiters?: { has(sessionId: string): boolean }) {
  if (d.parentDelegationId) {
    const parent = state.delegations[d.parentDelegationId];
    if (!parent || parent.status !== "waiting") return;
    const children = childDelegations(state, parent.id);
    if (!children.some(awaitingDelegation)) returnDelegations(state, children, text => resumeWork(parent, text));
  } else if (d.taskId) {
    const parent = state.tasks[d.taskId];
    if (!parent || parent.status !== "blocked" || parent.blockedOn?.responder !== "children") return;
    const children = taskDelegations(state, parent.id);
    if (!children.some(awaitingDelegation)) returnDelegations(state, children, text => resumeWork(parent, text));
  } else if (d.originSessionId) {
    const sessionId = d.originSessionId;
    if (waiters?.has(sessionId) || Object.values(state.runs).some(r => activeRun(r) && r.sessionId === sessionId)) return;
    const children = sessionDelegations(state, sessionId);
    if (!children.some(awaitingDelegation)) returnDelegations(state, children, text => { (state.deliveries[sessionId] ||= { texts: [] }).texts.push(text); });
  }
}

export function claimWaitResult(state: State, ids: string[], outcome: { timedOut: boolean; released: boolean }, canClaim: boolean, includeReturned: boolean) {
  const targets = ids.map(id => state.delegations[id]).filter(Boolean);
  const settled = outcome.released || !canClaim ? [] : targets.filter(d => (includeReturned || !d.returned) && !awaitingDelegation(d));
  const running = targets.filter(awaitingDelegation);
  for (const d of settled) d.returned = true;
  const output = outcome.released
    ? "Wait interrupted by new input; delegated work continues in the background."
    : settled.length
      ? resultsText(state, settled)
      : outcome.timedOut
        ? "Timed out waiting for delegated work; still running: " + running.map(d => nameOf(state, d.assigneeAgentId) + " (task " + d.id + ")").join(", ") + "."
        : "No pending delegated work.";
  return {
    settled: settled.map(d => ({
      taskId: d.id, assignee: nameOf(state, d.assigneeAgentId), status: d.status,
      ...(d.reply ? { reply: d.reply } : {}), ...(d.error ? { error: d.error } : {}),
    })),
    running: running.map(d => ({ taskId: d.id, assignee: nameOf(state, d.assigneeAgentId), status: d.status })),
    timedOut: outcome.timedOut,
    ...(outcome.released ? { released: true } : {}),
    output,
  };
}

export function resolveDirectReport(state: State, teamId: string, me: string, target: string) {
  if (state.memberships[memberKey(teamId, target)] && supervisor(state, teamId, target) === me) return target;
  const reports = directReports(state, teamId, me);
  const exact = reports.filter(r => r.name === target);
  if (exact.length === 1) return exact[0].id;
  const lower = target.toLowerCase();
  const matched = reports.filter(r => r.name.trim().toLowerCase() === lower);
  return matched.length === 1 ? matched[0].id : undefined;
}

export function cancelDelegationTree(state: State, delegationId: string) {
  for (const child of childDelegations(state, delegationId)) {
    cancelDelegationTree(state, child.id);
    if (!["done", "cancelled"].includes(child.status)) { child.status = "cancelled"; delete child.dispatch; child.returned = true; }
  }
}

export function cancelTaskDelegations(state: State, taskId: string) {
  for (const d of Object.values(state.delegations)) if (d.taskId === taskId && !["done", "cancelled"].includes(d.status)) {
    d.status = "cancelled"; delete d.dispatch; d.returned = true;
  }
}

export function markDelivered(task: Task) {
  task.status = "done";
  task.deliveredAt = new Date().toISOString();
  delete task.blockedOn;
}
