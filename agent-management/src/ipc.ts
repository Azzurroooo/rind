import net from "node:net";
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, unlink, link } from "node:fs/promises";
import type { Principal } from "./model.js";
import { ManagementError, requireValue } from "./model.js";
import { managementPaths, privateDirectory } from "./paths.js";
import { openStore } from "./store.js";
import { createService } from "./service.js";
import { createRindAdapter } from "./adapters/rind.js";
import { sessionHistory, independentHistory, independentFolder } from "./history.js";
import { managementBuildId } from "./build.js";
import { activeRun } from "./model.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connectSharedRuntime, stopSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { listenOwned, EndpointOccupiedError } from "../../rind-runtime-client/endpoint.js";
import { managerInstructions, memberInstructions, supervises, toolsFor } from "./tools.js";

const RUNTIME_START_MS = 30000;
// The work keeps going; only the caller stops waiting for it.
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ManagementError("RUNTIME_UNAVAILABLE", message)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function startServer(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string; serviceNonce?: string; onShutdown?: () => void }) {
  const startedAt = new Date().toISOString();
  const recordNonce = options.serviceNonce || randomUUID();
  // Fingerprint the code this process loaded, before anything can rebuild it.
  const build = managementBuildId();
  const paths = managementPaths(options.home);
  await privateDirectory(paths.state);
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
  async function sessionToolsFor(session: any) {
    const agent = store.state.agents[session.agentId];
    if (!agent) return undefined;
    const manager = agent.canonicalWorkspace === await realManager;
    return toolConfig({ kind: manager ? "manager" : "agent", sessionId: session.id });
  }
  const reportError = (error: unknown) => process.stderr.write("[" + new Date().toISOString() + "] agents management: " + String((error as Error)?.stack || error) + "\n");
  const reconciling = new Map<string, Promise<void>>();
  const reconcilePending = new Map<string, any>();
  async function reconcile(session: any) {
    if (!runtime || !session.runtimeSessionId || !session.shared) return;
    if (reconciling.has(session.id)) {
      reconcilePending.set(session.id, session);
      return reconciling.get(session.id);
    }
    const work = (async () => {
      let current = session;
      while (current && !closing && runtime) {
        reconcilePending.delete(current.id);
        try {
          const externalTools = await sessionToolsFor(current);
          const replay = await runtime!.request("session/replay", { session_id: current.runtimeSessionId, end: 0, ...(externalTools ? { external_tools: externalTools } : {}) });
          const active = replay.live_turn?.status === "running" || (replay.background_wait?.count || 0) > 0;
          const rawOutcome = replay.live_turn?.status || replay.turn_state?.status;
          const outcome = !active && (!rawOutcome || rawOutcome === "running") ? "failed" : rawOutcome;
          await service.request({ kind: "user" }, "reconcileSession", { requestId: "observe-" + randomBytes(12).toString("hex"), sessionId: current.id, connected: replay.hosted === true,
            active, needsInput: !!replay.live_turn?.question, outcome });
        } catch (error) {
          const missing = (error as { code?: string })?.code === "SessionNotFound";
          if (!closing && (!runtime || missing)) {
            await service.request({ kind: "user" }, "reconcileSession", { requestId: "missing-" + randomBytes(12).toString("hex"), sessionId: current.id, connected: false, ...(missing ? { missing: true } : {}) }).catch(() => {});
          } else if (!closing) {
            reportError(error);
          }
        }
        current = reconcilePending.get(session.id);
      }
    })().finally(() => {
      reconcilePending.delete(session.id);
      reconciling.delete(session.id);
    });
    reconciling.set(session.id, work);
    return work;
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
    let attachedClient: any;
    return connectSharedRuntime({ ...options, rindHome: options.home, start,
      onMessage(message: any) {
        if (message?.kind === "runtime" && message.type === "sessions_changed") { service.setLive(message.sessions || []); return; }
        if (message.event?.type === "folder_defaults_changed") { service.folderDefaultsChanged(); return; }
        if (message.event?.type === "wait_released" || message.event?.type === "turn_cancelled") { service.releaseWait(message.session_id); if (message.event?.type === "wait_released") return; }
        if (!["turn_started", "turn_completed", "turn_failed", "turn_cancelled", "user_question_requested", "background_wait_changed"].includes(message.event?.type) && !(message.event?.type === "tool_result" && message.event.tool_name === "ask_user_question")) return;
        const session = Object.values(store.state.sessions).find(s => s.runtimeSessionId === message.session_id);
        if (session) void reconcile(session);
      },
      onDisconnect() {
        if (attachedClient && runtime !== attachedClient) return;
        runtime = undefined;
        service.setLive([]);
        if (!closing) void reattach();
      },
    }).then(async value => {
      attachedClient = value;
      if (closing) { value.close(); throw new Error("Agents management is closing."); }
      if (runtime) { value.close(); return runtime; }
      try {
        await value.request("runtime/observe");
      } catch (error) {
        value.close();
        throw error;
      }
      if (closing) { value.close(); throw new Error("Agents management is closing."); }
      if (runtime) { value.close(); return runtime; }
      runtime = value;
      // A host from before the live table does not know runtime/sessions.
      const liveSessions = (await value.request("runtime/sessions").catch(() => ({ sessions: [] }))).sessions || [];
      if (closing || runtime !== value) { value.close(); throw new Error("Runtime disconnected."); }
      service.setLive(liveSessions);
      const liveIds = new Set(liveSessions.map((s: any) => s.id));
      const activeSessionIds = new Set(Object.values(store.state.runs).filter(activeRun).map(r => r.sessionId));
      const targets = Object.values(store.state.sessions).filter(s => s.shared && s.runtimeSessionId && (liveIds.has(s.runtimeSessionId) || activeSessionIds.has(s.id) || store.state.deliveries[s.id]?.texts.length));
      void Promise.all(targets.map(reconcile));
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
      const attempt = () => {
        if (closing) return;
        if (!runtime) { void executionHost(false).catch(() => {}); return; }
        for (const run of Object.values(store.state.runs)) {
          if (run.status === "unknown") {
            const session = store.state.sessions[run.sessionId];
            if (session?.shared && session.runtimeSessionId) void reconcile(session);
          }
        }
      };
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
    if (closing || runtime) return;
    const activeSessionIds = new Set(Object.values(store.state.runs).filter(activeRun).map(r => r.sessionId));
    for (const session of Object.values(store.state.sessions).filter(s => s.shared && (activeSessionIds.has(s.id) || service.isConnected(s.id)))) {
      void service.request({ kind: "user" }, "reconcileSession", { requestId: "disconnect-" + randomBytes(12).toString("hex"), sessionId: session.id, connected: false }).catch(() => {});
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
    const host = await within(executionHost(), RUNTIME_START_MS, "The shared Runtime did not start within " + RUNTIME_START_MS / 1000 + "s.");
    if (method === "models") return (await host.request("model/list", {})).models;
    return host.request("rind/folder_defaults/" + method, params);
  }
  // A session has one configuration, whoever opens it: a task run and a window
  // joining the task's conversation must agree, or the Runtime refuses the second.
  // A task's conversation is told who it is with each prompt; any other, once, here.
  function toolConfig(principal: Principal) {
    const token = issue(principal);
    const hostToken = issue(principal, true);
    const session = principal.kind === "user" ? undefined : store.state.sessions[principal.sessionId];
    const agent = session ? store.state.agents[session.agentId] : undefined;
    const skills = agent?.skillRefs || [];
    const manager = principal.kind === "manager";
    const managed = session?.origin === "managed";
    const task = managed && !session.delegationId;
    const tools = toolsFor(manager ? "manager" : "agent", { supervises: Boolean(session?.teamId && supervises(store.state, session.teamId, session.agentId)), task });
    return {
      skill_files: principal.kind === "manager" ? [] : skills.filter(ref => path.isAbsolute(ref)),
      command: process.execPath, args: [bridge], env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: token },
      lifecycle: { before: "hostTurnStart", after: "hostTurnEnd", env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: hostToken } },
      tools,
      ...(manager ? { instructions: managerInstructions(path.dirname(paths.root)) }
        : managed || !session ? {} : { instructions: memberInstructions(store.state, session) }),
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
        if (socket.writableLength > 32 * 1024 * 1024) { socket.destroy(); return; }
        socket.write(JSON.stringify(value) + "\n");
      }
    }
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
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
          requireValue(session && (session.shared || (session.origin === "direct" ? service.isConnected(session.id) : Object.values(store.state.runs).some(r => r.sessionId === session.id && ["starting", "running"].includes(r.status)))), "SESSION_EXPIRED", "The execution host no longer owns this session.");
          requireValue(typeof message.runtimeSessionId === "string" && message.runtimeSessionId, "UNAUTHORIZED", "Runtime session identity is required.");
          requireValue(!grant.host || ["hostTurnStart", "hostTurnEnd"].includes(message.method), "FORBIDDEN", "Host credentials can only publish lifecycle facts.");
          requireValue(!session.runtimeSessionId || session.runtimeSessionId === message.runtimeSessionId, "UNAUTHORIZED", "Credential does not match the attached conversation.");
        }
        let result;
        if (message.method === "hostTurnStart" || message.method === "hostTurnEnd") {
          requireValue(grant?.host && grant.principal.kind !== "user", "FORBIDDEN", "Only the execution host can publish lifecycle facts.");
          result = await service.request({ kind: "user" }, message.method, { ...message.params, sessionId: grant.principal.sessionId, runtimeSessionId: message.runtimeSessionId });
        } else if (message.method === "subscribe") {
          requireValue(principal.kind !== "agent", "FORBIDDEN", "Members work through delegate and report.");
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
          // A window waits on this before it reads keys: a Runtime that cannot start says so.
          if (session.shared) await within(executionHost(), RUNTIME_START_MS, "The shared Runtime did not start within " + RUNTIME_START_MS / 1000 + "s. Check `rind agents` › Background › Shared Runtime, then try again.");
          result = await sessionToolsFor(session);
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
            const list = (query: Record<string, unknown>) => host.request("session/list", query);
            const workspace = typeof params.workspace === "string" ? params.workspace.trim() : "";
            const excluded = params.excludeSessionIds ?? [];
            requireValue(Array.isArray(excluded) && excluded.every(id => typeof id === "string"), "INVALID_INPUT", "excludeSessionIds must be a list of conversation IDs.");
            result = workspace
              ? { sessions: await independentFolder(store.state, await realManager, workspace, list, excluded) }
              : { workspaces: await independentHistory(store.state, await realManager, list) };
          } else if (params.manager === true && !manager) result = { sessions: [] };
          else {
            const host = await executionHost();
            const list = async (workspace: string) => (await host.request("session/list", { workspace_root: workspace, limit: 100 })).sessions;
            result = { sessions: await sessionHistory(store.state, manager ? { agentId: manager.id } : { agentId: params.agentId, teamId: params.teamId }, list) };
          }
        } else if (message.method === "deleteSession") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Private session history is available only to the user.");
          const runtimeSessionId = typeof message.params.runtimeSessionId === "string" ? message.params.runtimeSessionId.trim() : "";
          requireValue(runtimeSessionId, "INVALID_INPUT", "A conversation is required.");
          const session = Object.values(store.state.sessions).find(s => s.runtimeSessionId === runtimeSessionId);
          const busy = "This conversation is running. Stop it or wait for it to finish before deleting it.";
          requireValue(!session || !Object.values(store.state.runs).some(r => r.sessionId === session.id && activeRun(r)), "SESSION_BUSY", busy);
          const host = await executionHost();
          const live = ((await host.request("runtime/sessions", {})).sessions || []).find((item: any) => item.id === runtimeSessionId);
          requireValue(!live || live.turn === "idle", "SESSION_BUSY", busy);
          requireValue(!(live?.watchers > 0), "SESSION_OPEN", "A Rind window is showing this conversation. Close it before deleting it.");
          await host.request("session/delete", { session_id: runtimeSessionId });
          if (session) await service.request({ kind: "user" }, "forgetSession", { requestId: "delete-" + randomBytes(12).toString("hex"), sessionId: session.id });
          result = { deleted: true, runtimeSessionId };
        } else {
          result = await service.request(principal, message.method, message.params);
          if (message.method === "attachSession" || message.method === "reattachSession") attached.push(result.id);
          if (message.method === "bindSession") await reconcile(result);
          else if (message.method === "cancelRun" && result?.runtimeSessionId) {
            const host = runtime || await executionHost(false).catch(() => undefined);
            if (host) await host.request("session/cancel", { session_id: result.runtimeSessionId }).catch(() => {});
          } else if (message.method === "delegate" && (message.params.new !== undefined || message.params.retire !== undefined) && principal.kind === "agent") {
            const teamId = store.state.sessions[principal.sessionId]?.teamId;
            await Promise.all(Object.values(store.state.sessions).filter(s => s.teamId === teamId && s.shared && s.runtimeSessionId).map(reconcile));
          } else if (["renameTeam", "addMember", "removeMember", "updateMember", "setLeader", "setSupervisor", "createWorkspace", "createWorktree", "copyWorkspace"].includes(message.method)) {
            for (const s of Object.values(store.state.sessions)) if (s.teamId === message.params.teamId && s.shared && s.runtimeSessionId) void reconcile(s);
          }
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
  try {
    await listenOwned(server, paths.endpoint);
  } catch (error) {
    if (error instanceof EndpointOccupiedError) throw new ManagementError("ALREADY_RUNNING", "Management service is already running.");
    throw error;
  }
  // Work that a restart would interrupt: running or starting runs. Unconfirmed
  // runs are already outside this service's control.
  function workload() {
    const runs = Object.values(store.state.runs).filter(r => r.status === "starting" || r.status === "running");
    const managed = (r: { taskId?: string; delegationId?: string }) => Boolean(r.taskId || r.delegationId);
    return { working: runs.length, tasks: runs.filter(managed).length, conversations: runs.filter(r => !managed(r)).length, unconfirmed: Object.values(store.state.runs).filter(r => r.status === "unknown").length };
  }
  // The services stop together; stopping one alone would leave the other
  // serving windows that can no longer be managed. Order matters:
  //   1. the scheduler stops, so managed tasks end as cancelled, not unconfirmed;
  //   2. running conversation turns are cancelled in the Runtime;
  //   3. the Runtime host stops (only a host that is already running is contacted);
  //   4. this service closes.
  async function stopEverything() {
    const conversations = Object.values(store.state.runs).filter(r => activeRun(r) && !r.taskId && !r.delegationId).map(r => store.state.sessions[r.sessionId]?.runtimeSessionId).filter(Boolean);
    closing = true;
    await service.stop();
    const host = runtime || await executionHost(false).catch(() => undefined);
    if (host) {
      await Promise.allSettled(conversations.map(sessionId => host.request("session/cancel", { session_id: sessionId })));
      await host.request("runtime/shutdown").catch(() => {});
    }
    await stopSharedRuntime({ rindHome: options.home }).catch(() => {});
    await close();
  }
  function releaseRecord() {
    return readFile(paths.record, "utf8").then(value => {
      if (JSON.parse(value).nonce !== recordNonce) return;
      return unlink(paths.record).catch(() => {});
    }, () => {}).catch(() => {});
  }
  let store: Awaited<ReturnType<typeof openStore>>;
  const realManager = (async () => { await privateDirectory(paths.manager); const { canonicalDirectory } = await import("./paths.js"); return canonicalDirectory(paths.manager); })();
  // Awaited by the requests that need it; a failure surfaces there, never as an unhandled rejection.
  realManager.catch(() => {});
  try {
    try { userToken = (await readFile(paths.token, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!userToken) {
      // Published whole: a client starting this service reads the file while it is created.
      const candidate = randomBytes(32).toString("hex");
      const draft = paths.token + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeFile(draft, candidate, { mode: 0o600, flag: "wx" });
      try { await link(draft, paths.token); userToken = candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; userToken = (await readFile(paths.token, "utf8")).trim(); }
      finally { await unlink(draft).catch(() => {}); }
    }
    await writeFile(paths.record, JSON.stringify({ pid: process.pid, nonce: recordNonce, startedAt }), { mode: 0o600 });
    store = await openStore(paths.state);
    const rind = createRindAdapter(options);
    const deliver = async (runtimeSessionId: string, text: string) => {
      const session = Object.values(store.state.sessions).find(s => s.runtimeSessionId === runtimeSessionId);
      const externalTools = session ? await sessionToolsFor(session) : undefined;
      await (await executionHost()).request("rind/session/deliver", { session_id: runtimeSessionId, text, ...(externalTools ? { external_tools: externalTools } : {}) });
    };
    service = createService({ store, paths, adapters: { rind: { async start(input, emit) { await executionHost(); return rind.start(input, emit); } } }, toolConfig, folderDefaults, deliver });
    await service.recover();
    if (Object.values(store.state.sessions).some(s => s.shared && s.runtimeSessionId)) {
      await executionHost(false).catch(() => {});
      await Promise.allSettled(reconciling.values());
    }
    readyResolve!();
  } catch (error) { readyReject!(error); for (const socket of sockets) socket.destroy(); server.close(); await releaseRecord(); throw error; }
  let closed: Promise<void> | undefined;
  function close() {
    return closed ||= (async () => {
      closing = true;
      if (probe) clearInterval(probe);
      // The process always lets go of its endpoint, even when stopping the
      // service failed: a service nobody can stop is worse than a loud error.
      try {
        await service.stop();
      } finally {
        // Even failed service cleanup must join an in-flight host connection.
        await realManager.catch(() => {});
        await probing?.catch(() => {});
        await runtimeConnecting?.catch(() => {});
        await Promise.allSettled(reconciling.values());
        runtime?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await releaseRecord();
      }
    })();
  }
  return { paths, close };
}
