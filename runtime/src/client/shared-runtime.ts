import net from "node:net";
import { privateDirectory, resolveRindHome } from "./local-files.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, open, unlink } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runtimeBuildId } from "./build-id.js";
import { probeEndpoint } from "./endpoint.js";
import { createLineBuffer } from "./ndjson.js";
import { acquireProcessLock } from "./process-lock.js";
import { isLongRunningRequest } from "../protocol/runtime-protocol.js";

const SPAWN_POLL_DELAYS_MS = [15, 20, 30, 50, 80];

export interface SharedRuntimePaths {
  directory: string;
  endpoint: string;
  token: string;
  record: string;
  log: string;
}

export interface SharedRuntimeStaleInfo {
  reason: "busy" | "unknown";
  pid?: number;
  busy?: number;
  attached?: number;
}

export interface SharedRuntimeConnection {
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  spawned?: boolean;
  acceptsInput?: boolean;
  stale?: SharedRuntimeStaleInfo;
}

export interface SharedRuntimeOptions {
  home?: string;
  rindHome?: string;
  repoRoot?: string;
  runtimePath?: string;
  start?: boolean;
  stopSpawnedHost?: boolean;
  hostSpawned?: boolean;
  cwd?: string;
  cliArgs?: readonly string[];
  externalTools?: unknown;
  onMessage?: (event: any) => void;
  onDeliver?: (deliver: any) => void;
  onRequest?: (prompt: any) => unknown | Promise<unknown>;
  onDisconnect?: () => void;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    info: { closing: boolean; error: Error },
  ) => void;
}

export function sharedRuntimePaths(home: string | undefined = process.env.RIND_HOME): SharedRuntimePaths {
  const directory = path.join(resolveRindHome(home), "runtime");
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\rind-runtime-" +
        createHash("sha256").update(directory.toLowerCase()).digest("hex").slice(0, 24)
      : path.join(directory, "runtime.sock");
  return {
    directory,
    endpoint,
    token: path.join(directory, "token"),
    record: path.join(directory, "host.json"),
    log: path.join(directory, "runtime.log"),
  };
}

export async function connectSharedRuntime(
  rawOptions: SharedRuntimeOptions = {},
): Promise<SharedRuntimeConnection> {
  const options: SharedRuntimeOptions = {
    ...rawOptions,
    rindHome: resolveRindHome(rawOptions.rindHome || rawOptions.home),
    repoRoot: rawOptions.repoRoot ? path.resolve(rawOptions.repoRoot) : undefined,
    runtimePath: rawOptions.runtimePath ? path.resolve(rawOptions.runtimePath) : undefined,
  };
  const paths = sharedRuntimePaths(options.rindHome);

  const connect = async (): Promise<SharedRuntimeConnection> => {
    const token = (await readFile(paths.token, "utf8")).trim();
    if (!token) {
      throw Object.assign(new Error("Shared Runtime credentials are not ready."), {
        code: "RUNTIME_NOT_READY",
      });
    }
    const socket = net.connect(paths.endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => failed(new Error("Runtime connection timed out.")), 3000);
      const failed = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", failed);
        resolve();
      });
      socket.once("error", failed);
    });
    socket.setEncoding("utf8");
    let closed = false;
    const pending = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
      }
    >();
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(
          Object.assign(
            new Error("Runtime connection lost; execution outcome is unconfirmed."),
            { code: "EXECUTION_UNCONFIRMED" },
          ),
        );
      }
      pending.clear();
      if (!closed) options.onDisconnect?.();
    });
    const send = (message: Record<string, unknown>): void => {
      if (!socket.destroyed) socket.write(JSON.stringify({ ...message, token }) + "\n");
    };
    const lines = createLineBuffer(
      (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event) {
            options.onMessage?.(message.event);
            return;
          }
          if (message.deliver) {
            options.onDeliver?.(message.deliver);
            return;
          }
          if (message.prompt) {
            Promise.resolve(options.onRequest?.(message.prompt))
              .then((value: any) =>
                send({ authReply: message.prompt.request_id, value: value?.value ?? value ?? "" }),
              )
              .catch(() => send({ authReply: message.prompt.request_id, value: "" }));
            return;
          }
          const p = pending.get(message.id);
          if (!p) return;
          if (p.timer) clearTimeout(p.timer);
          pending.delete(message.id);
          if (message.error) {
            p.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          } else {
            p.resolve(message.result);
          }
        } catch {
          socket.destroy();
        }
      },
      { maxBytes: 32 * 1024 * 1024, onOverflow: () => socket.destroy() },
    );
    socket.on("data", (chunk: string) => {
      lines.push(chunk);
    });
    return {
      request(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
          if (socket.destroyed) {
            reject(new Error("Runtime disconnected."));
            return;
          }
          const timer = isLongRunningRequest(method, params)
            ? null
            : setTimeout(() => {
                pending.delete(id);
                reject(
                  Object.assign(
                    new Error("Runtime request timed out; execution outcome is unconfirmed."),
                    { code: "EXECUTION_UNCONFIRMED" },
                  ),
                );
              }, 120000);
          pending.set(id, { resolve, reject, timer });
          send({ id, method, params });
        });
      },
      close(): void {
        closed = true;
        socket.destroy();
      },
    };
  };

  let replaced = false;
  const checked = async (
    connection: SharedRuntimeConnection,
  ): Promise<SharedRuntimeConnection | null> => {
    try {
      connection.spawned = false;
      if (options.start === false || !(options.repoRoot || options.runtimePath)) return connection;
      const [info, expected] = await Promise.all([
        within(connection.request("runtime/info").catch(() => null), 3000),
        runtimeBuildId(options),
      ]);
      if (info?.buildId === expected) return connection;
      if (info && !info.busy && !info.attached) {
        replaced = true;
        await connection.request("runtime/shutdown").catch(() => {});
        connection.close();
        for (let i = 0; i < 50; i++) {
          try {
            (await connect()).close();
          } catch {
            return null;
          }
          await delay(100);
        }
        throw new Error("The outdated shared Runtime did not stop. See " + paths.log);
      }
      if (!info) {
        connection.close();
        if (await waitForFreeEndpoint(paths, 5000)) {
          await endStuckHost(paths);
          return null;
        }
        if ((await endStuckHost(paths, connect)) && (await waitForFreeEndpoint(paths, 5000))) {
          return null;
        }
        throw new Error(
          "A Runtime is holding " +
            paths.endpoint +
            " without answering, and it would not stop. End it from the task manager, then try again.",
        );
      }
      connection.stale = {
        reason: info ? "busy" : "unknown",
        ...(info ? { pid: info.pid, busy: info.busy, attached: info.attached } : {}),
      };
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  };

  async function takeOverStuckEndpoint(): Promise<SharedRuntimeConnection | null> {
    for (let i = 0; i < 30; i++) {
      if (!(await probeEndpoint(paths.endpoint))) {
        await endStuckHost(paths);
        return null;
      }
      try {
        return await connect();
      } catch {
        // Retry while starting.
      }
      await delay(100);
    }
    await endStuckHost(paths, connect);
    if (!(await waitForFreeEndpoint(paths, 5000))) {
      throw new Error(
        "A Runtime is holding " +
          paths.endpoint +
          " without answering, and it would not stop. End it from the task manager, then try again.",
      );
    }
    return null;
  }

  let current: SharedRuntimeConnection | null = null;
  try {
    current = await connect();
  } catch (error) {
    if (options.start === false) throw error;
  }
  if (current) current = await checked(current);
  if (current) return current;
  const taken = await takeOverStuckEndpoint();
  if (taken) {
    current = await checked(taken);
    if (current) return current;
  }
  await privateDirectory(paths.directory);
  const lock = await acquireProcessLock(path.join(paths.directory, "host-start.lock"));
  try {
    let existing: SharedRuntimeConnection | undefined;
    try {
      existing = await connect();
    } catch {
      // Not listening yet.
    }
    if (existing) {
      const valid = await checked(existing);
      if (valid) return valid;
    }
    const reclaimed = await takeOverStuckEndpoint();
    if (reclaimed) {
      const valid = await checked(reclaimed);
      if (valid) return valid;
    }
    const log = await open(paths.log, "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./shared-server.js", import.meta.url)),
        JSON.stringify({
          repoRoot: options.repoRoot,
          runtimePath: options.runtimePath,
          rindHome: options.rindHome,
          ...(options.stopSpawnedHost && !replaced ? { stopWhenIdle: true } : {}),
        }),
        "--rind-host-nonce=" + randomUUID(),
      ],
      {
        cwd: paths.directory,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.versions.electron
          ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
          : process.env,
      },
    );
    child.on("error", () => {});
    child.unref();
    await log.close();
    for (let i = 0; i < 103; i++) {
      await delay(SPAWN_POLL_DELAYS_MS[i] ?? 100);
      try {
        const started = await connect();
        started.spawned = !replaced;
        return started;
      } catch {
        // Keep polling until host binds.
      }
    }
    throw new Error("Unable to connect to shared Runtime. See " + paths.log);
  } finally {
    await lock?.release();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function readCommandLine(pid: number): Promise<string> {
  try {
    if (process.platform === "linux") {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ");
    }
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ]
        : ["-p", String(pid), "-o", "command="];
    const executable = process.platform === "win32" ? "powershell.exe" : "ps";
    return (await promisify(execFile)(executable, args, { timeout: 3000, windowsHide: true })).stdout;
  } catch {
    return "";
  }
}

async function waitForFreeEndpoint(paths: SharedRuntimePaths, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (await probeEndpoint(paths.endpoint)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

async function endStuckHost(
  paths: SharedRuntimePaths,
  connect?: () => Promise<SharedRuntimeConnection>,
): Promise<boolean> {
  const raw = await readFile(paths.record, "utf8").catch(() => null);
  if (!raw) return false;
  let record: any;
  try {
    record = JSON.parse(raw);
  } catch {
    return false;
  }
  const pid = record?.pid;
  const workerPid = record?.workerPid;
  if (!Number.isInteger(pid) || pid <= 0 || !/^[0-9a-f-]{36}$/.test(record?.nonce || "")) {
    return false;
  }
  const entry = fileURLToPath(new URL("./shared-server.js", import.meta.url));
  const normalize = (value: string) =>
    process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  let hostMatched = false;
  if (pid !== process.pid && processAlive(pid)) {
    const command = await readCommandLine(pid);
    if (!command.trim() && canSignalProcess(pid)) {
      await waitForExit(pid, 2000);
    } else {
      hostMatched =
        normalize(command).includes(normalize(entry)) &&
        command.includes("--rind-host-nonce=" + record.nonce);
      if (hostMatched && connect) {
        let connection: SharedRuntimeConnection | undefined;
        try {
          connection = await connect();
          if (await within(connection.request("runtime/info").catch(() => null), 500)) {
            return false;
          }
        } catch {
          // Still unreachable.
        } finally {
          connection?.close();
        }
      }
    }
  }
  let workerMatched = false;
  if (
    Number.isInteger(workerPid) &&
    workerPid > 0 &&
    workerPid !== process.pid &&
    processAlive(workerPid)
  ) {
    const workerCommand = await readCommandLine(workerPid);
    if (!workerCommand.trim() && canSignalProcess(workerPid)) {
      await waitForExit(workerPid, 2000);
    } else {
      workerMatched = workerCommand.includes("app-server");
    }
  }
  if (!hostMatched && !workerMatched) {
    if (
      !processAlive(pid) &&
      (!Number.isInteger(workerPid) || workerPid <= 0 || !processAlive(workerPid)) &&
      !(await probeEndpoint(paths.endpoint))
    ) {
      if ((await readFile(paths.record, "utf8").catch(() => null)) === raw) {
        await unlink(paths.record).catch(() => {});
      }
    }
    return false;
  }
  if ((await readFile(paths.record, "utf8").catch(() => null)) !== raw) return false;
  if (hostMatched) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore exit race.
    }
    await waitForExit(pid, 5000);
  }
  if (workerMatched) {
    if (processAlive(workerPid)) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // Ignore exit race.
      }
    }
    await waitForExit(workerPid, 5000);
  }
  if ((await readFile(paths.record, "utf8").catch(() => null)) === raw) {
    await unlink(paths.record).catch(() => {});
  }
  return true;
}

export async function stopSharedRuntime(options: SharedRuntimeOptions = {}): Promise<boolean> {
  const paths = sharedRuntimePaths(options.rindHome || options.home);
  let stopped = false;
  const connection = await connectSharedRuntime({ ...options, start: false }).catch(() => null);
  if (connection) {
    try {
      if (await within(connection.request("runtime/shutdown").catch(() => null), 3000)) {
        stopped = true;
      }
    } finally {
      connection.close();
    }
    if (stopped) await waitForFreeEndpoint(paths, 5000);
  }
  if (await endStuckHost(paths)) {
    stopped = true;
    await waitForFreeEndpoint(paths, 5000);
  }
  return stopped;
}

export interface SharedRuntimeClient {
  start: () => Promise<SharedRuntimeConnection>;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  setVisible: (visible: boolean) => Promise<void>;
  shutdown: () => Promise<void>;
  forceShutdown: () => void;
  readonly child: SharedRuntimeConnection | null;
}

export function createSharedRuntimeClient(options: SharedRuntimeOptions): SharedRuntimeClient {
  let connection: SharedRuntimeConnection | undefined;
  let starting: Promise<SharedRuntimeConnection> | undefined;
  let initialization: Promise<any> | undefined;
  let closed = false;
  const args = options.cliArgs || [];
  const arg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sessionDir = arg("--session-dir");
  if (
    sessionDir &&
    resolveRindHome(sessionDir) !== path.join(resolveRindHome(options.rindHome || options.home), "sessions")
  ) {
    throw new Error("Shared Runtime uses RIND_HOME/sessions; omit --session-dir.");
  }

  function start(): Promise<SharedRuntimeConnection> {
    if (!starting) {
      starting = connectSharedRuntime({
        ...options,
        onDisconnect() {
          options.onExit?.(null, null, {
            closing: closed,
            error: new Error("Shared Runtime disconnected. Reopen the session to reconnect."),
          });
        },
      }).then(
        (value) => {
          connection = value;
          return value;
        },
        (error) => {
          starting = undefined;
          throw error;
        },
      );
    }
    return starting;
  }

  const scope = (client: SharedRuntimeConnection | undefined) => ({
    workspace_root: arg("--cwd") || arg("--dir") || options.cwd || process.cwd(),
    external_tools: options.externalTools || null,
    enable_user_question: !args.includes("--no-user-question"),
    ...(options.stopSpawnedHost
      ? { one_shot: true, ...(client?.spawned || options.hostSpawned ? { stop_when_idle: true } : {}) }
      : {}),
  });

  async function request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const client = await start();
    if (method === "initialize") {
      initialization ||= client
        .request("initialize")
        .then(async (base) => {
          if (options.onDeliver) {
            client.acceptsInput = await client.request("runtime/accept-input").then(
              () => true,
              () => false,
            );
          }
          return {
            ...base,
            ...(await client.request("session/open", {
              ...scope(client),
              session_id: arg("--session"),
              resume_latest: args.includes("--resume-latest") || args.includes("-c"),
            })),
          };
        })
        .catch((error) => {
          initialization = undefined;
          throw error;
        });
      return initialization;
    }
    if (method === "session/create") return client.request(method, { ...scope(client), ...params });
    return client.request(method, params);
  }

  function close(): void {
    closed = true;
    connection?.close();
    starting?.then((c) => c.close()).catch(() => {});
  }

  async function shutdown(): Promise<void> {
    closed = true;
    const active = connection || (await starting?.catch(() => null));
    if (active && options.stopSpawnedHost && (active.spawned || options.hostSpawned)) {
      try {
        const result = await within(
          active.request("runtime/shutdown", { if_idle: true }).catch(() => null),
          5000,
        );
        active.close();
        if (result?.stopped) {
          await waitForFreeEndpoint(sharedRuntimePaths(options.rindHome || options.home), 5000);
        }
      } finally {
        active.close();
      }
      return;
    }
    close();
  }

  async function setVisible(visible: boolean): Promise<void> {
    if (!connection || closed) return;
    await connection.request("runtime/visibility", { visible }).catch(() => {});
  }

  return {
    start,
    request,
    setVisible,
    shutdown,
    forceShutdown: close,
    get child() {
      return connection || null;
    },
  };
}
