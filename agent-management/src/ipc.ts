import net from "node:net";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, unlink, chmod, link } from "node:fs/promises";
import type { Principal } from "./model.js";
import { ManagementError, requireValue } from "./model.js";
import { managementPaths, privateDirectory } from "./paths.js";
import { openStore } from "./store.js";
import { createService } from "./service.js";
import { createRindAdapter } from "./adapters/rind.js";
import { sessionHistory, independentHistory } from "./history.js";
import { managementBuildId } from "./build.js";
import { activeRun } from "./model.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";

const RUNTIME_START_MS = 30000;
const MANAGEMENT_DESCRIPTION = "Manage registered teams and tasks. Call snapshot to discover IDs. Actions: getTeam(teamId) returns a concise team briefing; listModels(), getMemberModel(teamId,agentId), setMemberModel(teamId,agentId,provider?,model?,reasoningEffort?) and clearMemberModel(teamId,agentId,part:model|reasoningEffort) (user and Manager only; a member's model is its workspace's default and applies from its next task); createTeam(name), addMember(teamId,workspace,position?,responsibility?), removeMember(teamId,agentId), deleteTeam(teamId) (user and Manager only), setLeader(teamId,agentId), setSupervisor(teamId,agentId,reportsToAgentId), updateMember(teamId,agentId,position?,responsibility?), createWorkspace(teamId,name), createWorktree(teamId,name,repository,branch,base?), assignTask(teamId,assigneeAgentId,brief), getTask(taskId), updateTask(taskId,report:{outcome,summary,evidence:[],artifacts:[]}) or updateTask(taskId,status:blocked,blockedOn:{responder,action}), postTaskNote(taskId,text), publishArtifact(taskId,path), readArtifact(artifactId), startTask(taskId), setTaskPriority(taskId,priority:high|normal|low), cancelTask(taskId), cancelRun(runId). Only registered members may run. For the Manager, deleting a team with history or stopping a running task becomes a request the user approves in their Inbox; it leaves snapshot.approvals once the user decides. Share/copy choices require the user interface.";
// The work keeps going; only the caller stops waiting for it.
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ManagementError("RUNTIME_UNAVAILABLE", message)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function startServer(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string; onShutdown?: () => void }) {
  const startedAt = new Date().toISOString();
  // Fingerprint the code this process loaded, before anything can rebuild it.
  const build = managementBuildId();
  const paths = managementPaths(options.home);
  await privateDirectory(paths.state);
  if (process.platform !== "win32") {
    const inUse = await new Promise<boolean>(resolve => { const probe = net.connect(paths.endpoint); probe.once("connect", () => { probe.destroy(); resolve(true); }); probe.once("error", () => resolve(false)); });
    requireValue(!inUse, "ALREADY_RUNNING", "Management service is already running.");
    try { await unlink(paths.endpoint); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let readyResolve: () => void;
  let readyReject: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const sockets = new Set<net.Socket>();
  let service: ReturnType<typeof createService>;
  let userToken = "";
  let runtime: Awaited<ReturnType<typeof connectSharedRuntime>> | undefined;
  let runtimeConnecting: Promise<any> | undefined;
  let closing = false;
  async function reconcile(session: any) {
    if (!runtime || !session.runtimeSessionId || !session.shared) return;
    try {
      const replay = await runtime.request("session/replay", { session_id: session.runtimeSessionId });
      await service.request({ kind: "user" }, "reconcileSession", { requestId: "observe-" + randomBytes(12).toString("hex"), sessionId: session.id, connected: replay.hosted === true,
        active: replay.live_turn?.status === "running" || replay.tasks?.some((t: any) => ["starting", "running", "cancelling"].includes(t.status)), needsInput: !!replay.live_turn?.question,
        outcome: replay.live_turn?.status || replay.turn_state?.status });
    } catch {
      if (!closing) await service.request({ kind: "user" }, "reconcileSession", { requestId: "missing-" + randomBytes(12).toString("hex"), sessionId: session.id, connected: false }).catch(() => {});
    }
  }
  // start: false only reattaches to a running host and never spawns one.
  // start: true may spawn a host; start: false only attaches to a running one.
  // They never share a pending attempt, so a task that needs a host is not
  // handed a probe that is allowed to fail.
  let probing: Promise<any> | undefined;
  function executionHost(start = true): Promise<any> {
    if (runtime) return Promise.resolve(runtime);
    if (!start) return runtimeConnecting || (probing ||= attachHost(false).finally(() => { probing = undefined; }));
    return runtimeConnecting ||= (probing ? probing.catch(() => undefined).then(value => value || attachHost(true)) : attachHost(true)).finally(() => { runtimeConnecting = undefined; });
  }
  function attachHost(start: boolean): Promise<any> {
    return connectSharedRuntime({ ...options, rindHome: options.home, start,
      onMessage(message: any) {
        if (message?.kind === "runtime" && message.type === "sessions_changed") { service.setLive(message.sessions || []); return; }
        if (message.event?.type === "folder_defaults_changed") { service.folderDefaultsChanged(); return; }
        if (!["turn_started", "turn_completed", "turn_failed", "turn_cancelled", "user_question_requested", "task_updated"].includes(message.event?.type) && !(message.event?.type === "tool_result" && message.event.tool_name === "ask_user_question")) return;
        const session = Object.values(store.state.sessions).find(s => s.runtimeSessionId === message.session_id);
        if (session) void reconcile(session);
      },
      onDisconnect() {
        runtime = undefined;
        service.setLive([]);
        if (closing) return;
        for (const session of Object.values(store.state.sessions).filter(s => s.shared)) void service.request({ kind: "user" }, "reconcileSession", { requestId: "disconnect-" + randomBytes(12).toString("hex"), sessionId: session.id, connected: false }).catch(() => {});
        void reattach();
      },
    }).then(async value => {
      if (closing) { value.close(); throw new Error("Agents management is closing."); }
      if (runtime) { value.close(); return runtime; }
      runtime = value; await value.request("runtime/observe");
      // A host from before the live table does not know runtime/sessions.
      service.setLive((await value.request("runtime/sessions").catch(() => ({ sessions: [] }))).sessions || []);
      await Promise.all(Object.values(store.state.sessions).map(reconcile));
      return value;
    });
  }
  // While someone watches the Agents page, attach to a Runtime that windows
  // started on their own, so their conversations appear live. It only ever
  // connects to a running host (start: false); the probe is a failed local
  // connect every few seconds, and stops when nobody is watching.
  let watchers = 0, probe: NodeJS.Timeout | undefined;
  function watchRuntime(added: boolean) {
    watchers = Math.max(0, watchers + (added ? 1 : -1));
    if (watchers && !probe) {
      const attempt = () => { if (!runtime && !closing) void executionHost(false).catch(() => {}); };
      attempt();
      probe = setInterval(attempt, 3000);
      probe.unref?.();
    } else if (!watchers && probe) { clearInterval(probe); probe = undefined; }
  }
  // A window may have replaced an outdated host; follow it to the new one
  // instead of treating every shared session as lost. Never starts a host.
  async function reattach() {
    for (let attempt = 0; attempt < 20 && !closing && !runtime; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (closing || runtime) return;
      try { await executionHost(false); return; } catch {}
    }
  }
  const bridge = fileURLToPath(new URL("./bridge.js", import.meta.url));
  function issue(principal: Principal, host = false) {
    const payload = Buffer.from(JSON.stringify({ principal, host })).toString("base64url");
    return payload + "." + createHmac("sha256", userToken).update(payload).digest("hex");
  }
  function decode(token: unknown): { principal: Principal; host: boolean } | undefined {
    if (typeof token !== "string") return;
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !/^[a-f0-9]{64}$/.test(signature)) return;
    const expected = createHmac("sha256", userToken).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return;
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  }
  // A member's model lives with its folder in the Rind runtime, which also checks it can run.
  async function folderDefaults(method: "get" | "set" | "unset" | "resolve" | "models", params: Record<string, unknown> = {}) {
    const host = await executionHost();
    if (method === "models") return (await host.request("model/list", {})).models;
    return host.request("rind/folder_defaults/" + method, params);
  }
  function toolConfig(principal: Principal) {
    const token = issue(principal);
    const hostToken = issue(principal, true);
    const session = principal.kind === "user" ? undefined : store.state.sessions[principal.sessionId];
    const agent = session ? store.state.agents[session.agentId] : undefined;
    const skills = agent?.skillRefs || [];
    const role = session?.teamId ? store.state.memberships[session.teamId + "/" + session.agentId] : undefined;
    return {
      skill_files: principal.kind === "manager" ? [] : skills.filter(ref => path.isAbsolute(ref)),
      command: process.execPath, args: [bridge], env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: token },
      lifecycle: { before: "hostTurnStart", after: "hostTurnEnd", env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: hostToken } },
      tools: [{ name: "agent_management", description: MANAGEMENT_DESCRIPTION, parameters: { type: "object", properties: { action: { type: "string", description: "Operation name." }, parameters: { type: "object", description: "Operation parameters." } }, required: ["action"] } }],
      ...(principal.kind !== "manager" ? { instructions: [agent?.hint, role?.responsibility,
        session?.teamId ? "Team ID: " + session.teamId + "; Agent ID: " + session.agentId + ". Use snapshot for the organization tree. Delegate only to direct reports; integrate their delivery before reporting to your supervisor. Private conversations stay in their session." : "This conversation has no team authority.",
        skills.length ? "Assigned skills: " + skills.join(", ") : ""].filter(Boolean).join("\n") } : {}),
      ...(principal.kind === "manager" ? { enabled_tools: ["agent_management"], instructions: "You are the user's agents manager. Use agent_management to inspect all teams, assemble teams and assign work to their leaders. Keep delivery concise: progress, blockers needing the user, and links to tasks. You cannot browse members' private files. Sharing/copying workspaces requires the user's explicit choice." } : {}),
    };
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = ""; let unsubscribe: (() => void) | undefined;
    const attached: string[] = [];
    let connectionPrincipal: Principal | undefined;
    function send(value: object) {
      if (!socket.destroyed) {
        if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
        socket.write(JSON.stringify(value) + "\n");
      }
    }
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        void handle(line);
      }
    });
    async function handle(line: string) {
      let id: unknown;
      try {
        await ready;
        const message = JSON.parse(line); id = message.id;
        requireValue(typeof message.method === "string" && message.params && typeof message.params === "object" && !Array.isArray(message.params), "INVALID_REQUEST", "Expected a method and params object.");
        const grant = decode(message.token);
        const principal: Principal | undefined = message.token === userToken ? { kind: "user" } : grant?.principal;
        requireValue(principal, "UNAUTHORIZED", "Invalid management credentials.");
        if (connectionPrincipal) requireValue(JSON.stringify(connectionPrincipal) === JSON.stringify(principal), "UNAUTHORIZED", "Cannot change a connection's identity.");
        connectionPrincipal = principal;
        if (grant) {
          const session = store.state.sessions[grant.principal.kind === "user" ? "" : grant.principal.sessionId];
          requireValue(session && (session.origin === "direct" ? service.isConnected(session.id) : (session.shared && service.isConnected(session.id)) || Object.values(store.state.runs).some(r => r.sessionId === session.id && ["starting", "running"].includes(r.status))), "SESSION_EXPIRED", "The execution host no longer owns this session.");
          requireValue(typeof message.runtimeSessionId === "string" && message.runtimeSessionId, "UNAUTHORIZED", "Runtime session identity is required.");
          requireValue(!grant.host || ["hostTurnStart", "hostTurnEnd"].includes(message.method), "FORBIDDEN", "Host credentials can only publish lifecycle facts.");
          requireValue(!session.runtimeSessionId || session.runtimeSessionId === message.runtimeSessionId, "UNAUTHORIZED", "Credential does not match the attached conversation.");
        }
        let result;
        if (message.method === "hostTurnStart" || message.method === "hostTurnEnd") {
          requireValue(grant?.host && grant.principal.kind !== "user", "FORBIDDEN", "Only the execution host can publish lifecycle facts.");
          result = await service.request({ kind: "user" }, message.method, { ...message.params, sessionId: grant.principal.sessionId, runtimeSessionId: message.runtimeSessionId });
        } else if (message.method === "subscribe") {
          // A connection counts once, however often it resubscribes.
          if (!unsubscribe) watchRuntime(true);
          unsubscribe?.();
          // A burst of host events becomes one snapshot per connection. Responses
          // are written first, so a request is never answered with stale state.
          let pending = false;
          const stop = service.onChange(() => {
            if (pending) return;
            pending = true;
            setImmediate(() => { pending = false; if (!socket.destroyed) send({ event: "snapshot", snapshot: service.snapshot(principal) }); });
          });
          unsubscribe = () => { pending = true; stop(); };
          result = service.snapshot(principal);
        } else if (message.method === "sessionTools") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the host can issue session tools.");
          const session = store.state.sessions[message.params.sessionId];
          requireValue(session, "NOT_FOUND", "Session not found.");
          const manager = store.state.agents[session.agentId].canonicalWorkspace === await realManager;
          // A window waits on this before it reads keys: a Runtime that cannot start says so.
          if (session.shared) await within(executionHost(), RUNTIME_START_MS, "The shared Runtime did not start within " + RUNTIME_START_MS / 1000 + "s. Check `rind agents` › Background › Shared Runtime, then try again.");
          result = toolConfig({ kind: manager ? "manager" : "agent", sessionId: session.id });
        } else if (message.method === "serviceInfo") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the user can inspect the service.");
          // Report the Runtime host only when it is already connected; asking must not start one.
          // An older host does not know runtime/info; report it as legacy rather than absent.
          const host = runtime ? await runtime.request("runtime/info").catch(() => ({ legacy: true })) : null;
          result = { buildId: await build, pid: process.pid, startedAt, ...workload(), runtime: host && { ...host, stale: Boolean(runtime?.stale) } };
        } else if (message.method === "serviceShutdown") {
          // Leaving Rind never calls this; it is the explicit "stop background services" action.
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the user can stop the service.");
          const load = workload();
          // restart: replace only this service (to load an update). The Runtime and
          // every conversation keep running; windows reattach to the new service.
          if (message.params.restart === true) {
            requireValue(load.tasks === 0, "SERVICE_BUSY", load.tasks + (load.tasks === 1 ? " task is" : " tasks are") + " running here. Restart when they finish.", load);
            send({ id, result: { restarting: true, ...load } });
            void close().catch(reportError).finally(() => options.onShutdown?.());
            return;
          }
          requireValue(message.params.stopAgents === true || load.working === 0, "SERVICE_BUSY", load.working + (load.working === 1 ? " agent is" : " agents are") + " still working. Wait for them, or stop all agents.", load);
          send({ id, result: { stopping: true, ...load } });
          void stopEverything().catch(reportError).finally(() => options.onShutdown?.());
          return;
        } else if (message.method === "listSessions") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Private session history is available only to the user.");
          const params = message.params || {};
          const managerPath = params.manager === true ? await realManager : undefined;
          const manager = managerPath ? Object.values(store.state.agents).find(a => a.canonicalWorkspace === managerPath) : undefined;
          if (params.independent === true) {
            const host = await executionHost();
            result = { workspaces: await independentHistory(store.state, await realManager, async query => (await host.request("session/list", { limit: 100, ...query })).sessions) };
          } else if (params.manager === true && !manager) result = { sessions: [] };
          else {
            const host = await executionHost();
            const list = async (workspace: string) => (await host.request("session/list", { workspace_root: workspace, limit: 100 })).sessions;
            result = { sessions: await sessionHistory(store.state, manager ? { agentId: manager.id } : { agentId: params.agentId, teamId: params.teamId }, list) };
          }
        } else {
          result = await service.request(principal, message.method, message.params);
          if (message.method === "attachSession" || message.method === "reattachSession") attached.push(result.id);
          if (message.method === "bindSession") await reconcile(result);
        }
        send({ id, result });
      } catch (error) {
        const failure = error as Error & { code?: string; details?: unknown };
        send({ id, error: { code: failure.code || "MANAGEMENT_ERROR", message: failure.message, details: failure.details } });
      }
    }
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); if (unsubscribe) watchRuntime(false); unsubscribe?.(); if (service && !closing) void service.disconnect(attached).catch(() => {}); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, () => { server.off("error", reject); resolve(); }); });
  const reportError = (error: unknown) => process.stderr.write("agents management: " + String((error as Error)?.stack || error) + "\n");
  // Work that a restart would interrupt: running or starting runs. Unconfirmed
  // runs are already outside this service's control.
  function workload() {
    const runs = Object.values(store.state.runs).filter(r => r.status === "starting" || r.status === "running");
    return { working: runs.length, tasks: runs.filter(r => r.taskId).length, conversations: runs.filter(r => !r.taskId).length, unconfirmed: Object.values(store.state.runs).filter(r => r.status === "unknown").length };
  }
  // The services stop together; stopping one alone would leave the other
  // serving windows that can no longer be managed. Order matters:
  //   1. the scheduler stops, so managed tasks end as cancelled, not unconfirmed;
  //   2. running conversation turns are cancelled in the Runtime;
  //   3. the Runtime host stops (only a host that is already running is contacted);
  //   4. this service closes.
  async function stopEverything() {
    const conversations = Object.values(store.state.runs).filter(r => activeRun(r) && !r.taskId).map(r => store.state.sessions[r.sessionId]?.runtimeSessionId).filter(Boolean);
    closing = true;
    await service.stop();
    const host = runtime || await executionHost(false).catch(() => undefined);
    if (host) {
      await Promise.allSettled(conversations.map(sessionId => host.request("session/cancel", { session_id: sessionId })));
      await host.request("runtime/shutdown").catch(() => {});
    }
    await close();
  }
  let store: Awaited<ReturnType<typeof openStore>>;
  const realManager = (async () => { await privateDirectory(paths.manager); const { canonicalDirectory } = await import("./paths.js"); return canonicalDirectory(paths.manager); })();
  // Awaited by the requests that need it; a failure surfaces there, never as an unhandled rejection.
  realManager.catch(() => {});
  try {
    if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    try { userToken = (await readFile(paths.token, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!userToken) {
      // Published whole: a client starting this service reads the file while it is created.
      userToken = randomBytes(32).toString("hex");
      const draft = paths.token + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeFile(draft, userToken, { mode: 0o600, flag: "wx" });
      try { await link(draft, paths.token); } finally { await unlink(draft).catch(() => {}); }
    }
    store = await openStore(paths.state);
    const rind = createRindAdapter(options);
    service = createService({ store, paths, adapters: { rind: { async start(input, emit) { await executionHost(); return rind.start(input, emit); } } }, toolConfig, folderDefaults });
    await service.recover();
    readyResolve!();
    if (Object.values(store.state.sessions).some(s => s.shared && s.runtimeSessionId)) void executionHost().catch(() => {});
  } catch (error) { readyReject!(error); for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  let closed: Promise<void> | undefined;
  function close() {
    return closed ||= (async () => {
      closing = true;
      if (probe) clearInterval(probe);
      await service.stop();
      // The Manager folder may still be being secured; finish before reporting closed.
      await realManager.catch(() => {});
      // A Runtime still starting comes up after this; wait so that whoever
      // cleans up next (tests, `rind agents stop`) can see and stop it.
      await runtimeConnecting?.catch(() => {});
      runtime?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
  }
  return { paths, close };
}
