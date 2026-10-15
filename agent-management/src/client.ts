import net from "node:net";
import { readFile, open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { managementPaths, privateDirectory, resolveRindHome, type Paths } from "./paths.js";
import { managementBuildId } from "./build.js";
import { findServiceProcesses } from "./service-process.js";
import { probeEndpoint } from "../../rind-runtime-client/endpoint.js";
import { acquireProcessLock } from "../../rind-runtime-client/process-lock.js";

const sameFolder = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const active = (snapshot: any) => snapshot.runs.filter((run: any) => run.status === "starting" || run.status === "running").length;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}

async function waitForExit(pid: number, ms: number) {
  const deadline = Date.now() + ms;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function waitForFreeEndpoint(paths: Paths, ms: number) {
  const deadline = Date.now() + ms;
  while (await probeEndpoint(paths.endpoint)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

async function endStuckService(paths: Paths, connect?: () => Promise<ManagementClient>) {
  const raw = await readFile(paths.record, "utf8").catch(() => null);
  let recordedPid = 0;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && parsed.pid !== process.pid && /^[0-9a-f-]{36}$/.test(parsed?.nonce || "")) recordedPid = parsed.pid;
  } catch {}
  const pids = new Set<number>(await findServiceProcesses(fileURLToPath(new URL("./server.js", import.meta.url)), config => sameFolder(managementPaths(config.home).state, paths.state)));
  if (recordedPid && processAlive(recordedPid)) pids.add(recordedPid);
  if (!pids.size) return false;
  if (connect) {
    let client: ManagementClient | undefined;
    try {
      client = await connect();
      if (await within(client.request("serviceInfo").catch(() => null), 500)) return false;
    } catch {}
    finally { client?.close(); }
  }
  if (raw && await readFile(paths.record, "utf8").catch(() => null) !== raw) return false;
  let ended = false;
  for (const pid of pids) {
    if (!processAlive(pid)) continue;
    try { process.kill(pid, "SIGKILL"); ended = true; } catch {}
    await waitForExit(pid, 5000);
  }
  if (raw && await readFile(paths.record, "utf8").catch(() => null) === raw) await unlink(paths.record).catch(() => {});
  return ended;
}

// A service started before serviceInfo existed. Its own snapshot says whether
// anything runs; only then is its process ended so a current one can start.
export async function endLegacyService(client: ManagementClient, home?: string, { force = false } = {}) {
  const working = active(await client.request("snapshot"));
  if (working && !force) return { ended: false, working };
  const paths = managementPaths(home);
  const pids = await findServiceProcesses(fileURLToPath(new URL("./server.js", import.meta.url)), config => sameFolder(managementPaths(config.home).state, paths.state));
  client.close();
  for (const pid of pids) {
    try { process.kill(pid); } catch {}
    await waitForExit(pid, 5000);
  }
  return { ended: pids.length > 0, working };
}

export async function stopManagementService({ home }: { home?: string } = {}) {
  const paths = managementPaths(home);
  let stopped = false;
  const client = await connectManagement({ home, start: false }).catch(() => null);
  if (client) {
    try {
      if (await within(client.request("serviceShutdown", { stopAgents: true }).catch(() => null), 3000)) stopped = true;
    } finally {
      client.close();
    }
    if (stopped) await waitForFreeEndpoint(paths, 5000);
  }
  if (await endStuckService(paths)) {
    stopped = true;
    await waitForFreeEndpoint(paths, 5000);
  }
  return stopped;
}

export async function connectClient({ endpoint, token, runtimeSessionId, onSnapshot, onDisconnect }: {
  endpoint: string; token: string; runtimeSessionId?: string;
  onSnapshot?: (snapshot: any) => void; onDisconnect?: () => void;
}) {
  const socket = net.connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => failed(new Error("Management connection timed out.")), 3000);
    const failed = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once("connect", () => { clearTimeout(timer); socket.off("error", failed); resolve(); });
    socket.once("error", failed);
  });
  socket.setEncoding("utf8");
  let buffer = "";
  let closed = false;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  socket.on("error", () => {});
  socket.on("close", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Management connection lost; status is unconfirmed.")); } pending.clear(); if (!closed) onDisconnect?.(); });
  socket.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 32 * 1024 * 1024) { socket.destroy(new Error("Management response too large.")); return; }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.event === "snapshot") { onSnapshot?.(message.snapshot); continue; }
        const p = pending.get(message.id); if (!p) continue;
        pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code, details: message.error.details }));
        else p.resolve(message.result);
      } catch { socket.destroy(new Error("Invalid management response.")); }
    }
  });
  return {
    request(method: string, params: Record<string, any> = {}): Promise<any> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        if (socket.destroyed) { reject(new Error("Management service is disconnected.")); return; }
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Management request timed out. Retry with the same requestId if the outcome is unknown.")); }, 120000);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ id, token, runtimeSessionId, method, params: { requestId: id, ...params } }) + "\n");
      });
    },
    close() { closed = true; socket.destroy(); },
  };
}
export async function connectManagement(options: {
  home?: string; python?: string; repoRoot?: string; runtimePath?: string; start?: boolean;
  onSnapshot?: (snapshot: any) => void; onDisconnect?: () => void;
} = {}) {
  const home = resolveRindHome(options.home);
  const paths = managementPaths(home);
  const connect = async () => {
    const token = (await readFile(paths.token, "utf8")).trim();
    if (!token) throw new Error("The agents management credentials are not written yet.");
    return connectClient({ endpoint: paths.endpoint, token, onSnapshot: options.onSnapshot, onDisconnect: options.onDisconnect });
  };
  // A service started from older code keeps serving it after an update. It is
  // replaced only while no agent is working; otherwise the client keeps using
  // it and reports the pending update.
  const stopped = async () => {
    for (let i = 0; i < 50; i++) { try { (await connect()).close(); } catch { return true; } await delay(100); }
    throw new Error("The outdated agents management service did not stop. See " + path.join(paths.state, "service.log"));
  };
  async function checked(client: ManagementClient) {
    try {
      let legacy = false;
      const [info, expected] = await Promise.all([
        within(client.request("serviceInfo").catch(error => { legacy = error.code === "UNKNOWN_METHOD"; return null; }), 3000),
        managementBuildId(),
      ]);
      if (info?.buildId === expected) return Object.assign(client, { service: info });
      if (info && info.working === 0) {
        // Replace only this service; the shared Runtime and its windows keep running.
        await client.request("serviceShutdown", { restart: true }).catch(() => {});
        client.close();
        return (await stopped()) && null;
      }
      if (legacy) {
        const result = await endLegacyService(client, home);
        if (result.ended) return (await stopped()) && null;
        if (!result.working) throw new Error("An agents management service from an older Rind is running and could not be stopped. End its process and try again.");
        return Object.assign(client, { service: null, stale: { reason: "legacy", working: result.working } });
      }
      if (!info) {
        client.close();
        if (await waitForFreeEndpoint(paths, 5000)) return null;
        if (await endStuckService(paths, connect) && await waitForFreeEndpoint(paths, 5000)) return null;
        throw new Error("An agents management service is holding " + paths.endpoint + " without answering, and it would not stop.");
      }
      return Object.assign(client, { service: info, stale: { reason: "busy", working: info.working } });
    } catch (error) {
      client.close();
      throw error;
    }
  }
  async function waitForStartingService() {
    for (let i = 0; i < 30; i++) {
      if (!(await probeEndpoint(paths.endpoint))) return null;
      try { const current = await checked(await connect()); if (current) return current; } catch {}
      await delay(100);
    }
    await endStuckService(paths, connect);
    if (!(await waitForFreeEndpoint(paths, 5000))) {
      throw new Error("An agents management service is holding " + paths.endpoint + " without answering, and it would not stop.");
    }
    return null;
  }
  if (options.start === false) return Object.assign(await connect(), { service: null });
  try { const current = await checked(await connect()); if (current) return current; } catch {}
  const existing = await waitForStartingService();
  if (existing) return existing;
  await privateDirectory(paths.state);
  const lock = await acquireProcessLock(path.join(paths.state, "service-start.lock"));
  try {
    try { const current = await checked(await connect()); if (current) return current; } catch {}
    const taken = await waitForStartingService();
    if (taken) return taken;
    const log = await open(path.join(paths.state, "service.log"), "a", 0o600);
    const repoRoot = options.repoRoot || path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url)), JSON.stringify({ home, python: options.python || process.env.RIND_PYTHON || undefined, repoRoot, runtimePath: options.runtimePath || process.env.RIND_RUNTIME_PATH || "" }), "--rind-service-nonce=" + randomUUID()], { detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
    child.on("error", () => {}); child.unref(); await log.close();
    let last: unknown;
    for (let i = 0; i < 40; i++) {
      // Only a service that accepts these credentials counts as started.
      try {
        const client = await connect();
        const service = await client.request("serviceInfo").catch(error => { if (error.code === "UNKNOWN_METHOD") return null; client.close(); throw error; });
        return Object.assign(client, { service });
      } catch (error) { last = error; }
      await delay(100);
    }
    throw new Error("Unable to start agents management. See " + path.join(paths.state, "service.log") + ": " + String(last));
  } finally {
    await lock?.release();
  }
}
export type ManagementClient = Awaited<ReturnType<typeof connectClient>>;
export { managementPaths };
