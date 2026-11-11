const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CSI_AT = /\x1b\[[0-?]*[ -/]*[@-~]/y;
const LINE_BREAK_RE = /\r\n|\r|\n/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;
const segmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

// Intl.Segmenter only ever sees short windows of text. On some runtimes
// (Node 20) each step of a segment iterator costs time proportional to the
// whole input, so segmenting one long string is quadratic in time and memory.
const SEGMENT_WINDOW = 256;
const SEGMENT_WINDOW_MAX = 1024;
// Code points that always attach to the one before them, so a window never
// ends right before one: marks, emoji modifiers, joiners, variation selectors,
// tag characters and conjoining Hangul jamo.
const JOINS_PREVIOUS_RE = /^[\p{M}\p{Emoji_Modifier}\u200d\ufe00-\ufe0f\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
const REGIONAL_INDICATOR_RE = /^[\u{1f1e6}-\u{1f1ff}]$/u;
// Code points that can join a grapheme cluster with a neighbour: CR (before LF),
// joiners and extenders, spacing marks (including Thai and Lao AM), emoji
// modifiers, regional indicators, conjoining Hangul jamo and prepended
// concatenation marks. Text without any of them is one grapheme per code
// point, and skips Intl.Segmenter entirely; each call into the segmenter
// costs far more than reading the code points.
const CLUSTERING_RE = /[\r\u200d\p{Grapheme_Extend}\p{Mc}\u0e33\u0eb3\p{Emoji_Modifier}\p{Regional_Indicator}\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u0d4e\u{110bd}\u{110cd}\u{111c2}\u{111c3}\u{1193f}\u{11941}\u{11a3a}\u{11a84}-\u{11a89}\u{11d46}\u{11f02}\u{113d1}\u{16d63}\u{16d67}-\u{16d6a}]/u;

export const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value) {
  return String(value || "").replace(ANSI_RE, "");
}

export function graphemes(value) {
  const text = String(value || "");
  if (PRINTABLE_ASCII_RE.test(text)) return text.split("");
  return Array.from(eachGrapheme(text, 0, text.length));
}

const WIDTH_CACHE_MAX = 4096;
const widthCache = new Map();

export function textWidth(value) {
  const text = stripAnsi(value);
  if (PRINTABLE_ASCII_RE.test(text)) return text.length;
  if (text.length <= 512) {
    const cached = widthCache.get(text);
    if (cached !== undefined) return cached;
  }
  let width = 0;
  for (const segment of eachGrapheme(text, 0, text.length)) width += segmentWidth(segment);
  if (text.length <= 512) {
    if (widthCache.size >= WIDTH_CACHE_MAX) {
      widthCache.delete(widthCache.keys().next().value);
    }
    widthCache.set(text, width);
  }
  return width;
}

export function wrapTextCells(value, firstWidth, continuationWidth = firstWidth) {
  const chars = graphemes(value);
  if (!chars.length) {
    return [{
      text: "",
      startColumn: 0,
      length: 0,
      allowsEnd: true,
    }];
  }

  const chunks = [];
  let startColumn = 0;
  let availableWidth = positiveWidth(firstWidth);
  const nextLineWidth = positiveWidth(continuationWidth);
  while (startColumn < chars.length) {
    let endColumn = startColumn;
    let width = 0;
    while (endColumn < chars.length) {
      const nextWidth = segmentWidth(chars[endColumn]);
      if (width > 0 && width + nextWidth > availableWidth) {
        break;
      }
      width += nextWidth;
      endColumn += 1;
    }
    chunks.push({
      text: chars.slice(startColumn, endColumn).join(""),
      startColumn,
      length: endColumn - startColumn,
      allowsEnd: width < availableWidth,
    });
    startColumn = endColumn;
    availableWidth = nextLineWidth;
  }
  return chunks;
}

// Cuts text to maxWidth visible cells, ending in the ellipsis when anything is
// left out. Reads only as far as the cut, however long the text is.
export function truncateToWidth(value, maxWidth, ellipsis = "...") {
  const text = String(value || "");
  const ellipsisWidth = textWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) {
    return scanPrefix(text, maxWidth).overflow ? ellipsis.slice(0, Math.max(0, maxWidth)) : text;
  }
  const { kept, overflow } = scanPrefix(text, maxWidth - ellipsisWidth, maxWidth);
  return overflow ? closeAnsi(`${kept}${ellipsis}`) : text;
}

export function clipCells(value, maxWidth) {
  return truncateToWidth(value, maxWidth);
}

export function middleClipCells(value, maxWidth) {
  const text = String(value || "");
  if (!scanPrefix(text, maxWidth).overflow) {
    return text;
  }
  const suffix = "...";
  const available = Math.max(0, maxWidth - textWidth(suffix));
  const head = scanPrefix(text, Math.ceil(available / 2)).kept;
  return closeAnsi(`${closeAnsi(head)}${suffix}${takeEndCells(text, Math.floor(available / 2))}`);
}

export function wrapTextWithAnsi(value, firstWidth, continuationWidth = firstWidth) {
  const source = String(value ?? "");
  const first = positiveWidth(firstWidth);
  const cont = positiveWidth(continuationWidth);
  const lines = [];
  for (const logicalLine of source.split(LINE_BREAK_RE)) {
    wrapLogicalLine(logicalLine, first, cont, lines);
  }
  return lines.length ? lines : [""];
}

function wrapLogicalLine(line, firstWidth, contWidth, out) {
  const tokens = tokenizeLine(line);
  let available = firstWidth;
  let width = 0;
  let body = "";
  let hasContent = false;
  let activeCodes = [];

  const finishLine = () => {
    out.push(`${body}${body.includes("\x1b[") ? "\x1b[0m" : ""}`);
    body = activeCodes.join("");
    width = 0;
    hasContent = false;
    available = contWidth;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "ansi") {
      applyAnsiToState(token.text, activeCodes);
      body += token.text;
      continue;
    }
    let text = token.text;
    let tokenWidth = token.width;
    for (;;) {
      if (width + tokenWidth <= available) {
        body += text;
        width += tokenWidth;
        if (token.kind !== "space") {
          hasContent = true;
        }
        break;
      }
      if (token.kind === "space") {
        break;
      }
      if (!hasContent && width === 0 && tokenWidth > available) {
        const { kept, keptWidth } = scanPrefix(text, available);
        if (!kept || kept === text) {
          body += text;
          width += tokenWidth;
          hasContent = true;
          break;
        }
        body += kept;
        width += keptWidth;
        hasContent = true;
        text = text.slice(kept.length);
        tokenWidth -= keptWidth;
        finishLine();
        continue;
      }
      finishLine();
    }
  }
  out.push(`${body}${body.includes("\x1b[") ? "\x1b[0m" : ""}`);
}

function tokenizeLine(line) {
  const tokens = [];
  let word = "";
  let wordWidth = 0;
  let spaces = "";
  let spaceCount = 0;

  const flushWord = () => {
    if (word) {
      tokens.push({ kind: "word", text: word, width: wordWidth });
      word = "";
      wordWidth = 0;
    }
  };
  const flushSpaces = () => {
    if (spaces) {
      tokens.push({ kind: "space", text: spaces, width: spaceCount });
      spaces = "";
      spaceCount = 0;
    }
  };

  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\x1b") {
      const end = findCsiEnd(line, index);
      if (end !== -1) {
        flushWord();
        flushSpaces();
        tokens.push({ kind: "ansi", text: line.slice(index, end), width: 0 });
        index = end;
        continue;
      }
    }
    const codePoint = line.codePointAt(index);
    const segment = String.fromCodePoint(codePoint);
    if (segment === " ") {
      flushWord();
      spaces += segment;
      spaceCount += 1;
    } else {
      flushSpaces();
      const width = segmentWidth(segment);
      if (width > 1) {
        flushWord();
        tokens.push({ kind: "word", text: segment, width });
      } else {
        word += segment;
        wordWidth += width;
      }
    }
    index += segment.length;
  }
  flushWord();
  flushSpaces();
  return tokens;
}

function findCsiEnd(value, start) {
  if (start + 1 >= value.length || value[start + 1] !== "[") {
    return -1;
  }
  for (let index = start + 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
  }
  return -1;
}

function applyAnsiToState(sequence, activeCodes) {
  const params = sequence.slice(2, -1);
  if (params === "" || params === "0") {
    activeCodes.length = 0;
    return;
  }
  activeCodes.push(sequence);
}

// One pass over the start of the text: graphemes are kept while they fit in
// keepWidth, and the walk stops once the visible width exceeds limit. Escape
// sequences stay whole and take no cells.
function scanPrefix(text, keepWidth, limit = keepWidth) {
  let kept = "";
  let keptWidth = 0;
  let total = 0;
  let keeping = true;
  for (const token of eachToken(text)) {
    const width = segmentWidth(token);
    if (keeping && keptWidth + width <= keepWidth) {
      kept += token;
      keptWidth += width;
    } else {
      keeping = false;
    }
    total += width;
    if (total > limit) {
      return { kept, keptWidth, overflow: true };
    }
  }
  return { kept, keptWidth, overflow: false };
}

// The last maxWidth cells of the text. Only a tail window is read; it doubles
// until it holds enough cells or reaches the start.
function takeEndCells(text, maxWidth) {
  for (let span = maxWidth * 4 + 16; ; span *= 2) {
    const from = alignedStart(text, text.length - span);
    const tokens = Array.from(eachToken(text.slice(from)));
    let output = "";
    let width = 0;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const nextWidth = segmentWidth(tokens[index]);
      if (width + nextWidth > maxWidth) {
        return output;
      }
      output = `${tokens[index]}${output}`;
      width += nextWidth;
    }
    if (from === 0) {
      return output;
    }
  }
}

// A cut can leave a style open; reset it so it cannot bleed into padding.
function closeAnsi(text) {
  return text.includes("\x1b[") && !text.endsWith("\x1b[0m") ? text + "\x1b[0m" : text;
}

// Escape sequences, whole, and the graphemes between them, lazily.
function* eachToken(text) {
  let start = 0;
  while (start < text.length) {
    const escape = text.indexOf("\x1b", start);
    const end = escape === -1 ? text.length : escape;
    yield* eachGrapheme(text, start, end);
    if (escape === -1) {
      return;
    }
    CSI_AT.lastIndex = escape;
    start = CSI_AT.test(text) ? CSI_AT.lastIndex : escape + 1;
    yield text.slice(escape, start);
  }
}

// Graphemes of text[start, end), segmented one bounded window at a time. A
// window only ends inside a cluster when no boundary exists nearby (one cluster
// longer than a window); the pieces after such a cut are joined back on.
function* eachGrapheme(text, start, end) {
  let pending = "";
  while (start < end) {
    const cut = windowEnd(text, start, end);
    const chunk = text.slice(start, cut);
    let windowStart = true;
    const segments = !segmenter || !CLUSTERING_RE.test(chunk)
      ? chunk
      : Array.from(segmenter.segment(chunk), ({ segment }) => segment);
    for (const segment of segments) {
      if (windowStart && pending && JOINS_PREVIOUS_RE.test(segment)) {
        pending += segment;
      } else {
        if (pending) yield pending;
        pending = segment;
      }
      windowStart = false;
    }
    start = cut;
  }
  if (pending) yield pending;
}

function windowEnd(text, start, end) {
  if (end - start <= SEGMENT_WINDOW_MAX) {
    return end;
  }
  for (let index = start + SEGMENT_WINDOW; index < start + SEGMENT_WINDOW_MAX; index += 1) {
    if (isGraphemeBoundary(text, index)) return index;
  }
  return nearbyBoundary(text, start + SEGMENT_WINDOW_MAX, start + SEGMENT_WINDOW);
}

// The first boundary at or after index that does not fall inside an escape sequence.
function alignedStart(text, index) {
  if (index <= 0) {
    return 0;
  }
  const lookback = Math.max(0, index - 64);
  const found = text.slice(lookback, index).lastIndexOf("\x1b");
  if (found !== -1) {
    const escape = lookback + found;
    CSI_AT.lastIndex = escape;
    if (CSI_AT.test(text) && CSI_AT.lastIndex > index) {
      return CSI_AT.lastIndex;
    }
  }
  const limit = Math.min(text.length, index + SEGMENT_WINDOW_MAX);
  for (let at = index; at < limit; at += 1) {
    if (text[at] === "\x1b" || isGraphemeBoundary(text, at)) return at;
  }
  return limit === text.length ? text.length : nearbyBoundary(text, limit, index);
}

// Unicode grapheme rules break here whatever surrounds it: after a line feed,
// and between two base characters that never combine (printable ASCII, CJK
// ideographs, Hangul syllables).
function isGraphemeBoundary(text, index) {
  const before = text.charCodeAt(index - 1);
  return before === 0x0a || (isPlainBase(before) && isPlainBase(text.charCodeAt(index)));
}

function isPlainBase(code) {
  return (code >= 0x20 && code <= 0x7e)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7a3);
}

// For long runs without a guaranteed boundary: step back from index past
// positions that would split a surrogate pair, an emoji sequence, a flag or a
// combining sequence.
function nearbyBoundary(text, index, floor) {
  for (let at = index; at > floor; at -= 1) {
    const before = text.charCodeAt(at - 1);
    if ((before >= 0xd800 && before <= 0xdbff) || before === 0x200d || before === 0x0d) continue;
    if (JOINS_PREVIOUS_RE.test(text.slice(at, at + 2))) continue;
    if (REGIONAL_INDICATOR_RE.test(text.slice(at, at + 2)) && REGIONAL_INDICATOR_RE.test(text.slice(at - 2, at))) continue;
    return at;
  }
  return index;
}

function segmentWidth(segment) {
  if (segment.length === 1 && segment >= " " && segment <= "~") return 1;
  // A lone wide character (CJK, Hangul, fullwidth forms) is two cells, emoji or not.
  const code = segment.codePointAt(0);
  if (segment.length === (code > 0xffff ? 2 : 1) && isWideCodePoint(code)) return 2;
  const text = stripAnsi(segment);
  if (!text || isZeroWidth(text)) {
    return 0;
  }
  if (isEmoji(text)) {
    return 2;
  }
  return Array.from(text).some((char) => isWideCodePoint(char.codePointAt(0))) ? 2 : 1;
}

function positiveWidth(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
}

function isZeroWidth(text) {
  return /^[\u0300-\u036f\u0483-\u0489\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]+$/u.test(text);
}

// Two cells only for emoji presentation. Pictographic symbols such as \u21a9 \u25b6 \u2714 \u00a9
// default to text presentation and take one cell, unless FE0F asks for emoji.
function isEmoji(text) {
  return /^[0-9#*]\ufe0f?\u20e3$/u.test(text)
    || /[\u{1f1e6}-\u{1f1ff}]/u.test(text)
    || /\p{Emoji_Presentation}/u.test(text)
    || (text.includes("\u200d") && /\p{Extended_Pictographic}/u.test(text))
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
