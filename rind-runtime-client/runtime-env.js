export function buildRuntimeEnv(_repoRoot, baseEnv = process.env, { sourceRuntime = true, rindHome } = {}) {
  const env = { ...baseEnv };
  if (rindHome) {
    env.RIND_HOME = rindHome;
  }
  if (sourceRuntime && process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}
