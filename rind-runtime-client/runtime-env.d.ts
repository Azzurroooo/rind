export function resolveSourcePython(python: string | null | undefined, repoRoot: string): string;
export function buildRuntimeEnv(
  repoRoot: string,
  baseEnv?: Record<string, string | undefined>,
  options?: { sourceRuntime?: boolean; rindHome?: string },
): Record<string, string | undefined>;
