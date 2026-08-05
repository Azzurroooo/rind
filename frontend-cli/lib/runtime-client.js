import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { buildRuntimeEnv } from "./runtime-env.js";
import { createRuntimeRequest, runtimeRequestId } from "./runtime-protocol.js";

export function runHelpVersion({ python, repoRoot, cliArgs, cwd = process.cwd() }) {
  const result = spawnSync(python, [path.join(repoRoot, "main.py"), ...cliArgs], {
    cwd,
    env: buildRuntimeEnv(repoRoot),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

export function createRuntimeClient({
  python,
  repoRoot,
  cliArgs = [],
  cwd = process.cwd(),
  onEvent = () => {},
  onMessage = null,
  onStderr = () => {},
  onExit = () => {},
}) {
  const handleEvent = onMessage || onEvent;
  const runtimeBootstrap = [
    "import os, runpy, sys",
    `repo = os.path.abspath(${JSON.stringify(repoRoot)})`,
    "cwd = os.path.abspath(os.getcwd())",
    "blocked = {os.path.normcase(repo), os.path.normcase(cwd)}",
    "sys.path = [repo] + [p for p in sys.path if p and os.path.normcase(os.path.abspath(p)) not in blocked]",
    "runpy.run_module('agent.interfaces.runtime_server.stdio', run_name='__main__')",
  ].join("; ");

  let nextId = 1;
  let stdoutBuffer = "";
  let closing = false;
  let killTimer = null;
  const pending = new Map();
  const child = spawn(python, ["-c", runtimeBootstrap, ...cliArgs], {
    cwd,
    env: buildRuntimeEnv(repoRoot),
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
  child.on("exit", (code, signal) => {
    clearKillTimer();
    for (const { reject } of pending.values()) {
      reject(new Error(`Runtime exited with ${signal || code}`));
    }
    pending.clear();
    onExit(code, signal, { closing });
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (!child.stdin.writable || child.destroyed) {
        reject(new Error("Runtime stdin is closed"));
        return;
      }
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(createRuntimeRequest(id, method, params)) + "\n", (error) => {
        if (!error) {
          return;
        }
        pending.delete(id);
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
    if (message.kind === "response") {
      finishRequest(message);
      return;
    }
    if (message.kind === "event") {
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
    if (message.error) {
      callbacks.reject(new Error(message.error.message || "Runtime request failed"));
    } else {
      callbacks.resolve(message.result);
    }
  }

  function shutdown() {
    if (closing) {
      return Promise.resolve();
    }
    closing = true;
    scheduleKill();
    return request("shutdown").catch(() => {
      forceShutdown();
    }).finally(() => {
      if (child.stdin.writable) {
        child.stdin.end();
      }
    });
  }

  function forceShutdown() {
    closing = true;
    clearKillTimer();
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill races during shutdown.
      }
    }
  }

  function closeInput() {
    if (child.stdin.writable) {
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
    child,
    request,
    shutdown,
    forceShutdown,
    closeInput,
    isClosing: () => closing,
  };
}
