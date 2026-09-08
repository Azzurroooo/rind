// Tool display mapping (web-ui.md §2.2 / §6.6 工具块渲染).
//
// Ported from frontend-cli/lib/tool-display.js — the label/summary/detail/diff
// mapping LOGIC only, no TUI rendering. Pure functions: tool block entry in,
// display model out; ToolBlock.jsx just renders the model.
import { formatBytes } from "./files.js";

export const TOOL_OUTPUT_PREVIEW_LINES = 60;

// Read-only investigation tools whose individual rows carry little signal;
// long runs of them collapse into one group row (claude-code collapse pattern).
const LOW_STAKE_TOOLS = new Set(["read_file", "glob", "grep"]);
const TOOL_RUN_MIN = 3;

// Presentation-only grouping over the faithful entry stream: consecutive
// completed read/search calls merge into `{ kind: "tool-run", tools }`;
// anything else (running, failed, mutating, non-tool) breaks the run.
export function groupToolRuns(messages) {
  const output = [];
  let run = [];
  const flush = () => {
    if (run.length >= TOOL_RUN_MIN) output.push({ kind: "tool-run", tools: run });
    else output.push(...run);
    run = [];
  };
  for (const message of messages) {
    if (isGroupableTool(message)) run.push(message);
    else {
      flush();
      output.push(message);
    }
  }
  flush();
  return output;
}

function isGroupableTool(entry) {
  return entry?.role === "tool"
    && entry.status === "completed"
    && LOW_STAKE_TOOLS.has(String(entry.name || ""))
    && !failedMessage(entry);
}

const TOOL_LABELS = {
  bash: "Shell command",
  bash_output: "Background output",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  glob: "Find files",
  grep: "Search files",
  search_web: "Web search",
  web_search: "Web search",
  fetch_web_page: "Fetch web page",
  update_plan: "Update plan",
  ask_user_question: "Ask user",
  delegate: "Delegate task",
  agent_create: "Create agent",
  skill: "Load skill",
  skill_create: "Create skill",
};

export function toolLabel(name) {
  return TOOL_LABELS[String(name || "").trim()] || humanToolName(name);
}

export function humanToolName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "tool";
  return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// `args` may be a JSON string (args_preview) or an object; same for `result`.
export function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return parseObjectLoose(value);
}

export function parseToolResult(value) {
  if (value && typeof value === "object") {
    return Array.isArray(value) ? {} : value;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { data: value }; // plain-text result → still renderable as output
  }
}

export function payloadParts(tool) {
  const payload = parseToolResult(tool?.result ?? tool?.content ?? "");
  return {
    payload,
    data: payload.data && typeof payload.data === "object" ? payload.data : {},
    meta: pickObject(payload.meta),
  };
}

// One-line parameter summary for the collapsed row (level 1).
export function toolSummary(name, tool) {
  const args = parseToolArguments(tool?.args);
  const { data, meta } = payloadParts(tool);
  switch (name) {
    case "bash":
    case "bash_output": {
      const command = firstText(args.command, args.bg_id, data.bg_id);
      return command ? (name === "bash" ? `$ ${command}` : `bg ${command}`) : "";
    }
    case "read_file":
      return firstText(args.path, args.file_path, meta.path);
    case "write_file":
    case "edit_file":
      return firstText(args.file_path, args.path, firstMetaFilePath(meta));
    case "glob":
      return firstText(args.pattern, meta.pattern);
    case "grep":
      return firstText(args.pattern, meta.pattern);
    case "search_web":
    case "web_search":
      return firstText(args.query, args.search, meta.query);
    case "fetch_web_page":
      return firstText(args.url, meta.url);
    case "update_plan":
      return "Plan updated";
    case "ask_user_question":
      return String(args.question || "").slice(0, 120);
    default: {
      const generic = firstKeyArg(args);
      return generic || summarizeValue(data ?? payload.message ?? "");
    }
  }
}

// Key/value rows for level 2 (expanded detail).
export function toolDetails(name, tool) {
  const args = parseToolArguments(tool?.args);
  const { payload, data, meta } = payloadParts(tool);
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && String(value) !== "") rows.push({ label, value: String(value) });
  };
  switch (name) {
    case "bash":
    case "bash_output":
      push("command", args.command);
      push("cwd", data.cwd);
      push("exit", data.exit_code);
      push("background", data.bg_id ?? args.bg_id);
      push("state", data.status);
      break;
    case "read_file": {
      push("file", meta.path || args.path || args.file_path);
      if (meta.offset !== undefined) {
        push("lines", `${meta.offset}-${meta.next_offset != null ? meta.next_offset - 1 : "end"}`);
      }
      if (meta.truncated) push("note", "输出已截断，可按下一偏移继续读取");
      break;
    }
    case "glob":
    case "grep":
      push("pattern", args.pattern || meta.pattern);
      push("path", args.path || meta.path);
      if (name === "grep") push("glob", args.glob || meta.glob);
      break;
    case "write_file":
    case "edit_file": {
      push("file", args.file_path || firstMetaFilePath(meta));
      const counts = diffCounts(meta, tool);
      if (counts.added || counts.removed) push("changes", `+${counts.added} / -${counts.removed} 行`);
      break;
    }
    case "search_web":
    case "web_search":
      push("query", args.query || meta.query);
      push("source", meta.engine);
      break;
    case "fetch_web_page":
      push("url", args.url || meta.url);
      if (meta.truncated) push("note", "内容已截断");
      break;
    default:
      break;
  }
  if (payload.ok === false) push("error type", tool?.error_type || payload.error_type || "");
  if (Number(tool?.duration_ms) > 0) push("duration", formatDuration(tool.duration_ms));
  return rows;
}

// List-ish results for level 2 (files, matches, search hits, changed files).
export function toolItems(name, tool) {
  const args = parseToolArguments(tool?.args);
  const { data, meta } = payloadParts(tool);
  const values = Array.isArray(data) ? data : [];
  switch (name) {
    case "glob":
      return values.slice(0, 12).map((item) => ({ title: item?.path ?? String(item), detail: formatBytes(item?.size_bytes ?? item?.size) }));
    case "grep":
      return values.slice(0, 12).map((item) => ({ title: `${item?.file ?? "file"}:${item?.line ?? ""}`, detail: String(item?.text ?? "").replace(/\t/g, " ") }));
    case "search_web":
    case "web_search":
      return values.slice(0, 8).map((item) => ({ title: item?.title, url: item?.url, detail: item?.snippet }));
    case "write_file":
    case "edit_file": {
      const files = Array.isArray(meta.files) ? meta.files : [];
      if (!files.length) {
        const path = args.file_path || args.path;
        return path ? [{ title: String(path), detail: "" }] : [];
      }
      return files.slice(0, 8).map((item) => ({ title: item?.path, detail: `+${Number(item?.added_lines) || 0} / -${Number(item?.removed_lines) || 0} 行` }));
    }
    default:
      return [];
  }
}

// Body text for level 2 output area (may be capped by the caller).
export function toolOutput(name, tool) {
  const { payload, data } = payloadParts(tool);
  switch (name) {
    case "bash":
    case "bash_output": {
      if (String(data.status) === "running") return "命令在后台运行中";
      return joinNonEmpty([data.stdout, data.stderr]);
    }
    case "read_file":
      return typeof payload.data === "string" ? payload.data : "";
    case "fetch_web_page":
      return typeof payload.data === "string" ? payload.data : "";
    default: {
      if (typeof payload.data === "string") return payload.data;
      if (typeof payload.message === "string") return payload.message;
      return "";
    }
  }
}

// edit_file / write_file: unified diff text for DiffView. Returns "" when the
// result carries no diff (then the tool block falls back to items/output).
export function extractDiffText(name, tool) {
  if (name !== "edit_file" && name !== "write_file") return "";
  const { meta } = payloadParts(tool);
  const files = Array.isArray(meta.files) ? meta.files : [];
  const parts = files.map((file) => String(file?.diff || "")).filter(Boolean);
  if (parts.length) return parts.join("\n");
  // Fall back to raw +/- lines recorded by the file_change event.
  const lines = Array.isArray(tool?.fileChange?.lines) ? tool.fileChange.lines : [];
  if (lines.length) {
    return lines.map((change) => `${change?.kind === "added" ? "+" : change?.kind === "removed" ? "-" : " "}${change?.text ?? ""}`).join("\n");
  }
  return "";
}

export function failedMessage(tool) {
  const { payload } = payloadParts(tool);
  if (payload.ok === false || tool?.status === "failed") {
    return String(payload.error || tool?.error_type || "工具执行失败");
  }
  return "";
}

// Per-tool mutation stats for the turn-scoped change summary: files touched
// with +/- line counts. Sources, in order: meta.files entries, else the raw
// unified diff (same +/- counting DiffView renders).
export function toolChangeStats(name, tool) {
  if (name !== "edit_file" && name !== "write_file") return [];
  const { meta } = payloadParts(tool);
  const files = Array.isArray(meta.files) ? meta.files : [];
  if (files.length) {
    return files
      .map((file) => ({
        path: String(file?.path || ""),
        added: Number(file?.added_lines) || 0,
        removed: Number(file?.removed_lines) || 0,
      }))
      .filter((file) => file.path);
  }
  const diff = extractDiffText(name, tool);
  if (!diff) {
    const path = String(tool?.file || "");
    return path ? [{ path, added: 0, removed: 0 }] : [];
  }
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  const path = String(tool?.file || firstMetaFilePath(meta) || "");
  return [{ path, added, removed }];
}

// Aggregates the trailing turn segment (entries after the last user/queued
// entry) into `{ fileCount, added, removed, firstToolCallId }`, or null when
// the turn touched no files.
export function summarizeChanges(entries) {
  let start = entries.length;
  while (start > 0) {
    const role = entries[start - 1]?.role;
    if (role === "user" || role === "queued") break;
    start -= 1;
  }
  const stats = [];
  let firstToolCallId = "";
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.role !== "tool") continue;
    const files = toolChangeStats(String(entry.name || ""), entry);
    if (!files.length) continue;
    if (!firstToolCallId) firstToolCallId = String(entry.tool_call_id || entry.id || "");
    stats.push(...files);
  }
  if (!stats.length) return null;
  return {
    fileCount: stats.length,
    added: stats.reduce((sum, file) => sum + file.added, 0),
    removed: stats.reduce((sum, file) => sum + file.removed, 0),
    firstToolCallId,
  };
}

// Level 3 raw payloads: what went in, what came back.
export function rawPayloads(tool) {
  return {
    args: prettyJson(parseRaw(tool?.args)),
    result: prettyJson(parseRaw(tool?.result ?? tool?.content ?? "")),
  };
}

export function formatDuration(durationMs) {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.trunc(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(2)}s`;
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

// ---- helpers ----

function parseObjectLoose(value) {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function parseJson(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function parseRaw(value) {
  const parsed = parseJson(value);
  return parsed === null ? (value == null || value === "" ? null : String(value)) : parsed;
}

function prettyJson(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    const text = singleLine(value);
    if (text) return text;
  }
  return "";
}

function singleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function firstKeyArg(args) {
  for (const key of ["file_path", "path", "query", "url", "pattern", "command", "bg_id", "name", "agent_id"]) {
    const text = singleLine(args?.[key]);
    if (text) return text;
  }
  return "";
}

function firstMetaFilePath(meta) {
  return Array.isArray(meta.files) ? meta.files[0]?.path : undefined;
}

function joinNonEmpty(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.replace(/\s+$/, ""))
    .join("\n");
}

function diffCounts(meta, tool) {
  let added = 0;
  let removed = 0;
  const files = Array.isArray(meta.files) ? meta.files : [];
  for (const file of files) {
    added += Number(file?.added_lines) || 0;
    removed += Number(file?.removed_lines) || 0;
  }
  if (!added && !removed) {
    const lines = Array.isArray(tool?.fileChange?.lines) ? tool.fileChange.lines : [];
    for (const change of lines) {
      if (change?.kind === "added") added += 1;
      else if (change?.kind === "removed") removed += 1;
    }
  }
  return { added, removed };
}

function summarizeValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === "object") return Object.keys(value).slice(0, 4).join(", ");
  return String(value ?? "");
}
