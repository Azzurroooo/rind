import net from "node:net";
import { existsSync } from "node:fs";
import { privateDirectory, recordedNonce, resolveRindHome } from "./local-files.js";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile, unlink, link } from "node:fs/promises";
import { createRuntimeClient } from "./runtime-client.js";
import { sharedRuntimePaths } from "./shared-runtime.js";
import { listenOwned } from "./endpoint.js";
import { runtimeBuildId } from "./build-id.js";
import { createLiveSessions } from "./live-sessions.js";
import { createRemoteHost } from "./remote/host.js";
import { registerSharedWorkspace, samePath } from "./remote/workspaces.js";

// Only the detached entry point exits on its own; a test imports this module.
const hostEntry = Boolean(process.argv[1]?.endsWith("shared-server.js"));
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
// The detached host's stderr is the Runtime log: every line it carries gets a time.
const writeStderr = text => {
  const at = `[${new Date().toISOString()}] `;
  process.stderr.write(text.replace(/^(?=.)/gm, at));
};
const OBSERVE_EVENTS = new Set([
  "turn_started", "turn_completed", "turn_failed", "turn_cancelled",
  "user_question_requested", "user_question_answered", "background_wait_changed",
  "folder_defaults_changed", "wait_released", "session_discarded", "session_deleted",
  "session_renamed", "session_settings_changed",
]);
const STOPPED_REMOTE_STATE = {
  running: false,
  scope: "loopback",
  port: 0,
  addresses: [],
  accessCode: "",
  clients: 0,
};

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
  let token, recordNonce, initialized, workerPid = null, authOwner, stopping = false, closing, remoteHost;
  const startedAt = new Date().toISOString();
  const build = runtimeBuildId(options);
  const peers = new Set(), auth = new Map(), prompts = new Map();
  const deleting = new Set(), opening = new Map();
  const remoteEventListeners = new Set(), sessionWorkspaces = new Map(), pendingPromptTexts = new Map();
  const holdPrompt = (map, sid) => map.set(sid, (map.get(sid) || 0) + 1);
  const releasePrompt = (map, sid) => {
    const count = (map.get(sid) || 1) - 1;
    if (count > 0) map.set(sid, count);
    else map.delete(sid);
  };
  const writeLog = (event, fields = {}) => existsSync(paths.directory)
    ? appendFile(paths.log, `[${new Date().toISOString()}] ${event}${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => ` ${k}=${v}`).join("")}\n`, { mode: 0o600 }).catch(() => {})
    : Promise.resolve();
  const live = createLiveSessions({ onChange(sessions) { for (const peer of peers) if (peer.observe) peer.send({ event: { kind: "runtime", type: "sessions_changed", sessions } }); } });
  const busyCount = () => new Set([
    ...prompts.keys(),
    ...live.list().filter(item => item.turn !== "idle" || item.background).map(item => item.id),
  ]).size;
  const idleTtlMs = resolveIdleTtlMs(options);
  let idleSince = Date.now(), idleTimer = null, stopTimer = null, stopWhenIdle = Boolean(options.stopWhenIdle), hasConnectedPeer = false;
  const clearStopTimer = () => { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } };
  const isIdle = () => ![...peers].some(peer => !peer.observe) && !remoteHost?.state().running && busyCount() === 0 && opening.size === 0 && deleting.size === 0 && !authOwner;
  const touchActivity = () => {
    idleSince = Date.now();
    if (!stopWhenIdle || stopping || !isIdle()) { clearStopTimer(); return; }
    if (!stopTimer) {
      stopTimer = setTimeout(() => { stopTimer = null; if (!stopping && stopWhenIdle && isIdle()) void close("shutdown"); }, hasConnectedPeer ? 200 : 5000);
      stopTimer.unref?.();
    }
  };
  const client = createRuntimeClient({ ...options, rindHome, cwd: paths.directory, cliArgs: [], env: { RIND_SHARED_HOST_PID: String(process.pid) },
    onMessage(event) {
      // Sign-in progress (the URL to open) is for the window signing in.
      if (event?.method === "rind/auth/update") { authOwner?.send({ event }); return; }
      const type = event?.event?.type;
      if (type === "turn_started" && Number(event.event.user_message_chars) > 0 && pendingPromptTexts.has(event.session_id)) {
        const pending = pendingPromptTexts.get(event.session_id);
        pendingPromptTexts.delete(event.session_id);
        event = {
          ...event,
          event: {
            ...event.event,
            input: event.event.input || pending.input,
            ...(pending.clientInputId ? { client_input_id: event.event.client_input_id || pending.clientInputId } : {}),
            ...(pending.remote ? { remote_origin: true } : {}),
          },
        };
      }
      live.event(event);
      const observeEvent = OBSERVE_EVENTS.has(type) || (type === "tool_result" && event.event.tool_name === "ask_user_question");
      for (const peer of peers) if (peer.sessions.has(event.session_id) || (peer.observe && observeEvent)) peer.send({ event });
      for (const listener of remoteEventListeners) {
        try { listener(event); } catch {}
      }
      // A first prompt failed before its message saved the conversation: it never existed.
      if (type === "session_discarded") { live.forget(event.session_id); for (const peer of peers) peer.sessions.delete(event.session_id); }
      // A conversation was deleted: every list and live table drops it now.
      if (type === "session_deleted") { live.forget(event.session_id); for (const peer of peers) peer.sessions.delete(event.session_id); }
      if (isIdle()) touchActivity();
    },
    onRequest(prompt) { return new Promise(resolve => { if (!authOwner || authOwner.socket.destroyed) { resolve(""); return; } auth.set(prompt.request_id, { peer: authOwner, resolve }); authOwner.send({ prompt }); }); },
    onStderr: writeStderr,
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

  function attachIdleWindowPeersToSession(sessionId, workspaceRoot) {
    if (!sessionId) return;
    for (const p of peers) {
      if (p.window && !p.observe && p.sessions.size === 0 && (!workspaceRoot || !p.workspace || samePath(p.workspace, workspaceRoot))) {
        p.sessions.add(sessionId);
        viewIfOpen(p, sessionId, workspaceRoot ? { workspace: workspaceRoot } : undefined);
      }
    }
  }

  async function requestFromRemote(method, params = {}) {
    if (method === "session/subscribe" || method === "session/unsubscribe") return { ok: true };
    const base = await initialize();
    if (method === "initialize") return base;
    const sid = String(params.session_id || "");
    if (method === "session/prompt") {
      if (!prompts.has(sid) && live.turn(sid) === "idle" && typeof params.input === "string" && params.input.trim() && !params.resume) {
        pendingPromptTexts.set(sid, { input: params.input, clientInputId: params.client_input_id, remote: true });
      }
      holdPrompt(prompts, sid);
      attachIdleWindowPeersToSession(sid, sessionWorkspaces.get(sid) || "");
      let promptFailed = false, result;
      try {
        result = await client.request(method, params);
        return result;
      } catch (error) {
        promptFailed = true;
        throw error;
      } finally {
        pendingPromptTexts.delete(sid);
        releasePrompt(prompts, sid);
        if (!result?.steered && !prompts.has(sid)) live.settle(sid, promptFailed);
        if (isIdle()) touchActivity();
      }
    }
    const result = await client.request(method, params);
    if (["session/open", "session/new", "session/switch", "session/create"].includes(method)) {
      const nextSid = String(result?.session_id || sid || "");
      const ws = String(result?.workspace_root || params.workspace_root || "");
      if (nextSid && ws) sessionWorkspaces.set(nextSid, ws);
      if (nextSid) attachIdleWindowPeersToSession(nextSid, ws);
    }
    return result;
  }

  const getRemoteHost = () =>
    (remoteHost ||= createRemoteHost({
      getRindHome: () => rindHome,
      repoRoot: options.repoRoot,
      getRuntimePath: () => options.runtimePath || "",
      getPython: () => options.python,
      initializeRuntime: () => initialize(),
      requestRuntime: (method, params) => requestFromRemote(method, params),
      subscribeRuntime: (listener) => {
        remoteEventListeners.add(listener);
        return () => remoteEventListeners.delete(listener);
      },
      ensureRuntimeForWorkspace: async () => {
        await initialize();
      },
      isSharedRuntime: () => true,
      allowSharedObserver: false,
      allowMissingWebRoot: true,
      onStateChange: (state) => {
        for (const p of peers) p.send({ event: { kind: "remote", state } });
      },
    }));

  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const server = net.createServer(socket => {
    socket.setEncoding("utf8"); let buffer = "";
    const peer = { socket, sessions: new Set(), prompts: new Map(), observe: false, oneShot: false, window: false, workspace: "", send(message) { if (!socket.destroyed) { if (socket.writableLength > 32 * 1024 * 1024) socket.destroy(); else socket.write(JSON.stringify(message) + "\n"); } } };
    peers.add(peer); touchActivity(); socket.on("error", () => {});
    socket.on("close", () => {
      peers.delete(peer); live.leave(peer);
      if (peer.oneShot && initialized) {
        for (const sessionId of peer.prompts.keys()) void client.request("session/cancel", { session_id: sessionId }).catch(() => {});
      }
      for (const [id, entry] of auth) if (entry.peer === peer) { entry.resolve(""); auth.delete(id); }
      if (peer.window && remoteHost && ![...peers].some(other => other.window)) {
        void remoteHost.stop().catch(() => {});
      }
      if (isIdle()) touchActivity();
    });
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
        if (method === "remote/get") {
          if (!peer.oneShot) peer.window = true;
          peer.send({ id, result: remoteHost ? remoteHost.state() : STOPPED_REMOTE_STATE });
          return;
        }
        if (method === "remote/start") {
          if (!peer.oneShot) peer.window = true;
          if (typeof params.workspace_root === "string" && params.workspace_root.trim()) {
            await registerSharedWorkspace(rindHome, params.workspace_root.trim(), { setActive: true }).catch(() => {});
          }
          peer.send({ id, result: await getRemoteHost().start(params) });
          return;
        }
        if (method === "remote/stop") {
          peer.send({ id, result: remoteHost ? await remoteHost.stop() : STOPPED_REMOTE_STATE });
          return;
        }
        if (method === "remote/rotate") {
          if (!remoteHost) throw new Error("Enable remote access first.");
          peer.send({ id, result: remoteHost.rotate() });
          return;
        }
        if (method === "remote/allow-network") {
          if (!remoteHost) throw new Error("Enable local-network access first.");
          peer.send({ id, result: await remoteHost.allowNetwork(process.execPath) });
          return;
        }
        if (method === "remote/workspaces-changed") {
          peer.send({ id, result: remoteHost ? remoteHost.notifyWorkspacesChanged() : STOPPED_REMOTE_STATE });
          return;
        }
        if (method === "runtime/shutdown") {
          if (params.if_idle) {
            const attached = [...peers].some(other => other !== peer && !other.observe);
            if (attached || busyCount() > 0 || opening.size > 0 || deleting.size > 0 || authOwner) {
              peer.send({ id, result: { stopped: false, busy: busyCount() } });
              return;
            }
          }
          stopping = true;
          await remoteHost?.close().catch(() => {});
          if (initialized) {
            // A worker that already died mid-shutdown is no reason to stay up.
            try { await client.shutdown(); }
            catch (error) { writeStderr("runtime shutdown: " + (error?.message || String(error)) + "\n"); }
          }
          peer.send({ id, result: { stopped: true } });
          await close("shutdown");
          return;
        }
        const base = await initialize(); let result;
        if (method !== "runtime/observe") hasConnectedPeer = true;
        if (method === "initialize") {
          if (!peer.oneShot) peer.window = true;
          result = base;
        }
        else if (method === "runtime/observe") { peer.observe = true; result = { pid: client.child.pid }; }
        else if (method === "shutdown") { result = { detached: true }; peer.sessions.clear(); live.leave(peer); }
        else {
          if (["session/open", "session/create", "session/subscribe"].includes(method)) {
            if (params.one_shot === true) {
              peer.oneShot = true;
              peer.window = false;
              if (params.stop_when_idle === true) stopWhenIdle = true;
            } else if (!peer.oneShot) {
              stopWhenIdle = false;
              if (!peer.observe) peer.window = true;
            }
          }
          const { one_shot: _oneShot, stop_when_idle: _stopWhenIdle, ...workerParams } = params;
          if (typeof workerParams.workspace_root === "string" && workerParams.workspace_root.trim() && !peer.observe && !peer.oneShot) {
            peer.workspace = workerParams.workspace_root.trim();
            if (["session/open", "session/create", "session/new"].includes(method)) {
              void registerSharedWorkspace(rindHome, peer.workspace, { setActive: true })
                .then(() => remoteHost?.notifyWorkspacesChanged())
                .catch(() => {});
            }
          }
          if (method === "session/prompt") {
            if (!prompts.has(params.session_id) && live.turn(params.session_id) === "idle" && typeof workerParams.input === "string" && workerParams.input.trim() && !workerParams.resume) {
              pendingPromptTexts.set(params.session_id, { input: workerParams.input, clientInputId: workerParams.client_input_id, remote: false });
            }
            holdPrompt(prompts, params.session_id);
            holdPrompt(peer.prompts, params.session_id);
            viewIfOpen(peer, params.session_id);
          }
          if (method === "rind/auth/login") { if (authOwner) throw new Error("Another connection is signing in."); authOwner = peer; }
          if (method === "session/subscribe" || method === "session/prompt") peer.sessions.add(params.session_id);
          if (method === "session/unsubscribe") { peer.sessions.delete(params.session_id); live.leave(peer, params.session_id); result = { ok: true }; }
          let promptFailed = false;
          try { if (method !== "session/unsubscribe") result = await client.request(method, workerParams); }
          catch (error) { promptFailed = true; throw error; }
          finally {
            if (method === "rind/auth/login") authOwner = null;
            if (method === "session/prompt") {
              pendingPromptTexts.delete(params.session_id);
              releasePrompt(prompts, params.session_id);
              releasePrompt(peer.prompts, params.session_id);
              if (!result?.steered && !prompts.has(params.session_id)) live.settle(params.session_id, promptFailed);
            }
          }
          // A window before its first message has no session; session/create makes one.
          if (["session/open", "session/new", "session/switch", "session/create"].includes(method) && result.session_id) {
            peer.sessions.add(result.session_id);
            const ws = result.workspace_root || workerParams.workspace_root || "";
            if (ws) sessionWorkspaces.set(result.session_id, ws);
            viewIfOpen(peer, result.session_id, { workspace: result.workspace_root });
          }
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
    if (error?.code === "ENDPOINT_OCCUPIED") throw Object.assign(new Error("Shared Runtime is already running."), { code: "ALREADY_RUNNING" });
    throw error;
  }
  try {
    try { token = (await readFile(paths.token, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!token) {
      const candidate = randomBytes(32).toString("hex");
      // Clients can connect as soon as the endpoint appears. Publish only a
      // fully written token, as the Management service does for its user token.
      const draft = paths.token + "." + randomUUID() + ".tmp";
      await writeFile(draft, candidate, { mode: 0o600, flag: "wx" });
      try { await link(draft, paths.token); token = candidate; }
      catch (error) { if (error.code !== "EEXIST") throw error; token = (await readFile(paths.token, "utf8")).trim(); }
      finally { await unlink(draft).catch(() => {}); }
    }
    if (!token) throw new Error("Shared Runtime credentials are empty.");
    // Published once this host owns the endpoint: it names the process that
    // answers here, so a host that stops answering can still be ended.
    recordNonce = options.hostNonce || randomUUID();
    await writeRecord();
    await writeLog("host started", { pid: process.pid, rindHome, endpoint: paths.endpoint });
    if (hostEntry || options.idleTtlMs !== undefined) {
      const checkMs = Math.max(50, Math.min(idleTtlMs || 1000, 1000));
      idleTimer = setInterval(async () => {
        if (stopping) return;
        // A host that published itself here since owns the endpoint; this one is unreachable.
        const owner = await recordedNonce(paths.record);
        if (owner && owner !== recordNonce) { void close("superseded"); return; }
        if (!isIdle()) { touchActivity(); return; }
        if (owner !== recordNonce) { void close("record_removed"); return; }
        if (idleTtlMs > 0 && Date.now() - idleSince >= idleTtlMs) void close("idle_timeout");
      }, checkMs);
      idleTimer.unref?.();
    }
    touchActivity();
    readyResolve();
  } catch (error) {
    readyReject(error);
    for (const peer of peers) peer.socket.destroy();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  async function releaseRecord() {
    if (await recordedNonce(paths.record) === recordNonce) await unlink(paths.record).catch(() => {});
  }
  // Keep ownership until the worker stops, so a replacement cannot run a
  // second worker against the same history during cleanup. Every peer is let
  // go; force termination remains the last resort.
  function close(reason = "shutdown") {
    return closing ||= (async () => {
      stopping = true;
      clearStopTimer();
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      const forced = setTimeout(() => { for (const peer of peers) peer.socket.destroy(); }, 1000);
      forced.unref?.();
      for (const peer of peers) peer.socket.end();
      await remoteHost?.close().catch(() => {});
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
  }).catch(error => {
    // Losing a start race to a live host is expected; the client uses that host.
    if (error?.code !== "ALREADY_RUNNING") writeStderr(String(error?.stack || error) + "\n");
    process.exitCode = 1;
  });
}
