import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A long-lived background process keeps running the code it started with.
// Clients compare this fingerprint of the code on disk with the one a running
// process reports, so an update is noticed instead of silently serving old
// behaviour. Only file contents count, so a reinstall of identical code is a match.
const cache = new Map();
const SKIP = new Set(["node_modules", "__pycache__", ".git", "test", "tests"]);

async function files(root, extensions) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : files(full, extensions);
    return extensions.includes(path.extname(entry.name)) ? [full] : [];
  }));
  return nested.flat();
}

const here = path.dirname(fileURLToPath(import.meta.url));

// The shared Runtime is this transport plus the Python worker (or the
// packaged worker binary when one is configured).
export const runtimeBuildId = ({ repoRoot = "", runtimePath = "" } = {}) => buildId([
  { root: here, extensions: [".js"] },
  ...(runtimePath ? [{ file: runtimePath }] : [{ root: path.join(repoRoot, "agent"), extensions: [".py"] }, { file: path.join(repoRoot, "main.py"), content: true }]),
]);

// sources: [{ root, extensions }], [{ file, content: true }], or [{ file }] for a
// packaged binary, which is identified by size and modification time.
export function buildId(sources) {
  const key = JSON.stringify(sources);
  if (!cache.has(key)) cache.set(key, (async () => {
    const hash = createHash("sha256");
    for (const source of sources) {
      if (source.file && source.content) {
        hash.update(source.file + "\0").update(await readFile(source.file).catch(() => "missing")).update("\0");
        continue;
      }
      if (source.file) {
        const info = await stat(source.file).catch(() => null);
        hash.update(source.file + ":" + (info ? info.size + ":" + info.mtimeMs : "missing") + "\n");
        continue;
      }
      const list = (await files(source.root, source.extensions)).sort();
      for (const file of list) hash.update(path.relative(source.root, file) + "\0").update(await readFile(file)).update("\0");
    }
    return hash.digest("hex").slice(0, 16);
  })());
  return cache.get(key);
}
