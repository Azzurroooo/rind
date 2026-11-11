export function buildRuntimeEnv(
  repoRoot: string,
  baseEnv?: Record<string, string | undefined>,
  options?: { sourceRuntime?: boolean; command?: string; rindHome?: string },
): Record<string, string | undefined>;
