export function buildRuntimeEnv(
  _repoRoot: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  {
    sourceRuntime = true,
    command = "",
    rindHome,
  }: {
    sourceRuntime?: boolean;
    command?: string;
    rindHome?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (rindHome) {
    env.RIND_HOME = rindHome;
  }
  if (process.versions?.electron && (sourceRuntime || command === process.execPath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}
