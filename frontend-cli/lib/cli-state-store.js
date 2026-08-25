import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// CLI-owned runtime preferences, separate from the shared ~/.rind/settings.json
// that the Python runtime manages (apiKey/model/baseUrl).
export function cliStatePath(rindHome = process.env.RIND_HOME || path.join(homedir(), ".rind")) {
  return path.join(String(rindHome), "cli-state.json");
}

export function loadCliState(rindHome) {
  try {
    const parsed = JSON.parse(readFileSync(cliStatePath(rindHome), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCliState(patch, rindHome) {
  const file = cliStatePath(rindHome);
  try {
    const next = { ...loadCliState(rindHome), ...patch };
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
