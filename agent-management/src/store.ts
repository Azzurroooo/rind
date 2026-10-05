import { open, readFile, rename, truncate } from "node:fs/promises";
import path from "node:path";
import { emptyState, requireValue, type State } from "./model.js";
import { privateDirectory } from "./paths.js";

type Changes = Partial<Record<Exclude<keyof State, "seq">, Record<string, unknown>>>;
interface Entry { seq: number; changes: Changes }
export async function openStore(directory: string, rotateEvery = 256) {
  await privateDirectory(directory);
  const journal = path.join(directory, "events.jsonl");
  const snapshot = path.join(directory, "snapshot.json");
  let state = emptyState();
  try { state = JSON.parse(await readFile(snapshot, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  requireValue(Number.isSafeInteger(state.seq), "CORRUPT_STORE", "Invalid management snapshot.");
  let raw = "";
  try { raw = await readFile(journal, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const tail = raw.lastIndexOf("\n") + 1;
  if (tail !== raw.length) await truncate(journal, Buffer.byteLength(raw.slice(0, tail)));
  let previous = 0;
  for (const line of raw.slice(0, tail).split("\n").filter(Boolean)) {
    const entry: Entry = JSON.parse(line);
    requireValue(Number.isSafeInteger(entry.seq) && (previous === 0 || entry.seq === previous + 1), "CORRUPT_STORE", "Management journal sequence is corrupt.");
    previous = entry.seq;
    if (entry.seq <= state.seq) continue;
    requireValue(entry.seq === state.seq + 1, "CORRUPT_STORE", "Management journal has a gap.");
    apply(state, entry);
  }
  let fatal: unknown;
  return {
    get state() { return state; },
    async commit(next: State) {
      if (fatal) throw fatal;
      const changes: Changes = {};
      for (const table of Object.keys(state).filter(key => key !== "seq") as (keyof Changes)[]) {
        const delta: Record<string, unknown> = {};
        for (const id of new Set([...Object.keys(state[table]), ...Object.keys(next[table])])) {
          const before = (state[table] as Record<string, unknown>)[id];
          const after = (next[table] as Record<string, unknown>)[id];
          if (JSON.stringify(before) !== JSON.stringify(after)) delta[id] = after ?? null;
        }
        if (Object.keys(delta).length) changes[table] = delta;
      }
      if (!Object.keys(changes).length) return;
      const entry: Entry = { seq: state.seq + 1, changes };
      try {
        const file = await open(journal, "a", 0o600);
        try { await file.writeFile(JSON.stringify(entry) + "\n"); await file.sync(); }
        finally { await file.close(); }
        next.seq = entry.seq;
        state = next;
        if (state.seq % rotateEvery === 0) {
          const temporary = snapshot + ".tmp";
          const file = await open(temporary, "w", 0o600);
          try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
          finally { await file.close(); }
          await rename(temporary, snapshot);
          if (process.platform !== "win32") {
            const parent = await open(directory, "r");
            try { await parent.sync(); } finally { await parent.close(); }
          }
          // Either the previous journal or an empty journal can recover from this snapshot.
          const journalFile = await open(journal, "r+");
          try { await journalFile.truncate(0); await journalFile.sync(); }
          finally { await journalFile.close(); }
        }
      } catch (error) { fatal = error; throw error; }
    },
  };
}
function apply(state: State, entry: Entry) {
  for (const [table, changes] of Object.entries(entry.changes)) {
    const records = state[table as keyof Changes] as Record<string, unknown>;
    requireValue(records && typeof changes === "object", "CORRUPT_STORE", "Unknown management table.");
    for (const [id, value] of Object.entries(changes)) {
      if (value === null) delete records[id]; else records[id] = value;
    }
  }
  state.seq = entry.seq;
}
export type Store = Awaited<ReturnType<typeof openStore>>;
