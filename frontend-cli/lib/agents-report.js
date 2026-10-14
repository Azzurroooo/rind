import { paint, paintBackground } from "./theme.js";
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
const badge = status => paint.bold((paint[statusMeta(status).tone] || paint.dim)(statusMeta(status).glyph + " " + status));
const stamp = value => String(value || "").slice(0, 16).replace("T", " ");

// The label sits in a fixed column; wrapped and listed lines hang under the value.
function block(label, values, width, painter = text => text, { labelStyle = paint.dim, surface = false } = {}) {
  const room = Math.max(8, width - LABEL);
  const lines = values.map(value => String(value ?? "").trim()).filter(Boolean).flatMap(value => wrapTextWithAnsi(value, room));
  return lines.map((line, index) => {
    const rendered = (index ? " ".repeat(LABEL) : labelStyle(label.padEnd(LABEL))) + painter(line, index);
    return surface ? paintBackground(rendered, typeof surface === "string" ? surface : "surface") : rendered;
  });
}
const gap = groups => groups.filter(lines => lines.length).flatMap((lines, index) => index ? ["", ...lines] : lines);

// The page title is the brief's first line; here it reads in full, line breaks kept.
export function briefTitle(brief) { return single(clean(brief).trim().split(/\r?\n/)[0]); }
// Whether a brief may fold at some width: never wrongly no; the report body says when it did.
export function mayFoldBrief(brief) { const text = clean(brief).trim(); return text.split(/\r?\n/).length > BRIEF_LINES || text.length > BRIEF_LINES * 30; }
function briefBlock(brief, width, expanded) {
  const lines = block("Task", clean(brief).trim().split(/\r?\n/), width, (line, index) => index === 0 ? paint.bold(line) : line, { labelStyle: text => paint.bold(paint.accent(text)), surface: "surface" });
  if (expanded || lines.length <= BRIEF_LINES) return lines;
  return [...lines.slice(0, BRIEF_LINES), " ".repeat(LABEL) + paint.accent("▸ " + (lines.length - BRIEF_LINES) + " more lines") + paint.dim(" · z to show")];
}

function standing(report, width, now) {
  const { task, archived, team } = report;
  if (archived) return [paintBackground(paint.dim(single(team) + " was deleted. This report is kept read-only."), "surface")];
  if (task.status === "done" && task.review?.decision === "accepted") return [paintBackground(paint.bold(paint.success("✓ Accepted " + ago(task.review.at, now))), "surface")];
  if (task.status === "done" && task.review?.decision === "rework") {
    return [
      paintBackground(paint.bold(paint.warning("↺ Sent back for rework " + ago(task.review.at, now))), "surface"),
      ...block("Feedback", [clean(task.review.feedback)], width, paint.warning, { labelStyle: text => paint.bold(paint.warning(text)), surface: "surface" }),
    ];
  }
  if (task.status === "done" && report.decide) return [paintBackground(paint.bold(paint.accent("New delivery")) + paint.dim(" · ") + paint.accent(clean(report.decide)), "surfaceActive")];
  if (needsUser(task) && task.blockedOn) return block("Needs you", [clean(task.blockedOn.action)], width, paint.warning, { labelStyle: text => paint.bold(paint.warning(text)), surface: "surface" });
  if (task.blockedOn?.responder === "children") return block("Delegated", ["to its members. " + clean(task.blockedOn.action)], width, paint.notice, { labelStyle: text => paint.bold(paint.notice(text)), surface: "surface" });
  if (task.error) return block("Problem", [clean(task.error)], width, paint.danger, { labelStyle: text => paint.bold(paint.danger(text)), surface: "surface" });
  return [];
}

// Delivery file sizes read best in the unit a person would say.
function fileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function delivery({ task, artifacts }, width) {
  const r = task.report;
  if (!r) return [paintBackground(paint.dim("No delivery report yet."), "surface")];
  const files = artifacts.map(file => [paint.bold(paint.code(single(file.name))), file.size ? paint.notice(fileSize(file.size)) : "", paint.path(clean(file.path || ""))].filter(Boolean).join("  "));
  const published = !files.length && r.artifacts?.length ? [paint.dim(`${r.artifacts.length} published file${r.artifacts.length === 1 ? "" : "s"}`)] : [];
  return gap([
    block("Outcome", [clean(r.outcome)], width, text => paint.bold(paint.success(text)), { labelStyle: text => paint.bold(paint.success(text)), surface: "surface" }),
    block("Summary", [clean(r.summary)], width, text => text, { labelStyle: text => paint.bold(paint.accent(text)) }),
    block("Evidence", r.evidence.length ? r.evidence.map(item => paint.success("• ") + single(item)) : [paint.dim("none given")], width, text => text, { labelStyle: text => paint.bold(paint.fence(text)) }),
    block("Files", files.length ? files : published, width, text => text, { labelStyle: text => paint.bold(paint.path(text)) }),
    block("Next", [clean(r.nextAction)], width, paint.notice, { labelStyle: text => paint.bold(paint.notice(text)) }),
  ]);
}

function history({ task, runs, name }, width, expanded) {
  const notes = task.notes || [];
  const counts = [["Notes", notes.length], ["Runs", runs.length]].filter(([, count]) => count);
  if (!counts.length) return [];
  if (!expanded) return [paintBackground(paint.accent("▸ History") + paint.dim(" · " + counts.map(([label, count]) => label + " " + count).join(" · ") + "   z to show"), "surface")];
  return gap([
    [paintBackground(paint.accent("▾ History") + paint.dim("   z to hide"), "surface")],
    block("Notes", notes.map(note => paint.dim(stamp(note.createdAt)) + "  " + paint.accent(single(name(note.author))) + ": " + single(note.text)), width, text => text, { labelStyle: paint.fence }),
    block("Runs", runs.map(run => paint.dim(stamp(run.startedAt)) + "  " + (run.status === "succeeded" ? paint.success(single(run.status)) : paint.warning(single(run.status)))), width, text => text, { labelStyle: paint.fence }),
  ]);
}

// report: { task (with notes), team, owner, artifacts [{name, path}], runs,
// archived, decide (the review keys offered, e.g. "a accept"),
// name(id) for note authors }.
export function renderReport(report, width, { expanded = false, now = Date.now() } = {}) {
  const { task } = report;
  const when = task.deliveredAt ? paint.dim("delivered " + ago(task.deliveredAt, now)) : "";
  const priority = task.priority ? (task.priority === "high" ? paint.warning(task.priority + " priority") : paint.dim(task.priority + " priority")) : "";
  const header = paintBackground([badge(taskStatus(task)), paint.bold(single(report.team) + " › " + single(report.owner)), when, priority].filter(Boolean).join(paint.dim(" · ")), "surfaceActive");
  const origin = task.reworkOf ? "Rework of an earlier delivery" : "";
  return gap([
    [header, ...(origin ? [paint.notice(origin)] : [])],
    briefBlock(task.brief, width, expanded),
    standing(report, width, now),
    delivery(report, width),
    history(report, width, expanded),
  ]);
}
