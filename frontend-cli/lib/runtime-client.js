import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { buildRuntimeEnv } from "./runtime-env.js";
import {
  createRuntimeRequest,
  isRuntimeEvent,
  isRuntimeResponse,
  runtimeMethods,
  runtimeRequestId,
} from "./runtime-protocol.js";

export function resolveRuntimeLaunch({ python, repoRoot, runtimePath = "", cliArgs = [] }) {
  const executable = runtimePath
    ? { command: runtimePath, args: [] }
    : { command: python, args: [path.join(repoRoot, "main.py")] };
  const traceFlag = isTraceLlmEnvSet() ? ["--trace-llm"] : [];
  return {
    command: executable.command,
    args: [...executable.args, "app-server", "--stdio", ...traceFlag, ...cliArgs],
  };
}

const TRACE_TRUTHY = new Set(["1", "true", "yes", "on"]);
export function isTraceLlmEnvSet() {
  return TRACE_TRUTHY.has(String(process.env.RIND_TRACE_LLM || "").trim().toLowerCase());
}

// Turns stream for as long as the model runs; every other method must answer
// within a bounded window so a stalled runtime surfaces as an error, not silence.
const LONG_RUNNING_METHODS = new Set([runtimeMethods.sessionPrompt, runtimeMethods.sessionFollowUp]);
const REQUEST_TIMEOUT_MS = 120_000;

export function runHelpVersion({ python, repoRoot, runtimePath = "", cliArgs, cwd = process.cwd() }) {
  const executable = runtimePath
    ? { command: runtimePath, args: [] }
    : { command: python, args: [path.join(repoRoot, "main.py")] };
  const result = spawnSync(executable.command, [...executable.args, ...cliArgs], {
    cwd,
    env: buildRuntimeEnv(repoRoot, process.env, { sourceRuntime: !runtimePath }),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

export function createRuntimeClient({
  python,
  repoRoot,
  cliArgs = [],
  cwd = process.cwd(),
  rindHome = process.env.RIND_HOME,
  runtimePath = process.env.RIND_RUNTIME_PATH || "",
  onEvent = () => {},
  onMessage = null,
  onStderr = () => {},
  onExit = () => {},
}) {
  const handleEvent = onMessage || onEvent;
  const launch = resolveRuntimeLaunch({ python, repoRoot, runtimePath, cliArgs });

  let nextId = 1;
  let stdoutBuffer = "";
  let closing = false;
  let killTimer = null;
  let exitHandled = false;
  const pending = new Map();
  let child = null;

  function start() {
    if (child && !child.killed && child.exitCode === null) {
      return child;
    }
    if (closing) {
      throw new Error("Runtime is shutting down.");
    }
    stdoutBuffer = "";
    exitHandled = false;
    child = spawn(launch.command, launch.args, {
      cwd,
      env: buildRuntimeEnv(repoRoot, process.env, {
        sourceRuntime: !runtimePath,
        rindHome,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line) {
          receive(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => onStderr(chunk));
    child.once("error", (error) => {
      handleExit(null, null, error);
    });
    child.once("exit", (code, signal) => {
      handleExit(code, signal);
    });
    return child;
  }

  function handleExit(code, signal, cause = null) {
    if (exitHandled) {
      return;
    }
    exitHandled = true;
    clearKillTimer();
    const error = cause || new Error(`Runtime exited with ${signal || code}`);
    for (const entry of pending.values()) {
      clearRequestTimer(entry);
      entry.reject(error);
    }
    pending.clear();
    child = null;
    onExit(code, signal, { closing, error });
  }

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (!child && !closing) {
        try {
          start();
        } catch (error) {
          reject(error);
          return;
        }
      }
      if (!child || !child.stdin.writable || child.destroyed) {
        reject(new Error("Runtime stdin is closed. Restart Rind and try again."));
        return;
      }
      const entry = { resolve, reject };
      if (!LONG_RUNNING_METHODS.has(method)) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Runtime request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method}`));
        }, REQUEST_TIMEOUT_MS);
        entry.timer.unref?.();
      }
      pending.set(id, entry);
      child.stdin.write(JSON.stringify(createRuntimeRequest(id, method, params)) + "\n", (error) => {
        if (!error) {
          return;
        }
        pending.delete(id);
        clearRequestTimer(entry);
        reject(error);
      });
    });
  }

  function receive(line) {
    let message;
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
      handleEvent(message);
    }
  }

  function finishRequest(message) {
    const id = runtimeRequestId(message);
    const callbacks = pending.get(id);
    if (!callbacks) {
      return;
    }
    pending.delete(id);
    clearRequestTimer(callbacks);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || "Runtime request failed"));
    } else {
      callbacks.resolve(message.result);
    }
  }

  function clearRequestTimer(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function shutdown() {
    if (closing) {
      return Promise.resolve();
    }
    closing = true;
    if (!child) {
      return Promise.resolve();
    }
    scheduleKill();
    return request(runtimeMethods.shutdown).catch(() => {
      forceShutdown();
    }).finally(() => {
      if (child?.stdin.writable) {
        child.stdin.end();
      }
    });
  }

  function forceShutdown() {
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

  function closeInput() {
    if (child?.stdin.writable) {
      child.stdin.end();
    }
  }

  function scheduleKill() {
    clearKillTimer();
    killTimer = setTimeout(forceShutdown, 1500);
    killTimer.unref?.();
  }

  function clearKillTimer() {
    if (!killTimer) {
      return;
    }
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
    closeInput,
    isClosing: () => closing,
  };
}
