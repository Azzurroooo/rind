import path from "node:path";

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
