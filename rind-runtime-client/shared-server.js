import net from "node:net";
import { privateDirectory } from "./local-files.js";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { createRuntimeClient } from "./runtime-client.js";
import { sharedRuntimePaths } from "./shared-runtime.js";
import { runtimeBuildId } from "./build-id.js";
import { createLiveSessions } from "./live-sessions.js";

export async function startSharedServer(options) {
  const paths = sharedRuntimePaths(options.rindHome);
  await privateDirectory(paths.directory);
  if (process.platform !== "win32") {
    const live = await new Promise(resolve => { const socket = net.connect(paths.endpoint); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
    if (live) throw new Error("Shared Runtime is already running.");
    await unlink(paths.endpoint).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  let token, initialized, authOwner, stopping = false, closing;
  const startedAt = new Date().toISOString();
  const build = runtimeBuildId(options);
  const peers = new Set(), auth = new Map(), prompts = new Set();
  const live = createLiveSessions({ onChange(sessions) { for (const peer of peers) if (peer.observe) peer.send({ event: { kind: "runtime", type: "sessions_changed", sessions } }); } });
  const client = createRuntimeClient({ ...options, python: options.python || "python", cwd: paths.directory, cliArgs: [],
    onMessage(event) { live.event(event); for (const peer of peers) if (peer.observe || peer.sessions.has(event.session_id)) peer.send({ event }); },
    onRequest(prompt) { return new Promise(resolve => { if (!authOwner) { resolve(""); return; } auth.set(prompt.request_id, { peer: authOwner, resolve }); authOwner.send({ prompt }); }); },
    onStderr: text => process.stderr.write(text),
    // A crashed worker ends every turn it was running; nothing will report their end.
    onExit() { live.reset(); if (!stopping) for (const peer of peers) peer.socket.destroy(); initialized = null; },
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
  const initialize = () => initialized ||= (async () => { client.start(); return client.request("initialize"); })();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const server = net.createServer(socket => {
    socket.setEncoding("utf8"); let buffer = "";
    const peer = { socket, sessions: new Set(), observe: false, send(message) { if (!socket.destroyed) { if (socket.writableLength > 4 * 1024 * 1024) socket.destroy(); else socket.write(JSON.stringify(message) + "\n"); } } };
    peers.add(peer); socket.on("error", () => {});
    socket.on("close", () => { peers.delete(peer); live.leave(peer); for (const [id, entry] of auth) if (entry.peer === peer) { entry.resolve(""); auth.delete(id); } });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return; }
      let end; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); void handle(line); }
    });
    async function handle(line) {
      let id;
      try {
        await ready; const message = JSON.parse(line); id = message.id;
        if (message.token !== token) throw new Error("Invalid Runtime credentials.");
        if (message.authReply) { const entry = auth.get(message.authReply); if (entry?.peer === peer) { auth.delete(message.authReply); entry.resolve(message.value); } return; }
        const { method, params = {} } = message;
        if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected a method and params object.");
        if (stopping) throw new Error("Runtime is shutting down.");
        // Answered without starting the worker, so a client can decide whether
        // this host is current, and stop it, without spawning Python.
        // Windows count as attached; the management service only observes and
        // follows a replaced host by itself, so it never blocks an update.
        if (method === "runtime/info") {
          const attached = [...peers].filter(other => other !== peer && other.sessions.size > 0).length;
          peer.send({ id, result: { buildId: await build, pid: process.pid, startedAt, busy: prompts.size, attached, observed: [...peers].some(other => other !== peer && other.observe) } });
          return;
        }
        // Answered from the host's own table, without starting the worker.
        if (method === "runtime/sessions") { peer.send({ id, result: { sessions: live.list() } }); return; }
        if (method === "runtime/accept-input") { peer.acceptsInput = true; peer.send({ id, result: { ok: true } }); return; }
        // Open means on screen: a window covered by the Agents page reports it.
        if (method === "runtime/visibility") { if (params.visible === false) live.hide(peer); else live.show(peer); peer.send({ id, result: { ok: true } }); return; }
        if (method === "runtime/send") { peer.send({ id, result: await deliver(String(params.session_id || ""), String(params.input || "")) }); return; }
        if (method === "runtime/shutdown" && !initialized) { stopping = true; peer.send({ id, result: { stopped: true } }); await close(); return; }
        const base = await initialize(); let result;
        if (method === "initialize") result = base;
        else if (method === "runtime/observe") { peer.observe = true; result = { pid: client.child.pid }; }
        else if (method === "runtime/shutdown") { stopping = true; await client.shutdown(); peer.send({ id, result: { stopped: true } }); await close(); return; }
        else if (method === "shutdown") { result = { detached: true }; peer.sessions.clear(); live.leave(peer); }
        else {
          if (method === "session/prompt" && prompts.has(params.session_id)) throw new Error("This session already has an active request. Use steering or follow-up input.");
          if (method === "session/prompt") { prompts.add(params.session_id); viewIfOpen(peer, params.session_id); }
          if (method === "rind/auth/login") { if (authOwner) throw new Error("Another connection is signing in."); authOwner = peer; }
          if (method === "session/subscribe" || method === "session/prompt") peer.sessions.add(params.session_id);
          if (method === "session/unsubscribe") { peer.sessions.delete(params.session_id); result = { ok: true }; }
          try { if (method !== "session/unsubscribe") result = await client.request(method, params); }
          finally { if (method === "rind/auth/login") authOwner = null; if (method === "session/prompt") prompts.delete(params.session_id); }
          if (["session/open", "session/new", "session/switch"].includes(method)) { peer.sessions.add(result.session_id); viewIfOpen(peer, result.session_id, { workspace: result.workspace_root, draft: result.draft === true }); }
        }
        peer.send({ id, result });
      } catch (error) { peer.send({ id, error: { message: error.message, code: error.code } }); }
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, resolve); });
  try {
    try { token = (await readFile(paths.token, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!token) { token = randomBytes(32).toString("hex"); await writeFile(paths.token, token, { mode: 0o600, flag: "wx" }); }
    if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    readyResolve();
  } catch (error) {
    readyReject(error);
    for (const peer of peers) peer.socket.destroy();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  function close() {
    return closing ||= (async () => { stopping = true; if (initialized) await client.shutdown(); for (const peer of peers) peer.socket.end(); await new Promise(resolve => server.close(resolve)); })();
  }
  return { paths, close };
}

if (process.argv[1]?.endsWith("shared-server.js")) startSharedServer(JSON.parse(process.argv[2] || "{}")).catch(error => { console.error(error); process.exitCode = 1; });
