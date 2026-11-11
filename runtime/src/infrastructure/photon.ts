import type { PathOrFileDescriptor } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

export type PhotonModule = typeof import("@silvia-odwyer/photon-node");
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

const WASM_FILENAME = "photon_rs_bg.wasm";

let cachedPhoton: PhotonModule | null = null;

function pathOrNull(file: PathOrFileDescriptor): string | null {
  if (typeof file === "string") return file;
  if (file instanceof URL) return fileURLToPath(file);
  return null;
}

function getFallbackWasmPaths(): string[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const execDir = path.dirname(process.execPath);
  return [
    path.join(currentDir, WASM_FILENAME),
    path.resolve(currentDir, "..", WASM_FILENAME),
    path.resolve(currentDir, "..", "..", "node_modules", "@silvia-odwyer", "photon-node", WASM_FILENAME),
    path.join(execDir, WASM_FILENAME),
    path.join(execDir, "photon", WASM_FILENAME),
    path.join(process.cwd(), WASM_FILENAME),
  ];
}

function withPatchedWasmRead<T>(fn: () => T): T {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const fallbackPaths = getFallbackWasmPaths();
  const mutableFs = fs as { readFileSync: typeof fs.readFileSync };

  const patchedReadFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const [file, options] = args;
    const resolvedPath = pathOrNull(file);
    if (resolvedPath?.endsWith(WASM_FILENAME)) {
      try {
        return originalReadFileSync(...args);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== "ENOENT") {
          throw error;
        }
        for (const candidate of fallbackPaths) {
          if (!fs.existsSync(candidate)) continue;
          return options === undefined
            ? originalReadFileSync(candidate)
            : originalReadFileSync(candidate, options);
        }
        throw error;
      }
    }
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;

  try {
    mutableFs.readFileSync = patchedReadFileSync;
  } catch {
    Object.defineProperty(fs, "readFileSync", {
      value: patchedReadFileSync,
      writable: true,
      configurable: true,
    });
  }

  try {
    return fn();
  } finally {
    try {
      mutableFs.readFileSync = originalReadFileSync;
    } catch {
      Object.defineProperty(fs, "readFileSync", {
        value: originalReadFileSync,
        writable: true,
        configurable: true,
      });
    }
  }
}

export function loadPhotonSync(): PhotonModule {
  if (cachedPhoton) {
    return cachedPhoton;
  }
  cachedPhoton = withPatchedWasmRead(() => require("@silvia-odwyer/photon-node") as PhotonModule);
  return cachedPhoton;
}

export function resetPhotonCache(): void {
  cachedPhoton = null;
  try {
    const resolved = require.resolve("@silvia-odwyer/photon-node");
    delete require.cache[resolved];
  } catch {
    // ignore
  }
}

export async function loadPhoton(): Promise<PhotonModule> {
  return loadPhotonSync();
}
