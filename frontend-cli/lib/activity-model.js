import { activityTarget, classifyTool, parseArgsPreview } from "./activity-classifier.js";

export function createActivityModel(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  let entries = new Map();
  let order = [];
  let syntheticId = 0;
  let turnStartedAt = now();

  function reset() {
    entries = new Map();
    order = [];
    syntheticId = 0;
    turnStartedAt = now();
  }

  function ensure(event = {}) {
    const id = String(event.tool_call_id || `tool:${++syntheticId}`);
    let entry = entries.get(id);
    if (!entry) {
      const name = String(event.tool_name || "unknown");
      const kind = classifyTool(name, event.args_preview);
      entry = {
        id,
        name,
        kind,
        argsPreview: event.args_preview || "",
        target: activityTarget(name, event.args_preview, kind),
        status: "running",
        startedAt: now(),
        endedAt: 0,
        durationMs: 0,
        progress: "",
        fileChanges: [],
        result: {},
        errorType: "",
        errorSource: "",
        emitted: false,
      };
      entries.set(id, entry);
      order.push(id);
    } else if (event.tool_name) {
      entry.name = String(event.tool_name);
      entry.kind = classifyTool(entry.name, event.args_preview || entry.argsPreview);
      entry.target = activityTarget(entry.name, event.args_preview || entry.argsPreview, entry.kind);
    }
    if (event.args_preview && !entry.argsPreview) {
      entry.argsPreview = event.args_preview;
    }
    return entry;
  }

  function handle(event = {}) {
    const type = String(event.type || event.event_type || "");
    if (type === "turn_started") {
      reset();
      return { changed: true };
    }
    if (["tool_requested", "tool_call_started", "tool_progress", "tool_result", "file_change", "user_question_requested"].includes(type)) {
      const entry = ensure(event);
      if (type === "tool_requested" || type === "tool_call_started") {
        entry.status = "running";
        return { changed: true, entry };
      }
      if (type === "tool_progress") {
        entry.progress = progressMessage(event.payload);
        return { changed: true, entry };
      }
      if (type === "user_question_requested") {
        entry.kind = "ask";
        entry.status = "waiting";
        entry.target = String(event.question || entry.target || "input required").replace(/\s+/g, " ").trim();
        return { changed: true, entry };
      }
      if (type === "file_change") {
        entry.fileChanges.push(event);
        return { changed: true, entry };
      }
      entry.status = normalizeStatus(event.status);
      entry.durationMs = safeDuration(event.duration_ms);
      entry.endedAt = now();
      entry.errorType = String(event.error_type || "");
      entry.errorSource = String(event.error_source || "");
      entry.result = parseResult(event.result);
      entry.metrics = deriveMetrics(entry);
      if (entry.status === "done" && entry.metrics.exitCode) entry.status = "fail";
      const committedEntry = coalesce(entry);
      if (["inspect", "search"].includes(committedEntry.kind)) {
        return { changed: true, entry: committedEntry, committed: false, pending: true };
      }
      committedEntry.emitted = true;
      return { changed: true, entry: committedEntry, committed: true };
    }
    return { changed: false };
  }

  function active() {
    return order
      .map((id) => entries.get(id))
      .filter((entry) => entry && !entry.mergedInto && ["running", "live", "waiting"].includes(entry.status));
  }

  function completed() {
    return order.map((id) => entries.get(id)).filter((entry) => entry && !entry.mergedInto && !["running", "live", "waiting"].includes(entry.status));
  }

  function coalesce(entry) {
    if (!["inspect", "search"].includes(entry.kind) || entry.status !== "done") return entry;
    const previous = [...order].reverse()
      .map((id) => entries.get(id))
      .find((item) => item && item.id !== entry.id && !item.mergedInto && !item.emitted && !["running", "live", "waiting"].includes(item.status));
    if (!previous || previous.kind !== entry.kind || (entry.kind === "search" && searchKey(previous.target) !== searchKey(entry.target))) return entry;
    previous.durationMs += entry.durationMs;
    previous.fileChanges.push(...entry.fileChanges);
    previous.metrics = {
      ...previous.metrics,
      hits: (previous.metrics?.hits || 0) + (entry.metrics?.hits || 0),
      files: (previous.metrics?.files || 0) + (entry.metrics?.files || 0),
    };
    if (entry.kind === "inspect") {
      previous.metrics.files = Math.max(1, previous.metrics.files || 1) + 1;
      previous.target = `${previous.metrics.files} files`;
    }
    entry.mergedInto = previous.id;
    return previous;
  }

  function summary(durationMs = 0) {
    const all = completed();
    const changedFiles = new Set();
    let added = 0;
    let removed = 0;
    let testsPassed = 0;
    let testsFailed = 0;
    let failed = 0;
    for (const entry of all) {
      for (const change of entry.fileChanges) {
        if (change.file_path) {
          changedFiles.add(change.file_path);
        }
        for (const line of Array.isArray(change.lines) ? change.lines : []) {
          if (line?.kind === "added") added += 1;
          if (line?.kind === "removed") removed += 1;
        }
      }
      testsPassed += entry.metrics?.testsPassed || 0;
      testsFailed += entry.metrics?.testsFailed || 0;
      if (["fail", "stop"].includes(entry.status) || (entry.metrics?.exitCode || 0) !== 0) failed += 1;
    }
    const total = safeDuration(durationMs) || Math.max(0, now() - turnStartedAt);
    return {
      tools: all.length,
      failed,
      changedFiles: changedFiles.size,
      added,
      removed,
      testsPassed,
      testsFailed,
      durationMs: total,
    };
  }

  function hasActive() {
    return active().length > 0;
  }

  function flushPending() {
    const rows = completed().filter((entry) => !entry.emitted && ["inspect", "search"].includes(entry.kind));
    for (const entry of rows) entry.emitted = true;
    return rows;
  }

  return {
    reset,
    handle,
    active,
    completed,
    flushPending,
    summary,
    hasActive,
  };
}

function searchKey(target) {
  return String(target || "").split(/\s+in\s+/i, 1)[0].trim().toLowerCase();
}

function normalizeStatus(status) {
  const value = String(status || "completed").toLowerCase();
  if (["cancelled", "canceled", "stopped", "interrupted"].includes(value)) return "stop";
  if (["failed", "error", "nonzero", "non_zero"].includes(value)) return "fail";
  if (["warning", "warn"].includes(value)) return "warn";
  return "done";
}

function safeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function progressMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["message", "status", "text"]) {
    const value = String(payload[key] || "").replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return "";
}

function parseResult(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function deriveMetrics(entry) {
  const data = entry.result?.data && typeof entry.result.data === "object" ? entry.result.data : entry.result;
  const stdout = String(data?.stdout || "");
  const stderr = String(data?.stderr || "");
  const message = String(data?.message || data?.output || "");
  const error = String(entry.result?.error || data?.error || "");
  const output = [stdout, stderr, message, error].filter(Boolean).join("\n");
  const exitCode = Number(data?.exit_code ?? data?.exitCode);
  const testsPassed = firstNumber(output, /(\d+)\s+(?:tests?\s+)?passed\b/i);
  const testsFailed = firstNumber(output, /(\d+)\s+(?:tests?\s+)?failed\b/i);
  const hits = firstNumber(output, /(\d+)\s+hits?\b/i);
  const files = firstNumber(output, /(\d+)\s+files?\b/i);
  return {
    output: output.replace(/\s+/g, " ").trim(),
    exitCode: Number.isInteger(exitCode) && exitCode !== 0 ? exitCode : 0,
    testsPassed,
    testsFailed,
    hits,
    files,
  };
}

function firstNumber(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}
