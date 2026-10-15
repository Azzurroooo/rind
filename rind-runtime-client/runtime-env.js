import path from "node:path";
import { existsSync } from "node:fs";

export function resolveSourcePython(python, repoRoot) {
  if (python && python !== "python" && python !== "python3") return python;
  const windows = process.platform === "win32";
  const candidate = path.join(repoRoot, ".venv", windows ? "Scripts" : "bin", windows ? "python.exe" : "python");
  return existsSync(candidate) ? candidate : python || (windows ? "python" : "python3");
}

export function buildRuntimeEnv(repoRoot, baseEnv = process.env, { sourceRuntime = true, rindHome } = {}) {
  const env = { ...baseEnv };
  if (rindHome) {
    env.RIND_HOME = rindHome;
  }
  if (!sourceRuntime) {
    return env;
  }
  return {
    ...env,
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: prependPath(repoRoot, baseEnv.PYTHONPATH),
    PYTHONUTF8: "1",
  };
}

function prependPath(entry, value) {
  return value ? `${entry}${path.delimiter}${value}` : entry;
}
