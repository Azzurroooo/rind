export function buildRuntimeEnv(_repoRoot, baseEnv = process.env, { sourceRuntime = true, command = "", rindHome } = {}) {
  const env = { ...baseEnv };
  if (rindHome) {
    env.RIND_HOME = rindHome;
  }
  if (process.versions?.electron && (sourceRuntime || command === process.execPath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}
