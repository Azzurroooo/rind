import net from "node:net";
import { existsSync } from "node:fs";
import { privateDirectory, resolveRindHome } from "./local-files.js";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile, unlink } from "node:fs/promises";
import { createRuntimeClient } from "./runtime-client.js";
import { sharedRuntimePaths } from "./shared-runtime.js";
import { listenOwned } from "./endpoint.js";
import { runtimeBuildId } from "./build-id.js";
import { createLiveSessions } from "./live-sessions.js";

// Only the detached entry point exits on its own; a test imports this module.
const hostEntry = Boolean(process.argv[1]?.endsWith("shared-server.js"));
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const OBSERVE_EVENTS = new Set([
  "turn_started", "turn_completed", "turn_failed", "turn_cancelled",
  "user_question_requested", "user_question_answered", "background_wait_changed",
  "folder_defaults_changed", "wait_released", "session_discarded", "session_deleted",
]);

function resolveIdleTtlMs(options) {
  const raw = options?.idleTtlMs ?? process.env.RIND_RUNTIME_IDLE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

export async function startSharedServer(options) {
  const rindHome = resolveRindHome(options.rindHome);
  const paths = sharedRuntimePaths(rindHome);
  await privateDirectory(paths.directory);
  let token, recordNonce, initialized, workerPid = null, authOwner, stopping = false, closing;
  const startedAt = new Date().toISOString();
  const build = runtimeBuildId(options);
  const peers = new Set(), auth = new Map(), prompts = new Set();
  const deleting = new Set(), opening = new Map();
  const writeLog = (event, fields = {}) => existsSync(paths.directory)
    ? appendFile(paths.log, `[${new Date().toISOString()}] ${event}${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => ` ${k}=${v}`).join("")}\n`, { mode: 0o600 }).catch(() => {})
    : Promise.resolve();
  const live = createLiveSessions({ onChange(sessions) { for (const peer of peers) if (peer.observe) peer.send({ event: { kind: "runtime", type: "sessions_changed", sessions } }); } });
  const busyCount = () => new Set([
    ...prompts,
    ...live.list().filter(item => item.turn !== "idle" || item.background).map(item => item.id),
  ]).size;
  const idleTtlMs = resolveIdleTtlMs(options);
  let idleSince = Date.now(), idleTimer = null;
  const isIdle = () => peers.size === 0 && busyCount() === 0 && opening.size === 0 && deleting.size === 0 && !authOwner;
  const touchActivity = () => { idleSince = Date.now(); };
  const client = createRuntimeClient({ ...options, rindHome, cwd: paths.directory, cliArgs: [], env: { RIND_SHARED_HOST_PID: String(process.pid) },
    onMessage(event) {
      // Sign-in progress (the URL to open) is for the window signing in.
      if (event?.method === "rind/auth/update") { authOwner?.send({ event }); return; }
      live.event(event);
      const type = event?.event?.type;
      const observeEvent = OBSERVE_EVENTS.has(type) || (type === "tool_result" && event.event.tool_name === "ask_user_question");
      for (const peer of peers) if (peer.sessions.has(event.session_id) || (peer.observe && observeEvent)) peer.send({ event });
      // A first prompt failed before its message saved the conversation: it never existed.
      if (type === "session_discarded") { live.forget(event.session_id); for (const peer of peers) peer.sessions.delete(event.session_id); }
      // A conversation was deleted: every list and live table drops it now.
      if (type === "session_deleted") { live.forget(event.session_id); for (const peer of peers) peer.sessions.delete(event.session_id); }
      if (isIdle()) touchActivity();
    },
    onRequest(prompt) { return new Promise(resolve => { if (!authOwner || authOwner.socket.destroyed) { resolve(""); return; } auth.set(prompt.request_id, { peer: authOwner, resolve }); authOwner.send({ prompt }); }); },
    onStderr: text => process.stderr.write(text),
    // A crashed worker ends every turn it was running; nothing will report their end.
    // The host stops with it: a later client starts a fresh host instead of
    // reaching one that can no longer spawn a worker.
    onExit() {
      live.reset();
      initialized = null;
      if (stopping) return;
      for (const peer of peers) peer.socket.destroy();
      void close("worker_exit");
    },
  });
  // `rind send`: the window that most recently showed the session takes the
  // input as if typed there. Without one, a turn that is still running takes it
  // as a follow-up. Nothing else is started: a new turn needs the tools and
  // scope that only a window (or management, for a task) configures.
  async function deliver(sessionId, input) {
    if (!sessionId || !input.trim()) throw Object.assign(new Error("A session and a non-empty prompt are required."), { code: "INVALID_INPUT" });
    const window = live.newestViewer(sessionId, other => other.acceptsInput && peers.has(other));
    if (window) { window.send({ deliver: { session_id: sessionId, input } }); return { delivered: "window" }; }
    if (live.turn(sessionId) === "idle") throw Object.assign(new Error("No Rind window has session " + sessionId + " open, and it is not running."), { code: "SESSION_NOT_OPEN" });
    await initialize();
    await client.request("rind/session/follow_up", { session_id: sessionId, input });
    return { delivered: "queued" };
  }
  // A request can finish after its window closed; a closed window shows nothing.
  const viewIfOpen = (peer, id, details) => { if (peers.has(peer)) live.view(peer, id, details); };
  const writeRecord = (pid = workerPid) => writeFile(paths.record, JSON.stringify({ pid: process.pid, ...(pid ? { workerPid: pid } : {}), nonce: recordNonce, startedAt }), { mode: 0o600 });
  const initialize = () => initialized ||= (async () => { const child = client.start(); workerPid = child?.pid || null; await writeRecord(workerPid).catch(() => {}); await writeLog("worker started", { pid: process.pid, workerPid }); return client.request("initialize"); })().catch(error => { initialized = undefined; throw error; });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const server = net.createServer(socket => {
    socket.setEncoding("utf8"); let buffer = "";
    const peer = { socket, sessions: new Set(), observe: false, send(message) { if (!socket.destroyed) { if (socket.writableLength > 32 * 1024 * 1024) socket.destroy(); else socket.write(JSON.stringify(message) + "\n"); } } };
    peers.add(peer); touchActivity(); socket.on("error", () => {});
    socket.on("close", () => { peers.delete(peer); live.leave(peer); for (const [id, entry] of auth) if (entry.peer === peer) { entry.resolve(""); auth.delete(id); } if (isIdle()) touchActivity(); });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
      let end; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); void handle(line); }
    });
    async function handle(line) {
      let id, sessionId, holdsSession = false, deletesSession = false;
      try {
        await ready; const message = JSON.parse(line); id = message.id;
        if (message.token !== token) throw new Error("Invalid Runtime credentials.");
        if (message.authReply) { const entry = auth.get(message.authReply); if (entry?.peer === peer) { auth.delete(message.authReply); entry.resolve(message.value); } return; }
        const { method, params = {} } = message;
        if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected a method and params object.");
        if (stopping) throw new Error("Runtime is shutting down.");
        sessionId = String(params.session_id || "");
        if (sessionId && deleting.has(sessionId)) throw Object.assign(new Error("This conversation is being deleted."), { code: "SESSION_BUSY" });
        if (method === "session/delete" && sessionId) {
          if (opening.has(sessionId) || prompts.has(sessionId) || live.turn(sessionId) !== "idle") {
            throw Object.assign(new Error("This conversation is running or being opened. Wait before deleting it."), { code: "SESSION_BUSY" });
          }
          if (live.newestViewer(sessionId)) throw Object.assign(new Error("A Rind window is showing this conversation. Close it before deleting it."), { code: "SESSION_OPEN" });
          deleting.add(sessionId); deletesSession = true;
        } else if (sessionId && ["session/open", "session/switch", "session/create", "session/subscribe", "session/prompt", "rind/session/compact"].includes(method)) {
          opening.set(sessionId, (opening.get(sessionId) || 0) + 1); holdsSession = true;
        }
        // Answered without starting the worker, so a client can decide whether
        // this host is current, and stop it, without spawning Python.
        // Windows count as attached; the management service only observes and
        // follows a replaced host by itself, so it never blocks an update.
        if (method === "runtime/info") {
          const attached = [...peers].filter(other => other !== peer && other.sessions.size > 0).length;
          peer.send({ id, result: { buildId: await build, pid: process.pid, startedAt, busy: busyCount(), attached, observed: [...peers].some(other => other !== peer && other.observe) } });
          return;
        }
        // Answered from the host's own table, without starting the worker.
        if (method === "runtime/sessions") { peer.send({ id, result: { sessions: live.list() } }); return; }
        if (method === "runtime/accept-input") { peer.acceptsInput = true; peer.send({ id, result: { ok: true } }); return; }
        // Open means on screen: a window covered by the Agents page reports it.
        if (method === "runtime/visibility") { if (params.visible === false) live.hide(peer); else live.show(peer, id => !deleting.has(id)); peer.send({ id, result: { ok: true } }); return; }
        if (method === "runtime/send") { peer.send({ id, result: await deliver(String(params.session_id || ""), String(params.input || "")) }); return; }
        if (method === "runtime/shutdown") {
          if (params.if_idle) {
            const attached = [...peers].some(other => other !== peer && !other.observe);
            if (attached || busyCount() > 0 || opening.size > 0 || deleting.size > 0 || authOwner) {
              peer.send({ id, result: { stopped: false, busy: busyCount() } });
              return;
            }
          }
          stopping = true;
          if (initialized) {
            // A worker that already died mid-shutdown is no reason to stay up.
            try { await client.shutdown(); }
            catch (error) { process.stderr.write("runtime shutdown: " + (error?.message || String(error)) + "\n"); }
          }
          peer.send({ id, result: { stopped: true } });
          await close("shutdown");
          return;
        }
        const base = await initialize(); let result;
        if (method === "initialize") result = base;
        else if (method === "runtime/observe") { peer.observe = true; result = { pid: client.child.pid }; }
        else if (method === "shutdown") { result = { detached: true }; peer.sessions.clear(); live.leave(peer); }
        else {
          if (method === "session/prompt" && prompts.has(params.session_id)) throw new Error("This session already has an active request. Use steering or follow-up input.");
          if (method === "session/prompt") { prompts.add(params.session_id); viewIfOpen(peer, params.session_id); }
          if (method === "rind/auth/login") { if (authOwner) throw new Error("Another connection is signing in."); authOwner = peer; }
          if (method === "session/subscribe" || method === "session/prompt") peer.sessions.add(params.session_id);
          if (method === "session/unsubscribe") { peer.sessions.delete(params.session_id); live.leave(peer, params.session_id); result = { ok: true }; }
          let promptFailed = false;
          try { if (method !== "session/unsubscribe") result = await client.request(method, params); }
          catch (error) { promptFailed = true; throw error; }
          finally {
            if (method === "rind/auth/login") authOwner = null;
            if (method === "session/prompt") { prompts.delete(params.session_id); live.settle(params.session_id, promptFailed); }
          }
          // A window before its first message has no session; session/create makes one.
          if (["session/open", "session/new", "session/switch", "session/create"].includes(method) && result.session_id) { peer.sessions.add(result.session_id); viewIfOpen(peer, result.session_id, { workspace: result.workspace_root }); }
        }
        peer.send({ id, result });
      } catch (error) { peer.send({ id, error: { message: error.message, code: error.code } }); }
      finally {
        if (deletesSession) deleting.delete(sessionId);
        if (holdsSession) {
          const count = opening.get(sessionId) - 1;
          if (count) opening.set(sessionId, count); else opening.delete(sessionId);
        }
        if (isIdle()) touchActivity();
      }
    }
  });
  try {
    await listenOwned(server, paths.endpoint);
  } catch (error) {
    if (error?.code === "ENDPOINT_OCCUPIED") throw new Error("Shared Runtime is already running.");
    throw error;
  }
  try {
    try { token = (await readFile(paths.token, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!token) {
      const candidate = randomBytes(32).toString("hex");
      try { await writeFile(paths.token, candidate, { mode: 0o600, flag: "wx" }); token = candidate; }
      catch (error) { if (error.code !== "EEXIST") throw error; token = (await readFile(paths.token, "utf8")).trim(); }
    }
    // Published once this host owns the endpoint: it names the process that
    // answers here, so a host that stops answering can still be ended.
    recordNonce = options.hostNonce || randomUUID();
    await writeRecord();
    await writeLog("host started", { pid: process.pid, rindHome, endpoint: paths.endpoint });
    if (hostEntry || options.idleTtlMs !== undefined) {
      const checkMs = Math.max(50, Math.min(idleTtlMs || 1000, 1000));
      idleTimer = setInterval(async () => {
        if (stopping) return;
        if (!isIdle()) { touchActivity(); return; }
        const raw = await readFile(paths.record, "utf8").catch(() => null);
        let recordOwned = false;
        try { recordOwned = Boolean(raw && JSON.parse(raw).nonce === recordNonce); } catch {}
        if (!recordOwned) { void close("record_removed"); return; }
        if (idleTtlMs > 0 && Date.now() - idleSince >= idleTtlMs) void close("idle_timeout");
      }, checkMs);
      idleTimer.unref?.();
    }
    readyResolve();
  } catch (error) {
    readyReject(error);
    for (const peer of peers) peer.socket.destroy();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  function releaseRecord() {
    return readFile(paths.record, "utf8").then(value => {
      if (JSON.parse(value).nonce !== recordNonce) return; // a later host owns it now
      return unlink(paths.record).catch(() => {});
    }, () => {}).catch(() => {});
  }
  // Keep ownership until the worker stops, so a replacement cannot run a
  // second worker against the same history during cleanup. Every peer is let
  // go; force termination remains the last resort.
  function close(reason = "shutdown") {
    return closing ||= (async () => {
      stopping = true;
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      const forced = setTimeout(() => { for (const peer of peers) peer.socket.destroy(); }, 1000);
      forced.unref?.();
      for (const peer of peers) peer.socket.end();
      try { if (initialized) await client.shutdown(); }
      catch { /* the worker already exited or refused; the host still has to go */ }
      client.forceShutdown();
      if (reason !== "record_removed") await writeLog("host stopped", { pid: process.pid, workerPid, reason });
      const closed = new Promise(resolve => server.close(resolve));
      for (const peer of peers) peer.socket.destroy();
      await closed;
      clearTimeout(forced);
      await releaseRecord();
      if (hostEntry) process.exit(0);
    })();
  }
  return { paths, close };
}

if (hostEntry) {
  startSharedServer({ ...JSON.parse(process.argv[2] || "{}"), hostNonce: process.argv[3]?.replace(/^--rind-host-nonce=/, "") }).then(server => {
    const stop = signal => { void server.close(signal); };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
