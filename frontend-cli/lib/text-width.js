const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const segmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function stripAnsi(value) {
  return String(value || "").replace(ANSI_RE, "");
}

export function graphemes(value) {
  const text = String(value || "");
  return segmenter
    ? Array.from(segmenter.segment(text), (segment) => segment.segment)
    : Array.from(text);
}

export function textWidth(value) {
  return graphemes(stripAnsi(value)).reduce((width, segment) => width + segmentWidth(segment), 0);
}

export function clipCells(value, maxWidth) {
  const text = String(value || "");
  if (textWidth(text) <= maxWidth) {
    return text;
  }
  const suffix = "...";
  const suffixWidth = textWidth(suffix);
  if (maxWidth <= suffixWidth) {
    return suffix.slice(0, Math.max(0, maxWidth));
  }
  return `${takeStartCells(text, maxWidth - suffixWidth)}${suffix}`;
}

export function middleClipCells(value, maxWidth) {
  const text = String(value || "");
  if (textWidth(text) <= maxWidth) {
    return text;
  }
  const suffix = "...";
  const available = Math.max(0, maxWidth - textWidth(suffix));
  const headWidth = Math.ceil(available / 2);
  const tailWidth = Math.floor(available / 2);
  return `${takeStartCells(text, headWidth)}${suffix}${takeEndCells(text, tailWidth)}`;
}

function takeStartCells(value, maxWidth) {
  let output = "";
  let width = 0;
  for (const segment of graphemes(value)) {
    const nextWidth = segmentWidth(segment);
    if (width + nextWidth > maxWidth) {
      break;
    }
    output += segment;
    width += nextWidth;
  }
  return output;
}

function takeEndCells(value, maxWidth) {
  let output = "";
  let width = 0;
  for (const segment of graphemes(value).reverse()) {
    const nextWidth = segmentWidth(segment);
    if (width + nextWidth > maxWidth) {
      break;
    }
    output = `${segment}${output}`;
    width += nextWidth;
  }
  return output;
}

function segmentWidth(segment) {
  const text = stripAnsi(segment);
  if (!text || isZeroWidth(text)) {
    return 0;
  }
  if (isEmoji(text)) {
    return 2;
  }
  return Array.from(text).some((char) => isWideCodePoint(char.codePointAt(0))) ? 2 : 1;
}

function isZeroWidth(text) {
  return /^[\u0300-\u036f\u0483-\u0489\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]+$/u.test(text);
}

function isEmoji(text) {
  return /^[0-9#*]\ufe0f?\u20e3$/u.test(text)
    || /[\u{1f1e6}-\u{1f1ff}]/u.test(text)
    || /\p{Extended_Pictographic}/u.test(text)
    || text.includes("\u200d")
    || text.includes("\ufe0f");
}

function isWideCodePoint(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
}
