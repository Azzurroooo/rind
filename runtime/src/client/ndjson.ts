export interface LineBuffer {
  push: (chunk: string | Buffer | Uint8Array) => boolean;
  reset: () => void;
}

export function createLineBuffer(
  onLine: (line: string) => void,
  {
    maxBytes = 0,
    onOverflow = null,
  }: {
    maxBytes?: number;
    onOverflow?: (() => void) | null;
  } = {},
): LineBuffer {
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let failed = false;

  function reset(): void {
    pending.length = 0;
    pendingBytes = 0;
    failed = false;
  }

  function push(chunk: string | Buffer | Uint8Array): boolean {
    if (failed) return false;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(0x0a, start);
      const part = bytes.subarray(start, end === -1 ? bytes.length : end);
      pendingBytes += part.length;
      if (maxBytes > 0 && pendingBytes > maxBytes) {
        reset();
        failed = true;
        onOverflow?.();
        return false;
      }
      if (part.length) pending.push(part);
      if (end === -1) break;
      let line = (
        pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
      ).toString("utf8");
      pending.length = 0;
      pendingBytes = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
      start = end + 1;
    }
    return true;
  }

  return { push, reset };
}
