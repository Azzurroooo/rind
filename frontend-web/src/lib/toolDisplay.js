// Tool call display (surface-design-v2 section 5). One specialized formatter
// per tool turns a reducer tool entry into a row model; nothing here renders.
// The rule throughout is "never show" raw arguments, JSON payloads, file
// contents or empty sections unless the tool has no better representation.
import { changeStats, filePath, formatEditFile, formatGlob, formatGrep, formatReadFile, formatWriteFile } from "./tools/fileTools.js";
import { formatCreate, formatFetchWebPage, formatGeneric, formatSearchWeb, formatSkill, formatUpdateGoal } from "./tools/miscTools.js";
import { errorMessage, parseToolArguments, payloadParts, splitError, singleLine } from "./tools/parse.js";
import { formatBash, formatBashOutput, formatDelegate, formatTaskControl } from "./tools/runTools.js";
import { CAPS, meta } from "./tools/caps.js";

export { parseToolArguments, parseToolResult, partialJsonStrings } from "./tools/parse.js";
export { taskFinishState } from "./tools/runTools.js";

// Tools that never get a row: the question card and the sticky plan own them.
export const HIDDEN_TOOLS = new Set(["ask_user_question", "update_plan"]);

const FORMATTERS = {
  read_file: formatReadFile,
  write_file: formatWriteFile,
  edit_file: formatEditFile,
  grep: formatGrep,
  glob: formatGlob,
  bash: formatBash,
  bash_output: formatBashOutput,
  task_control: formatTaskControl,
  search_web: formatSearchWeb,
  web_search: formatSearchWeb,
  fetch_web_page: formatFetchWebPage,
  delegate: formatDelegate,
  agent_create: formatCreate("agent"),
  skill_create: formatCreate("skill"),
  skill: formatSkill,
  update_goal: formatUpdateGoal,
};

// Row model for one tool entry:
// { id, callId, name, hidden, kind, verb, target, targetIsPath, mono, meta:[{text,tone}],
//   body, error:{lines,details}|null, status, duration_ms, openFile, change }
export function toolView(tool, { settled = false } = {}) {
  const name = String(tool?.name || "tool");
  const callId = String(tool?.tool_call_id || tool?.id || "");
  const base = { id: String(tool?.id || callId), callId, name, duration_ms: Number(tool?.duration_ms) || 0 };
  if (HIDDEN_TOOLS.has(name)) return { ...base, hidden: true, kind: "hidden", status: callStatus(tool, {}, "", settled, name) };
  const args = parseToolArguments(tool?.args ?? tool?.args_preview);
  const parts = payloadParts(tool);
  const model = (FORMATTERS[name] || formatGeneric)(tool, args, parts);
  const status = callStatus(tool, parts.payload, model.taskState, settled, name);
  return {
    ...base,
    hidden: false,
    targetIsPath: false,
    mono: false,
    openFile: "",
    ...model,
    status,
    meta: rowMeta(tool, model, status),
    error: status === "error" ? rowError(tool, parts, model) : null,
  };
}

function callStatus(tool, payload, taskState, settled, name) {
  const raw = String(tool?.status || "");
  if (raw === "running") {
    if (settled) return "cancelled"; // the turn ended without a result
    return name === "ask_user_question" ? "waiting" : "running";
  }
  if (raw === "cancelled" || tool?.error_type === "cancelled") return "cancelled";
  if (raw === "failed" || raw === "error" || payload?.ok === false) return "error";
  if (taskState === "error") return "error";
  if (taskState === "cancelled") return "cancelled";
  return "success";
}

// tool_progress replaces the meta while running; it never appends lines.
function rowMeta(tool, model, status) {
  const progress = Array.isArray(tool?.progress) ? tool.progress : [];
  if (status === "running" && progress.length) return meta(singleLine(progress[progress.length - 1]));
  const duration = model.withDuration ? formatDuration(tool?.duration_ms) : "";
  return [...(model.meta || []), ...meta(duration)];
}

function rowError(tool, parts, model) {
  const fallback = parts.text && !model.body ? parts.text : "";
  const message = errorMessage(parts.payload, fallback);
  if (message) return splitError(message, CAPS.error.cap);
  if (model.body) return null; // e.g. stderr already in the terminal body
  const type = String(tool?.error_type || parts.payload?.error_type || "").trim();
  return { lines: [type ? `Tool failed (${type})` : "Tool failed"], details: "" };
}

// Per-tool mutation stats for the turn change summary.
export function toolChangeStats(name, tool) {
  if (name !== "edit_file" && name !== "write_file") return [];
  const parts = payloadParts(tool);
  const stats = changeStats(tool, parts);
  if (stats.length) return stats;
  const path = filePath(parseToolArguments(tool?.args), parts);
  return path ? [{ path, added: 0, removed: 0 }] : [];
}

// Aggregates the trailing turn (entries after the last user/queued entry)
// into `{ fileCount, added, removed, firstToolCallId }`, or null.
export function summarizeChanges(entries) {
  let start = entries.length;
  while (start > 0) {
    const role = entries[start - 1]?.role;
    if (role === "user" || role === "queued") break;
    start -= 1;
  }
  const touched = entries.slice(start)
    .filter((entry) => entry?.role === "tool")
    .map((entry) => ({ entry, files: toolChangeStats(String(entry.name || ""), entry) }))
    .filter((item) => item.files.length);
  if (!touched.length) return null;
  const stats = touched.flatMap((item) => item.files);
  return {
    fileCount: stats.length,
    added: stats.reduce((sum, file) => sum + file.added, 0),
    removed: stats.reduce((sum, file) => sum + file.removed, 0),
    firstToolCallId: String(touched[0].entry.tool_call_id || touched[0].entry.id || ""),
  };
}

export function formatDuration(durationMs) {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.trunc(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}
