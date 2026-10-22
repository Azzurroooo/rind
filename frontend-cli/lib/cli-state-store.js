import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTheme } from "./theme.js";

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedState = null;
let briefMode = false;

export const DEFAULT_SPINNER = "orbit";
export const DEFAULT_MAX_CONCURRENT_RUNS = 128;
export const CONCURRENT_RUN_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128, 256, 512]);

const SPINNERS = Object.freeze([
  {
    name: "sweep",
    label: "Sweep",
    frames: Object.freeze(["█▒░░░", "▒█▒░░", "░▒█▒░", "░░▒█▒", "░░░▒█", "░░▒█▒", "░▒█▒░", "▒█▒░░"]),
  },
  {
    name: "pulse",
    label: "Pulse",
    frames: Object.freeze(["░", "▒", "▓", "█", "▓", "▒"]),
  },
  {
    name: "bars",
    label: "Bars",
    frames: Object.freeze(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"]),
  },
  {
    name: "orbit",
    label: "Orbit",
    frames: Object.freeze(["◐", "◓", "◑", "◒"]),
  },
]);

let activeSpinner = SPINNERS[3];
let maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS;

export function getMaxConcurrentRuns() {
  return maxConcurrentRuns;
}

export function normalizeMaxConcurrentRuns(value) {
  const parsed = Number(String(value ?? "").trim());
  return CONCURRENT_RUN_OPTIONS.includes(parsed) ? parsed : null;
}

export function setMaxConcurrentRuns(value) {
  const normalized = normalizeMaxConcurrentRuns(value);
  if (!normalized) return null;
  maxConcurrentRuns = normalized;
  return maxConcurrentRuns;
}

export function resetMaxConcurrentRuns() {
  maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS;
  return maxConcurrentRuns;
}

export function concurrentRunOptions() {
  return CONCURRENT_RUN_OPTIONS.map((limit) => ({
    name: String(limit),
    label: String(limit),
    description: limit === DEFAULT_MAX_CONCURRENT_RUNS
      ? `${limit} concurrent agent runs (default)`
      : `${limit} concurrent agent runs`,
    current: limit === maxConcurrentRuns,
  }));
}

export function isBriefMode() {
  return briefMode;
}

export function setBriefMode(enabled) {
  briefMode = Boolean(enabled);
  return briefMode;
}

export function currentSpinner() {
  return { name: activeSpinner.name, label: activeSpinner.label, frames: activeSpinner.frames };
}

export function spinnerNames() {
  return SPINNERS.map((item) => item.name);
}

export function spinnerOptions() {
  return SPINNERS.map((item) => ({
    name: item.name,
    label: item.label,
    frames: item.frames,
    preview: item.frames.join(" "),
    current: item.name === activeSpinner.name,
  }));
}

export function setSpinner(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return null;
  const byIndex = /^[1-4]$/.test(key) ? SPINNERS[Number(key) - 1] : null;
  const found = byIndex || SPINNERS.find((item) => item.name === key || item.label.toLowerCase() === key);
  if (!found) return null;
  activeSpinner = found;
  return currentSpinner();
}

export function resetSpinner() {
  activeSpinner = SPINNERS[3];
  return currentSpinner();
}

export function spinnerFrame(frame) {
  const frames = activeSpinner.frames;
  const index = Math.floor(Math.abs(Number(frame) || 0)) % frames.length;
  return frames[index];
}

// CLI-owned runtime preferences, separate from the shared ~/.rind/settings.json
// that the Python runtime manages (apiKey/model/baseUrl).
export function cliStatePath(rindHome = process.env.RIND_HOME || path.join(homedir(), ".rind")) {
  return path.join(String(rindHome), "cli-state.json");
}

export function loadCliState(rindHome) {
  const file = cliStatePath(rindHome);
  try {
    const { mtimeMs } = statSync(file);
    if (cachedState && cachedPath === file && cachedMtimeMs === mtimeMs) {
      return { ...cachedState };
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    cachedPath = file;
    cachedMtimeMs = mtimeMs;
    cachedState = state;
    return { ...state };
  } catch {
    if (cachedPath === file) {
      cachedPath = "";
      cachedMtimeMs = -1;
      cachedState = null;
    }
    return {};
  }
}

export function saveCliState(patch, rindHome) {
  const file = cliStatePath(rindHome);
  if (patch && typeof patch === "object") {
    if ("brief" in patch) setBriefMode(patch.brief);
    if ("spinner" in patch && patch.spinner) setSpinner(patch.spinner);
    if ("maxConcurrentRuns" in patch) setMaxConcurrentRuns(patch.maxConcurrentRuns);
  }
  try {
    const next = { ...loadCliState(rindHome), ...patch };
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, file);
    cachedPath = file;
    cachedMtimeMs = statSync(file).mtimeMs;
    cachedState = next;
    return true;
  } catch {
    return false;
  }
}

// Every surface (chat and `rind agents`) draws with the preferences chosen in cli-state.json.
export function applySavedTheme(rindHome) {
  const { theme, brief, spinner, maxConcurrentRuns: savedRuns } = loadCliState(rindHome);
  if (theme) setTheme(theme);
  setBriefMode(brief === true);
  setSpinner(spinner || DEFAULT_SPINNER);
  if (!setMaxConcurrentRuns(savedRuns)) resetMaxConcurrentRuns();
}
