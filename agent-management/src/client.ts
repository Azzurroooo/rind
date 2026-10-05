import net from "node:net";
import { readFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { managementPaths, privateDirectory } from "./paths.js";

export async function connectClient({ endpoint, token, runtimeSessionId, onSnapshot, onDisconnect }: {
  endpoint: string; token: string; runtimeSessionId?: string;
  onSnapshot?: (snapshot: any) => void; onDisconnect?: () => void;
}) {
  const socket = net.connect(endpoint);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
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
  home?: string; python?: string; repoRoot?: string; runtimePath?: string;
  onSnapshot?: (snapshot: any) => void; onDisconnect?: () => void;
} = {}) {
  const paths = managementPaths(options.home);
  const connect = async () => connectClient({ endpoint: paths.endpoint, token: (await readFile(paths.token, "utf8")).trim(), onSnapshot: options.onSnapshot, onDisconnect: options.onDisconnect });
  try { return await connect(); } catch {}
  await privateDirectory(paths.state);
  const log = await open(path.join(paths.state, "service.log"), "a", 0o600);
  const repoRoot = options.repoRoot || path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url)), JSON.stringify({ home: options.home, python: options.python || process.env.RIND_PYTHON || "python", repoRoot, runtimePath: options.runtimePath || process.env.RIND_RUNTIME_PATH || "" })], { detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  child.on("error", () => {}); child.unref(); await log.close();
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try { return await connect(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Unable to start agents management. See " + path.join(paths.state, "service.log") + ": " + String(last));
}
export type ManagementClient = Awaited<ReturnType<typeof connectClient>>;
export { managementPaths };
