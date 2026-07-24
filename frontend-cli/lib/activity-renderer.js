import { clipCells, textWidth } from "./text-width.js";

export function renderLiveDock(activity, width = process.stdout.columns || 80, now = Date.now()) {
  if (!activity) return "";
  const columns = positiveWidth(width, 80);
  const kind = String(activity.kind || "note");
  const target = String(activity.target || activity.name || "working").replace(/\s+/g, " ").trim();
  const elapsed = formatElapsed(activity.durationMs || Math.max(0, now - Number(activity.startedAt || now)));
  if (columns < 40) {
    return `now ${kind}: live\n  ${clipCells(target, Math.max(4, columns - 2))}`;
  }
  const prefix = `${padRight("now", 8)}${padRight(kind, 9)}`;
  const concurrent = Number(activity.runningCount || 0);
  const suffix = columns < 60
    ? elapsed
    : concurrent > 1
      ? `${elapsed}  +${concurrent - 1} running`
      : `${elapsed}  ctrl+c stop`;
  const targetWidth = Math.max(8, columns - textWidth(prefix) - textWidth(suffix) - 1);
  const clippedTarget = clipCells(target, targetWidth);
  const padding = Math.max(1, columns - textWidth(prefix) - textWidth(clippedTarget) - textWidth(suffix));
  return `${prefix}${clippedTarget}${" ".repeat(padding)}${dim(suffix)}`;
}

export function renderLedgerRow(activity, width = process.stdout.columns || 80) {
  if (!activity) return "";
  const columns = positiveWidth(width, 80);
  const kind = String(activity.kind || "note");
  const target = ledgerTarget(activity);
  const result = ledgerResult(activity);
  const duration = formatDuration(activity.durationMs);
  const status = activity.status === "done" ? result.status : activity.status;
  const statusText = `${status}${result.detail ? ` ${result.detail}` : ""}`;
  const prefix = `${padRight(kind, 9)}`;
  if (columns < 40) {
    return `${prefix.trim()} ${status}\n  ${clipCells(target, Math.max(8, columns - 2))}`;
  }
  if (columns < 60) {
    const targetWidth = Math.max(8, columns - textWidth(prefix) - textWidth(duration) - 2);
    const detail = ["fail", "stop", "warn"].includes(activity.status) ? `\n  ${failureDetail(activity)}` : "";
    return `${prefix}${clipCells(target, targetWidth)} ${duration}\n  ${styleStatus(clipCells(statusText, Math.max(8, columns - 2)), status)}${detail}`;
  }
  const resultWidth = Math.min(32, Math.max(18, Math.floor(columns * 0.28)));
  const targetWidth = Math.max(10, columns - textWidth(prefix) - resultWidth - textWidth(duration) - 3);
  const line = `${prefix}${clipCells(target, targetWidth)}${" ".repeat(Math.max(1, targetWidth - textWidth(clipCells(target, targetWidth)) + 1))}${clipCells(statusText, resultWidth)} ${duration}`;
  if (activity.status === "fail" || activity.status === "stop" || activity.status === "warn") {
    const detail = failureDetail(activity);
    return detail ? `${styleStatus(line, activity.status)}\n  ${detail}` : styleStatus(line, activity.status);
  }
  return styleStatus(line, status);
}

export function renderSummaryLine(summary) {
  const facts = [];
  if (summary.changedFiles) facts.push(`${summary.changedFiles} files changed`);
  if (summary.added || summary.removed) facts.push(`+${summary.added} -${summary.removed}`);
  if (summary.testsPassed) facts.push(`${summary.testsPassed} tests passed`);
  if (summary.testsFailed) facts.push(`${summary.testsFailed} tests failed`);
  if (!facts.length && summary.tools) facts.push(`${summary.tools} tools`);
  facts.push(formatDuration(summary.durationMs));
  return `${styleStatus("summary", summary.failed ? "fail" : "pass")} ${facts.join(" | ")}`;
}

export function renderOutcomeLine(kind, target, status, durationMs = 0, detail = "", width = process.stdout.columns || 80) {
  return renderLedgerRow({
    kind,
    target,
    status,
    durationMs,
    errorType: status === "fail" ? "turn" : "",
    metrics: { output: detail },
    fileChanges: [],
  }, width);
}

export function renderDebugActivity(event) {
  const type = String(event?.type || event?.event_type || "tool");
  const id = String(event?.tool_call_id || "unknown");
  const name = String(event?.tool_name || "unknown");
  const args = event?.args_preview ? ` args=${String(event.args_preview).replace(/\s+/g, " ")}` : "";
  const result = event?.result ? ` result=${String(event.result).replace(/\s+/g, " ")}` : "";
  const payload = event?.payload ? ` payload=${JSON.stringify(event.payload).replace(/\s+/g, " ")}` : "";
  return `[debug] ${type}: ${name} id=${id}${args}${payload}${result}`;
}

function ledgerTarget(activity) {
  if (activity.kind === "change" && activity.fileChanges?.length) {
    const paths = activity.fileChanges.map((change) => change.file_path).filter(Boolean);
    if (paths.length) return paths.length > 1 ? `${paths[0]} +${paths.length - 1} more` : paths[0];
  }
  return activity.target || activity.name || "working";
}

function ledgerResult(activity) {
  const metrics = activity.metrics || {};
  if (activity.status === "fail") return { status: "fail", detail: metrics.exitCode ? String(metrics.exitCode) : "" };
  if (activity.status === "stop") return { status: "stop", detail: "" };
  if (activity.status === "warn") return { status: "warn", detail: "" };
  if (activity.kind === "search" && (metrics.hits || metrics.files)) {
    return { status: "done", detail: `${metrics.hits || 0} hits / ${metrics.files || 0} files` };
  }
  if (activity.kind === "change") {
    const added = countChanges(activity.fileChanges, "added");
    const removed = countChanges(activity.fileChanges, "removed");
    return { status: "done", detail: `+${added} -${removed}` };
  }
  if (activity.kind === "check" && (metrics.testsPassed || metrics.testsFailed)) {
    return { status: "pass", detail: `${metrics.testsPassed || 0}/${(metrics.testsPassed || 0) + (metrics.testsFailed || 0)}` };
  }
  return { status: "done", detail: "" };
}

function failureDetail(activity) {
  const metrics = activity.metrics || {};
  const message = metrics.output || activity.errorType || "operation failed";
  const next = activity.kind === "check" ? "next  fix the reported failure before rerunning" : "next  inspect the error and retry";
  return `${clipCells(message, 100)}\n  ${next}`;
}

function countChanges(changes, kind) {
  return (Array.isArray(changes) ? changes : []).reduce((total, change) => total + (Array.isArray(change.lines) ? change.lines.filter((line) => line?.kind === kind).length : 0), 0);
}

function styleStatus(text, status) {
  if (!colorEnabled()) return text;
  const code = status === "fail" ? "38;5;203" : status === "warn" || status === "stop" ? "38;5;221" : status === "pass" || status === "done" ? "38;5;113" : "38;5;81";
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text) {
  return colorEnabled() ? `\x1b[2m${text}\x1b[0m` : text;
}

function colorEnabled() {
  return Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

function positiveWidth(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function padRight(value, width) {
  const text = String(value || "");
  return `${text}${" ".repeat(Math.max(0, width - textWidth(text)))}`;
}

function formatElapsed(value) {
  const seconds = Math.floor(Math.max(0, Number(value) || 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return `${Math.trunc(milliseconds)}ms`;
  if (milliseconds >= 60000) {
    const seconds = Math.round(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${(milliseconds / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
}
