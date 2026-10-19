import { randomUUID, createHash } from "node:crypto";
import { mkdir, rm, stat, copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { activeRun, awaitingDelegation, entryTask, memberKey, requireValue, text, type State, type Agent, type Principal, type Session, type Run, type Task, type Delegation, type Report, type Adapter, type AdapterHandle, type Approval, type FolderDefaults } from "./model.js";
import { canonicalDirectory, inside, privateDirectory, type Paths } from "./paths.js";
import type { Store } from "./store.js";
import { previewLegacyTeam } from "./legacy.js";
import { sessionStatus, memberStatus, queuedReason, priorityRank, teamBriefing, managerOverview, projectionIndex, type LiveSession } from "./projection.js";
import { retain } from "./retention.js";

import { supervisor, manages, setSupervisor } from "./organization.js";
import { dissolveTeam, dropSession, expireApprovals, pruneAgents, unbindSessions } from "./teams.js";
import { MEMBER_OPERATIONS, directReports, memberInstructions, supervises } from "./tools.js";
import { publishArtifact } from "./artifacts.js";
import { newWorkspacePath, addWorktree, removeWorktree } from "./workspaces.js";

type Params = Record<string, any>;
const DELEGATE_NEXT = "Keep working in parallel, call delegate({wait: true}) only if this turn is blocked on the result right now, or tell the user what was started and end your turn to receive results when they settle.";
const WAIT_PENDING = Symbol("waitPending");
interface WaitPending { [WAIT_PENDING]: { sessionId: string; ids: string[]; timeoutMs: number; includeReturned: boolean } }
// Teams are picked by name in the sidebar and in `rind agents`; two live teams never share one.
const teamNameTaken = (state: State, name: string) => Object.values(state.teams).some(t => !t.archive && t.name.trim().toLowerCase() === name.trim().toLowerCase());
const reads = new Set(["snapshot", "listTeams", "getTeam", "listAgents", "getTask", "previewCopy", "previewImport", "readArtifact", "listArchive", "listModels", "getMemberModel", "listFolderDefaults"]);
const MEMBER_MODEL_PARTS = { model: "model", reasoningEffort: "reasoning_effort" } as const;
export function createService({ store, paths, adapters, toolConfig, folderDefaults, deliver }: {
  store: Store; paths: Paths; adapters: Record<string, Adapter>;
  toolConfig: (principal: Principal) => object;
  folderDefaults: FolderDefaults;
  // Runs a message as the next turn of a Runtime conversation.
  deliver: (runtimeSessionId: string, text: string) => Promise<void>;
}) {
  let serial: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let scheduling = false;
  let scheduleRequested = false;
  const live = new Map<string, AdapterHandle>();
  const cancelling = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const executions = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const connected = new Set<string>();
  // Pushed by the shared Runtime; not persisted, since it only describes now.
  let runtimeSessions = new Map<string, LiveSession>();
  // Bumped when the Runtime reports a changed folder default; pages refetch what they show.
  let folderDefaultsVersion = 0;
  function releaseSessionWait(sessionId: string) {
    const set = waiters.get(sessionId);
    if (!set) return;
    waiters.delete(sessionId);
    for (const wake of set) wake();
  }
  function transaction<T>(work: (state: State) => Promise<T> | T): Promise<T> {
    const result = serial.then(async () => {
      const next = structuredClone(store.state);
      const result = await work(next);
      expireApprovals(next);
      retain(next);
      const previousSeq = store.state.seq;
      await store.commit(next);
      for (const id of connected) if (!store.state.sessions[id]) connected.delete(id);
      if (store.state.seq !== previousSeq) for (const listener of listeners) listener();
      if (Object.keys(store.state.deliveries).length) void flushDeliveries();
      return result;
    });
    serial = result.catch(() => {});
    return result;
  }
  // A conversation that delegated work gets its results once its Runtime hosts it.
  let flushing = false, flushAgain = false, flushTimer: ReturnType<typeof setTimeout> | undefined;
  async function flushDeliveries() {
    if (flushing) { flushAgain = true; return; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    flushing = true;
    try {
      do {
        flushAgain = false;
        for (const [sessionId, { texts }] of Object.entries(store.state.deliveries)) {
          if (stopped) return;
          const session = store.state.sessions[sessionId];
          if (session && !(session.runtimeSessionId && (session.shared || connected.has(sessionId)))) continue;
          // Another run owns the folder: the turn would be refused, so the delivery waits for that run to end.
          if (session && Object.values(store.state.runs).some(r => activeRun(r) && r.sessionId !== sessionId && store.state.sessions[r.sessionId]?.agentId === session.agentId)) continue;
          try {
            if (session) {
              await deliver(session.runtimeSessionId, texts.join("\n\n"));
              connected.add(sessionId);
            }
          } catch (error) {
            // A conversation that is gone will never take it; anything else is retried on the next change.
            if (!["SessionNotFound", "SessionClosed"].includes((error as { code?: string }).code || "")) {
              reportServiceError(error);
              if (!stopped && !flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = undefined; void flushDeliveries(); }, 2000);
                flushTimer.unref?.();
              }
              continue;
            }
          }
          await transaction(state => {
            const left = state.deliveries[sessionId]?.texts.slice(texts.length) || [];
            if (left.length) state.deliveries[sessionId] = { texts: left }; else delete state.deliveries[sessionId];
          });
        }
      } while (flushAgain && !stopped);
    } finally { flushing = false; }
  }
  function sessionOf(state: State, actor: Principal) {
    if (actor.kind === "user") return undefined;
    const session = state.sessions[actor.sessionId];
    requireValue(session, "SESSION_EXPIRED", "This management session is no longer registered.");
    return session;
  }
  function teamAccess(state: State, actor: Principal, teamId: string, read = false) {
    const team = state.teams[teamId];
    requireValue(team, "NOT_FOUND", "Team not found.");
    if (actor.kind === "agent") {
      const session = sessionOf(state, actor)!;
      requireValue(session.teamId === teamId && state.memberships[memberKey(teamId, session.agentId)], "FORBIDDEN", "This session cannot access that team.");
    }
    requireValue(read || !team.archive, "TEAM_ARCHIVED", "This team was deleted; its deliveries are kept read-only. Read them with listArchive.");
    return team;
  }
  function taskAccess(state: State, actor: Principal, taskId: string, read = false) {
    const task = state.tasks[taskId];
    requireValue(task, "NOT_FOUND", "Task not found.");
    teamAccess(state, actor, task.teamId, read);
    if (actor.kind === "agent") {
      const session = sessionOf(state, actor)!;
      requireValue(session.agentId === task.assigneeAgentId || manages(state, task.teamId, session.agentId, task.assigneeAgentId), "FORBIDDEN", "Only the task owner or its supervisors can access this task.");
    }
    return task;
  }
  function coordinate(state: State, actor: Principal, teamId: string, targetId: string, direct = false) {
    teamAccess(state, actor, teamId);
    if (actor.kind !== "agent") return;
    const id = sessionOf(state, actor)!.agentId;
    requireValue(direct ? supervisor(state, teamId, targetId) === id : manages(state, teamId, id, targetId), "FORBIDDEN", "Only this member's supervisor can coordinate its work.");
  }
  function ownSession(state: State, actor: Principal, sessionId: string) {
    const session = state.sessions[sessionId];
    requireValue(session, "NOT_FOUND", "Session not found.");
    requireValue(actor.kind === "user" || actor.sessionId === sessionId, "FORBIDDEN", "Session does not belong to this caller.");
    return session;
  }
  function userOnly(actor: Principal) { requireValue(actor.kind === "user", "USER_CONFIRMATION_REQUIRED", "Complete this choice through the user interface."); }
  function author(state: State, actor: Principal) { return actor.kind === "user" ? "user" : actor.kind === "manager" ? "manager" : sessionOf(state, actor)!.agentId; }
  function requireMember(state: State, teamId: string, agentId: string) {
    requireValue(state.memberships[memberKey(teamId, agentId)], "NOT_TEAM_MEMBER", "The target is not registered in this team. Add it before starting work.");
  }
  // Only the user and the Manager choose which model a member runs on; leaders and members cannot.
  function memberWorkspace(state: State, actor: Principal, teamId: string, agentId: string) {
    requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user and the Manager choose a member's model.");
    teamAccess(state, actor, teamId);
    requireMember(state, teamId, agentId);
    return state.agents[agentId].canonicalWorkspace;
  }
  // The user sees in the Inbox what the Manager changed; the user's own changes need no notice.
  function noticeFromManager(state: State, actor: Principal, teamId: string, agentId: string, title: string) {
    if (actor.kind !== "manager") return;
    const id = randomUUID();
    state.notices[id] = { id, teamId, agentId, title, createdAt: new Date().toISOString() };
  }
  async function addMember(state: State, actor: Principal, p: Params) {
    teamAccess(state, actor, p.teamId);
    const agent = state.agents[p.agentId];
    requireValue(agent, "NOT_FOUND", "Agent not found.");
    await privateDirectory(paths.manager);
    requireValue(agent.canonicalWorkspace !== await canonicalDirectory(paths.manager), "FORBIDDEN", "The manager workspace cannot join a team.");
    const conflicts = Object.values(state.memberships).filter(m => m.teamId !== p.teamId && state.agents[m.agentId].canonicalWorkspace === agent.canonicalWorkspace);
    if (conflicts.length) {
      requireValue(actor.kind === "user" && p.share === true, "WORKSPACE_SHARED", "This workspace already belongs to another team. Create an independent copy (recommended), or explicitly share it.", { teams: conflicts.map(m => state.teams[m.teamId].name), workspace: agent.canonicalWorkspace });
    }
    requireValue(!state.memberships[memberKey(p.teamId, agent.id)], "ALREADY_MEMBER", "This workspace is already a member of this team.");
    const parentId = p.reportsToAgentId || (actor.kind === "agent" ? sessionOf(state, actor)!.agentId : state.teams[p.teamId].leaderAgentId);
    if (actor.kind === "agent") requireValue(parentId === sessionOf(state, actor)!.agentId, "FORBIDDEN", "New members must report to you.");
    const membership = { teamId: p.teamId as string, agentId: agent.id, ...(p.position ? { position: text(p.position, "Position", 200) } : {}), ...(p.responsibility ? { responsibility: text(p.responsibility, "Responsibility") } : {}) };
    state.memberships[memberKey(p.teamId, agent.id)] = membership;
    if (!state.teams[p.teamId].leaderAgentId) state.teams[p.teamId].leaderAgentId = agent.id;
    if (parentId) setSupervisor(state, p.teamId, agent.id, parentId);
    return membership;
  }
  async function register(state: State, p: Params): Promise<Agent> {
    const canonicalWorkspace = await canonicalDirectory(text(p.workspace, "Workspace"));
    requireValue(!inside(await canonicalDirectory(paths.state), canonicalWorkspace), "FORBIDDEN", "The management state directory cannot be an agent workspace.");
    const adapter = p.adapter || "rind";
    requireValue(Object.hasOwn(adapters, adapter), "UNSUPPORTED_ADAPTER", "No installed execution adapter: " + adapter);
    const existing = Object.values(state.agents).find(a => a.canonicalWorkspace === canonicalWorkspace && a.adapter === adapter);
    if (existing) return existing;
    const agent = { id: randomUUID(), name: p.name ? text(p.name, "Name", 200) : path.basename(canonicalWorkspace), canonicalWorkspace, adapter,
      ...(p.hint ? { hint: text(p.hint, "Agent instructions") } : {}),
      ...(p.skillRefs ? { skillRefs: strings(p.skillRefs, "Skills") } : {}) };
    state.agents[agent.id] = agent;
    return agent;
  }
  function note(state: State, taskId: string, by: string, message: string) {
    const id = randomUUID();
    state.notes[id] = { id, taskId, author: by, text: message, createdAt: new Date().toISOString() };
    return state.notes[id];
  }
  const taskDelegations = (state: State, taskId: string) => Object.values(state.delegations).filter(d => d.taskId === taskId && !d.parentDelegationId);
  const childDelegations = (state: State, delegationId: string) => Object.values(state.delegations).filter(d => d.parentDelegationId === delegationId);
  const sessionDelegations = (state: State, sessionId: string) => Object.values(state.delegations).filter(d => d.originSessionId === sessionId && !d.parentDelegationId);
  function ownDelegations(state: State, session: Session) {
    const run = Object.values(state.runs).find(r => activeRun(r) && r.sessionId === session.id);
    if (run?.delegationId) return childDelegations(state, run.delegationId);
    if (run?.taskId) return taskDelegations(state, run.taskId);
    return sessionDelegations(state, session.id);
  }
  // Whoever delegated the work hears back once all of it has settled: a parent
  // task or delegation runs again, a conversation gets a delivery. While the
  // delegator is still running its own turn (or actively waiting in-turn),
  // results remain unreturned so delegate({wait: true}) can claim them first.
  function wakeDelegator(state: State, d: Delegation) {
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
      if (waiters.has(sessionId) || Object.values(state.runs).some(r => activeRun(r) && r.sessionId === sessionId)) return;
      const children = sessionDelegations(state, sessionId);
      if (!children.some(awaitingDelegation)) returnDelegations(state, children, text => { (state.deliveries[sessionId] ||= { texts: [] }).texts.push(text); });
    }
  }
  function returnDelegations(state: State, delegations: Delegation[], send: (text: string) => void) {
    const fresh = delegations.filter(d => !d.returned && !awaitingDelegation(d));
    if (!fresh.length) return;
    for (const d of fresh) d.returned = true;
    send(resultsText(state, fresh));
  }
  const nameOf = (state: State, id: string) => id === "user" ? "the user" : state.agents[id]?.name || id;
  function resultsText(state: State, delegations: Delegation[]) {
    return ["Delegated work settled:", ...delegations.map(d => {
      const head = "- " + nameOf(state, d.assigneeAgentId) + " · task " + d.id + " · ";
      if (d.status === "done") return head + "delivered: " + (d.reply || "");
      return head + d.status + (d.error ? ": " + d.error : "");
    })].join("\n");
  }
  // The task or delegation runs again, told why.
  function resumeWork(work: Task | Delegation, message: string) {
    work.resume = work.resume ? work.resume + "\n\n" + message : message;
    work.status = "queued"; work.dispatch = true;
    if ("blockedOn" in work) delete work.blockedOn;
    delete work.error;
  }
  // An entry task assigned by the user or Manager. It owns the 1-page report.
  function newTask(state: State, actor: Principal, teamId: string, assigneeAgentId: string, brief: string, start: boolean) {
    const team = teamAccess(state, actor, teamId);
    requireValue(team.leaderAgentId, "LEADER_REQUIRED", "Choose a team leader before assigning work.");
    requireMember(state, teamId, assigneeAgentId);
    const by = actor.kind === "manager" ? "manager" : "user";
    const id = randomUUID();
    const task: Task = { id, teamId, assigneeAgentId, createdBy: by, brief, status: "queued", ...(start ? { dispatch: true } : {}) };
    state.tasks[id] = task; note(state, id, by, "Assigned: " + brief);
    return task;
  }
  // Internal work delegated by a team member to a direct report.
  function newDelegation(state: State, session: Session, teamId: string, assigneeAgentId: string, brief: string) {
    const team = state.teams[teamId];
    requireValue(team?.leaderAgentId, "LEADER_REQUIRED", "Choose a team leader before assigning work.");
    requireMember(state, teamId, assigneeAgentId);
    const run = Object.values(state.runs).find(r => activeRun(r) && r.sessionId === session.id);
    const parent = run?.delegationId ? state.delegations[run.delegationId] : undefined;
    const taskId = parent ? parent.taskId : run?.taskId;
    const originSessionId = parent ? parent.originSessionId : !taskId ? session.id : undefined;
    const id = randomUUID();
    const delegation: Delegation = {
      id, teamId, fromAgentId: session.agentId, assigneeAgentId, brief, status: "queued", dispatch: true,
      ...(taskId ? { taskId } : {}),
      ...(parent ? { parentDelegationId: parent.id } : {}),
      ...(originSessionId ? { originSessionId } : {}),
    };
    state.delegations[id] = delegation;
    return delegation;
  }
  function blockTask(state: State, actor: Principal, task: Task, blocked: Params) {
    const responder = blocked?.responder === undefined ? "user" : text(blocked.responder, "Blocker responder", 200);
    requireValue(responder === "user", "INVALID_RESPONDER", "Task blockers ask the user; use delegate to coordinate with team members.");
    task.blockedOn = { responder: "user", action: text(blocked?.action, "Unblocking action") };
    task.status = "blocked";
    note(state, task.id, author(state, actor), "Needs user: " + task.blockedOn.action);
  }
  async function report(state: State, actor: Principal, p: Params) {
    const run = Object.values(state.runs).find(r => activeRun(r) && r.sessionId === (actor as { sessionId: string }).sessionId && r.taskId && !r.delegationId);
    requireValue(run, "NO_TASK", "This conversation has no active task; reply directly in the conversation instead of calling report.");
    const task = state.tasks[run.taskId!];
    requireValue(task.status === "running", "TASK_NOT_RUNNING", "Report from an active task.");
    if (p.blocked !== undefined) { blockTask(state, actor, task, p.blocked); return { taskId: task.id, status: "blocked", next: "End your turn." }; }
    const pending = taskDelegations(state, task.id);
    requireValue(!pending.some(d => awaitingDelegation(d) || !d.returned), "WORK_OUTSTANDING",
      pending.some(awaitingDelegation)
        ? "Your delegated work is still running. Call delegate({wait: true}) or end your turn to receive the results before reporting."
        : "Delegated results are ready. Call delegate({wait: true}) to read them before reporting.");
    const delivery = validateReport({ outcome: p.outcome, summary: p.summary, evidence: p.evidence ?? [], artifacts: [] });
    for (const file of p.artifacts === undefined ? [] : strings(p.artifacts, "Artifacts")) {
      const artifact = await publishArtifact(paths.artifacts, { workspace: state.agents[task.assigneeAgentId].canonicalWorkspace }, { teamId: task.teamId, recipient: "user", taskId: task.id }, file);
      state.artifacts[artifact.id] = artifact; delivery.artifacts.push(artifact.id);
    }
    task.report = delivery;
    note(state, task.id, author(state, actor), "Delivery submitted; awaiting confirmed execution completion.");
    return { taskId: task.id, delivered: true, next: "End your turn; your delivery goes to the user." };
  }
  function claimWaitResult(state: State, ids: string[], outcome: { timedOut: boolean; released: boolean }, canClaim: boolean, includeReturned: boolean) {
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
  function prepareWait(state: State, actor: Principal, session: Session, p: Params): WaitPending | ReturnType<typeof claimWaitResult> {
    requireValue(p.to === undefined && p.new === undefined && p.brief === undefined && p.message === undefined && p.cancel === undefined && p.retire === undefined && p.interrupt === undefined,
      "INVALID_INPUT", "Use {wait: true, task?, timeoutMs?} without other delegate actions.");
    const rawTimeout = p.timeoutMs === undefined ? 30000 : Number(p.timeoutMs);
    requireValue(Number.isFinite(rawTimeout) && rawTimeout >= 1000 && rawTimeout <= 60000, "INVALID_INPUT", "timeoutMs must be between 1000 and 60000.");
    const timeoutMs = Math.floor(rawTimeout);
    const includeReturned = p.task !== undefined;
    let targets: Delegation[];
    if (includeReturned) {
      const id = text(p.task, "Task");
      const d = state.delegations[id];
      if (!d && state.tasks[id]) coordinate(state, actor, state.tasks[id].teamId, state.tasks[id].assigneeAgentId);
      requireValue(d, "NOT_FOUND", "Delegated work not found.");
      teamAccess(state, actor, d.teamId);
      requireValue(d.fromAgentId === session.agentId || manages(state, d.teamId, session.agentId, d.assigneeAgentId), "FORBIDDEN", "Only this member's supervisor can coordinate its work.");
      targets = [d];
    } else {
      targets = ownDelegations(state, session).filter(d => !d.returned);
    }
    const ids = targets.map(d => d.id);
    if (!targets.length || targets.some(d => !awaitingDelegation(d))) {
      return claimWaitResult(state, ids, { timedOut: false, released: false }, true, includeReturned);
    }
    return { [WAIT_PENDING]: { sessionId: session.id, ids, timeoutMs, includeReturned } };
  }
  function waitForDelegations(sessionId: string, ids: string[], timeoutMs: number): Promise<{ timedOut: boolean; released: boolean }> {
    const ready = () => ids.some(id => { const d = store.state.delegations[id]; return !d || !awaitingDelegation(d); });
    if (ready()) return Promise.resolve({ timedOut: false, released: false });
    if (stopped) return Promise.resolve({ timedOut: false, released: true });
    return new Promise(resolve => {
      let done = false;
      const finish = (outcome: { timedOut: boolean; released: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        listeners.delete(onStateChange);
        const set = waiters.get(sessionId);
        if (set) { set.delete(onRelease); if (!set.size) waiters.delete(sessionId); }
        resolve(outcome);
      };
      const onStateChange = () => { if (ready()) finish({ timedOut: false, released: false }); };
      const onRelease = () => finish({ timedOut: false, released: true });
      const timer = setTimeout(() => finish({ timedOut: true, released: false }), timeoutMs);
      listeners.add(onStateChange);
      let set = waiters.get(sessionId);
      if (!set) { set = new Set(); waiters.set(sessionId, set); }
      set.add(onRelease);
    });
  }
  function resolveDirectReport(state: State, teamId: string, me: string, target: string) {
    if (state.memberships[memberKey(teamId, target)] && supervisor(state, teamId, target) === me) return target;
    const reports = directReports(state, teamId, me);
    const exact = reports.filter(r => r.name === target);
    if (exact.length === 1) return exact[0].id;
    const lower = target.toLowerCase();
    const matched = reports.filter(r => r.name.trim().toLowerCase() === lower);
    return matched.length === 1 ? matched[0].id : undefined;
  }
  async function delegate(state: State, actor: Principal, p: Params, prefetched?: any) {
    const session = sessionOf(state, actor)!;
    const teamId = session.teamId, me = session.agentId;
    requireValue(teamId && state.memberships[memberKey(teamId, me)], "FORBIDDEN", "This conversation has no team.");
    if (p.wait === true) return prepareWait(state, actor, session, p);
    const forms = ["to", "new", "task", "retire"].filter(key => p[key] !== undefined);
    requireValue(forms.length === 1, "INVALID_INPUT",
      "Use exactly one form: {to, brief}, {new, brief}, {task, message, interrupt?}, {task, cancel: true}, {wait: true, task?, timeoutMs?} or {retire}."
      + (forms.length === 0 && p.brief !== undefined ? " Direct reports: " + JSON.stringify(directReports(state, teamId, me)) : ""));
    if (p.task !== undefined) return followUp(state, actor, text(p.task, "Task"), p, prefetched);
    if (p.retire !== undefined) return retire(state, teamId, me, text(p.retire, "retire", 200));
    const brief = text(p.brief, "Brief");
    let to: string;
    if (p.new !== undefined) to = (await addReport(state, actor, teamId, me, p.new)).id;
    else {
      const resolved = resolveDirectReport(state, teamId, me, text(p.to, "to", 200));
      requireValue(resolved, "NOT_DIRECT_REPORT", "Delegate only to your direct reports: " + JSON.stringify(directReports(state, teamId, me)));
      to = resolved;
    }
    const delegation = newDelegation(state, session, teamId, to, brief);
    return { taskId: delegation.id, assignee: nameOf(state, to), status: "queued", ...(p.new !== undefined ? { agentId: to, workspace: state.agents[to].canonicalWorkspace } : {}), next: DELEGATE_NEXT };
  }
  // A new direct report: a worktree on its own branch of a team repository, or an empty folder
  // that starts with its creator's chosen model, as a worktree starts with its repository's.
  async function addReport(state: State, actor: Principal, teamId: string, me: string, spec: Params) {
    requireValue(spec && typeof spec === "object", "INVALID_INPUT", "new needs a name.");
    requireValue(supervises(state, teamId, me), "FORBIDDEN", "Only the team leader or a member with direct reports adds members.");
    const target = await newWorkspacePath(state.teams[teamId].createRoot, spec.name);
    const own = state.agents[me].canonicalWorkspace;
    const worktreeOf = spec.branch === undefined ? undefined : spec.repository ? await canonicalDirectory(text(spec.repository, "Repository")) : own;
    if (worktreeOf) {
      requireValue(Object.values(state.memberships).some(m => m.teamId === teamId && state.agents[m.agentId].canonicalWorkspace === worktreeOf), "FORBIDDEN", "Branch a repository registered in this team.");
      await addWorktree(worktreeOf, target, spec.branch, spec.base);
    } else {
      await mkdir(target);
    }
    try {
      if (!worktreeOf) await inheritModel(own, target);
      const agent = await register(state, { workspace: target, name: spec.name });
      agent.addedBy = me;
      if (worktreeOf) agent.worktreeOf = worktreeOf;
      await addMember(state, actor, { teamId, agentId: agent.id, ...(spec.responsibility ? { responsibility: spec.responsibility } : {}) });
      return agent;
    } catch (error) {
      await (worktreeOf ? removeWorktree(worktreeOf, target) : rm(target, { recursive: true, force: true })).catch(() => {});
      throw error;
    }
  }
  // Only what was chosen for the creator's folder is copied; settings.json stays the default for both.
  async function inheritModel(from: string, to: string) {
    const resolved = (await folderDefaults("resolve", { workspace_roots: [from] })).folders[from];
    const model = resolved && resolved.model_source !== "settings", effort = resolved && resolved.effort_source !== "settings";
    if (model || effort) await folderDefaults("set", { workspace_root: to, provider_id: model ? resolved.provider : "", model_id: model ? resolved.model : "", reasoning_effort: effort ? resolved.reasoning_effort : "" });
  }
  async function retire(state: State, teamId: string, me: string, target: string) {
    const agentId = state.agents[target] ? target : resolveDirectReport(state, teamId, me, target) || target;
    const agent = state.agents[agentId];
    requireValue(agent?.addedBy === me && state.memberships[memberKey(teamId, agentId)], "FORBIDDEN", "Retire only a direct report you added.");
    const busy = Object.values(state.tasks).some(t => t.teamId === teamId && t.assigneeAgentId === agentId && !["done", "cancelled"].includes(t.status))
      || Object.values(state.delegations).some(d => d.teamId === teamId && d.assigneeAgentId === agentId && awaitingDelegation(d));
    requireValue(!busy, "MEMBER_BUSY", "This member still has open work. Cancel it or let it finish first.");
    requireRemovable(state, teamId, agentId);
    if (agent.worktreeOf) await removeWorktree(agent.worktreeOf, agent.canonicalWorkspace);
    dropMember(state, teamId, agentId);
    return agent.worktreeOf ? { retired: agentId, kept: "its branch" } : { retired: agentId, kept: agent.canonicalWorkspace };
  }
  function requireRemovable(state: State, teamId: string, agentId: string) {
    requireValue(!Object.values(state.memberships).some(m => m.teamId === teamId && supervisor(state, teamId, m.agentId) === agentId), "HAS_REPORTS", "Move this member's direct reports before removing it.");
    requireValue(state.teams[teamId].leaderAgentId !== agentId, "LEADER_REQUIRED", "Choose another leader before removing this member.");
    requireValue(!Object.values(state.runs).some(r => activeRun(r) && state.sessions[r.sessionId].teamId === teamId && state.sessions[r.sessionId].agentId === agentId), "MEMBER_BUSY", "Stop or resolve this member's run first.");
  }
  function dropMember(state: State, teamId: string, agentId: string) {
    delete state.memberships[memberKey(teamId, agentId)];
    for (const task of Object.values(state.tasks)) if (task.teamId === teamId && task.assigneeAgentId === agentId && !["done", "cancelled"].includes(task.status)) { task.status = "needs_attention"; delete task.dispatch; task.error = "Member removed from team."; }
    for (const d of Object.values(state.delegations)) if (d.teamId === teamId && d.assigneeAgentId === agentId && awaitingDelegation(d)) { d.status = "failed"; delete d.dispatch; d.error = "Member removed from team."; wakeDelegator(state, d); }
    const released = unbindSessions(state, s => s.teamId === teamId && s.agentId === agentId, openInWindow);
    pruneAgents(state, new Set([agentId, ...released]));
  }
  function cancelDelegationTree(state: State, delegationId: string) {
    for (const child of childDelegations(state, delegationId)) {
      cancelDelegationTree(state, child.id);
      if (!["done", "cancelled"].includes(child.status)) { child.status = "cancelled"; delete child.dispatch; child.returned = true; }
    }
  }
  function cancelTaskDelegations(state: State, taskId: string) {
    for (const d of Object.values(state.delegations)) if (d.taskId === taskId && !["done", "cancelled"].includes(d.status)) {
      d.status = "cancelled"; delete d.dispatch; d.returned = true;
    }
  }
  async function followUp(state: State, actor: Principal, id: string, p: Params, prefetched?: any) {
    const d = state.delegations[id];
    if (!d && state.tasks[id]) coordinate(state, actor, state.tasks[id].teamId, state.tasks[id].assigneeAgentId);
    requireValue(d, "NOT_FOUND", "Delegated work not found.");
    teamAccess(state, actor, d.teamId);
    const me = sessionOf(state, actor)!.agentId;
    requireValue(d.fromAgentId === me || manages(state, d.teamId, me, d.assigneeAgentId), "FORBIDDEN", "Only this member's supervisor can coordinate its work.");
    if (p.cancel === true) {
      // Cancelled by its delegator: nothing to report back.
      d.returned = true;
      cancelDelegationTree(state, d.id);
      const run = Object.values(state.runs).find(r => r.delegationId === d.id && activeRun(r));
      if (run && live.has(run.id)) { d.status = "cancelled"; delete d.dispatch; return { runId: run.id, cancelling: true, taskId: d.id, status: "cancelled" }; }
      requireValue(!["done", "cancelled"].includes(d.status), "TASK_FINISHED", "This task has already finished.");
      d.status = "cancelled"; delete d.dispatch; wakeDelegator(state, d);
      return { taskId: d.id, status: "cancelled" };
    }
    requireValue(d.status !== "cancelled", "TASK_FINISHED", "This task was cancelled.");
    requireValue(p.message === undefined || p.brief === undefined || p.message === p.brief, "INVALID_INPUT", "Provide message (not both message and brief) when following up on a task.");
    const message = text(p.message ?? p.brief, "Message");
    const from = "From " + nameOf(state, me) + ": " + message;
    const run = Object.values(state.runs).find(r => r.delegationId === d.id && activeRun(r));
    if (d.status === "running" && !p.interrupt) {
      if (run && (prefetched ?? await live.get(run.id)?.steer?.(from))) {
        releaseSessionWait(run.sessionId);
        return { taskId: d.id, assignee: nameOf(state, d.assigneeAgentId), status: "steered", next: DELEGATE_NEXT };
      }
    }
    if (p.interrupt && (d.status === "running" || d.status === "waiting")) cancelDelegationTree(state, d.id);
    if (d.status === "queued") {
      const hadRuns = Object.values(state.runs).some(r => r.delegationId === d.id);
      if (p.interrupt) {
        if (hadRuns || d.resume) d.resume = from; else { d.brief = message; delete d.resume; }
      } else {
        d.resume = (d.resume || d.brief) + "\n\n" + from;
      }
      d.dispatch = true; d.returned = false;
      return { taskId: d.id, assignee: nameOf(state, d.assigneeAgentId), status: "queued", ...(p.interrupt ? { interrupted: true } : {}), next: DELEGATE_NEXT };
    }
    delete d.reply; delete d.error; d.returned = false;
    resumeWork(d, from);
    return {
      taskId: d.id, assignee: nameOf(state, d.assigneeAgentId), status: "queued",
      ...(p.interrupt ? { interrupted: true } : {}),
      ...(p.interrupt && run ? { runId: run.id, cancelling: true } : {}),
      next: DELEGATE_NEXT,
    };
  }
  function markDelivered(task: Task) { task.status = "done"; task.deliveredAt = new Date().toISOString(); delete task.blockedOn; }
  function deleteTeam(state: State, teamId: string) {
    requireValue(!Object.values(state.runs).some(r => activeRun(r) && state.sessions[r.sessionId]?.teamId === teamId), "TEAM_BUSY", "Stop or resolve the team's running work before deleting it.");
    return dissolveTeam(state, teamId, (taskId, message) => note(state, taskId, "system", message), openInWindow);
  }
  // A window shows it, or a private worker still hosts it.
  function openInWindow(session: Session) {
    const live = runtimeSessions.get(session.runtimeSessionId);
    return Boolean(live && (live.watchers > 0 || live.turn !== "idle")) || (!session.shared && connected.has(session.id));
  }
  function stopRun(state: State, by: string, run: Run, task: Task) {
    task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
    cancelTaskDelegations(state, task.id);
    note(state, task.id, by, "Requested execution stop.");
    // The workspace remains reserved until the adapter confirms termination.
    return { runId: run.id, cancelling: true };
  }
  // One pending request per decision; asking again returns the same one.
  function askUser(state: State, actor: Principal, request: Pick<Approval, "kind" | "teamId" | "title"> & Partial<Approval>) {
    const pending = Object.values(state.approvals).find(a => a.kind === request.kind && a.teamId === request.teamId && a.runId === request.runId);
    if (pending) return { approval: pending };
    const id = randomUUID();
    state.approvals[id] = { ...request, id, requestedBy: author(state, actor), createdAt: new Date().toISOString() };
    return { approval: state.approvals[id] };
  }
  function workspaceBusy(state: State, workspace: string) {
    return Object.values(state.runs).some(r => activeRun(r) && state.agents[state.sessions[r.sessionId]?.agentId]?.canonicalWorkspace === workspace);
  }
  function newRun(state: State, sessionId: string, taskId?: string, delegationId?: string): Run {
    const session = state.sessions[sessionId];
    const agent = state.agents[session.agentId];
    requireValue(!workspaceBusy(state, agent.canonicalWorkspace), "WORKSPACE_BUSY", "Another run owns this workspace. Wait for it to finish or resolve its unknown status.");
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), sessionId, ...(taskId ? { taskId } : {}), ...(delegationId ? { delegationId } : {}), status: "starting", startedAt: now, lastObservedAt: now, hostSequence: 0 };
    state.runs[run.id] = run;
    return run;
  }
  // What the user and the Manager see; members never read the organization.
  function filtered(state: State, actor: Principal) {
    const teams = Object.values(state.teams).filter(t => !t.archive);
    const teamIds = new Set(teams.map(t => t.id));
    const tasks = Object.values(state.tasks).filter(t => teamIds.has(t.teamId) && entryTask(t));
    const taskIds = new Set(tasks.map(t => t.id));
    const sessions = Object.values(state.sessions);
    const index = projectionIndex(state, connected, runtimeSessions);
    return {
      seq: state.seq, teams,
      agents: Object.values(state.agents).map(a => actor.kind === "user" ? a : { id: a.id, name: a.name, adapter: a.adapter, canonicalWorkspace: a.canonicalWorkspace }),
      memberships: Object.values(state.memberships).filter(m => teamIds.has(m.teamId)).map(m => ({ ...m, reportsToAgentId: supervisor(state, m.teamId, m.agentId), status: memberStatus(index, m.agentId, m.teamId) })),
      tasks: tasks.map(task => ({ ...task, ...(task.status === "queued" ? { queueReason: queuedReason(index, task) } : {}) })), sessions: sessions.map(s => ({ ...(actor.kind === "user" ? s : { id: s.id, agentId: s.agentId, teamId: s.teamId, origin: s.origin }), ...sessionStatus(index, s.id) })),
      connectedSessions: sessions.filter(s => connected.has(s.id)).map(s => s.id),
      // Every conversation in the shared Runtime, including plain ones outside any team.
      ...(actor.kind === "user" ? { live: [...runtimeSessions.values()], folderDefaultsVersion } : {}),
      // Archived work is read on demand (listArchive) so it never weighs on live pushes.
      ...(actor.kind === "user" ? { notices: Object.values(state.notices) } : {}),
      approvals: Object.values(state.approvals), archivedTeams: Object.values(state.teams).filter(t => t.archive).map(t => ({ id: t.id, name: t.name, archivedAt: t.archive!.at })),
      runs: Object.values(state.runs).map(r => {
        const origin = r.delegationId ? state.delegations[r.delegationId]?.originSessionId : undefined;
        return origin ? { ...r, originSessionId: origin } : r;
      }),
      notes: Object.values(state.notes).filter(n => taskIds.has(n.taskId)),
      artifacts: Object.values(state.artifacts).filter(a => taskIds.has(a.taskId)),
    };
  }
  async function operate(state: State, actor: Principal, method: string, p: Params, prefetched?: any): Promise<any> {
    if (actor.kind !== "user") sessionOf(state, actor);
    switch (method) {
      case "snapshot": return actor.kind === "manager" ? managerOverview(filtered(state, actor), state.agents) : filtered(state, actor);
      case "listTeams": return filtered(state, actor).teams;
      case "listAgents": return filtered(state, actor).agents;
      case "getTeam": {
        teamAccess(state, actor, p.teamId); const view = filtered(state, actor);
        const tasks = view.tasks.filter(t => t.teamId === p.teamId);
        return { team: state.teams[p.teamId], members: view.memberships.filter(m => m.teamId === p.teamId), tasks, briefing: teamBriefing(tasks, state.agents) };
      }
      case "getTask": { const task = taskAccess(state, actor, p.taskId, true); return { ...task, notes: Object.values(state.notes).filter(n => n.taskId === task.id), artifacts: Object.values(state.artifacts).filter(a => a.taskId === task.id) }; }
      case "createTeam": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user or manager can create teams.");
        const id = randomUUID();
        const createRoot = p.createRoot ? await canonicalDirectory(text(p.createRoot, "Creation root")) : path.join(paths.workspaces, id);
        const name = text(p.name, "Team name", 200);
        requireValue(!teamNameTaken(state, name), "TEAM_NAME_TAKEN", "A team named \"" + name.trim() + "\" already exists. Choose another name.");
        const team = { id, name, createRoot };
        state.teams[id] = team; return team;
      }
      case "renameTeam": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user or manager can rename teams.");
        const team = teamAccess(state, actor, p.teamId);
        const name = text(p.name, "Team name", 200);
        requireValue(!Object.values(state.teams).some(t => t.id !== team.id && !t.archive && t.name.trim().toLowerCase() === name.trim().toLowerCase()), "TEAM_NAME_TAKEN", "A team named \"" + name.trim() + "\" already exists. Choose another name.");
        team.name = name; return team;
      }
      case "registerAgent": return register(state, p);
      case "addMember": {
        if (!p.agentId) { const agent = await register(state, p); p = { ...p, agentId: agent.id }; }
        return addMember(state, actor, p);
      }
      case "removeMember": {
        coordinate(state, actor, p.teamId, p.agentId);
        requireRemovable(state, p.teamId, p.agentId);
        dropMember(state, p.teamId, p.agentId);
        return { removed: true };
      }
      case "deleteTeam": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user or Manager can delete teams.");
        const team = teamAccess(state, actor, p.teamId);
        // The Manager deletes only a team with nothing in it; anything else is the user's decision.
        const used = [state.tasks, state.memberships, state.sessions].some(table => Object.values(table).some(item => item.teamId === team.id));
        if (actor.kind === "user") requireValue(p.confirmName === team.name, "CONFIRMATION_REQUIRED", "Type the team name exactly to delete it.");
        else if (used) {
          requireValue(!Object.values(state.runs).some(r => activeRun(r) && state.sessions[r.sessionId]?.teamId === team.id), "TEAM_BUSY", "Stop or resolve the team's running work before deleting it.");
          return askUser(state, actor, { kind: "deleteTeam", teamId: team.id, title: "Delete team " + team.name });
        }
        return deleteTeam(state, team.id);
      }
      case "listArchive": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user or Manager can read deleted teams.");
        const teams = Object.values(state.teams).filter(t => t.archive).sort((a, b) => b.archive!.at.localeCompare(a.archive!.at));
        return { teams: teams.map(team => ({ ...team, tasks: Object.values(state.tasks).filter(t => t.teamId === team.id && entryTask(t)) })) };
      }
      case "setLeader": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user or manager can change team leadership.");
        teamAccess(state, actor, p.teamId); requireMember(state, p.teamId, p.agentId);
        const previous = state.teams[p.teamId].leaderAgentId;
        // Move the previous root below the new root; keep the other branches intact.
        if (previous && previous !== p.agentId) {
          for (const m of Object.values(state.memberships)) if (m.teamId === p.teamId && m.agentId !== previous && m.agentId !== p.agentId && !m.reportsToAgentId) m.reportsToAgentId = previous;
          state.memberships[memberKey(p.teamId, previous)].reportsToAgentId = p.agentId;
        }
        delete state.memberships[memberKey(p.teamId, p.agentId)].reportsToAgentId;
        state.teams[p.teamId].leaderAgentId = p.agentId; return state.teams[p.teamId];
      }
      case "setSupervisor": {
        teamAccess(state, actor, p.teamId);
        return setSupervisor(state, p.teamId, p.agentId, p.reportsToAgentId);
      }
      case "updateMember": {
        coordinate(state, actor, p.teamId, p.agentId); requireMember(state, p.teamId, p.agentId);
        const member = state.memberships[memberKey(p.teamId, p.agentId)];
        for (const field of ["position", "responsibility"] as const) {
          if (p[field] === undefined) continue;
          if (p[field] === "") delete member[field];
          else member[field] = text(p[field], field, field === "position" ? 200 : 16000);
        }
        return member;
      }
      case "createWorkspace":
      case "createWorktree":
      case "copyWorkspace": {
        const team = teamAccess(state, actor, p.teamId);
        const target = await newWorkspacePath(team.createRoot, p.name);
        if (method === "createWorktree") {
          const repo = await canonicalDirectory(text(p.repository, "Repository"));
          requireValue(actor.kind === "user" || Object.values(state.memberships).some(m => m.teamId === team.id && state.agents[m.agentId].canonicalWorkspace === repo), "FORBIDDEN", "Choose a repository already registered in this team.");
          await addWorktree(repo, target, p.branch, p.base);
        } else if (method === "copyWorkspace") {
          userOnly(actor);
          const preview = await copyPreview(text(p.source, "Source"));
          requireValue(p.confirmation === preview.fingerprint, "COPY_CONFIRMATION_REQUIRED", "Review the copy preview before copying.", preview);
          requireValue(!inside(preview.source, target), "INVALID_PATH", "A copy cannot be placed inside its source.");
          await mkdir(target);
          for (const relative of preview.files) {
            const destination = path.join(target, relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await copyFile(path.join(preview.source, relative), destination);
          }
        } else await mkdir(target);
        const agent = await register(state, { ...p, workspace: target });
        await addMember(state, actor, { ...p, agentId: agent.id });
        return agent;
      }
      case "previewCopy": userOnly(actor); return copyPreview(text(p.source, "Source"));
      case "previewImport": userOnly(actor); return previewLegacyTeam(text(p.root, "Legacy team directory"));
      case "importTeam": {
        userOnly(actor);
        const preview = await previewLegacyTeam(text(p.root, "Legacy team directory"));
        requireValue(p.confirmation === preview.fingerprint && !preview.errors.length, "IMPORT_CONFIRMATION_REQUIRED", "Review and resolve the import preview first.", preview);
        // Importing the same folder again returns its live team; a deleted one stays archived and a new team is made.
        const base = "import-" + createHash("sha256").update(preview.root).digest("hex").slice(0, 24);
        const existing = Object.values(state.teams).find(t => (t.id === base || t.id.startsWith(base + "-")) && !t.archive);
        if (existing) return existing;
        const id = state.teams[base] ? base + "-" + randomUUID().slice(0, 8) : base;
        // The name comes from the old files, not from the user: keep it free of clashes.
        let name = preview.name;
        for (let n = 2; teamNameTaken(state, name); n++) name = preview.name + " (" + n + ")";
        state.teams[id] = { id, name, createRoot: path.join(paths.workspaces, id) };
        for (const source of preview.agents) {
          const agent = await register(state, source);
          await addMember(state, actor, { teamId: id, agentId: agent.id, responsibility: source.responsibility, share: p.share === true });
          if (source.legacyId === preview.leader) state.teams[id].leaderAgentId = agent.id;
        }
        return state.teams[id];
      }
      case "assignTask": return newTask(state, actor, p.teamId, p.assigneeAgentId, text(p.brief, "Brief"), p.start !== false);
      case "delegate": return delegate(state, actor, p, prefetched);
      case "report": return report(state, actor, p);
      case "startTask": {
        const task = taskAccess(state, actor, p.taskId);
        requireMember(state, task.teamId, task.assigneeAgentId);
        requireValue(["queued", "blocked", "needs_attention"].includes(task.status), "TASK_BUSY", "Task is not ready to start.");
        requireValue(!Object.values(state.runs).some(r => r.taskId === task.id && activeRun(r)), "RUN_UNCONFIRMED", "Resolve the previous run before retrying.");
        cancelTaskDelegations(state, task.id);
        if (Object.values(state.runs).some(r => r.taskId === task.id && !r.delegationId)) resumeWork(task, "Continue this task from where it stopped.");
        else { task.status = "queued"; task.dispatch = true; delete task.blockedOn; delete task.error; }
        note(state, task.id, author(state, actor), "Requested task start."); return task;
      }
      case "setTaskPriority": {
        const task = taskAccess(state, actor, p.taskId);
        requireValue(task.status === "queued", "TASK_NOT_QUEUED", "Only queued tasks can change priority.");
        requireValue(["high", "normal", "low"].includes(p.priority), "INVALID_INPUT", "Priority must be high, normal or low.");
        if (p.priority === "normal") delete task.priority; else task.priority = p.priority;
        note(state, task.id, author(state, actor), "Queue priority: " + p.priority); return task;
      }
      case "cancelTask": {
        const task = taskAccess(state, actor, p.taskId);
        requireValue(!Object.values(state.runs).some(r => r.taskId === task.id && activeRun(r)), "RUN_ACTIVE", "Stop or resolve the active run before cancelling this task.");
        requireValue(!["done", "cancelled"].includes(task.status), "TASK_FINISHED", "This task has already finished.");
        task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
        cancelTaskDelegations(state, task.id);
        note(state, task.id, author(state, actor), "Cancelled task."); return task;
      }
      case "reviewTask": {
        userOnly(actor);
        const task = taskAccess(state, actor, p.taskId);
        requireValue(task.status === "done" && task.report, "TASK_NOT_DELIVERED", "Only a delivered task can be accepted or sent back.");
        requireValue(!task.review, "ALREADY_REVIEWED", "This delivery was already reviewed.");
        const at = new Date().toISOString();
        if (p.decision === "accept") { task.review = { decision: "accepted", at }; note(state, task.id, "user", "Accepted the delivery."); return { task }; }
        requireValue(p.decision === "rework", "INVALID_INPUT", "Choose accept or rework.");
        const feedback = text(p.feedback, "Feedback");
        requireMember(state, task.teamId, task.assigneeAgentId);
        // Rework is a new task for the same owner, so the reviewed delivery stays as it was.
        const id = randomUUID();
        const rework: Task = { id, teamId: task.teamId, assigneeAgentId: task.assigneeAgentId, createdBy: "user", brief: "Rework of your delivery for: " + task.brief + "\nThe user's feedback: " + feedback + "\nYour previous delivery: " + JSON.stringify(task.report), status: "queued", reworkOf: task.id, dispatch: true, ...(task.priority ? { priority: task.priority } : {}) };
        state.tasks[id] = rework;
        note(state, id, "user", "Feedback on the previous delivery: " + feedback);
        task.review = { decision: "rework", at, feedback, reworkTaskId: id };
        note(state, task.id, "user", "Sent back for rework: " + feedback);
        return { task, rework };
      }
      case "postTaskNote": {
        const task = taskAccess(state, actor, p.taskId);
        const result = note(state, task.id, author(state, actor), text(p.text, "Note"));
        const sender = nameOf(state, author(state, actor));
        if (p.answer === true) {
          requireValue(task.status === "blocked" && task.blockedOn?.responder === author(state, actor), "FORBIDDEN", "Only the named responder can resolve this blocker.");
          resumeWork(task, sender + " answered your blocker: " + result.text);
        } else if (task.status === "running") {
          const line = sender + " noted: " + result.text;
          const run = Object.values(state.runs).find(r => r.taskId === task.id && !r.delegationId && activeRun(r));
          const handle = run ? live.get(run.id) : undefined;
          if (!handle?.steer || !(prefetched ?? await handle.steer(line))) resumeWork(task, line);
        } else if (task.status === "blocked" && task.blockedOn?.responder === "children") {
          resumeWork(task, sender + " noted: " + result.text);
        } else if (task.status === "queued") {
          const line = sender + " noted: " + result.text;
          task.resume = task.resume ? task.resume + "\n\n" + line : task.brief + "\n\n" + line;
        }
        return result;
      }
      case "readArtifact": {
        const artifact = state.artifacts[p.artifactId]; requireValue(artifact, "NOT_FOUND", "Artifact not found.");
        const task = taskAccess(state, actor, artifact.taskId, true);
        const location = path.join(paths.artifacts, artifact.file);
        if (actor.kind === "user") return { ...artifact, path: location };
        requireValue(artifact.size <= 64 * 1024, "ARTIFACT_TOO_LARGE", "Ask the user to open this artifact; inline preview is limited to 64 KiB.");
        return { ...artifact, content: await readFile(location, "utf8") };
      }
      case "attachSession": {
        userOnly(actor);
        let agent;
        if (p.manager) {
          await privateDirectory(paths.manager);
          agent = await register(state, { workspace: paths.manager, name: "Manager" });
        } else {
          agent = state.agents[p.agentId]; requireValue(agent, "NOT_FOUND", "Agent not found.");
          if (p.teamId) requireMember(state, p.teamId, agent.id);
        }
        if (p.runtimeSessionId) {
          const existing = Object.values(state.sessions).find(s => s.runtimeSessionId === p.runtimeSessionId);
          if (existing) {
            requireValue(existing.agentId === agent.id && existing.teamId === p.teamId, "SESSION_SCOPE_CONFLICT", "This conversation belongs to a different team or member.");
            if (p.shared && !existing.shared) {
              requireValue(!Object.values(state.runs).some(r => r.sessionId === existing.id && ["starting", "running"].includes(r.status)), "SESSION_PRIVATE_HOST", "This session is running in a private Worker. Finish it before moving to the shared Runtime.");
              for (const run of Object.values(state.runs)) if (run.sessionId === existing.id && !run.taskId && !run.delegationId && run.status === "unknown") run.status = "failed";
              existing.shared = true;
            }
            return existing;
          }
        }
        const id = randomUUID();
        state.sessions[id] = { id, agentId: agent.id, ...(p.teamId ? { teamId: p.teamId } : {}), runtimeSessionId: p.runtimeSessionId || "", origin: "direct", ...(p.shared ? { shared: true } : {}) };
        return state.sessions[id];
      }
      case "bindSession": {
        const session = ownSession(state, actor, p.sessionId);
        requireValue(!session.runtimeSessionId || session.runtimeSessionId === p.runtimeSessionId, "SESSION_MISMATCH", "Cannot change the runtime identity of an attached session.");
        requireValue(!Object.values(state.sessions).some(s => s.id !== session.id && s.runtimeSessionId === p.runtimeSessionId && (s.teamId !== session.teamId || s.agentId !== session.agentId)), "SESSION_SCOPE_CONFLICT", "This conversation belongs to a different team or agent. Start a new session.");
        session.runtimeSessionId = text(p.runtimeSessionId, "Runtime session"); return session;
      }
      case "beginRun": {
        userOnly(actor); const session = ownSession(state, actor, p.sessionId);
        if (session.teamId) requireMember(state, session.teamId, session.agentId);
        return newRun(state, session.id);
      }
      case "reattachSession": {
        userOnly(actor);
        const session = ownSession(state, actor, p.sessionId);
        requireValue(session.origin === "direct" && session.runtimeSessionId === p.runtimeSessionId, "SESSION_MISMATCH", "Reconnection must match the original direct session.");
        if (session.teamId) requireMember(state, session.teamId, session.agentId);
        for (const run of Object.values(state.runs)) if (run.sessionId === session.id && activeRun(run)) {
          run.status = p.active === true ? "running" : "failed";
          run.lastObservedAt = new Date().toISOString();
        }
        return session;
      }
      case "hostTurnStart": {
        userOnly(actor);
        const session = ownSession(state, actor, p.sessionId);
        requireValue(session.runtimeSessionId === "" || session.runtimeSessionId === p.runtimeSessionId, "SESSION_MISMATCH", "Runtime session does not match its host credential.");
        session.runtimeSessionId = p.runtimeSessionId;
        if (session.teamId) requireMember(state, session.teamId, session.agentId);
        for (const r of Object.values(state.runs)) {
          if (r.sessionId !== session.id && !r.taskId && !r.delegationId && r.status === "unknown" && state.sessions[r.sessionId]?.agentId === session.agentId) r.status = "failed";
        }
        const run = Object.values(state.runs).find(r => r.sessionId === session.id && activeRun(r)) || newRun(state, session.id);
        run.status = "running"; run.needsInput = false; run.lastObservedAt = new Date().toISOString();
        return run;
      }
      case "hostTurnEnd": {
        userOnly(actor);
        const session = ownSession(state, actor, p.sessionId);
        const run = Object.values(state.runs).find(r => r.sessionId === session.id && activeRun(r));
        if (run) {
          run.lastObservedAt = new Date().toISOString();
          if (!run.taskId && !run.delegationId && !p.pending) {
            run.status = p.outcome === "turn_completed" ? "succeeded" : p.outcome === "turn_cancelled" ? "cancelled" : "failed";
            const children = sessionDelegations(state, session.id);
            if (!children.some(awaitingDelegation)) {
              returnDelegations(state, children, text => { (state.deliveries[session.id] ||= { texts: [] }).texts.push(text); });
            }
          }
          run.needsInput = false;
        }
        return { observed: true };
      }
      case "reportRunEvent": {
        userOnly(actor); const run = state.runs[p.runId]; requireValue(run && run.sessionId === p.sessionId, "NOT_FOUND", "Run not found.");
        requireValue(Number.isSafeInteger(p.hostSequence) && p.hostSequence > 0, "INVALID_INPUT", "A host sequence is required.");
        if (p.hostSequence <= run.hostSequence) return run;
        if (!activeRun(run)) return run;
        requireValue(["working", "needs_input", "completed", "failed", "cancelled", "unknown"].includes(p.type), "INVALID_INPUT", "Invalid run event.");
        run.hostSequence = p.hostSequence; run.lastObservedAt = new Date().toISOString();
        run.status = p.type === "completed" ? "succeeded" : ["working", "needs_input"].includes(p.type) ? "running" : p.type;
        run.needsInput = p.type === "needs_input"; return run;
      }
      case "reconcileSession": {
        userOnly(actor); const session = ownSession(state, actor, p.sessionId);
        const settled = ["completed", "failed", "cancelled"].includes(p.outcome) || ((p.connected || p.missing) && !p.active);
        for (const run of Object.values(state.runs)) if (run.sessionId === session.id && activeRun(run)) {
          const prevStatus = run.status, prevNeedsInput = run.needsInput;
          if (p.active) { run.status = "running"; run.needsInput = !!p.needsInput; }
          else if (!run.taskId && !run.delegationId && settled) {
            run.status = p.outcome === "completed" ? "succeeded" : p.outcome === "cancelled" ? "cancelled" : "failed";
            run.needsInput = false;
            const children = sessionDelegations(state, session.id);
            if (!children.some(awaitingDelegation)) {
              returnDelegations(state, children, text => { (state.deliveries[session.id] ||= { texts: [] }).texts.push(text); });
            }
          }
          else if (!p.connected) run.status = "unknown";
          if (run.delegationId) {
            const d = state.delegations[run.delegationId];
            const rootTask = d?.taskId ? state.tasks[d.taskId] : undefined;
            if (p.active) {
              if (d?.status === "failed") { d.status = "running"; delete d.error; }
              if (rootTask?.status === "needs_attention") {
                if (Object.values(state.runs).some(r => r.taskId === rootTask.id && !r.delegationId && activeRun(r))) rootTask.status = "running";
                else { rootTask.status = "blocked"; rootTask.blockedOn = { responder: "children", action: "Continues when its members deliver." }; }
                delete rootTask.error;
              }
            } else if (!live.has(run.id) && settled) {
              run.status = p.outcome === "completed" ? "succeeded" : p.outcome === "cancelled" ? "cancelled" : "failed";
              run.needsInput = false;
              if (d && !["done", "cancelled"].includes(d.status)) {
                d.status = "failed";
                d.error = "Execution finished while management was disconnected.";
                wakeDelegator(state, d);
              }
            }
          } else if (run.taskId) {
            const task = state.tasks[run.taskId];
            if (p.active && task.status === "needs_attention") { task.status = "running"; delete task.error; }
            else if (!live.has(run.id) && settled) {
              run.status = p.outcome === "completed" ? "succeeded" : p.outcome === "cancelled" ? "cancelled" : "failed";
              run.needsInput = false;
              if (task && !["done", "cancelled"].includes(task.status)) {
                if (taskDelegations(state, task.id).some(awaitingDelegation)) {
                  task.status = "blocked"; task.blockedOn = { responder: "children", action: "Continues when its members deliver." }; delete task.report; delete task.error;
                } else if (task.report && p.outcome === "completed") markDelivered(task);
                else if (task.status !== "blocked") { task.status = "needs_attention"; task.error = "Execution finished while management was disconnected. Inspect the session before retrying."; }
              }
            }
          }
          if (run.status !== prevStatus || run.needsInput !== prevNeedsInput) {
            run.lastObservedAt = new Date().toISOString();
          }
        }
        return session;
      }
      case "detachSession": {
        userOnly(actor); const session = ownSession(state, actor, p.sessionId);
        for (const run of Object.values(state.runs)) if (!session.shared && run.sessionId === session.id && activeRun(run)) run.status = "unknown";
        // Released from its team, or left before its first message created a conversation: nothing to keep.
        const unused = session.released || (!session.runtimeSessionId && !Object.values(state.runs).some(r => r.sessionId === session.id));
        if (unused && !Object.values(state.runs).some(r => r.sessionId === session.id && activeRun(r))) { dropSession(state, session.id); pruneAgents(state, [session.agentId]); }
        return { detached: true };
      }
      case "forgetSession": {
        // The Runtime already removed the conversation; its registration and
        // anything that waited to be delivered to it go with it.
        userOnly(actor); const session = ownSession(state, actor, p.sessionId);
        requireValue(!Object.values(state.runs).some(r => r.sessionId === session.id && activeRun(r)), "SESSION_BUSY", "This conversation is running. Stop it or wait for it to finish before deleting it.");
        dropSession(state, session.id);
        delete state.deliveries[session.id];
        return { forgotten: session.id };
      }
      case "resolveRun": {
        userOnly(actor); const run = state.runs[p.runId];
        requireValue(run?.status === "unknown", "INVALID_STATE", "Only unknown runs require reconciliation.");
        requireValue(p.confirmStopped === true, "USER_CONFIRMATION_REQUIRED", "Confirm that the old process has stopped before releasing its workspace.");
        run.status = "failed"; run.needsInput = false; run.lastObservedAt = new Date().toISOString();
        if (!run.taskId && !run.delegationId) {
          const children = sessionDelegations(state, run.sessionId);
          if (!children.some(awaitingDelegation)) {
            returnDelegations(state, children, text => { (state.deliveries[run.sessionId] ||= { texts: [] }).texts.push(text); });
          }
        } else if (run.delegationId) {
          const d = state.delegations[run.delegationId];
          if (d && !["done", "cancelled"].includes(d.status)) {
            d.status = "failed";
            d.error ||= "Execution stopped after unconfirmed state.";
            wakeDelegator(state, d);
          }
        } else if (run.taskId) {
          const task = state.tasks[run.taskId];
          if (task && task.status === "running") {
            task.status = "needs_attention";
            task.error ||= "Execution stopped after unconfirmed state.";
            delete task.dispatch;
          }
        }
        return run;
      }
      case "cancelRun": {
        const run = state.runs[p.runId];
        if (run && !run.taskId && !run.delegationId) {
          userOnly(actor);
          requireValue(activeRun(run), "NOT_RUNNING", "This conversation is not running.");
          run.status = "cancelled"; run.needsInput = false; run.lastObservedAt = new Date().toISOString();
          for (const d of sessionDelegations(state, run.sessionId)) if (!["done", "failed", "cancelled"].includes(d.status)) { d.status = "cancelled"; delete d.dispatch; cancelDelegationTree(state, d.id); }
          releaseSessionWait(run.sessionId);
          const runtimeSessionId = state.sessions[run.sessionId]?.runtimeSessionId;
          return { runId: run.id, cancelling: true, ...(runtimeSessionId ? { runtimeSessionId } : {}) };
        }
        requireValue((run?.taskId || run?.delegationId) && live.has(run.id), "NOT_RUNNING", "Only a live managed task can be cancelled here.");
        if (run.taskId) {
          const task = taskAccess(state, actor, run.taskId);
          if (actor.kind === "manager") return askUser(state, actor, { kind: "cancelRun", teamId: task.teamId, runId: run.id, taskId: task.id, title: "Stop " + task.brief });
          return stopRun(state, author(state, actor), run, task);
        }
        const d = state.delegations[run.delegationId!]; requireValue(d, "NOT_FOUND", "Task not found.");
        teamAccess(state, actor, d.teamId);
        if (actor.kind === "manager") return askUser(state, actor, { kind: "cancelRun", teamId: d.teamId, runId: run.id, title: "Stop " + d.brief });
        d.status = "cancelled"; delete d.dispatch; cancelDelegationTree(state, d.id);
        return { runId: run.id, cancelling: true };
      }
      case "resolveApproval": {
        userOnly(actor);
        const approval = state.approvals[p.approvalId];
        requireValue(approval, "NOT_FOUND", "This request was already handled.");
        delete state.approvals[approval.id];
        if (p.approve !== true) {
          if (approval.taskId && state.tasks[approval.taskId]) note(state, approval.taskId, "user", "Declined: " + approval.title);
          return { declined: true };
        }
        if (approval.kind === "deleteTeam") return state.teams[approval.teamId] && !state.teams[approval.teamId].archive ? deleteTeam(state, approval.teamId) : { expired: true };
        const run = state.runs[approval.runId!];
        if ((!run?.taskId && !run?.delegationId) || !live.has(run.id) || !activeRun(run)) return { expired: true };
        if (run.taskId && state.tasks[run.taskId]) return stopRun(state, "user", run, state.tasks[run.taskId]);
        if (run.delegationId && state.delegations[run.delegationId]) {
          const d = state.delegations[run.delegationId];
          d.status = "cancelled"; delete d.dispatch; cancelDelegationTree(state, d.id);
        }
        return { runId: run.id, cancelling: true };
      }
      case "listModels": {
        requireValue(actor.kind !== "agent", "FORBIDDEN", "Only the user and the Manager choose a member's model.");
        return { models: await folderDefaults("models") };
      }
      case "getMemberModel":
        return folderDefaults("get", { workspace_root: memberWorkspace(state, actor, p.teamId, p.agentId) });
      case "setMemberModel": {
        const workspace = memberWorkspace(state, actor, p.teamId, p.agentId);
        requireValue(Boolean(p.provider) === Boolean(p.model), "INVALID_INPUT", "Give provider and model together.");
        requireValue(p.model || p.reasoningEffort, "INVALID_INPUT", "Give provider and model, a reasoningEffort, or both.");
        const result = prefetched ?? await folderDefaults("set", { workspace_root: workspace, provider_id: p.provider || "", model_id: p.model || "", reasoning_effort: p.reasoningEffort || "" });
        const parts = [p.model ? "model " + p.provider + " / " + p.model : "", p.reasoningEffort ? "effort " + p.reasoningEffort : ""].filter(Boolean);
        noticeFromManager(state, actor, p.teamId, p.agentId, "Manager set " + state.agents[p.agentId].name + "'s " + parts.join(" and "));
        return result;
      }
      case "clearMemberModel": {
        const workspace = memberWorkspace(state, actor, p.teamId, p.agentId);
        const group = MEMBER_MODEL_PARTS[p.part as keyof typeof MEMBER_MODEL_PARTS];
        requireValue(group, "INVALID_INPUT", "part must be model or reasoningEffort.");
        const result = prefetched ?? await folderDefaults("unset", { workspace_root: workspace, group });
        noticeFromManager(state, actor, p.teamId, p.agentId, "Manager cleared " + state.agents[p.agentId].name + "'s " + (group === "model" ? "model" : "effort") + "; the default applies");
        return result;
      }
      case "listFolderDefaults": {
        userOnly(actor);
        requireValue(Array.isArray(p.workspaces) && p.workspaces.every((w: unknown) => typeof w === "string"), "INVALID_INPUT", "workspaces must be a list of folder paths.");
        return (await folderDefaults("resolve", { workspace_roots: p.workspaces })).folders;
      }
      case "dismissNotice": {
        userOnly(actor);
        delete state.notices[p.noticeId];
        return { dismissed: true };
      }
      default: requireValue(false, "UNKNOWN_METHOD", "Unknown management operation: " + method);
    }
  }
  async function request(actor: Principal, method: string, params: Params = {}) {
    requireValue(!stopped, "SERVICE_STOPPING", "Management service is shutting down.");
    requireValue((actor.kind === "agent") === MEMBER_OPERATIONS.has(method), "FORBIDDEN", actor.kind === "agent" ? "Members work through delegate and report." : "delegate and report belong to team members.");
    if (reads.has(method)) return operate(store.state, actor, method, params);
    const requestId = text(params.requestId, "Request ID", 200);
    if (method === "reconcileSession") {
      userOnly(actor);
      const session = ownSession(store.state, actor, params.sessionId);
      const activeRuns = Object.values(store.state.runs).filter(r => r.sessionId === session.id && activeRun(r));
      const unchangedActive = Boolean(params.active) && activeRuns.every(r => {
        if (r.status !== "running" || Boolean(r.needsInput) !== Boolean(params.needsInput)) return false;
        const d = r.delegationId ? store.state.delegations[r.delegationId] : undefined;
        const task = d?.taskId ? store.state.tasks[d.taskId] : r.taskId ? store.state.tasks[r.taskId] : undefined;
        return d?.status !== "failed" && task?.status !== "needs_attention";
      });
      const unchangedUnknown = !params.connected && !params.active && !params.missing && !params.outcome && activeRuns.every(r => r.status === "unknown");
      if (!activeRuns.length || unchangedActive || unchangedUnknown) {
        const wasConnected = connected.has(session.id);
        if (params.connected) connected.add(session.id); else connected.delete(session.id);
        if (wasConnected !== connected.has(session.id)) for (const listener of listeners) listener();
        if (params.connected) void flushDeliveries();
        return session;
      }
    }
    const key = (actor.kind === "user" ? "user" : actor.kind + "/" + actor.sessionId) + "/" + method + "/" + requestId;
    const input = JSON.stringify(params);
    // Host observations restate facts and are safe to repeat, so they keep no receipt.
    const remember = method !== "reconcileSession";
    let prefetched: any;
    if (!store.state.receipts[key]) {
      if (method === "setMemberModel") {
        if (actor.kind !== "user") sessionOf(store.state, actor);
        const workspace = memberWorkspace(store.state, actor, params.teamId, params.agentId);
        requireValue(Boolean(params.provider) === Boolean(params.model), "INVALID_INPUT", "Give provider and model together.");
        requireValue(params.model || params.reasoningEffort, "INVALID_INPUT", "Give provider and model, a reasoningEffort, or both.");
        prefetched = await folderDefaults("set", { workspace_root: workspace, provider_id: params.provider || "", model_id: params.model || "", reasoning_effort: params.reasoningEffort || "" });
      } else if (method === "clearMemberModel") {
        if (actor.kind !== "user") sessionOf(store.state, actor);
        const workspace = memberWorkspace(store.state, actor, params.teamId, params.agentId);
        const group = MEMBER_MODEL_PARTS[params.part as keyof typeof MEMBER_MODEL_PARTS];
        requireValue(group, "INVALID_INPUT", "part must be model or reasoningEffort.");
        prefetched = await folderDefaults("unset", { workspace_root: workspace, group });
      } else if (method === "delegate" && params.task !== undefined && !params.wait && !params.cancel && !params.interrupt) {
        const session = store.state.sessions[(actor as { sessionId: string }).sessionId];
        const d = store.state.delegations[typeof params.task === "string" ? params.task.trim() : ""];
        const rawMsg = params.message === undefined || params.brief === undefined || params.message === params.brief ? (params.message ?? params.brief) : undefined;
        if (session && d && d.status === "running" && session.teamId === d.teamId && store.state.memberships[memberKey(d.teamId, session.agentId)] && !store.state.teams[d.teamId]?.archive && (d.fromAgentId === session.agentId || manages(store.state, d.teamId, session.agentId, d.assigneeAgentId)) && typeof rawMsg === "string" && rawMsg.trim()) {
          const run = Object.values(store.state.runs).find(r => r.delegationId === d.id && activeRun(r));
          const from = "From " + nameOf(store.state, session.agentId) + ": " + text(rawMsg, "Message");
          if (run && live.get(run.id)?.steer) prefetched = await live.get(run.id)!.steer!(from);
        }
      } else if (method === "postTaskNote" && params.answer !== true) {
        const task = store.state.tasks[params.taskId];
        if (task && task.status === "running") {
          const run = Object.values(store.state.runs).find(r => r.taskId === task.id && !r.delegationId && activeRun(r));
          const handle = run ? live.get(run.id) : undefined;
          if (handle?.steer && typeof params.text === "string" && params.text.trim()) {
            if (actor.kind !== "user") sessionOf(store.state, actor);
            taskAccess(store.state, actor, params.taskId);
            const line = nameOf(store.state, author(store.state, actor)) + " noted: " + text(params.text, "Note");
            prefetched = await handle.steer(line);
          }
        }
      }
    }
    const result = await transaction(async state => {
      const receipt = state.receipts[key];
      if (receipt) { requireValue(receipt.input === input, "REQUEST_ID_REUSED", "A request ID cannot be reused for different input."); return receipt.result; }
      const result = await operate(state, actor, method, params, prefetched);
      if (remember && !(result as { [WAIT_PENDING]?: unknown })?.[WAIT_PENDING]) {
        state.receipts[key] = { input, result: structuredClone(result), at: Date.now() };
      }
      return result;
    });
    const waitSpec = (result as { [WAIT_PENDING]?: { sessionId: string; ids: string[]; timeoutMs: number; includeReturned: boolean } })?.[WAIT_PENDING];
    if (waitSpec) {
      void schedule().catch(reportServiceError);
      const outcome = await waitForDelegations(waitSpec.sessionId, waitSpec.ids, waitSpec.timeoutMs);
      const finalResult = await transaction(state => {
        const session = state.sessions[waitSpec.sessionId];
        const canClaim = !session || session.origin !== "managed" || Object.values(state.runs).some(r => r.sessionId === session.id && activeRun(r));
        const res = claimWaitResult(state, waitSpec.ids, outcome, canClaim, waitSpec.includeReturned);
        if (remember) state.receipts[key] = { input, result: structuredClone(res), at: Date.now() };
        return res;
      });
      void schedule().catch(reportServiceError);
      return finalResult;
    }
    const stopping = (result as { cancelling?: boolean; runId?: string })?.cancelling ? (result as { runId?: string }).runId : undefined;
    if ((result as { cancelling?: boolean })?.cancelling) {
      for (const [id, handle] of live) {
        const r = store.state.runs[id];
        if (id === stopping || (r?.taskId && store.state.tasks[r.taskId]?.status === "cancelled") || (r?.delegationId && store.state.delegations[r.delegationId]?.status === "cancelled")) {
          cancelling.add(id);
          void handle.cancel().catch(error => failRun(id, error));
        }
      }
    }
    if (method === "reconcileSession") {
      const wasConnected = connected.has(params.sessionId);
      if (params.connected) connected.add(params.sessionId); else connected.delete(params.sessionId);
      if (wasConnected !== connected.has(params.sessionId)) for (const listener of listeners) listener();
    }
    if (method === "attachSession" || method === "reattachSession") connected.add((result as Session).id);
    if (method === "hostTurnStart" && store.state.sessions[params.sessionId]?.shared) connected.add(params.sessionId);
    if (method === "detachSession" && (!store.state.sessions[params.sessionId]?.shared || !store.state.sessions[params.sessionId]?.runtimeSessionId)) connected.delete(params.sessionId);
    if (["attachSession", "reattachSession", "detachSession"].includes(method)) for (const listener of listeners) listener();
    if (["attachSession", "reattachSession", "reconcileSession", "hostTurnEnd"].includes(method)) void flushDeliveries();
    void schedule().catch(reportServiceError);
    return result;
  }
  async function failRun(runId: string, error: unknown) {
    await transaction(state => {
      const run = state.runs[runId];
      if (!run || !activeRun(run)) return;
      const started = run.status === "running";
      run.status = !started || (error as { code?: string })?.code === "EXECUTION_FAILED" ? "failed" : "unknown"; run.lastObservedAt = new Date().toISOString();
      if (run.delegationId) {
        const d = state.delegations[run.delegationId];
        if (d) {
          d.status = "failed"; d.error = String(error); delete d.dispatch;
          if (run.status === "unknown" && d.taskId && state.tasks[d.taskId]) {
            const task = state.tasks[d.taskId];
            task.status = "needs_attention"; task.error = String(error); delete task.dispatch; delete task.blockedOn;
          } else wakeDelegator(state, d);
        }
      } else if (run.taskId) {
        const task = state.tasks[run.taskId];
        task.status = "needs_attention"; task.error = String(error); delete task.dispatch;
      }
    });
  }
  async function execute(runId: string, input: string, delivery = false) {
    try {
      const state = store.state;
      const startRun = state.runs[runId];
      const work = startRun.delegationId ? state.delegations[startRun.delegationId] : state.tasks[startRun.taskId!];
      const session = state.sessions[startRun.sessionId];
      const agent = state.agents[session.agentId];
      const instructions = memberInstructions(state, session, work);
      const handle = await adapters[agent.adapter].start({ agent, session, task: work, input, ...(delivery ? { delivery: true } : {}), instructions, externalTools: toolConfig({ kind: "agent", sessionId: session.id }) }, event => {
        void transaction(next => {
          const run = next.runs[runId];
          if (!activeRun(run) || event.sequence <= run.hostSequence) return;
          run.status = "running"; run.hostSequence = event.sequence; run.lastObservedAt = new Date().toISOString();
        }).catch(reportServiceError);
      });
      // Observed at once: a run can fail before this execution reaches its await,
      // and an unobserved rejection would end the service process.
      handle.completion.catch(() => {});
      live.set(runId, handle);
      connected.add(session.id);
      await transaction(next => { next.sessions[session.id].runtimeSessionId = handle.runtimeSessionId; next.runs[runId].status = "running"; });
      const current = startRun.delegationId ? store.state.delegations[startRun.delegationId] : store.state.tasks[startRun.taskId!];
      if (stopped || cancelling.has(runId) || current?.status === "cancelled" || (startRun.taskId && store.state.tasks[startRun.taskId]?.status === "cancelled")) await handle.cancel();
      const { content } = await handle.completion;
      await transaction(next => {
        const run = next.runs[runId];
        if (run.delegationId) {
          const d = next.delegations[run.delegationId];
          if (d.taskId && next.tasks[d.taskId]?.status === "cancelled") d.status = "cancelled";
          run.status = d.status === "cancelled" ? "cancelled" : "succeeded";
          run.lastObservedAt = new Date().toISOString(); run.needsInput = false;
          if (d.status !== "queued") delete d.dispatch;
          const children = childDelegations(next, d.id);
          if (d.status === "cancelled") { /* Explicit stop suppresses continuation. */ }
          else if (d.status === "queued" && d.dispatch) { /* Child results arrived before this run ended. */ }
          else if (children.some(awaitingDelegation)) { d.status = "waiting"; delete d.reply; }
          else if (children.some(c => !c.returned)) returnDelegations(next, children, text => resumeWork(d, text));
          else if (content.trim()) { d.status = "done"; d.reply = content.trim(); delete d.error; }
          else { d.status = "failed"; d.error = "Ended without a reply."; }
          wakeDelegator(next, d);
          return;
        }
        const task = next.tasks[run.taskId!];
        run.status = task.status === "cancelled" ? "cancelled" : "succeeded";
        run.lastObservedAt = new Date().toISOString(); run.needsInput = false;
        if (task.status !== "queued") delete task.dispatch;
        const children = taskDelegations(next, task.id);
        if (task.status === "cancelled") { /* Explicit human stop suppresses continuation. */ }
        else if (task.status === "queued" && task.dispatch) { /* A routed answer arrived before this run ended. */ }
        else if (task.status === "blocked") { /* Preserve explicitly routed blockers. */ }
        else if (children.some(awaitingDelegation)) {
          task.status = "blocked"; task.blockedOn = { responder: "children", action: "Continues when its members deliver." }; delete task.report;
        } else if (task.report) markDelivered(task);
        else if (children.some(d => !d.returned)) returnDelegations(next, children, text => resumeWork(task, text));
        // Its final reply travels with the result, as Codex reports a sub-agent's last message.
        else { task.status = "needs_attention"; task.error = "Execution ended without a delivery report. " + (content.trim() ? "Its final reply: " + content.trim() : "It ended without a reply."); }
      });
    } catch (error) { await failRun(runId, error); }
    finally { live.delete(runId); cancelling.delete(runId); const s = store.state.runs[runId]?.sessionId; if (s) releaseSessionWait(s); void schedule().catch(reportServiceError); }
  }
  const hasDispatchableWork = (state: State) =>
    Object.values(state.tasks).some(t => t.status === "queued" && Boolean(t.dispatch)) ||
    Object.values(state.delegations).some(d => d.status === "queued" && Boolean(d.dispatch));

  async function schedule() {
    if (stopped) return;
    if (scheduling) { scheduleRequested = true; return; }
    if (!hasDispatchableWork(store.state)) return;
    scheduling = true;
    try {
      do {
        scheduleRequested = false;
        if (!hasDispatchableWork(store.state)) break;
        const starts = await transaction(async state => {
          if (stopped) return [];
          const starts: { runId: string; input: string; delivery: boolean }[] = [];
          for (const task of Object.values(state.tasks).sort((a, b) => priorityRank(a) - priorityRank(b))) {
            if (task.status !== "queued" || !task.dispatch) continue;
            const team = state.teams[task.teamId];
            const agent = state.agents[task.assigneeAgentId];
            if (!team?.leaderAgentId || !state.memberships[memberKey(task.teamId, task.assigneeAgentId)]) { task.status = "needs_attention"; task.error = "Team leadership or membership changed."; delete task.dispatch; continue; }
            if (workspaceBusy(state, agent.canonicalWorkspace)) continue;
            try { await canonicalDirectory(agent.canonicalWorkspace); }
            catch (error) { task.status = "needs_attention"; task.error = String(error); delete task.dispatch; continue; }
            const previous = Object.values(state.runs).filter(r => r.taskId === task.id && !r.delegationId).map(r => state.sessions[r.sessionId]).filter(Boolean).at(-1);
            const session: Session = previous || { id: randomUUID(), agentId: agent.id, teamId: task.teamId, runtimeSessionId: "", origin: "managed", shared: true };
            session.shared = true;
            state.sessions[session.id] = session;
            const run = newRun(state, session.id, task.id);
            task.status = "running"; delete task.report; delete task.error;
            starts.push({ runId: run.id, input: task.resume || task.brief, delivery: Boolean(task.resume && session.runtimeSessionId) });
            delete task.resume;
          }
          for (const d of Object.values(state.delegations)) {
            if (d.status !== "queued" || !d.dispatch) continue;
            const team = state.teams[d.teamId];
            const agent = state.agents[d.assigneeAgentId];
            if (!team?.leaderAgentId || !state.memberships[memberKey(d.teamId, d.assigneeAgentId)] || !state.memberships[memberKey(d.teamId, d.fromAgentId)]) {
              d.status = "failed"; d.error = "Team leadership or membership changed."; delete d.dispatch; wakeDelegator(state, d); scheduleRequested = true; continue;
            }
            if (workspaceBusy(state, agent.canonicalWorkspace)) continue;
            try { await canonicalDirectory(agent.canonicalWorkspace); }
            catch (error) { d.status = "failed"; d.error = String(error); delete d.dispatch; wakeDelegator(state, d); scheduleRequested = true; continue; }
            const previous = Object.values(state.runs).filter(r => r.delegationId === d.id).map(r => state.sessions[r.sessionId]).filter(Boolean).at(-1);
            const session: Session = previous || { id: randomUUID(), agentId: agent.id, teamId: d.teamId, runtimeSessionId: "", origin: "managed", shared: true, delegationId: d.id };
            session.shared = true; session.delegationId = d.id;
            state.sessions[session.id] = session;
            const run = newRun(state, session.id, d.taskId, d.id);
            d.status = "running"; delete d.reply; delete d.error;
            starts.push({ runId: run.id, input: d.resume || d.brief, delivery: Boolean(d.resume && session.runtimeSessionId) });
            delete d.resume;
          }
          return starts;
        });
        if (!stopped) {
          for (const start of starts) {
            const execution = execute(start.runId, start.input, start.delivery);
            executions.add(execution);
            void execution.finally(() => executions.delete(execution)).catch(() => {});
          }
        }
      } while (scheduleRequested && !stopped);
    } finally {
      scheduling = false;
      if (scheduleRequested && !stopped) void schedule().catch(reportServiceError);
    }
  }
  return {
    request, snapshot: (actor: Principal) => filtered(store.state, actor),
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async recover() { await transaction(state => {
      for (const run of Object.values(state.runs)) if (activeRun(run)) {
        run.status = "unknown";
        if (run.delegationId && state.delegations[run.delegationId]) {
          const d = state.delegations[run.delegationId];
          d.status = "failed"; d.error = "Execution host disconnected. Confirm the old process stopped before retrying."; delete d.dispatch;
        }
        if (run.taskId && state.tasks[run.taskId]) {
          const task = state.tasks[run.taskId];
          task.status = "needs_attention"; task.error = "Execution host disconnected. Confirm the old process stopped before retrying."; delete task.dispatch; delete task.blockedOn;
        }
      }
      for (const d of Object.values(state.delegations)) if (d.dispatch) {
        delete d.dispatch;
        if (d.status === "queued") { d.status = "failed"; d.error = "Service restarted before dispatch."; }
      }
      for (const task of Object.values(state.tasks)) if (task.dispatch || (task.status === "blocked" && task.blockedOn?.responder === "children")) {
        delete task.dispatch;
        if (task.status === "queued" || (task.status === "blocked" && task.blockedOn?.responder === "children")) {
          task.status = "needs_attention"; task.error = "Service restarted before dispatch. Start explicitly to continue."; delete task.blockedOn;
        }
      }
    }); },
    isConnected: (sessionId: string) => connected.has(sessionId),
    folderDefaultsChanged() {
      folderDefaultsVersion += 1;
      for (const listener of listeners) listener();
    },
    setLive(sessions: LiveSession[]) {
      runtimeSessions = new Map(sessions.map(session => [session.id, session]));
      for (const listener of listeners) listener();
      void flushDeliveries();
    },
    releaseWait(runtimeSessionId: string) {
      for (const session of Object.values(store.state.sessions)) {
        if (session.runtimeSessionId === runtimeSessionId) releaseSessionWait(session.id);
      }
    },
    async disconnect(sessionIds: string[]) {
      if (stopped) return;
      sessionIds = sessionIds.filter(id => !store.state.sessions[id]?.shared);
      for (const id of sessionIds) connected.delete(id);
      await transaction(state => { for (const run of Object.values(state.runs)) if (sessionIds.includes(run.sessionId) && activeRun(run)) run.status = "unknown"; });
      for (const listener of listeners) listener();
    },
    async stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      for (const sid of [...waiters.keys()]) releaseSessionWait(sid);
      await serial;
      await transaction(state => {
        for (const runId of live.keys()) {
          const run = state.runs[runId];
          if (run?.delegationId && state.delegations[run.delegationId] && activeRun(run)) state.delegations[run.delegationId].status = "cancelled";
          if (run?.taskId && state.tasks[run.taskId] && activeRun(run)) state.tasks[run.taskId].status = "cancelled";
        }
      });
      await Promise.allSettled([...live.values()].map(h => h.cancel()));
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...executions]),
        new Promise<void>(resolve => { stopTimer = setTimeout(resolve, 5000); stopTimer.unref?.(); }),
      ]).finally(() => clearTimeout(stopTimer));
      await serial;
    },
  };
}
export function validateReport(p: Params): Report {
  return { outcome: text(p.outcome, "Outcome", 200), summary: text(p.summary, "Summary", 4000), evidence: strings(p.evidence, "Evidence"), artifacts: strings(p.artifacts, "Artifacts"), ...(p.nextAction ? { nextAction: text(p.nextAction, "Next action") } : {}) };
}
function reportServiceError(error: unknown) { console.error(`[${new Date().toISOString()}] Agents management state update failed:`, error); }
function strings(value: unknown, label: string): string[] {
  requireValue(Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === "string" && v.length <= 4000), "INVALID_INPUT", label + " must be a list of at most 100 strings.");
  return value;
}
async function copyPreview(sourcePath: string) {
  const source = await canonicalDirectory(sourcePath);
  const files: string[] = []; const excluded: string[] = []; let bytes = 0;
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(source, absolute);
      if (entry.isSymbolicLink() || /^(?:\.git|\.rind|\.env(?:\..*)?|node_modules|\.venv|dist|build|.*\.(?:pem|key|p12|pfx))$/i.test(entry.name)) { excluded.push(relative); continue; }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) { files.push(relative); bytes += (await stat(absolute)).size; }
      requireValue(files.length < 10000 && bytes < 512 * 1024 * 1024, "COPY_TOO_LARGE", "Copy exceeds 10,000 files or 512 MiB. Prepare an independent directory manually.");
    }
  }
  await visit(source);
  files.sort(); excluded.sort();
  const fingerprint = createHash("sha256");
  for (const file of files) { fingerprint.update(file); fingerprint.update(await readFile(path.join(source, file))); }
  return { source, files, excluded, bytes, fingerprint: fingerprint.digest("hex") };
}
