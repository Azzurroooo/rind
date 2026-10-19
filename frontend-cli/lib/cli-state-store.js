import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTheme } from "./theme.js";

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedState = null;
let briefMode = false;

export function isBriefMode() {
  return briefMode;
}

export function setBriefMode(enabled) {
  briefMode = Boolean(enabled);
  return briefMode;
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
  if (patch && typeof patch === "object" && "brief" in patch) {
    setBriefMode(patch.brief);
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
  const { theme, brief } = loadCliState(rindHome);
  if (theme) setTheme(theme);
  setBriefMode(brief === true);
}
