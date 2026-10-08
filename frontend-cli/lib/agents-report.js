import { paint } from "./theme.js";
import { wrapTextWithAnsi } from "./text-width.js";
import { clean, single, statusMeta, taskStatus, needsUser, relativeTime } from "./agents-model.js";

// A task's delivery as one readable report: what it is and where it stands,
// then the delivery in aligned blocks, then its history folded away.
const LABEL = 10;
// A long brief shows this many lines until z unfolds it.
const BRIEF_LINES = 6;

export const ago = (value, now = Date.now()) => {
  const time = relativeTime(value, now);
  return !time ? "" : time === "now" ? "just now" : time.includes("-") ? "on " + time : time + " ago";
};
const badge = status => (paint[statusMeta(status).tone] || paint.dim)(statusMeta(status).glyph + " " + status);
const stamp = value => String(value || "").slice(0, 16).replace("T", " ");

// The label sits in a fixed column; wrapped and listed lines hang under the value.
function block(label, values, width, painter = text => text) {
  const room = Math.max(8, width - LABEL);
  const lines = values.map(value => clean(value).trim()).filter(Boolean).flatMap(value => wrapTextWithAnsi(value, room));
  return lines.map((line, index) => (index ? " ".repeat(LABEL) : paint.dim(label.padEnd(LABEL))) + painter(line));
}
const gap = groups => groups.filter(lines => lines.length).flatMap((lines, index) => index ? ["", ...lines] : lines);

// The page title is the brief's first line; here it reads in full, line breaks kept.
export function briefTitle(brief) { return single(clean(brief).trim().split(/\r?\n/)[0]); }
// Whether a brief may fold at some width: never wrongly no; the report body says when it did.
export function mayFoldBrief(brief) { const text = clean(brief).trim(); return text.split(/\r?\n/).length > BRIEF_LINES || text.length > BRIEF_LINES * 30; }
function briefBlock(brief, width, expanded) {
  const lines = block("Task", clean(brief).trim().split(/\r?\n/), width);
  if (expanded || lines.length <= BRIEF_LINES) return lines;
  return [...lines.slice(0, BRIEF_LINES), " ".repeat(LABEL) + paint.dim("▸ " + (lines.length - BRIEF_LINES) + " more lines · z to show")];
}

function standing(report, width, now) {
  const { task, archived, team } = report;
  if (archived) return [paint.dim(single(team) + " was deleted. This report is kept read-only.")];
  if (task.status === "done" && task.review?.decision === "accepted") return [paint.success("✓ Accepted " + ago(task.review.at, now))];
  if (task.status === "done" && task.review?.decision === "rework") return [paint.warning("↺ Sent back for rework " + ago(task.review.at, now)), ...block("Feedback", [task.review.feedback], width)];
  if (task.status === "done" && report.decide) return [paint.accent("New delivery · " + report.decide)];
  if (needsUser(task) && task.blockedOn) return block("Needs you", [task.blockedOn.action], width, paint.warning);
  if (task.blockedOn?.responder === "children") return block("Delegated", ["to its members. " + task.blockedOn.action], width);
  if (task.blockedOn) return block("Asked", [report.name(task.blockedOn.responder) + ": " + task.blockedOn.action], width);
  if (task.error) return block("Problem", [task.error], width, paint.warning);
  return [];
}

function delivery({ task, artifacts }, width) {
  const r = task.report;
  if (!r) return [paint.dim("No delivery report yet.")];
  return gap([
    block("Outcome", [r.outcome], width, paint.bold),
    block("Summary", [r.summary], width),
    block("Evidence", r.evidence.map(item => "• " + single(item)), width),
    block("Files", artifacts.map(file => single(file.name) + "  " + paint.dim(clean(file.path || ""))), width),
    block("Next", [r.nextAction], width),
  ]);
}

function history({ task, runs, subtasks, name }, width, expanded) {
  const notes = task.notes || [];
  const counts = [["Notes", notes.length], ["Runs", runs.length], ["Subtasks", subtasks.length]].filter(([, count]) => count);
  if (!counts.length) return [];
  if (!expanded) return [paint.dim("▸ History · " + counts.map(([label, count]) => label + " " + count).join(" · ") + "   z to show")];
  return gap([
    [paint.dim("▾ History   z to hide")],
    block("Notes", notes.map(note => stamp(note.createdAt) + "  " + name(note.author) + ": " + single(note.text)), width),
    block("Runs", runs.map(run => stamp(run.startedAt) + "  " + run.status), width),
    block("Subtasks", subtasks.map(child => statusMeta(taskStatus(child)).glyph + " " + single(child.brief) + " · " + name(child.assigneeAgentId)), width),
  ]);
}

// report: { task (with notes), team, owner, artifacts [{name, path}], runs,
// subtasks, archived, decide (the review keys offered, e.g. "a accept"),
// name(id) for note authors and responders }.
export function renderReport(report, width, { expanded = false, now = Date.now() } = {}) {
  const { task } = report;
  const when = task.deliveredAt ? "delivered " + ago(task.deliveredAt, now) : "";
  const header = [badge(taskStatus(task)), single(report.team) + " › " + single(report.owner), when, task.priority ? task.priority + " priority" : ""].filter(Boolean).join(paint.dim(" · "));
  const origin = [task.reworkOf ? "Rework of an earlier delivery" : "", task.parentTaskId ? "Subtask" : ""].filter(Boolean).join(" · ");
  return gap([
    [header, ...(origin ? [paint.dim(origin)] : [])],
    briefBlock(task.brief, width, expanded),
    standing(report, width, now),
    delivery(report, width),
    history(report, width, expanded),
  ]);
}
