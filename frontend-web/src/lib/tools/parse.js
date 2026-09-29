// Parsing helpers shared by the per-tool formatters. Tool entries carry
// `args` (a JSON string that may still be streaming, or an object) and
// `result` (a `{ok, data, meta, error}` JSON payload, or plain text).

const STACK_LINE = /^(Traceback \(most recent call last\)|\s+at\s|\s+File ")/;

export function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return partialJsonStrings(value);
  }
}

// Arguments stream in as incomplete JSON. Pull out every `"key": "value"`
// string pair seen so far (the last one may be unterminated) so the row
// target and the write/edit body fill in while the model is still typing.
export function partialJsonStrings(text) {
  const source = String(text || "");
  const pattern = /"([A-Za-z_][\w-]*)"\s*:\s*"/g;
  const found = {};
  let match = pattern.exec(source);
  while (match) {
    const { value, end } = readJsonString(source, pattern.lastIndex);
    if (!(match[1] in found)) found[match[1]] = value;
    pattern.lastIndex = end;
    match = pattern.exec(source);
  }
  return found;
}

function readJsonString(source, start) {
  let index = start;
  let raw = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\"") return { value: decodeJsonString(raw), end: index + 1 };
    if (char === "\\") {
      if (index + 1 >= source.length) break; // escape still streaming
      raw += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    raw += char;
    index += 1;
  }
  return { value: decodeJsonString(raw), end: source.length };
}

function decodeJsonString(raw) {
  const safe = raw.replace(/\\u(?![0-9a-fA-F]{4})[0-9a-fA-F]{0,3}$/, "");
  try {
    return JSON.parse(`"${safe}"`);
  } catch {
    return safe.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

export function parseToolResult(value) {
  if (value && typeof value === "object") return Array.isArray(value) ? { data: value } : value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { data: parsed };
    return parsed && typeof parsed === "object" ? parsed : { data: value };
  } catch {
    return { data: value }; // plain-text result is still renderable
  }
}

export function payloadParts(tool) {
  const payload = parseToolResult(tool?.result ?? tool?.output ?? tool?.content ?? "");
  const data = payload.data;
  return {
    payload,
    data,
    record: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    list: Array.isArray(data) ? data : [],
    text: typeof data === "string" ? data : "",
    meta: pickObject(payload.meta),
  };
}

export function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function singleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function firstText(...values) {
  for (const value of values) {
    const text = singleLine(value);
    if (text) return text;
  }
  return "";
}

export function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

export function textLines(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return text ? text.split("\n") : [];
}

export function basename(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

export function urlParts(value) {
  try {
    const url = new URL(String(value || ""));
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return { domain: url.hostname.replace(/^www\./, ""), path };
  } catch {
    return { domain: singleLine(value), path: "" };
  }
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// Error text split for display: the first lines (at most `limit`, stopping
// before a stack trace) and the remainder behind "Show details".
export function splitError(text, limit = 6) {
  const lines = textLines(text);
  if (!lines.length) return null;
  const stackAt = lines.findIndex((line) => STACK_LINE.test(line));
  const cut = Math.min(limit, stackAt > 0 ? stackAt : lines.length);
  return { lines: lines.slice(0, cut), details: lines.slice(cut).join("\n") };
}

export function errorMessage(payload, fallback) {
  const error = payload?.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") return String(error.message || error.detail || JSON.stringify(error));
  return String(fallback || "");
}
