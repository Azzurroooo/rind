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

// Formats inline Markdown (**bold**, `code`, [label](url)) while keeping the caller's base style.
export function formatInline(value, base = text => text) {
  let out = "", last = 0;
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  for (const match of value.matchAll(pattern)) {
    if (match.index > last) out += base(value.slice(last, match.index));
    if (match[1] !== undefined) out += paint.code(match[1]);
    else if (match[2] !== undefined) out += paint.bold(base(match[2]));
    else out += paint.bold(base(match[3])) + paint.dim(" (" + match[4] + ")");
    last = match.index + match[0].length;
  }
  return out + (last < value.length ? base(value.slice(last)) : "");
}

// Turns multi-line report prose (headings, bullets, numbered items, code fences) into styled lines.
export function formatReportLines(value, base = text => text) {
  const raw = clean(value).trim();
  if (!raw) return [];
  const lines = [];
  let inFence = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (!trimmed) continue;
    if (inFence) { lines.push("  " + paint.code(line.replace(/^\s{0,2}/, ""))); continue; }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) { lines.push(paint.bold(formatInline(heading[1], base))); continue; }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) { lines.push(paint.accent("• ") + formatInline(bullet[1], base)); continue; }
    const numbered = trimmed.match(/^(\d+[.)])\s+(.*)$/);
    if (numbered) { lines.push(paint.accent(numbered[1] + " ") + formatInline(numbered[2], base)); continue; }
    lines.push(formatInline(trimmed, base));
  }
  return lines;
}

// The page title is the brief's first line; here it reads in full, line breaks kept.
export function briefTitle(brief) { return single(clean(brief).trim().split(/\r?\n/)[0]); }
// Whether a brief may fold at some width: never wrongly no; the report body says when it did.
export function mayFoldBrief(brief) { const text = clean(brief).trim(); return text.split(/\r?\n/).length > BRIEF_LINES || text.length > BRIEF_LINES * 30; }
function briefBlock(brief, width, expanded) {
  const raw = clean(brief).trim().split(/\r?\n/).filter(line => line.trim());
  const formatted = raw.map((line, index) => index === 0 ? paint.bold(formatInline(line.trim().replace(/^#{1,6}\s+/, ""))) : formatReportLines(line)[0] || single(line));
  const lines = block("Task", formatted, width, text => text, { labelStyle: text => paint.bold(paint.accent(text)), surface: "surface" });
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
      ...block("Feedback", formatReportLines(task.review.feedback, paint.warning), width, text => text, { labelStyle: text => paint.bold(paint.warning(text)), surface: "surface" }),
    ];
  }
  if (task.status === "done" && report.decide) return [paintBackground(paint.bold(paint.accent("New delivery")) + paint.dim(" · ") + paint.accent(clean(report.decide)), "surfaceActive")];
  if (needsUser(task) && task.blockedOn) return block("Needs you", formatReportLines(task.blockedOn.action, paint.warning), width, text => text, { labelStyle: text => paint.bold(paint.warning(text)), surface: "surface" });
  if (task.blockedOn?.responder === "children") return block("Delegated", ["to its members. " + single(task.blockedOn.action)], width, paint.notice, { labelStyle: text => paint.bold(paint.notice(text)), surface: "surface" });
  if (task.error) return block("Problem", formatReportLines(task.error, paint.danger), width, text => text, { labelStyle: text => paint.bold(paint.danger(text)), surface: "surface" });
  return [];
}

// Delivery file sizes read best in the unit a person would say.
export function fileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export const cap = value => { const s = single(value); return s ? s[0].toUpperCase() + s.slice(1) : ""; };

function delivery({ task, artifacts }, width) {
  const r = task.report;
  if (!r) return [paintBackground(paint.dim("No delivery report yet."), "surface")];
  const files = artifacts.map(file => [paint.bold(paint.code(single(file.name))), file.size ? paint.notice(fileSize(file.size)) : "", paint.path(clean(file.path || ""))].filter(Boolean).join("  "));
  const published = !files.length && r.artifacts?.length ? [paint.dim(`${r.artifacts.length} published file${r.artifacts.length === 1 ? "" : "s"}`)] : [];
  const summaryLines = formatReportLines(r.summary);
  const evidenceLines = (r.evidence || []).flatMap(item => {
    const parts = formatReportLines(clean(item).trim().replace(/^[-*•]\s+/, ""));
    return parts.map((line, i) => (i === 0 ? paint.success("• ") : "  ") + line);
  });
  return gap([
    block("Outcome", [formatInline(cap(r.outcome), text => paint.bold(paint.success(text)))], width, text => text, { labelStyle: text => paint.bold(paint.success(text)), surface: "surface" }),
    block("Summary", summaryLines, width, text => text, { labelStyle: text => paint.bold(paint.accent(text)) }),
    block("Evidence", evidenceLines.length ? evidenceLines : [paint.dim("none given")], width, text => text, { labelStyle: text => paint.bold(paint.fence(text)) }),
    block("Files", files.length ? files : published, width, text => text, { labelStyle: text => paint.bold(paint.path(text)) }),
    block("Next", formatReportLines(r.nextAction, paint.notice), width, text => text, { labelStyle: text => paint.bold(paint.notice(text)) }),
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
    block("Runs", runs.map(run => paint.dim(stamp(run.startedAt)) + "  " + (run.status === "succeeded" ? paint.success(cap(run.status)) : paint.warning(cap(run.status)))), width, text => text, { labelStyle: paint.fence }),
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
