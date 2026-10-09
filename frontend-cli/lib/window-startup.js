// A window's startup: from launch until it reads keys, it connects to Agents
// management and the Runtime and restores the conversation. Each step is
// written to RIND_HOME/logs/window-<pid>.log with its time, and so is any
// stretch where the event loop was blocked, so a window that seems frozen
// can be told apart: still waiting on a step, or busy drawing.
//
// Until the window reads keys itself, Esc or Ctrl+C cancels the startup.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { releaseInput, takeInput } from "./tui/console-input.js";

const KEEP_LOGS = 20;
const BLOCKED_MS = 500;
const ESC = "\x1b", CTRL_C = "\x03";

export function windowLogPath(home = process.env.RIND_HOME || path.join(os.homedir(), ".rind"), pid = process.pid) {
  return path.join(home, "logs", "window-" + pid + ".log");
}

export function createWindowLog({ file = windowLogPath(), now = Date.now, keep = KEEP_LOGS } = {}) {
  const started = now();
  let ready = true;
  // This window's own log is about to be written; it counts as one of those kept.
  try { mkdirSync(path.dirname(file), { recursive: true }); prune(path.dirname(file), keep - 1); }
  catch { ready = false; }
  // Logging never gets in the window's way: a failed write is dropped.
  function write(text) {
    if (!ready) return;
    try { appendFileSync(file, new Date(now()).toISOString() + " +" + (now() - started) + "ms " + text + "\n"); } catch { ready = false; }
  }
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const timer = setInterval(() => {
    const worst = delay.max / 1e6;
    if (worst > BLOCKED_MS) write("event loop blocked " + Math.round(worst) + "ms");
    delay.reset();
  }, 1000);
  timer.unref?.();
  return {
    file,
    step: name => write(name),
    close() { clearInterval(timer); delay.disable(); },
  };
}

// The newest `keep` logs stay; a window that is still running keeps writing to its own.
function prune(directory, keep) {
  const logs = readdirSync(directory).filter(name => /^window-\d+\.log$/.test(name))
    .map(name => ({ name, at: statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const { name } of logs.slice(keep)) { try { unlinkSync(path.join(directory, name)); } catch {} }
}

// Reads Esc and Ctrl+C until the window takes the keyboard (stop), and says
// so on the line it will clear. Arrow keys also begin with Esc; only a lone
// Esc cancels.
export function guardStartup({ input = process.stdin, output = process.stdout, onCancel, label = "Opening conversation…  esc goes back" }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return { stop() {} };
  const raw = Boolean(input.isRaw);
  let active = true;
  const onData = chunk => {
    const text = String(chunk);
    if (text === ESC || text.includes(CTRL_C)) { stop(); onCancel(text === ESC ? "esc" : "ctrl+c"); }
  };
  function stop() {
    if (!active) return;
    active = false;
    input.off("data", onData);
    releaseInput(input, raw);
    output.write("\r\x1b[2K");
  }
  input.on("data", onData);
  takeInput(input);
  output.write("\x1b[2m" + label + "\x1b[0m");
  return { stop };
}
