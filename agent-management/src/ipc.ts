import net from "node:net";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import type { Principal } from "./model.js";
import { requireValue } from "./model.js";
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

export async function startServer(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string; onShutdown?: () => void }) {
  const startedAt = new Date().toISOString();
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
  function executionHost() {
    if (runtime) return Promise.resolve(runtime);
    return runtimeConnecting ||= connectSharedRuntime({ ...options, rindHome: options.home,
      onMessage(message: any) {
        if (!["turn_started", "turn_completed", "turn_failed", "turn_cancelled", "user_question_requested", "task_updated"].includes(message.event?.type) && !(message.event?.type === "tool_result" && message.event.tool_name === "ask_user_question")) return;
        const session = Object.values(store.state.sessions).find(s => s.runtimeSessionId === message.session_id);
        if (session) void reconcile(session);
      },
      onDisconnect() {
        runtime = undefined;
        if (!closing) for (const session of Object.values(store.state.sessions).filter(s => s.shared)) void service.request({ kind: "user" }, "reconcileSession", { requestId: "disconnect-" + randomBytes(12).toString("hex"), sessionId: session.id, connected: false }).catch(() => {});
      },
    }).then(async value => {
      runtime = value; await value.request("runtime/observe");
      await Promise.all(Object.values(store.state.sessions).map(reconcile));
      return value;
    }).finally(() => { runtimeConnecting = undefined; });
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
      name: "agent_management",
      description: "Manage registered teams and tasks. Call snapshot to discover IDs. Actions: getTeam(teamId) returns a concise team briefing; createTeam(name), addMember(teamId,workspace,position?,responsibility?), setLeader(teamId,agentId), setSupervisor(teamId,agentId,reportsToAgentId), updateMember(teamId,agentId,position?,responsibility?), createWorkspace(teamId,name), createWorktree(teamId,name,repository,branch,base?), assignTask(teamId,assigneeAgentId,brief), getTask(taskId), updateTask(taskId,report:{outcome,summary,evidence:[],artifacts:[]}) or updateTask(taskId,status:blocked,blockedOn:{responder,action}), postTaskNote(taskId,text), publishArtifact(taskId,path), readArtifact(artifactId), startTask(taskId), setTaskPriority(taskId,priority:high|normal|low), cancelTask(taskId), cancelRun(runId). Only registered members may run. Share/copy choices require the user interface.",
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
          if (session.shared) await executionHost();
          result = toolConfig({ kind: manager ? "manager" : "agent", sessionId: session.id });
        } else if (message.method === "serviceInfo") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the user can inspect the service.");
          result = { buildId: await managementBuildId(), pid: process.pid, startedAt, ...workload() };
        } else if (message.method === "serviceShutdown") {
          // Leaving Rind never calls this; it is the explicit "stop background services" action.
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the user can stop the service.");
          const load = workload();
          requireValue(message.params.stopAgents === true || load.working === 0, "SERVICE_BUSY", load.working + (load.working === 1 ? " agent is" : " agents are") + " still working. Wait for them, or stop all agents.", load);
          send({ id, result: { stopping: true, ...load } });
          void (async () => {
            if (message.params.stopAgents === true) await stopConversations();
            await close();
            options.onShutdown?.();
          })().catch(reportError);
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
    socket.on("close", () => { sockets.delete(socket); unsubscribe?.(); if (service) void service.disconnect(attached).catch(() => {}); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, () => { server.off("error", reject); resolve(); }); });
  const reportError = (error: unknown) => process.stderr.write("agents management: " + String((error as Error)?.stack || error) + "\n");
  // Work that a restart would interrupt: running or starting runs. Unconfirmed
  // runs are already outside this service's control.
  function workload() {
    const runs = Object.values(store.state.runs).filter(r => r.status === "starting" || r.status === "running");
    return { working: runs.length, tasks: runs.filter(r => r.taskId).length, conversations: runs.filter(r => !r.taskId).length, unconfirmed: Object.values(store.state.runs).filter(r => r.status === "unknown").length };
  }
  // Direct conversations run in the shared Runtime, not here: cancel their
  // turns there, then stop the host itself. Managed tasks stop with the service.
  async function stopConversations() {
    const host = runtime || await executionHost().catch(() => undefined);
    if (!host) return;
    const running = Object.values(store.state.runs).filter(r => activeRun(r) && !r.taskId).map(r => store.state.sessions[r.sessionId]?.runtimeSessionId).filter(Boolean);
    await Promise.allSettled(running.map(sessionId => host.request("session/cancel", { session_id: sessionId })));
    await host.request("runtime/shutdown").catch(() => {});
  }
  let store: Awaited<ReturnType<typeof openStore>>;
  const realManager = (async () => { await privateDirectory(paths.manager); const { canonicalDirectory } = await import("./paths.js"); return canonicalDirectory(paths.manager); })();
  try {
    if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    try { userToken = (await readFile(paths.token, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!userToken) { userToken = randomBytes(32).toString("hex"); await writeFile(paths.token, userToken, { mode: 0o600, flag: "wx" }); }
    store = await openStore(paths.state);
    const rind = createRindAdapter(options);
    service = createService({ store, paths, adapters: { rind: { async start(input, emit) { await executionHost(); return rind.start(input, emit); } } }, toolConfig });
    await service.recover();
    readyResolve!();
    if (Object.values(store.state.sessions).some(s => s.shared && s.runtimeSessionId)) void executionHost().catch(() => {});
  } catch (error) { readyReject!(error); for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  let closed: Promise<void> | undefined;
  function close() {
    return closed ||= (async () => {
      closing = true;
      await service.stop();
      runtime?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
  }
  return { paths, close };
}
