import { randomUUID, createHash } from "node:crypto";
import { mkdir, stat, copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { activeRun, memberKey, requireValue, text, type State, type Agent, type Principal, type Session, type Run, type Task, type Report, type Adapter, type AdapterHandle, type Approval, type FolderDefaults } from "./model.js";
import { canonicalDirectory, inside, privateDirectory, type Paths } from "./paths.js";
import type { Store } from "./store.js";
import { previewLegacyTeam } from "./legacy.js";
import { sessionStatus, memberStatus, queuedReason, priorityRank, teamBriefing, projectionIndex, type LiveSession } from "./projection.js";
import { retain } from "./retention.js";

import { supervisor, manages, setSupervisor } from "./organization.js";
import { dissolveTeam, dropSession, expireApprovals, pruneAgents, unbindSessions } from "./teams.js";
import { MEMBER_OPERATIONS, directReports, memberInstructions, supervises } from "./tools.js";
import { publishArtifact } from "./artifacts.js";
import { newWorkspacePath, addWorktree, removeWorktree } from "./workspaces.js";

type Params = Record<string, any>;
const END_TURN = "End your turn now; the results are delivered to you when your delegated work settles.";
// Teams are picked by name in the sidebar and in `rind agents`; two live teams never share one.
const teamNameTaken = (state: State, name: string) => Object.values(state.teams).some(t => !t.archive && t.name.trim().toLowerCase() === name.trim().toLowerCase());
const awaitingDelivery = (task: Task) => ["queued", "running"].includes(task.status) || (task.status === "blocked" && task.blockedOn?.responder === "children");
const reads = new Set(["snapshot", "listTeams", "getTeam", "listAgents", "getTask", "previewCopy", "previewImport", "readArtifact", "listArchive", "listModels", "getMemberModel", "listFolderDefaults"]);
const MEMBER_MODEL_PARTS = { model: "model", reasoningEffort: "reasoning_effort" } as const;
export function createService({ store, paths, adapters, toolConfig, folderDefaults, deliver }: {
  store: Store; paths: Paths; adapters: Record<string, Adapter>;
  toolConfig: (principal: Principal, task?: Task) => object;
  folderDefaults: FolderDefaults;
  // Runs a message as the next turn of a Runtime conversation.
  deliver: (runtimeSessionId: string, text: string) => Promise<void>;
}) {
  let serial: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let scheduling = false;
  let scheduleRequested = false;
  const live = new Map<string, AdapterHandle>();
  const executions = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const connected = new Set<string>();
  // Pushed by the shared Runtime; not persisted, since it only describes now.
  let runtimeSessions = new Map<string, LiveSession>();
  // Bumped when the Runtime reports a changed folder default; pages refetch what they show.
  let folderDefaultsVersion = 0;
  function transaction<T>(work: (state: State) => Promise<T> | T): Promise<T> {
    const result = serial.then(async () => {
      const next = structuredClone(store.state);
      const result = await work(next);
      expireApprovals(next);
      retain(next);
      const previousSeq = store.state.seq;
      await store.commit(next);
      if (store.state.seq !== previousSeq) for (const listener of listeners) listener();
      if (Object.keys(store.state.deliveries).length) void flushDeliveries();
      return result;
    });
    serial = result.catch(() => {});
    return result;
  }
  // A conversation that delegated work gets its results once its Runtime hosts it.
  let flushing = false, flushAgain = false;
  async function flushDeliveries() {
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    try {
      do {
        flushAgain = false;
        for (const [sessionId, { texts }] of Object.entries(store.state.deliveries)) {
          if (stopped) return;
          const session = store.state.sessions[sessionId];
          if (session && !(session.runtimeSessionId && connected.has(sessionId))) continue;
          // Another run owns the folder: the turn would be refused, so the delivery waits for that run to end.
          if (session && Object.values(store.state.runs).some(r => activeRun(r) && r.sessionId !== sessionId && store.state.sessions[r.sessionId]?.agentId === session.agentId)) continue;
          try { if (session) await deliver(session.runtimeSessionId, texts.join("\n\n")); }
          catch (error) {
            // A conversation that is gone will never take it; anything else is retried on the next change.
            if (!["SessionNotFound", "SessionClosed"].includes((error as { code?: string }).code || "")) { reportServiceError(error); continue; }
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
      requireValue(session.agentId === task.assigneeAgentId || manages(state, task.teamId, session.agentId, task.assigneeAgentId) || task.createdBy === session.agentId, "FORBIDDEN", "Only the task owner, its supervisors or its delegator can access this task.");
    }
    return task;
  }
  function coordinate(state: State, actor: Principal, teamId: string, targetId: string, direct = false) {
    teamAccess(state, actor, teamId);
    if (actor.kind !== "agent") return;
    const id = sessionOf(state, actor)!.agentId;
    requireValue(direct ? supervisor(state, teamId, targetId) === id : manages(state, teamId, id, targetId), "FORBIDDEN", "Only this member's supervisor can coordinate its work.");
  }
  function taskControl(state: State, actor: Principal, task: Task) {
    if (actor.kind === "agent" && task.createdBy === sessionOf(state, actor)!.agentId) return;
    coordinate(state, actor, task.teamId, task.assigneeAgentId);
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
  // Whoever delegated the work hears back once all of it has settled: a parent
  // task runs again, a conversation gets a delivery.
  function wakeDelegator(state: State, child: Task) {
    if (child.parentTaskId) wakeParentTask(state, child, state.tasks[child.parentTaskId]);
    else if (child.originSessionId) {
      const sessionId = child.originSessionId;
      const delegated = Object.values(state.tasks).filter(t => t.originSessionId === sessionId);
      if (!delegated.some(awaitingDelivery)) returnResults(state, delegated, text => { (state.deliveries[sessionId] ||= { texts: [] }).texts.push(text); });
    }
  }
  function wakeParentTask(state: State, child: Task, parent?: Task) {
    if (!parent || parent.status !== "blocked") return;
    if (parent.blockedOn?.responder === child.assigneeAgentId) {
      if (child.status === "done" && child.report) returnResults(state, [child], text => resume(parent, text));
      else if (["blocked", "needs_attention", "cancelled"].includes(child.status)) {
        parent.status = "needs_attention"; parent.error = "The named responder needs help. Inspect task " + child.id;
      }
      return;
    }
    if (parent.blockedOn?.responder !== "children") return;
    const children = childrenOf(state, parent.id);
    if (!children.some(awaitingDelivery)) returnResults(state, children, text => resume(parent, text));
  }
  function returnResults(state: State, tasks: Task[], send: (text: string) => void) {
    const fresh = tasks.filter(t => !t.returned && !awaitingDelivery(t));
    if (!fresh.length) return;
    for (const task of fresh) task.returned = true;
    send(resultsText(state, fresh));
  }
  const nameOf = (state: State, id: string) => id === "user" ? "the user" : state.agents[id]?.name || id;
  function resultsText(state: State, tasks: Task[]) {
    return ["Delegated work settled:", ...tasks.map(task => {
      const head = "- " + nameOf(state, task.assigneeAgentId) + " · task " + task.id + " · ";
      if (task.status === "done" && task.report) {
        const files = task.report.artifacts.map(id => state.artifacts[id]).filter(Boolean).map(a => path.join(paths.artifacts, a.file));
        return [head + "delivered: " + task.report.outcome, "  " + task.report.summary,
          task.report.evidence.length ? "  Evidence: " + task.report.evidence.join("; ") : "",
          files.length ? "  Files (read them with read_file): " + files.join(", ") : ""].filter(Boolean).join("\n");
      }
      if (task.status === "blocked" && task.blockedOn) return head + "blocked, needs " + nameOf(state, task.blockedOn.responder) + ": " + task.blockedOn.action;
      return head + task.status.replace("_", " ") + (task.error ? ": " + task.error : "");
    })].join("\n");
  }
  // The task runs again, told why.
  function resume(task: Task, message: string) {
    task.resume = task.resume ? task.resume + "\n\n" + message : message;
    task.status = "queued"; task.dispatch = true; delete task.blockedOn; delete task.error;
  }
  const childrenOf = (state: State, taskId: string) => Object.values(state.tasks).filter(t => t.parentTaskId === taskId);
  // A delegated task belongs to the task its delegator is running, or else to the conversation it came from.
  function newTask(state: State, actor: Principal, teamId: string, assigneeAgentId: string, brief: string, start: boolean) {
    const team = teamAccess(state, actor, teamId);
    requireValue(team.leaderAgentId, "LEADER_REQUIRED", "Choose a team leader before assigning work.");
    requireMember(state, teamId, assigneeAgentId);
    const run = actor.kind === "user" ? undefined : Object.values(state.runs).find(r => activeRun(r) && r.sessionId === actor.sessionId);
    const delegator = run?.taskId ? { parentTaskId: run.taskId } : actor.kind === "user" ? {} : { originSessionId: actor.sessionId };
    const id = randomUUID();
    const task: Task = { id, teamId, assigneeAgentId, createdBy: author(state, actor), brief, status: "queued", ...delegator, ...(start ? { dispatch: true } : {}) };
    state.tasks[id] = task; note(state, id, author(state, actor), "Assigned: " + brief);
    return task;
  }
  function blockTask(state: State, actor: Principal, task: Task, blocked: Params) {
    const responder = text(blocked?.responder, "Blocker responder", 200);
    requireValue(responder === "user" || !!state.memberships[memberKey(task.teamId, responder)], "INVALID_RESPONDER", "Choose the user or a current team member as responder.");
    if (actor.kind === "agent") requireValue(responder === "user" || responder === supervisor(state, task.teamId, task.assigneeAgentId) || supervisor(state, task.teamId, responder) === task.assigneeAgentId, "FORBIDDEN", "Route blockers to the user, your supervisor or a direct report.");
    requireValue(responder !== task.assigneeAgentId, "INVALID_RESPONDER", "A blocker needs someone other than its owner.");
    let ancestor = task.parentTaskId ? state.tasks[task.parentTaskId] : undefined;
    while (ancestor) {
      requireValue(ancestor.createdBy !== "system" || ancestor.assigneeAgentId !== responder, "BLOCKER_CYCLE", "This responder is already waiting in the blocker chain. Route the unresolved decision to the user.");
      ancestor = ancestor.parentTaskId ? state.tasks[ancestor.parentTaskId] : undefined;
    }
    task.blockedOn = { responder, action: text(blocked?.action, "Unblocking action") };
    task.status = "blocked";
    note(state, task.id, author(state, actor), "Needs " + responder + ": " + task.blockedOn.action);
    if (responder !== "user" && !manages(state, task.teamId, responder, task.assigneeAgentId) && !childrenOf(state, task.id).some(t => t.assigneeAgentId === responder && !["done", "cancelled"].includes(t.status))) {
      const id = randomUUID();
      state.tasks[id] = { id, teamId: task.teamId, assigneeAgentId: responder, createdBy: "system", brief: "Resolve the blocker on task " + task.id + " (" + task.brief + "): " + task.blockedOn.action + ". Report your answer; the blocked task resumes with it.", status: "queued", parentTaskId: task.id, dispatch: true };
    }
  }
  async function report(state: State, actor: Principal, p: Params) {
    const run = Object.values(state.runs).find(r => activeRun(r) && r.sessionId === (actor as { sessionId: string }).sessionId && r.taskId);
    requireValue(run, "NO_TASK", "This conversation is not working on a task; nothing to report.");
    const task = state.tasks[run.taskId!];
    requireValue(task.status === "running", "TASK_NOT_RUNNING", "Report from an active task.");
    if (p.blocked !== undefined) { blockTask(state, actor, task, p.blocked); return { taskId: task.id, status: "blocked", next: "End your turn." }; }
    requireValue(!childrenOf(state, task.id).some(awaitingDelivery), "WORK_OUTSTANDING", "Your delegated work is not in yet. " + END_TURN + " Then report.");
    const delivery = validateReport({ outcome: p.outcome, summary: p.summary, evidence: p.evidence ?? [], artifacts: [] });
    const recipient = task.parentTaskId ? state.tasks[task.parentTaskId].assigneeAgentId : task.createdBy;
    for (const file of p.artifacts === undefined ? [] : strings(p.artifacts, "Artifacts")) {
      const artifact = await publishArtifact(paths.artifacts, { workspace: state.agents[task.assigneeAgentId].canonicalWorkspace }, { teamId: task.teamId, recipient, taskId: task.id }, file);
      state.artifacts[artifact.id] = artifact; delivery.artifacts.push(artifact.id);
    }
    task.report = delivery;
    note(state, task.id, author(state, actor), "Delivery submitted; awaiting confirmed execution completion.");
    return { taskId: task.id, delivered: true, next: "End your turn; your delivery goes to " + nameOf(state, recipient) + "." };
  }
  async function delegate(state: State, actor: Principal, p: Params) {
    const session = sessionOf(state, actor)!;
    const teamId = session.teamId, me = session.agentId;
    requireValue(teamId && state.memberships[memberKey(teamId, me)], "FORBIDDEN", "This conversation has no team.");
    const forms = ["to", "new", "task", "retire"].filter(key => p[key] !== undefined);
    requireValue(forms.length === 1, "INVALID_INPUT", "Use exactly one form: {to, brief}, {new, brief}, {task, message}, {task, cancel: true} or {retire}.");
    if (p.task !== undefined) return followUp(state, actor, taskAccess(state, actor, text(p.task, "Task")), p);
    if (p.retire !== undefined) return retire(state, teamId, me, text(p.retire, "retire", 200));
    const brief = text(p.brief, "Brief");
    let to: string;
    if (p.new !== undefined) to = (await addReport(state, actor, teamId, me, p.new)).id;
    else {
      to = text(p.to, "to", 200);
      requireValue(state.memberships[memberKey(teamId, to)] && supervisor(state, teamId, to) === me, "NOT_DIRECT_REPORT", "Delegate only to your direct reports: " + JSON.stringify(directReports(state, teamId, me)));
    }
    const task = newTask(state, actor, teamId, to, brief, true);
    return { taskId: task.id, assignee: nameOf(state, to), ...(p.new !== undefined ? { agentId: to, workspace: state.agents[to].canonicalWorkspace } : {}), next: END_TURN };
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
      await inheritModel(own, target);
    }
    const agent = await register(state, { workspace: target, name: spec.name });
    agent.addedBy = me;
    if (worktreeOf) agent.worktreeOf = worktreeOf;
    await addMember(state, actor, { teamId, agentId: agent.id, ...(spec.responsibility ? { responsibility: spec.responsibility } : {}) });
    return agent;
  }
  // Only what was chosen for the creator's folder is copied; settings.json stays the default for both.
  async function inheritModel(from: string, to: string) {
    const resolved = (await folderDefaults("resolve", { workspace_roots: [from] })).folders[from];
    const model = resolved && resolved.model_source !== "settings", effort = resolved && resolved.effort_source !== "settings";
    if (model || effort) await folderDefaults("set", { workspace_root: to, provider_id: model ? resolved.provider : "", model_id: model ? resolved.model : "", reasoning_effort: effort ? resolved.reasoning_effort : "" });
  }
  async function retire(state: State, teamId: string, me: string, agentId: string) {
    const agent = state.agents[agentId];
    requireValue(agent?.addedBy === me && state.memberships[memberKey(teamId, agentId)], "FORBIDDEN", "Retire only a direct report you added.");
    requireValue(!Object.values(state.tasks).some(t => t.teamId === teamId && t.assigneeAgentId === agentId && !["done", "cancelled"].includes(t.status)), "MEMBER_BUSY", "This member still has open work. Cancel it or let it finish first.");
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
    const released = unbindSessions(state, s => s.teamId === teamId && s.agentId === agentId, openInWindow);
    pruneAgents(state, new Set([agentId, ...released]));
  }
  function followUp(state: State, actor: Principal, task: Task, p: Params) {
    taskControl(state, actor, task);
    const by = author(state, actor);
    if (p.cancel === true) {
      // Cancelled by its delegator: nothing to report back.
      task.returned = true;
      const run = Object.values(state.runs).find(r => r.taskId === task.id && activeRun(r));
      if (run && live.has(run.id)) return stopRun(state, by, run, task);
      requireValue(!["done", "cancelled"].includes(task.status), "TASK_FINISHED", "This task has already finished.");
      task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
      note(state, task.id, by, "Cancelled task."); wakeDelegator(state, task);
      return { taskId: task.id, status: "cancelled" };
    }
    requireValue(["done", "blocked", "needs_attention"].includes(task.status), "TASK_IN_PROGRESS", "This task is still in progress; its result is delivered to you first.");
    const message = text(p.message, "Message");
    note(state, task.id, by, message);
    delete task.report; delete task.deliveredAt; task.returned = false;
    resume(task, "From " + nameOf(state, by) + ": " + message);
    return { taskId: task.id, status: "queued", next: END_TURN };
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
    task.status = "cancelled"; delete task.dispatch;
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
  function newRun(state: State, sessionId: string, taskId?: string): Run {
    const session = state.sessions[sessionId];
    const agent = state.agents[session.agentId];
    requireValue(!workspaceBusy(state, agent.canonicalWorkspace), "WORKSPACE_BUSY", "Another run owns this workspace. Wait for it to finish or resolve its unknown status.");
    const now = new Date().toISOString();
    const run = { id: randomUUID(), sessionId, ...(taskId ? { taskId } : {}), status: "starting" as const, startedAt: now, lastObservedAt: now, hostSequence: 0 };
    state.runs[run.id] = run;
    return run;
  }
  // What the user and the Manager see; members never read the organization.
  function filtered(state: State, actor: Principal) {
    const teams = Object.values(state.teams).filter(t => !t.archive);
    const teamIds = new Set(teams.map(t => t.id));
    const tasks = Object.values(state.tasks).filter(t => teamIds.has(t.teamId));
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
      runs: Object.values(state.runs),
      notes: Object.values(state.notes).filter(n => taskIds.has(n.taskId)),
      artifacts: Object.values(state.artifacts).filter(a => taskIds.has(a.taskId)),
    };
  }
  async function operate(state: State, actor: Principal, method: string, p: Params): Promise<any> {
    if (actor.kind !== "user") sessionOf(state, actor);
    switch (method) {
      case "snapshot": return filtered(state, actor);
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
        return { teams: teams.map(team => ({ ...team, tasks: Object.values(state.tasks).filter(t => t.teamId === team.id) })) };
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
      case "delegate": return delegate(state, actor, p);
      case "report": return report(state, actor, p);
      case "startTask": {
        const task = taskAccess(state, actor, p.taskId); taskControl(state, actor, task);
        requireMember(state, task.teamId, task.assigneeAgentId);
        requireValue(["queued", "blocked", "needs_attention"].includes(task.status), "TASK_BUSY", "Task is not ready to start.");
        requireValue(!Object.values(state.runs).some(r => r.taskId === task.id && activeRun(r)), "RUN_UNCONFIRMED", "Resolve the previous run before retrying.");
        if (Object.values(state.runs).some(r => r.taskId === task.id)) resume(task, "Continue this task from where it stopped.");
        else { task.status = "queued"; task.dispatch = true; delete task.blockedOn; delete task.error; }
        note(state, task.id, author(state, actor), "Requested task start."); return task;
      }
      case "setTaskPriority": {
        const task = taskAccess(state, actor, p.taskId); taskControl(state, actor, task);
        requireValue(task.status === "queued", "TASK_NOT_QUEUED", "Only queued tasks can change priority.");
        requireValue(["high", "normal", "low"].includes(p.priority), "INVALID_INPUT", "Priority must be high, normal or low.");
        if (p.priority === "normal") delete task.priority; else task.priority = p.priority;
        note(state, task.id, author(state, actor), "Queue priority: " + p.priority); return task;
      }
      case "cancelTask": {
        const task = taskAccess(state, actor, p.taskId); taskControl(state, actor, task);
        requireValue(!Object.values(state.runs).some(r => r.taskId === task.id && activeRun(r)), "RUN_ACTIVE", "Stop or resolve the active run before cancelling this task.");
        requireValue(!["done", "cancelled"].includes(task.status), "TASK_FINISHED", "This task has already finished.");
        task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
        note(state, task.id, author(state, actor), "Cancelled task."); wakeDelegator(state, task); return task;
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
        if (p.answer === true) {
          requireValue(task.status === "blocked" && task.blockedOn?.responder === author(state, actor), "FORBIDDEN", "Only the named responder can resolve this blocker.");
          resume(task, nameOf(state, author(state, actor)) + " answered your blocker: " + result.text);
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
              requireValue(!Object.values(state.runs).some(r => r.sessionId === existing.id && activeRun(r)), "SESSION_PRIVATE_HOST", "This session is running in a private Worker. Finish it before moving to the shared Runtime.");
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
          if (!run.taskId && !p.pending) run.status = p.outcome === "turn_completed" ? "succeeded" : p.outcome === "turn_cancelled" ? "cancelled" : "failed";
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
        for (const run of Object.values(state.runs)) if (run.sessionId === session.id && activeRun(run)) {
          if (p.active) { run.status = "running"; run.needsInput = !!p.needsInput; }
          else if (!p.connected) run.status = "unknown";
          else if (!run.taskId && ["completed", "failed", "cancelled"].includes(p.outcome)) run.status = p.outcome === "completed" ? "succeeded" : p.outcome;
          if (run.taskId && !live.has(run.id)) {
            const task = state.tasks[run.taskId];
            if (p.active && task.status === "needs_attention") { task.status = "running"; delete task.error; }
            else if (p.connected && !p.active && ["completed", "failed", "cancelled"].includes(p.outcome)) {
              run.status = p.outcome === "completed" ? "succeeded" : p.outcome;
              if (task.report && p.outcome === "completed") markDelivered(task);
              else if (task.status !== "blocked") { task.status = "needs_attention"; task.error = "Execution finished while management was disconnected. Inspect the session before retrying."; }
              wakeDelegator(state, task);
            }
          }
          run.lastObservedAt = new Date().toISOString();
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
      case "resolveRun": {
        userOnly(actor); const run = state.runs[p.runId];
        requireValue(run?.status === "unknown", "INVALID_STATE", "Only unknown runs require reconciliation.");
        requireValue(p.confirmStopped === true, "USER_CONFIRMATION_REQUIRED", "Confirm that the old process has stopped before releasing its workspace.");
        run.status = "failed"; return run;
      }
      case "cancelRun": {
        const run = state.runs[p.runId]; requireValue(run?.taskId && live.has(run.id), "NOT_RUNNING", "Only a live managed task can be cancelled here.");
        const task = taskAccess(state, actor, run.taskId); taskControl(state, actor, task);
        if (actor.kind === "manager") return askUser(state, actor, { kind: "cancelRun", teamId: task.teamId, runId: run.id, taskId: task.id, title: "Stop " + task.brief });
        return stopRun(state, author(state, actor), run, task);
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
        if (!run?.taskId || !live.has(run.id) || !activeRun(run)) return { expired: true };
        return stopRun(state, "user", run, state.tasks[run.taskId]);
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
        const result = await folderDefaults("set", { workspace_root: workspace, provider_id: p.provider || "", model_id: p.model || "", reasoning_effort: p.reasoningEffort || "" });
        const parts = [p.model ? "model " + p.provider + " / " + p.model : "", p.reasoningEffort ? "effort " + p.reasoningEffort : ""].filter(Boolean);
        noticeFromManager(state, actor, p.teamId, p.agentId, "Manager set " + state.agents[p.agentId].name + "'s " + parts.join(" and "));
        return result;
      }
      case "clearMemberModel": {
        const workspace = memberWorkspace(state, actor, p.teamId, p.agentId);
        const group = MEMBER_MODEL_PARTS[p.part as keyof typeof MEMBER_MODEL_PARTS];
        requireValue(group, "INVALID_INPUT", "part must be model or reasoningEffort.");
        const result = await folderDefaults("unset", { workspace_root: workspace, group });
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
    const key = (actor.kind === "user" ? "user" : actor.kind + "/" + actor.sessionId) + "/" + method + "/" + requestId;
    const input = JSON.stringify(params);
    // Host observations restate facts and are safe to repeat, so they keep no receipt.
    const remember = method !== "reconcileSession";
    const result = await transaction(async state => {
      const receipt = state.receipts[key];
      if (receipt) { requireValue(receipt.input === input, "REQUEST_ID_REUSED", "A request ID cannot be reused for different input."); return receipt.result; }
      const result = await operate(state, actor, method, params);
      if (remember) state.receipts[key] = { input, result: structuredClone(result), at: Date.now() };
      return result;
    });
    const stopping = (result as { cancelling?: boolean; runId?: string })?.cancelling ? (result as { runId: string }).runId : undefined;
    if (stopping) void live.get(stopping)?.cancel().catch(error => failRun(stopping, error));
    if (method === "reconcileSession") { if (params.connected) connected.add(params.sessionId); else connected.delete(params.sessionId); for (const listener of listeners) listener(); }
    if (method === "attachSession" || method === "reattachSession") connected.add((result as Session).id);
    if (method === "detachSession" && (!store.state.sessions[params.sessionId]?.shared || !store.state.sessions[params.sessionId]?.runtimeSessionId)) connected.delete(params.sessionId);
    if (["attachSession", "reattachSession", "detachSession"].includes(method)) for (const listener of listeners) listener();
    if (["attachSession", "reattachSession", "reconcileSession"].includes(method)) void flushDeliveries();
    void schedule().catch(reportServiceError);
    return result;
  }
  async function failRun(runId: string, error: unknown) {
    await transaction(state => {
      const run = state.runs[runId];
      if (!run) return;
      run.status = (error as { code?: string })?.code === "EXECUTION_FAILED" ? "failed" : "unknown"; run.lastObservedAt = new Date().toISOString();
      if (run.taskId) { const task = state.tasks[run.taskId]; task.status = "needs_attention"; task.error = String(error); delete task.dispatch; wakeDelegator(state, task); }
    });
  }
  async function execute(taskId: string, runId: string, input: string) {
    try {
      const state = store.state;
      const task = state.tasks[taskId];
      const session = state.sessions[state.runs[runId].sessionId];
      const agent = state.agents[session.agentId];
      const instructions = memberInstructions(state, session, task);
      const handle = await adapters[agent.adapter].start({ agent, session, task, input, instructions, externalTools: toolConfig({ kind: "agent", sessionId: session.id }, task) }, event => {
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
      if (stopped || store.state.tasks[taskId].status === "cancelled") await handle.cancel();
      await handle.completion;
      await transaction(next => {
        const run = next.runs[runId]; const task = next.tasks[taskId];
        run.status = task.status === "cancelled" ? "cancelled" : "succeeded";
        run.lastObservedAt = new Date().toISOString(); run.needsInput = false;
        if (task.status !== "queued") delete task.dispatch;
        const children = childrenOf(next, task.id);
        if (task.status === "cancelled") { /* Explicit human stop suppresses continuation. */ }
        else if (task.status === "queued" && task.dispatch) { /* A routed answer arrived before this run ended. */ }
        else if (task.status === "blocked") { /* Preserve explicitly routed blockers. */ }
        else if (children.some(awaitingDelivery)) {
          task.status = "blocked"; task.blockedOn = { responder: "children", action: "Continues when its members deliver." }; delete task.report;
        } else if (task.report) markDelivered(task);
        else if (children.some(t => !t.returned)) returnResults(next, children, text => resume(task, text));
        else { task.status = "needs_attention"; task.error = "Execution ended without a delivery report. Review the session and retry when ready."; }
        wakeDelegator(next, task);
      });
    } catch (error) { await failRun(runId, error); }
    finally { live.delete(runId); void schedule().catch(reportServiceError); }
  }
  async function schedule() {
    if (stopped) return;
    if (scheduling) { scheduleRequested = true; return; }
    scheduling = true;
    try {
      do {
        scheduleRequested = false;
        const starts = await transaction(async state => {
          if (stopped) return [];
          const starts: { taskId: string; runId: string; input: string }[] = [];
          for (const task of Object.values(state.tasks).sort((a, b) => priorityRank(a) - priorityRank(b))) {
            if (task.status !== "queued" || !task.dispatch) continue;
            const team = state.teams[task.teamId];
            const agent = state.agents[task.assigneeAgentId];
            if (!team?.leaderAgentId || !state.memberships[memberKey(task.teamId, task.assigneeAgentId)] || (!["user", "manager", "system"].includes(task.createdBy) && !state.memberships[memberKey(task.teamId, task.createdBy)])) { task.status = "needs_attention"; task.error = "Team leadership or membership changed."; delete task.dispatch; continue; }
            if (workspaceBusy(state, agent.canonicalWorkspace)) continue;
            try { await canonicalDirectory(agent.canonicalWorkspace); }
            catch (error) { task.status = "needs_attention"; task.error = String(error); delete task.dispatch; continue; }
            const previous = Object.values(state.runs).filter(r => r.taskId === task.id).map(r => state.sessions[r.sessionId]).filter(Boolean).at(-1);
            const session: Session = previous || { id: randomUUID(), agentId: agent.id, teamId: task.teamId, runtimeSessionId: "", origin: "managed", shared: true };
            session.shared = true;
            state.sessions[session.id] = session;
            const run = newRun(state, session.id, task.id);
            task.status = "running"; delete task.report; delete task.error;
            starts.push({ taskId: task.id, runId: run.id, input: task.resume || task.brief });
            delete task.resume;
          }
          return starts;
        });
        if (!stopped) {
          for (const start of starts) {
            const execution = execute(start.taskId, start.runId, start.input);
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
        if (run.taskId) { const task = state.tasks[run.taskId]; task.status = "needs_attention"; task.error = "Execution host disconnected. Confirm the old process stopped before retrying."; delete task.dispatch; }
      }
      for (const task of Object.values(state.tasks)) if (task.dispatch) { delete task.dispatch; if (task.status === "queued") { task.status = "needs_attention"; task.error = "Service restarted before dispatch. Start explicitly to continue."; } }
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
    async disconnect(sessionIds: string[]) {
      if (stopped) return;
      sessionIds = sessionIds.filter(id => !store.state.sessions[id]?.shared);
      for (const id of sessionIds) connected.delete(id);
      await transaction(state => { for (const run of Object.values(state.runs)) if (sessionIds.includes(run.sessionId) && activeRun(run)) run.status = "unknown"; });
      for (const listener of listeners) listener();
    },
    async stop() {
      stopped = true;
      await serial;
      await transaction(state => {
        for (const runId of live.keys()) {
          const run = state.runs[runId];
          if (run?.taskId && activeRun(run)) state.tasks[run.taskId].status = "cancelled";
        }
      });
      await Promise.allSettled([...live.values()].map(h => h.cancel()));
      await Promise.allSettled([...executions]);
      await serial;
    },
  };
}
export function validateReport(p: Params): Report {
  return { outcome: text(p.outcome, "Outcome", 200), summary: text(p.summary, "Summary", 4000), evidence: strings(p.evidence, "Evidence"), artifacts: strings(p.artifacts, "Artifacts"), ...(p.nextAction ? { nextAction: text(p.nextAction, "Next action") } : {}) };
}
function reportServiceError(error: unknown) { console.error("Agents management state update failed:", error); }
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
