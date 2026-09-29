// Line caps per body kind (spec 5.3), after frontend-cli/lib/tool-display.js:
// `cap` is what an opened row shows, `expandedCap` what "Show all" reveals.
export const CAPS = Object.freeze({
  terminal: { cap: 5, expandedCap: 400 },
  code: { cap: 20, expandedCap: 400 },
  diff: { cap: 20, expandedCap: 400 },
  list: { cap: 20, expandedCap: 200 },
  web: { cap: 16, expandedCap: 16 },
  markdown: { cap: 24, expandedCap: 24 },
  generic: { cap: 40, expandedCap: 40 },
  error: { cap: 6 },
});

export const LIVE_FINISHED_WINDOW = 2;

export function meta(text, tone = "dim") {
  return text ? [{ text: String(text), tone }] : [];
}
