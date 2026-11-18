import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLineBuffer } from "./ndjson.js";
import { buildRuntimeEnv } from "./runtime-env.js";
import {
  createRuntimeRequest,
  isLongRunningRequest,
  isRuntimeEvent,
  isRuntimeRequest,
  isRuntimeResponse,
  runtimeMethods,
  runtimeRequestId,
  type RequestId,
} from "../protocol/runtime-protocol.js";

const defaultRepoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const REQUEST_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

function isJsRuntimePath(runtimePath = ""): boolean {
  return !runtimePath || /\.(?:c|m)?js$/i.test(runtimePath);
}

export function resolveRuntimeExecutable(
  repoRoot = defaultRepoRoot,
  runtimePath = "",
): { command: string; args: string[] } {
  if (!runtimePath) {
    return { command: process.execPath, args: [path.join(repoRoot, "runtime", "dist", "cli.js")] };
  }
  if (/\.(?:c|m)?js$/i.test(runtimePath)) {
    return { command: process.execPath, args: [runtimePath] };
  }
  return { command: runtimePath, args: [] };
}

export function resolveRuntimeLaunch({
  repoRoot = defaultRepoRoot,
  runtimePath = "",
  cliArgs = [],
}: {
  repoRoot?: string;
  runtimePath?: string;
  cliArgs?: readonly string[];
} = {}): { command: string; args: string[] } {
  const executable = resolveRuntimeExecutable(repoRoot, runtimePath);
  const traceFlag = isTraceLlmEnvSet() ? ["--trace-llm"] : [];
  return {
    command: executable.command,
    args: [...executable.args, "app-server", "--stdio", ...traceFlag, ...cliArgs],
  };
}

const TRACE_TRUTHY = new Set(["1", "true", "yes", "on"]);
export function isTraceLlmEnvSet(): boolean {
  return TRACE_TRUTHY.has(String(process.env.RIND_TRACE_LLM || "").trim().toLowerCase());
}

export function runHelpVersion({
  repoRoot = defaultRepoRoot,
  runtimePath = "",
  cliArgs = [],
  cwd = process.cwd(),
}: {
  repoRoot?: string;
  runtimePath?: string;
  cliArgs?: readonly string[];
  cwd?: string;
} = {}): number {
  const executable = resolveRuntimeExecutable(repoRoot, runtimePath);
  const result = spawnSync(executable.command, [...executable.args, ...cliArgs], {
    cwd,
    env: buildRuntimeEnv(repoRoot, process.env, {
      sourceRuntime: isJsRuntimePath(runtimePath),
      command: executable.command,
    }),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

interface PendingCallbackEntry {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout> | null;
}

export interface RuntimeClientOptions {
  repoRoot?: string;
  cliArgs?: readonly string[];
  cwd?: string;
  rindHome?: string;
  runtimePath?: string;
  externalTools?: unknown;
  env?: NodeJS.ProcessEnv | null;
  onMessage?: ((message: any) => void) | null;
  onRequest?: ((message: any) => unknown | Promise<unknown>) | null;
  onStderr?: (chunk: string) => void;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    info: { closing: boolean; error: Error },
  ) => void;
  spawnProcess?: typeof spawn;
}

export interface RuntimeClientInstance {
  readonly child: ChildProcessWithoutNullStreams | null;
  start: () => ChildProcessWithoutNullStreams;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  shutdown: () => Promise<void>;
  forceShutdown: () => void;
  isClosing: () => boolean;
}

export function createRuntimeClient({
  repoRoot = defaultRepoRoot,
  cliArgs = [],
  cwd = process.cwd(),
  rindHome = process.env.RIND_HOME,
  runtimePath = process.env.RIND_RUNTIME_PATH || "",
  externalTools = null,
  env = null,
  onMessage = null,
  onRequest = null,
  onStderr = () => {},
  onExit = () => {},
  spawnProcess = spawn,
}: RuntimeClientOptions = {}): RuntimeClientInstance {
  const handleEvent = onMessage;
  const launch = resolveRuntimeLaunch({ repoRoot, runtimePath, cliArgs });

  let nextId = 1;
  let stderrBuffer = "";
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let exitHandled = false;
  const pending = new Map<RequestId, PendingCallbackEntry>();
  let child: ChildProcessWithoutNullStreams | null = null;

  function start(): ChildProcessWithoutNullStreams {
    if (child && !child.killed && child.exitCode === null) {
      return child;
    }
    if (closing) {
      throw new Error("Runtime is shutting down.");
    }
    stderrBuffer = "";
    exitHandled = false;
    child = spawnProcess(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      env: buildRuntimeEnv(
        repoRoot,
        {
          ...process.env,
          ...(env || {}),
          RIND_EXTERNAL_TOOLS: externalTools ? JSON.stringify(externalTools) : "",
        },
        {
          sourceRuntime: isJsRuntimePath(runtimePath),
          command: launch.command,
          rindHome,
        },
      ),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const stdoutLines = createLineBuffer((line) => {
      if (line) {
        receive(line);
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutLines.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-4096);
      onStderr(chunk);
    });
    child.once("error", (error: Error) => {
      handleExit(null, null, error);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      handleExit(code, signal);
    });
    return child;
  }

  function handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    cause: Error | null = null,
  ): void {
    if (exitHandled) {
      return;
    }
    exitHandled = true;
    clearKillTimer();
    const startupError = stderrBuffer.match(/^(?:Startup|Session|Runtime) error: (.+)$/m)?.[1]?.trim();
    const error = cause || new Error(startupError || `Runtime exited with ${signal || code}`);
    for (const entry of pending.values()) {
      clearRequestTimer(entry);
      entry.reject(error);
    }
    pending.clear();
    child = null;
    onExit(code, signal, { closing, error });
  }

  function request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin.writable || child.killed) {
        reject(new Error("Runtime is not running. Start it before sending a request."));
        return;
      }
      const entry: PendingCallbackEntry = { resolve, reject };
      if (!isLongRunningRequest(method, params)) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Runtime request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method}`));
        }, REQUEST_TIMEOUT_MS);
        entry.timer.unref?.();
      }
      pending.set(id, entry);
      child.stdin.write(
        JSON.stringify(createRuntimeRequest(id, method, params)) + "\n",
        (error) => {
          if (!error) return;
          pending.delete(id);
          clearRequestTimer(entry);
          reject(error);
        },
      );
    });
  }

  function receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isRuntimeResponse(message)) {
      finishRequest(message);
      return;
    }
    if (isRuntimeEvent(message)) {
      handleEvent?.(message);
      return;
    }
    if (message?.kind === "event" && message.method === "rind/auth/update") {
      handleEvent?.(message);
      return;
    }
    if (isRuntimeRequest(message)) {
      Promise.resolve(onRequest?.(message) || {})
        .then((result: any) =>
          child?.stdin?.write(
            JSON.stringify({
              kind: "request",
              request_id: message.request_id,
              method: message.method,
              params: { value: result?.value ?? result ?? "" },
            }) + "\n",
          ),
        )
        .catch(() =>
          child?.stdin?.write(
            JSON.stringify({
              kind: "request",
              request_id: message.request_id,
              method: message.method,
              params: { value: "" },
            }) + "\n",
          ),
        );
    }
  }

  function finishRequest(message: any): void {
    const id = runtimeRequestId(message);
    if (id === undefined) return;
    const callbacks = pending.get(id);
    if (!callbacks) return;
    pending.delete(id);
    clearRequestTimer(callbacks);
    if (message.error) {
      callbacks.reject(
        Object.assign(new Error(message.error.message || "Runtime request failed"), {
          code: message.error.type,
        }),
      );
    } else {
      callbacks.resolve(message.result);
    }
  }

  function clearRequestTimer(entry: PendingCallbackEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    if (!child) return Promise.resolve();
    const runtime = child;
    if (runtime.exitCode !== null || runtime.signalCode !== null) {
      return runtime.exitCode === 0
        ? Promise.resolve()
        : Promise.reject(
            new Error(`Runtime already exited with ${runtime.signalCode || runtime.exitCode}`),
          );
    }
    const exited = new Promise<{ code?: number | null; signal?: NodeJS.Signals | null; error?: Error }>(
      (resolve) => {
        runtime.once("close", (code, signal) => resolve({ code, signal }));
        runtime.once("error", (error) => resolve({ error }));
      },
    );
    let shutdownError: Error | null = null;
    killTimer = setTimeout(() => {
      shutdownError = new Error(
        `Runtime shutdown timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s; forced termination.`,
      );
      forceShutdown();
    }, SHUTDOWN_TIMEOUT_MS);
    killTimer.unref?.();
    shutdownPromise = request(runtimeMethods.shutdown)
      .catch((error: Error) => {
        shutdownError ??= error;
      })
      .then(async () => {
        closeInput();
        const { code, signal, error } = await exited;
        if (error) throw error;
        if (code !== 0) {
          throw shutdownError || new Error(`Runtime exited during shutdown with ${signal || code}`);
        }
      })
      .finally(clearKillTimer);
    return shutdownPromise;
  }

  function forceShutdown(): void {
    closing = true;
    clearKillTimer();
    if (child && !child.killed && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill races during shutdown.
      }
    }
  }

  function closeInput(): void {
    if (child?.stdin.writable) {
      child.stdin.end();
    }
  }

  function clearKillTimer(): void {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = null;
  }

  return {
    get child() {
      return child;
    },
    start,
    request,
    shutdown,
    forceShutdown,
    isClosing: () => closing,
  };
}
