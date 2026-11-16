export function createLineBuffer(onLine, { maxBytes = 0, onOverflow = null } = {}) {
  const pending = [];
  let pendingBytes = 0;
  let failed = false;

  function reset() {
    pending.length = 0;
    pendingBytes = 0;
    failed = false;
  }

  function push(chunk) {
    if (failed) return false;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(0x0a, start);
      const part = bytes.subarray(start, end === -1 ? bytes.length : end);
      pendingBytes += part.length;
      // The limit covers a frame, excluding LF (including an optional CR).
      if (maxBytes > 0 && pendingBytes > maxBytes) {
        reset();
        failed = true;
        onOverflow?.();
        return false;
      }
      if (part.length) pending.push(part);
      if (end === -1) break;
      let line = (pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)).toString("utf8");
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
