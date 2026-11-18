// Parsing helpers shared by the per-tool formatters. Tool entries carry
// `args` (a JSON string that may still be streaming, or an object) and
// `result` (a `{ok, data, meta, error}` JSON payload, or plain text).
import { parseStructuredToolPayload, partialJsonStrings } from "../../../../runtime/dist/protocol/tool-semantics.js";

export { partialJsonStrings };

const STACK_LINE = /^(Traceback \(most recent call last\)|\s+at\s|\s+File ")/;

export function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  const { structured, payload } = parseStructuredToolPayload(value);
  return structured ? payload : partialJsonStrings(value);
}

export function parseToolResult(value) {
  if (value && typeof value === "object") return Array.isArray(value) ? { data: value } : value;
  if (typeof value !== "string" || !value) return {};
  const { structured, payload, parsed } = parseStructuredToolPayload(value);
  if (structured) return payload;
  if (Array.isArray(parsed)) return { data: parsed };
  return { data: value }; // plain-text result is still renderable
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
