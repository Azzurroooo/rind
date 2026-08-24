const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const LINE_BREAK_RE = /\r\n|\r|\n/;
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

export function truncateToWidth(value, maxWidth, ellipsis = "...") {
  const text = String(value || "");
  if (textWidth(text) <= maxWidth) {
    return text;
  }
  const suffixWidth = textWidth(ellipsis);
  if (maxWidth <= suffixWidth) {
    return ellipsis.slice(0, Math.max(0, maxWidth));
  }
  return `${takeStartCells(text, maxWidth - suffixWidth)}${ellipsis}`;
}

export function expandTabs(value, tabWidth = 4) {
  const text = String(value || "");
  if (!text.includes("\t")) {
    return text;
  }
  let column = 0;
  let output = "";
  for (const segment of graphemes(text)) {
    if (segment === "\t") {
      const spaces = tabWidth - (column % tabWidth);
      output += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    output += segment;
    column += segmentWidth(segment);
  }
  return output;
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
        const take = takeStartCells(text, available);
        if (!take || take === text) {
          body += text;
          width += tokenWidth;
          hasContent = true;
          break;
        }
        body += take;
        width += textWidth(take);
        hasContent = true;
        text = text.slice(take.length);
        tokenWidth -= textWidth(take);
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

function positiveWidth(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
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
