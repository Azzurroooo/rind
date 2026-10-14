// The right-hand panel of the Agents page. Every row describes itself with the
// same parts, drawn in the same order:
//
//   title     bold, at most a few lines
//   context   one dim line: where it belongs
//   state     one line: status, toned
//   callout   at most one thing that needs doing, toned
//   facts     label column + value; values wrap under themselves
//   text      short prose, for rows that are places rather than things
//
// Parts are separated by one blank line; facts sit together. When the panel
// is too short, whole facts are dropped from the end (they come most important
// first) instead of cutting one in half.
import { paint } from "./theme.js";
import { textWidth, truncateToWidth, wrapTextWithAnsi } from "./text-width.js";
import { clean } from "./agents-model.js";

const LABEL = 9;
// Below this width labels sit above their values.
const STACK_BELOW = 34;
const TONES = { warning: paint.warning, accent: paint.accent, success: paint.success, danger: paint.danger };

// Strips OSC, non-SGR CSI and control characters while keeping SGR colors (\x1b[...m).
const safe = value => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b(?!\[[0-9;]*m)/g, "").replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");

// Wrapped lines lose the space they broke at.
const wrapped = (text, width) => wrapTextWithAnsi(text, Math.max(1, width)).map(line => line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1"));
function limited(lines, max, width) {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), truncateToWidth(lines[max - 1] + " …", width, "…")];
}
// A value is a line or several; each wraps, and the whole fact keeps to `lines`.
function valueLines(value, width, max) {
  const parts = (Array.isArray(value) ? value : [value]).filter(part => part !== undefined && part !== null && part !== "");
  return limited(parts.flatMap(part => wrapped(safe(part), width)), max, width);
}

function factLines({ label, value, lines = 2 }, width) {
  if (width < STACK_BELOW) return [paint.dim(label), ...valueLines(value, width - 2, lines).map(line => "  " + line)];
  return valueLines(value, width - LABEL, lines).map((line, index) => (index ? " ".repeat(LABEL) : paint.dim(label.padEnd(LABEL))) + line);
}

export function renderPanel(panel, width, height = Infinity) {
  if (!panel) return [];
  const head = [
    ...limited(wrapped(paint.bold(clean(panel.title || "")), width), panel.titleLines || 2, width),
    ...(panel.context ? [truncateToWidth(paint.dim(clean(panel.context)), width, "…")] : []),
  ];
  const sections = [head];
  if (panel.state) sections.push([truncateToWidth(safe(panel.state), width, "…")]);
  if (panel.callout) sections.push(wrapped((TONES[panel.callout.tone] || paint.warning)(clean(panel.callout.text)), width));
  const rawFacts = (panel.facts || []).filter(fact => fact && fact.value !== undefined && fact.value !== null && fact.value !== "" && !(Array.isArray(fact.value) && !fact.value.length));
  const facts = rawFacts.map(fact => factLines(fact, width));
  const text = (panel.text || []).map(paragraph => wrapped(safe(paragraph), width));
  const assemble = count => {
    const parts = [...sections, ...(count ? [facts.slice(0, count).flat()] : []), ...text];
    return parts.flatMap((lines, index) => (index ? ["", ...lines] : lines));
  };
  let count = facts.length;
  let lines = assemble(count);
  while (count > 0 && lines.length > height) {
    if (count === 1) {
      const base = assemble(0).length;
      const room = height - base - (base ? 1 : 0) - (width < STACK_BELOW ? 1 : 0);
      if (room >= 1) {
        facts[0] = factLines({ ...rawFacts[0], lines: Math.min(rawFacts[0].lines || 2, room) }, width);
        lines = assemble(1);
        break;
      }
    }
    lines = assemble(--count);
  }
  return lines.slice(0, height).map(line => (textWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}
