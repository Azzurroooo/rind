import { StringDecoder } from "node:string_decoder";

export function createLineBuffer(onLine, { maxBytes = 0, onOverflow = null } = {}) {
  let decoder = null;
  let carry = "";
  const pending = [];
  let pendingLength = 0;

  function reset() {
    decoder = null;
    carry = "";
    pending.length = 0;
    pendingLength = 0;
  }

  function push(chunk) {
    const text = typeof chunk === "string"
      ? chunk
      : (decoder ??= new StringDecoder("utf8")).write(chunk);
    if (!text) return true;
    const nextLength = carry.length + pendingLength + text.length;
    if (maxBytes > 0 && nextLength > maxBytes) {
      reset();
      onOverflow?.();
      return false;
    }
    if (!text.includes("\n")) {
      pending.push(text);
      pendingLength += text.length;
      return true;
    }
    const combined = pending.length
      ? carry + pending.join("") + text
      : carry
        ? carry + text
        : text;
    pending.length = 0;
    pendingLength = 0;
    let start = 0;
    let end;
    while ((end = combined.indexOf("\n", start)) !== -1) {
      let line = combined.slice(start, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = end + 1;
      onLine(line);
    }
    carry = combined.slice(start);
    return true;
  }

  return { push, reset };
}
