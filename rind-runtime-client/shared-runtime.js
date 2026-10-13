import net from "node:net";
import { privateDirectory } from "./local-files.js";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile, open, stat, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeBuildId } from "./build-id.js";
import { probeEndpoint } from "./endpoint.js";

export function sharedRuntimePaths(home = process.env.RIND_HOME || path.join(os.homedir(), ".rind")) {
  const directory = path.resolve(home, "runtime");
  const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\rind-runtime-" + createHash("sha256").update(directory.toLowerCase()).digest("hex").slice(0, 24) : path.join(directory, "runtime.sock");
  return { directory, endpoint, token: path.join(directory, "token"), record: path.join(directory, "host.json") };
}

export async function connectSharedRuntime(options = {}) {
  const paths = sharedRuntimePaths(options.rindHome || options.home);
  const connect = async () => {
    const token = (await readFile(paths.token, "utf8")).trim();
    const socket = net.connect(paths.endpoint);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.setEncoding("utf8");
    let buffer = "", closed = false;
    const pending = new Map();
    socket.on("error", () => {});
    socket.on("close", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error("Runtime connection lost; execution outcome is unconfirmed."), { code: "EXECUTION_UNCONFIRMED" })); } pending.clear(); if (!closed) options.onDisconnect?.(); });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.event) { options.onMessage?.(message.event); continue; }
          if (message.deliver) { options.onDeliver?.(message.deliver); continue; }
          if (message.prompt) {
            Promise.resolve(options.onRequest?.(message.prompt)).then(value => send({ authReply: message.prompt.request_id, value: value?.value ?? value ?? "" })).catch(() => send({ authReply: message.prompt.request_id, value: "" }));
            continue;
          }
          const p = pending.get(message.id); if (!p) continue;
          clearTimeout(p.timer); pending.delete(message.id);
          if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else p.resolve(message.result);
        } catch { socket.destroy(); }
      }
    });
    function send(message) { if (!socket.destroyed) socket.write(JSON.stringify({ ...message, token }) + "\n"); }
    return {
      request(method, params = {}) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
          if (socket.destroyed) { reject(new Error("Runtime disconnected.")); return; }
          const long = ["session/prompt", "rind/session/follow_up", "rind/session/compact"].includes(method) || (method === "rind/command/execute" && /^\/compact\b/.test(params.input || ""));
          const timer = long ? null : setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Runtime request timed out; execution outcome is unconfirmed."), { code: "EXECUTION_UNCONFIRMED" })); }, 120000);
          pending.set(id, { resolve, reject, timer }); send({ id, method, params });
        });
      },
      close() { closed = true; socket.destroy(); },
    };
  };
  // A host started from older code keeps running it. Replace it when nothing
  // depends on it; otherwise keep using it and report the pending update.
  const checked = async connection => {
    if (options.start === false || !(options.repoRoot || options.runtimePath)) return connection;
    const [info, expected] = await Promise.all([
      // A host that takes seconds to answer its own health check is not usable.
      Promise.race([connection.request("runtime/info").catch(() => null), delay(3000).then(() => null)]),
      runtimeBuildId(options),
    ]);
    if (info?.buildId === expected) return connection;
    if (info && !info.busy && !info.attached) {
      await connection.request("runtime/shutdown").catch(() => {});
      connection.close();
      for (let i = 0; i < 50; i++) { try { (await connect()).close(); } catch { return null; } await delay(100); }
      throw new Error("The outdated shared Runtime did not stop. See " + path.join(paths.directory, "runtime.log"));
    }
    if (!info) {
      // The endpoint answers but no host serves it: a Runtime that is shutting
      // down, or one that stopped answering. Wait for the endpoint to free,
      // then end a host that is provably stuck so a fresh one can start.
      connection.close();
      if (await waitForFreeEndpoint(paths, 5000)) return null;
      if (await endStuckHost(paths) && await waitForFreeEndpoint(paths, 5000)) return null;
      throw new Error("A Runtime is holding " + paths.endpoint + " without answering, and it would not stop. End it from the task manager, then try again.");
    }
    connection.stale = { reason: info ? "busy" : "unknown", ...(info ? { pid: info.pid, busy: info.busy, attached: info.attached } : {}) };
    return connection;
  };
  // An endpoint that answers but serves nobody — no token yet, a host shutting
  // down, or one that stopped answering — must not block the next host. Wait for
  // a host that is still starting, then end a host that is provably stuck
  // through the pid record it published (orca ends a stale daemon the same way).
  // Returns a usable connection, or null once the endpoint is free.
  async function takeOverStuckEndpoint() {
    for (let i = 0; i < 30; i++) {
      if (!(await probeEndpoint(paths.endpoint))) return null;
      try { return await connect(); } catch {}
      await delay(100);
    }
    await endStuckHost(paths);
    if (!(await waitForFreeEndpoint(paths, 5000))) {
      throw new Error("A Runtime is holding " + paths.endpoint + " without answering, and it would not stop. End it from the task manager, then try again.");
    }
    return null;
  }

  let current = null;
  try { current = await checked(await connect()); } catch (error) { if (options.start === false) throw error; }
  if (current) return current;
  const taken = await takeOverStuckEndpoint();
  if (taken) { current = await checked(taken); if (current) return current; }
  await privateDirectory(paths.directory);
  // One starter at a time: without it two windows can each spawn a host while
  // neither is connectable yet. The loser waits, then finds the winner.
  const lock = await acquireHostLock(paths, 30000);
  try {
    try { const current = await checked(await connect()); if (current) return current; } catch {}
    const log = await open(path.join(paths.directory, "runtime.log"), "a", 0o600);
    // The host must not hold the caller's working directory open: on Windows a
    // process whose current directory is inside a folder blocks removing it.
    const child = spawn(process.execPath, [fileURLToPath(new URL("./shared-server.js", import.meta.url)), JSON.stringify({ python: options.python, repoRoot: options.repoRoot, runtimePath: options.runtimePath, rindHome: options.rindHome || options.home })], { cwd: paths.directory, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
    child.on("error", () => {}); child.unref(); await log.close();
    for (let i = 0; i < 100; i++) {
      try { return await connect(); } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Unable to connect to shared Runtime. See " + path.join(paths.directory, "runtime.log"));
  } finally {
    await lock?.release();
  }
}

// Serializes starting the host. Advisory only — the endpoint bind decides who
// serves — and reclaimed when its owner died, never removed without proof.
// Follows orca's instance lock (src/main/orcad/orcad-instance-lock.ts).
async function acquireHostLock(paths, timeoutMs) {
  const file = path.join(paths.directory, "host.lock");
  const nonce = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), nonce })); }
      finally { await handle.close(); }
      return { release: async () => {
        const record = await readFile(file, "utf8").then(value => JSON.parse(value), () => null);
        if (record?.nonce !== nonce) return;
        await unlink(file).catch(() => {});
      } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (!(await lockHeldByLiveProcess(file, 10000))) {
      const claim = file + ".stale-" + process.pid + "-" + randomUUID().slice(0, 8);
      try { await rename(file, claim); } catch (error) { if (error?.code !== "ENOENT") throw error; continue; }
      await unlink(claim).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// A lock is held while the process that published it is alive; a garbled
// record counts only past its write grace, since it may still be arriving.
async function lockHeldByLiveProcess(file, garbledGraceMs) {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return false;
  try {
    const record = JSON.parse(raw);
    return Number.isInteger(record?.pid) && record.pid > 0 && processAlive(record.pid);
  } catch {
    const value = await stat(file).catch(() => null);
    return value !== null && Date.now() - value.mtimeMs < garbledGraceMs;
  }
}

// Only ESRCH proves a process is gone; EPERM means it exists.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// True once nothing accepts connections on the endpoint; the deadline keeps a
// host that never leaves from blocking the caller forever.
async function waitForFreeEndpoint(paths, ms) {
  const deadline = Date.now() + ms;
  while (await probeEndpoint(paths.endpoint)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

// A live endpoint that does not answer cannot be reached through its own
// protocol; the pid record it publishes is the only way to end it. This runs
// only after the endpoint has served nothing for seconds, so a host that is
// merely starting is never touched. orca ends a stale daemon the same way.
async function endStuckHost(paths) {
  const record = await readFile(paths.record, "utf8").then(value => JSON.parse(value), () => null);
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) return false;
  try { process.kill(pid, "SIGKILL"); } catch { return false; }
  return true;
}

export function createSharedRuntimeClient(options) {
  let connection, starting, initialization, closed = false;
  const args = options.cliArgs || [];
  const arg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--trace-llm")) throw new Error("Shared Runtime tracing is host-wide. Set RIND_TRACE_LLM=1 before starting the shared host instead of --trace-llm.");
  const sessionDir = arg("--session-dir");
  if (sessionDir && path.resolve(sessionDir) !== path.resolve(options.rindHome || options.home || process.env.RIND_HOME || path.join(os.homedir(), ".rind"), "sessions")) throw new Error("Shared Runtime uses RIND_HOME/sessions; omit --session-dir.");
  function start() {
    if (!starting) {
      // A failed attempt must not be remembered: the next ensure may reconnect.
      starting = connectSharedRuntime({ ...options, onDisconnect() { options.onExit?.(null, null, { closing: closed, error: new Error("Shared Runtime disconnected. Reopen the session to reconnect.") }); } })
        .then(value => { connection = value; return value; }, error => { starting = undefined; throw error; });
    }
    return starting;
  }
  // Where this window works and what its conversation may use; a conversation
  // opened (an existing one) or created (on the first message) gets the same.
  const scope = () => ({ workspace_root: arg("--cwd") || arg("--dir") || options.cwd || process.cwd(), external_tools: options.externalTools || null, enable_user_question: !args.includes("--no-user-question") });
  async function request(method, params = {}) {
    const client = await start();
    if (method === "initialize") {
      // A window that takes `rind send` input says so before it opens its session.
      // A host from before `rind send` routing does not know this; the window then
      // keeps its own send endpoint (client.acceptsInput stays false).
      // Without --session nothing is created yet: the first message does that.
      initialization ||= client.request("initialize").then(async base => (options.onDeliver && (client.acceptsInput = await client.request("runtime/accept-input").then(() => true, () => false)), { ...base, ...await client.request("session/open", {
        ...scope(), session_id: arg("--session"), resume_latest: args.includes("--resume-latest") || args.includes("-c"),
      }) }));
      return initialization;
    }
    if (method === "session/create") return client.request(method, { ...scope(), ...params });
    return client.request(method, params);
  }
  function close() { closed = true; connection?.close(); starting?.then(c => c.close()).catch(() => {}); }
  // Covered by the Agents page, the window still holds its session but no
  // longer shows it. Best effort: an older host does not know this request.
  async function setVisible(visible) {
    if (!connection || closed) return;
    try { await connection.request("runtime/visibility", { visible }); } catch {}
  }
  return { start, request, setVisible, shutdown: async () => close(), forceShutdown: close, closeInput: close, get child() { return connection || null; } };
}
