import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildIdSource =
  | { root: string; extensions: readonly string[] }
  | { file: string };

const cache = new Map<string, Promise<string>>();
const SKIP = new Set(["node_modules", ".git", "test", "tests"]);

async function files(root: string, extensions: readonly string[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> | string[] => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : files(full, extensions);
      return extensions.includes(path.extname(entry.name)) ? [full] : [];
    }),
  );
  return nested.flat();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRuntimeDist = path.resolve(here, "..");

export function runtimeBuildId({
  repoRoot = "",
  runtimePath = "",
}: {
  repoRoot?: string;
  runtimePath?: string;
} = {}): Promise<string> {
  return buildId([
    { root: here, extensions: [".js"] },
    ...(runtimePath
      ? [{ file: runtimePath }]
      : [
          {
            root: repoRoot ? path.join(repoRoot, "runtime", "dist") : defaultRuntimeDist,
            extensions: [".js"],
          },
        ]),
  ]);
}

function hashFile(hash: Hash, file: string): Promise<void> {
  return new Promise((resolve) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", () => {
        hash.update("missing");
        resolve();
      });
  });
}

export function buildId(sources: readonly BuildIdSource[]): Promise<string> {
  const key = JSON.stringify(sources);
  let existing = cache.get(key);
  if (!existing) {
    existing = (async () => {
      const hash = createHash("sha256");
      for (const source of sources) {
        if ("file" in source) {
          hash.update(path.basename(source.file) + "\0");
          await hashFile(hash, source.file);
          hash.update("\0");
          continue;
        }
        const list = (await files(source.root, source.extensions)).sort();
        for (const file of list) {
          hash
            .update(path.relative(source.root, file) + "\0")
            .update(await readFile(file))
            .update("\0");
        }
      }
      return hash.digest("hex").slice(0, 16);
    })();
    cache.set(key, existing);
  }
  return existing;
}
