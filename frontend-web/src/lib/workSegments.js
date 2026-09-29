// Work segments (surface-design-v2 5.1): every tool call between two pieces
// of visible prose (a user message or assistant text) folds into ONE segment
// with a generated summary. System notices and question cards render outside
// the fold without ending the segment. After LobeHub's WorkflowCollapse.
import { toolView } from "./toolDisplay.js";
import { LIVE_FINISHED_WINDOW } from "./tools/caps.js";
import { basename, plural } from "./tools/parse.js";

const PROSE_ROLES = new Set(["user", "assistant", "queued"]);

// entries -> [{type:"message"|"system"|"question", key, entry} | segment]
export function buildTimeline(entries, { active = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = [];
  let open = -1;
  list.forEach((entry, index) => {
    const key = String(entry?.id || `${entry?.role || "entry"}-${index}`);
    if (entry?.role === "tool") {
      if (open < 0) {
        groups.push({ type: "segment", key: `segment:${key}`, entries: [] });
        open = groups.length - 1;
      }
      groups[open] = { ...groups[open], entries: [...groups[open].entries, entry] };
      return;
    }
    if (PROSE_ROLES.has(entry?.role)) open = -1;
    const type = entry?.role === "question" ? "question" : entry?.role === "system" ? "system" : "message";
    groups.push({ type, key, entry });
  });
  const lastSegment = open; // only a segment with no prose after it can be live
  return groups
    .map((group, index) => (group.type === "segment" ? toSegment(group, active && index === lastSegment) : group))
    .filter((group) => group.type !== "segment" || group.calls.length > 0);
}

function toSegment(group, live) {
  const views = group.entries.map((entry) => toolView(entry, { settled: !live }));
  const calls = views.filter((view) => !view.hidden);
  const waiting = views.some((view) => view.status === "waiting");
  const summary = summarizeCalls(calls);
  return {
    type: "segment",
    key: group.key,
    calls,
    live,
    waiting,
    status: segmentStatus(calls, waiting),
    summary,
    duration_ms: calls.reduce((sum, call) => sum + (Number(call.duration_ms) || 0), 0),
    autoOpen: live || waiting || summary.failed > 0,
  };
}

export function segmentStatus(calls, waiting = false) {
  if (calls.some((call) => call.status === "running")) return "running";
  if (waiting || calls.some((call) => call.status === "waiting")) return "waiting";
  if (calls.some((call) => call.status === "error")) return "error";
  if (calls.length && calls.every((call) => call.status === "cancelled")) return "cancelled";
  return "success";
}

// Live window: the running call(s) plus the last N finished, in order.
export function liveWindow(calls, finished = LIVE_FINISHED_WINDOW) {
  const done = calls.map((call, index) => ({ call, index })).filter(({ call }) => call.status !== "running");
  const keep = new Set([
    ...calls.map((call, index) => (call.status === "running" ? index : -1)).filter((index) => index >= 0),
    ...done.slice(-finished).map(({ index }) => index),
  ]);
  const visible = calls.filter((call, index) => keep.has(index));
  return { visible, earlier: calls.length - visible.length };
}

// "Read 4 files, searched 2 patterns, ran 3 commands, edited app.ts +12 -3"
export function summarizeCalls(calls) {
  const order = [];
  const groups = new Map();
  for (const call of calls) {
    const key = call.kind === "create" ? `create-${call.noun}` : call.kind;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.set(key, [...groups.get(key), call]);
  }
  const phrases = order.map((key) => phrase(key, groups.get(key))).filter(Boolean);
  const failed = calls.filter((call) => call.status === "error").length;
  const cancelled = calls.filter((call) => call.status === "cancelled").length;
  const text = capitalize(phrases.join(", "));
  return { text, failed, cancelled, full: summaryText({ text, failed, cancelled }) };
}

export function summaryText({ text, failed = 0, cancelled = 0 }) {
  const tail = [failed ? `${failed} failed` : "", cancelled ? `${cancelled} cancelled` : ""].filter(Boolean);
  return [text, ...tail].filter(Boolean).join(", ");
}

function phrase(key, calls) {
  const count = calls.length;
  const one = count === 1 ? calls[0] : null;
  switch (key) {
    case "read": return fileListPhrase("read", calls);
    case "write": return `${fileListPhrase("wrote", calls)} +${sum(calls, "added")}`;
    case "edit": return `${fileListPhrase("edited", calls)} +${sum(calls, "added")} -${sum(calls, "removed")}`;
    case "search": return `searched ${plural(count, "pattern")}`;
    case "web": return count === 1 ? "searched the web" : `searched the web ${count} times`;
    case "fetch": return one ? `read ${one.targetLabel || one.target || "a page"}` : `read ${count} pages`;
    case "run": return `ran ${plural(count, "command")}`;
    case "task": return `checked ${plural(count, "task")}`;
    case "stop": return `stopped ${plural(count, "task")}`;
    case "delegate": return one ? `delegated to ${one.agent || "agent"}` : `delegated ${count} tasks`;
    case "skill": return one && one.target ? `loaded skill ${one.target}` : `loaded ${plural(count, "skill")}`;
    case "goal": return "updated goal";
    case "other": return one ? `used ${one.verb}` : `used ${count} tools`;
    default: {
      if (!key.startsWith("create-")) return "";
      const noun = key.slice("create-".length);
      return one && one.target ? `created ${noun} ${one.target}` : `created ${plural(count, noun)}`;
    }
  }
}

function fileListPhrase(verb, calls) {
  const paths = [...new Set(calls.map((call) => call.target).filter(Boolean))];
  if (paths.length === 1) return `${verb} ${basename(paths[0])}`;
  return `${verb} ${plural(paths.length || calls.length, "file")}`;
}

function sum(calls, field) {
  return calls.reduce((total, call) => total + (Number(call.change?.[field]) || 0), 0);
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}
