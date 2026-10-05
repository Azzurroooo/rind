import net from "node:net";
import { privateDirectory } from "./local-files.js";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function sharedRuntimePaths(home = process.env.RIND_HOME || path.join(os.homedir(), ".rind")) {
  const directory = path.resolve(home, "runtime");
  const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\rind-runtime-" + createHash("sha256").update(directory.toLowerCase()).digest("hex").slice(0, 24) : path.join(directory, "runtime.sock");
  return { directory, endpoint, token: path.join(directory, "token") };
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
  try { return await connect(); } catch (error) { if (options.start === false) throw error; }
  await privateDirectory(paths.directory);
  const log = await open(path.join(paths.directory, "runtime.log"), "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./shared-server.js", import.meta.url)), JSON.stringify({ python: options.python, repoRoot: options.repoRoot, runtimePath: options.runtimePath, rindHome: options.rindHome || options.home })], { detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  child.on("error", () => {}); child.unref(); await log.close();
  for (let i = 0; i < 100; i++) {
    try { return await connect(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Unable to connect to shared Runtime. See " + path.join(paths.directory, "runtime.log"));
}

export function createSharedRuntimeClient(options) {
  let connection, starting, initialization, closed = false;
  const args = options.cliArgs || [];
  const arg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--trace-llm")) throw new Error("Shared Runtime tracing is host-wide. Set RIND_TRACE_LLM=1 before starting the shared host instead of --trace-llm.");
  const sessionDir = arg("--session-dir");
  if (sessionDir && path.resolve(sessionDir) !== path.resolve(options.rindHome || options.home || process.env.RIND_HOME || path.join(os.homedir(), ".rind"), "sessions")) throw new Error("Shared Runtime uses RIND_HOME/sessions; omit --session-dir.");
  function start() {
    starting ||= connectSharedRuntime({ ...options, onDisconnect() { options.onExit?.(null, null, { closing: closed, error: new Error("Shared Runtime disconnected. Reopen the session to reconnect.") }); } }).then(value => { connection = value; return value; });
    return starting;
  }
  async function request(method, params = {}) {
    const client = await start();
    if (method === "initialize") {
      initialization ||= client.request("initialize").then(async base => ({ ...base, ...await client.request("session/open", {
        workspace_root: arg("--cwd") || arg("--dir") || options.cwd || process.cwd(), session_id: arg("--session"), resume_latest: args.includes("--resume-latest") || args.includes("-c"),
        external_tools: options.externalTools || null, enable_user_question: !args.includes("--no-user-question"),
      }) }));
      return initialization;
    }
    return client.request(method, params);
  }
  function close() { closed = true; connection?.close(); starting?.then(c => c.close()).catch(() => {}); }
  return { start, request, shutdown: async () => close(), forceShutdown: close, closeInput: close, get child() { return connection || null; } };
}
