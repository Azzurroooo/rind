import { writeFileSync } from "node:fs";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A conversation opened from Agents runs as a child window. When the user
// moves elsewhere from inside it, the child does not open a nested window:
// it writes where to go next and exits, and the window that opened it acts.
// So there is never more than one level, and "leave Rind" reaches every level.
//
//   { action: "agents", from }         show the Agents page; `from` is the
//                                      { runtimeSessionId, workspace } it left
//   { action: "leave" }                leave Rind entirely; agents keep running
//   { action: "open", chat: {...} }    open another conversation instead
//   { action: "failed", error }        it could not start; the opener shows why
// A window that exits without a decision reads as { action: "return" }: go
// back to whatever opened it.
export const HANDOFF_ENV = "RIND_AGENTS_HANDOFF";
const ACTIONS = new Set(["agents", "leave", "open", "failed"]);

// Read once at startup and removed from the environment, so background
// services and tools started from this window never inherit it.
export function takeHandoffPath(env = process.env) {
  const file = env[HANDOFF_ENV] || "";
  delete env[HANDOFF_ENV];
  return file;
}

// Best effort: a missing opener means there is nobody to hand off to.
export async function writeHandoff(next, file) {
  if (!file) return false;
  try { await writeFile(file, JSON.stringify(next), { mode: 0o600 }); return true; } catch { return false; }
}
// For a forced exit, which may not wait for anything.
export function writeHandoffSync(next, file) {
  if (!file) return false;
  try { writeFileSync(file, JSON.stringify(next), { mode: 0o600 }); return true; } catch { return false; }
}

export async function createHandoff() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rind-handoff-"));
  const file = path.join(directory, "next.json");
  return {
    file,
    async read() {
      try {
        const value = JSON.parse(await readFile(file, "utf8"));
        const complete = value?.action === "open" ? Boolean(value.chat) : value?.action === "failed" ? typeof value.error === "string" : true;
        if (ACTIONS.has(value?.action) && complete) return value;
      } catch {}
      return { action: "return" };
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
