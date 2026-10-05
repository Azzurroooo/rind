import net from "node:net";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import type { Principal } from "./model.js";
import { requireValue } from "./model.js";
import { managementPaths, privateDirectory } from "./paths.js";
import { openStore } from "./store.js";
import { createService } from "./service.js";
import { createRindAdapter } from "./adapters/rind.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function startServer(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string }) {
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
    const skills = session ? store.state.agents[session.agentId]?.skillRefs || [] : [];
    return {
      skill_files: principal.kind === "manager" ? [] : skills.filter(ref => path.isAbsolute(ref)),
      command: process.execPath, args: [bridge], env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: token },
      lifecycle: { before: "hostTurnStart", after: "hostTurnEnd", env: { RIND_MANAGEMENT_ENDPOINT: paths.endpoint, RIND_MANAGEMENT_TOKEN: hostToken } },
      name: "agent_management",
      description: "Manage registered teams and tasks. Call snapshot to discover IDs. Actions: getTeam(teamId) returns a concise team briefing; createTeam(name), addMember(teamId,workspace,position?,responsibility?), setLeader(teamId,agentId), updateMember(teamId,agentId,position?,responsibility?), createWorkspace(teamId,name), createWorktree(teamId,name,repository,branch,base?), assignTask(teamId,assigneeAgentId,brief), getTask(taskId), updateTask(taskId,report:{outcome,summary,evidence:[],artifacts:[]}) or updateTask(taskId,status:blocked,blockedOn:{responder,action}), postTaskNote(taskId,text), publishArtifact(taskId,path), readArtifact(artifactId), startTask(taskId), setTaskPriority(taskId,priority:high|normal|low), cancelTask(taskId), cancelRun(runId). Only registered members may run. Share/copy choices require the user interface.",
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
          requireValue(session && (session.origin === "direct" ? service.isConnected(session.id) : Object.values(store.state.runs).some(r => r.sessionId === session.id && ["starting", "running"].includes(r.status))), "SESSION_EXPIRED", "The execution host no longer owns this session.");
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
          unsubscribe = service.onChange(() => send({ event: "snapshot", snapshot: service.snapshot(principal) }));
          result = service.snapshot(principal);
        } else if (message.method === "sessionTools") {
          requireValue(principal.kind === "user", "FORBIDDEN", "Only the host can issue session tools.");
          const session = store.state.sessions[message.params.sessionId];
          requireValue(session && session.origin === "direct", "NOT_FOUND", "Direct session not found.");
          const manager = store.state.agents[session.agentId].canonicalWorkspace === await realManager;
          result = toolConfig({ kind: manager ? "manager" : "agent", sessionId: session.id });
        } else {
          result = await service.request(principal, message.method, message.params);
          if (message.method === "attachSession" || message.method === "reattachSession") attached.push(result.id);
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
  let store: Awaited<ReturnType<typeof openStore>>;
  const realManager = (async () => { await privateDirectory(paths.manager); const { canonicalDirectory } = await import("./paths.js"); return canonicalDirectory(paths.manager); })();
  try {
    if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    try { userToken = (await readFile(paths.token, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!userToken) { userToken = randomBytes(32).toString("hex"); await writeFile(paths.token, userToken, { mode: 0o600, flag: "wx" }); }
    store = await openStore(paths.state);
    service = createService({ store, paths, adapters: { rind: createRindAdapter(options) }, toolConfig });
    await service.recover();
    readyResolve!();
  } catch (error) { readyReject!(error); for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  return {
    paths,
    async close() {
      await service.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
