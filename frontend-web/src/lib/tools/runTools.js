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

function unwrapRecord(record, data) {
  let current = record && typeof record === "object" ? record : {};
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch {
      // Plain string data.
    }
  }
  if (current.result && typeof current.result === "object" && !Array.isArray(current.result)) {
    return current.result;
  }
  return current;
}

export function formatDelegate(tool, args, parts) {
  const record = unwrapRecord(parts.record, parts.data);
  if (args.wait === true || Array.isArray(record.settled)) {
    const settled = Array.isArray(record.settled) ? record.settled : [];
    const taskId = firstText(args.task);
    const target = taskId ? `task ${taskId}` : "delegated tasks";
    const output = String(record.output || record.summary || "").trim();
    return {
      kind: "delegate",
      verb: "Waited for",
      target,
      agent: target,
      meta: [
        ...meta(`${settled.length} settled`),
        ...(record.timedOut ? meta("timed out", "danger") : record.released ? meta("released") : []),
      ],
      withDuration: true,
      body: output ? { type: "markdown", text: output, ...CAPS.markdown } : null,
      taskState: record.timedOut ? "error" : "",
    };
  }
  if (firstText(args.retire)) {
    const retired = firstText(args.retire);
    return {
      kind: "delegate",
      verb: "Retired",
      target: retired,
      agent: retired,
      meta: [],
      withDuration: true,
      body: null,
      taskState: "",
    };
  }
  const isNew = Boolean(args.new?.name && !record.assignee && !args.to);
  const baseAgent = firstText(record.assignee, args.to, args.new?.name, args.agent, args.agent_id, args.name, record.agent_id) || "agent";
  const agentLabel = isNew ? `${baseAgent} (new)` : baseAgent;
  const task = firstText(args.brief, args.message, args.task, args.prompt, args.description);
  const clipped = task.length > DELEGATE_TASK_MAX ? `${task.slice(0, DELEGATE_TASK_MAX - 1)}…` : task;
  const answer = String(record.summary || record.answer || (typeof record.result === "string" ? record.result : "") || parts.text || "").trim();
  const status = singleLine(record.status);
  return {
    kind: "delegate",
    verb: "Delegated to",
    target: clipped ? `${agentLabel}: ${clipped}` : agentLabel,
    agent: baseAgent,
    meta: [...meta(record.taskId ? "task " + record.taskId : ""), ...meta(status && status !== "completed" ? status : "")],
    withDuration: true,
    body: answer ? { type: "markdown", text: answer, ...CAPS.markdown } : null,
    taskState: taskFinishState(status),
  };
}

export function formatReport(tool, args, parts) {
  const record = unwrapRecord(parts.record, parts.data);
  const blocked = args.blocked && typeof args.blocked === "object" ? args.blocked : null;
  if (blocked) {
    const responder = singleLine(blocked.responder || "lead");
    const action = singleLine(blocked.action || "");
    const summary = String(args.summary || "").trim();
    return {
      kind: "report",
      verb: "Reported",
      target: "blocked",
      meta: meta(action ? `needs ${responder}: ${action}` : `needs ${responder}`, "danger"),
      body: summary ? { type: "markdown", text: summary, ...CAPS.markdown } : null,
      taskState: "",
    };
  }
  const outcome = firstText(args.outcome, record.outcome, record.status) || "completed";
  const delivered = Boolean(record.delivered);
  const summary = String(args.summary || record.summary || "").trim();
  const evidence = Array.isArray(args.evidence) ? args.evidence.map((item) => singleLine(item)).filter(Boolean) : [];
  const artifacts = Array.isArray(args.artifacts)
    ? args.artifacts.map((item) => String(item || "").split(/[\\/]/).pop()).filter(Boolean)
    : [];
  const sections = [
    summary,
    evidence.length ? `**Evidence:** ${evidence.join(" · ")}` : "",
    artifacts.length ? `**Files:** \`${artifacts.join("`, `")}\`` : "",
  ].filter(Boolean);
  return {
    kind: "report",
    verb: "Reported",
    target: outcome,
    meta: [
      ...(delivered ? meta("delivered", "success") : []),
      ...(artifacts.length ? meta(plural(artifacts.length, "file")) : []),
    ],
    body: sections.length ? { type: "markdown", text: sections.join("\n\n"), ...CAPS.markdown } : null,
    taskState: "",
  };
}

export function formatAgentManagement(tool, args, parts) {
  const record = unwrapRecord(parts.record, parts.data);
  const rawAction = firstText(args.action, args.operation, record.action) || "update";
  const actionLabel = rawAction.replace(/[_-]+/g, " ");
  const subject = firstText(
    args.name,
    args.team,
    args.agent,
    args.member,
    args.taskId,
    args.teamId,
    args.agentId,
    record.name,
    record.team?.name,
    record.agent?.name,
  );
  const summary = String(record.summary || args.brief || args.description || "").trim();
  return {
    kind: "manage",
    verb: "Managed agents",
    target: subject ? `${actionLabel}: ${subject}` : actionLabel,
    meta: meta(singleLine(record.status)),
    body: summary ? { type: "markdown", text: summary, ...CAPS.markdown } : null,
    taskState: "",
  };
}
