export function buildId(
  sources: Array<{ root?: string; extensions?: string[]; file?: string }>,
): Promise<string>;
export function runtimeBuildId(options?: {
  repoRoot?: string;
  runtimePath?: string;
}): Promise<string>;
