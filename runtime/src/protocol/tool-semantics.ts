// Pure, platform-independent tool payload and status helpers shared across
// CLI, Web, Desktop, and Mobile surfaces (no Node built-ins).

export interface StructuredToolPayload {
  structured: boolean;
  payload: Record<string, unknown>;
  parsed: unknown;
}

export type TaskStatusCategory = "" | "running" | "error" | "cancelled" | "success";

export interface ToolTruncationInfo {
  truncated: boolean;
  totalBytes: number | null;
  nextOffset: number | null;
  hasMorePages: boolean;
}

export function partialJsonStrings(text: unknown): Record<string, string> {
  const source = String(text || "");
  const pattern = /"([A-Za-z_][\w-]*)"\s*:\s*"/g;
  const found: Record<string, string> = {};
  let match = pattern.exec(source);
  while (match) {
    const { value, end } = readJsonString(source, pattern.lastIndex);
    if (!(match[1] in found)) found[match[1]] = value;
    pattern.lastIndex = end;
    match = pattern.exec(source);
  }
  return found;
}

function readJsonString(source: string, start: number): { value: string; end: number } {
  let index = start;
  let raw = "";
  while (index < source.length) {
    const char = source[index];
    if (char === '"') return { value: decodeJsonString(raw), end: index + 1 };
    if (char === "\\") {
      if (index + 1 >= source.length) break;
      raw += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    raw += char;
    index += 1;
  }
  return { value: decodeJsonString(raw), end: source.length };
}

function decodeJsonString(raw: string): string {
  const safe = raw.replace(/(^|[^\\])((?:\\\\)*)\\u([0-9a-fA-F]{0,3})$/, "$1$2");
  try {
    return JSON.parse(`"${safe}"`) as string;
  } catch {
    return safe
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

export function parseStructuredToolPayload(value: unknown): StructuredToolPayload {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return { structured: false, payload: {}, parsed: value };
    return {
      structured: true,
      payload: value as Record<string, unknown>,
      parsed: value,
    };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { structured: false, payload: {}, parsed: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        structured: true,
        payload: parsed as Record<string, unknown>,
        parsed,
      };
    }
    return { structured: false, payload: {}, parsed };
  } catch {
    return { structured: false, payload: {}, parsed: undefined };
  }
}

const TASK_RUNNING_STATES = new Set(["starting", "running", "cancelling"]);
const TASK_ERROR_STATES = new Set(["failed", "timed_out", "lost"]);

export function classifyTaskStatus(status: unknown): TaskStatusCategory {
  const value = String(status ?? "").trim().toLowerCase();
  if (!value) return "";
  if (TASK_RUNNING_STATES.has(value)) return "running";
  if (TASK_ERROR_STATES.has(value)) return "error";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "success";
}

export function toolTruncationMeta(meta: unknown): ToolTruncationInfo {
  const obj =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const truncated = obj.truncated === true;
  const rawBytes = obj.total_bytes;
  const parsedBytes = Number(rawBytes);
  const totalBytes =
    rawBytes !== undefined && rawBytes !== null && rawBytes !== "" && Number.isFinite(parsedBytes)
      ? parsedBytes
      : null;
  const rawNext = obj.next_offset;
  const parsedNext = Number(rawNext);
  const nextOffset =
    rawNext !== undefined && rawNext !== null && rawNext !== "" && Number.isFinite(parsedNext)
      ? parsedNext
      : null;
  return {
    truncated,
    totalBytes,
    nextOffset,
    hasMorePages: truncated || nextOffset !== null,
  };
}

export function unwrapNestedToolData(rawData: unknown): Record<string, unknown> {
  let current: Record<string, unknown> =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  if (typeof rawData === "string") {
    const { structured, payload } = parseStructuredToolPayload(rawData);
    if (structured) current = payload;
  }
  if (current.result && typeof current.result === "object" && !Array.isArray(current.result)) {
    return current.result as Record<string, unknown>;
  }
  return current;
}
