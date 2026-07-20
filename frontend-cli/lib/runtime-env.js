import path from "node:path";

export function buildRuntimeEnv(repoRoot, baseEnv = process.env) {
  return {
    ...baseEnv,
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: prependPath(repoRoot, baseEnv.PYTHONPATH),
    PYTHONUTF8: "1",
  };
}

function prependPath(entry, value) {
  return value ? `${entry}${path.delimiter}${value}` : entry;
}
