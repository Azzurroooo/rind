// Formatters for process-like tools: bash, bash_output, task_control, delegate.
import { CAPS, meta } from "./caps.js";
import { firstLine, firstText, plural, singleLine, textLines } from "./parse.js";

const TASK_RUNNING = new Set(["starting", "running", "cancelling"]);
const TASK_FAILED = new Set(["failed", "timed_out", "lost"]);
const STOP_ACTIONS = new Set(["stop", "cancel", "kill", "terminate", "interrupt"]);
const DELEGATE_TASK_MAX = 80;

// Background task status (same mapping as the CLI's taskFinishState).
export function taskFinishState(status) {
  const value = String(status || "").toLowerCase();
  if (TASK_RUNNING.has(value)) return "running";
  if (TASK_FAILED.has(value)) return "error";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return value ? "success" : "";
}

function outputLines(record, text) {
  const streams = [record.stdout, record.stderr, record.output]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap((value) => textLines(value));
  return streams.length ? streams : textLines(text);
}

export function formatBash(tool, args, parts) {
  const { record } = parts;
  const exit = Number(record.exit_code);
  const background = Boolean(record.bg_id || record.task_id) && taskFinishState(record.status) === "running";
  const lines = outputLines(record, parts.text);
  const metaParts = [
    ...(Number.isFinite(exit) && exit !== 0 && record.exit_code !== null ? meta(`exit ${exit}`, "danger") : []),
    ...(background ? meta("background") : []),
  ];
  return {
    kind: "run",
    verb: "Ran",
    target: firstLine(args.command || args.cmd),
    mono: true,
    meta: metaParts,
    withDuration: true,
    body: lines.length ? { type: "terminal", lines, ...CAPS.terminal } : null,
    taskState: taskFinishState(record.status),
  };
}

export function formatBashOutput(tool, args, parts) {
  const { record } = parts;
  const lines = outputLines(record, parts.text);
  return {
    kind: "task",
    verb: "Checked",
    target: firstText(args.task_id, args.bg_id, record.task_id, record.bg_id) || "task",
    mono: true,
    meta: meta(singleLine(record.status)),
    body: lines.length ? { type: "terminal", lines, ...CAPS.terminal } : null,
    taskState: taskFinishState(record.status),
  };
}

export function formatTaskControl(tool, args, parts) {
  const { record } = parts;
  const action = String(args.action || "").toLowerCase();
  const stopping = STOP_ACTIONS.has(action);
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const lines = tasks.map((task) => [task?.task_id || task?.id, task?.status, firstLine(task?.command || task?.label)].filter(Boolean).join("  "));
  const metaText = singleLine(record.status) || (tasks.length || action === "list" ? plural(tasks.length, "task") : "");
  return {
    kind: stopping ? "stop" : "task",
    verb: stopping ? "Stopped" : "Checked",
    target: firstText(args.task_id, args.bg_id, record.task_id) || (stopping ? "task" : "tasks"),
    mono: true,
    meta: meta(metaText),
    body: lines.length ? { type: "terminal", lines, ...CAPS.terminal } : null,
    taskState: stopping ? "" : taskFinishState(record.status),
  };
}

export function formatDelegate(tool, args, parts) {
  const { record } = parts;
  const agent = firstText(args.agent, args.agent_id, args.name, record.agent_id) || "agent";
  const task = firstText(args.task, args.prompt, args.message, args.description);
  const clipped = task.length > DELEGATE_TASK_MAX ? `${task.slice(0, DELEGATE_TASK_MAX - 1)}…` : task;
  const answer = String(record.summary || record.answer || record.result || parts.text || "").trim();
  const status = singleLine(record.status);
  return {
    kind: "delegate",
    verb: "Delegated to",
    target: clipped ? `${agent}: ${clipped}` : agent,
    agent,
    meta: meta(status && status !== "completed" ? status : ""),
    withDuration: true,
    body: answer ? { type: "markdown", text: answer, ...CAPS.markdown } : null,
    taskState: taskFinishState(status),
  };
}
