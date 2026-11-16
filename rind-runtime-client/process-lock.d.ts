export function acquireProcessLock(
  lockPath: string,
  timeoutMs?: number,
): Promise<{ release(): Promise<void> } | null>;
