export function createLineBuffer(
  onLine: (line: string) => void,
  options?: { maxBytes?: number; onOverflow?: () => void },
): {
  push(chunk: string | Buffer): boolean;
  reset(): void;
};
