export function buildRuntimeEnv(
  repoRoot: string,
  baseEnv?: Record<string, string | undefined>,
  options?: { sourceRuntime?: boolean; rindHome?: string },
): Record<string, string | undefined>;
