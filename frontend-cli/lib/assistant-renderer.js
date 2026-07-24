import { graphemes, textWidth } from "./text-width.js";

const INLINE_TOKEN_RE = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
const PLAIN_TEXT_RE = /[`*#>|\[]/;
const CONTENT_PREFIX = "  ";
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export class AssistantRenderer {
  constructor(write, options = {}) {
    this.write = write;
    this.color = options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
    this.pending = "";
    this.inCodeBlock = false;
    this.lineOpen = false;
    this.atLineStart = true;
    this.visibleColumn = 0;
    this.columns = options.columns;
  }

  append(text) {
    this.pending += String(text || "");
    while (true) {
      const newlineIndex = this.pending.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      this.renderLine(line, true);
    }
    this.flushPlainPending();
  }

  finish() {
    if (this.pending) {
      this.renderLine(this.pending, false);
      this.pending = "";
    }
    if (this.lineOpen) {
      this.writeText("\n");
      this.lineOpen = false;
    }
  }

  flushPlainPending() {
    if (!this.pending || this.inCodeBlock || !isPlainLine(this.pending)) {
      return;
    }
    this.writePlain(this.pending, false);
    this.pending = "";
  }

  renderLine(line, newline) {
    if (isTableLine(line, this.inCodeBlock)) {
      this.renderTableLine(line, newline);
      return;
    }
    if (line.trim().startsWith("```")) {
      this.renderCodeFence(line, newline);
      return;
    }
    if (this.inCodeBlock) {
      this.writeStyled(styled(line, this.color, "codeBlock"), newline);
      return;
    }
    if (isPlainLine(line)) {
      this.writePlain(line, newline);
      return;
    }
    this.writeStyled(renderMarkdownishLine(line, this.color), newline);
  }

  renderTableLine(line, newline) {
    const cells = parseTableRow(line);
    if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      return;
    }
    const rendered = cells.map((cell, index) =>
      renderInline(cell, this.color, index === 0 ? "tableHeader" : "")
    );
    this.writeStyled(rendered.join(dim(" | ", this.color)), newline);
  }

  renderCodeFence(line, newline) {
    const opening = !this.inCodeBlock;
    this.inCodeBlock = opening;
    const label = opening ? line.trim().slice(3).trim().slice(0, 32) : "";
    this.writeStyled(dim(opening ? codeOpenLabel(label) : "└ end", this.color), newline);
  }

  writePlain(text, newline) {
    this.writeText(text + (newline ? "\n" : ""));
    this.lineOpen = Boolean(text) && !newline;
  }

  writeStyled(text, newline) {
    this.writeText(text + (newline ? "\n" : ""));
    this.lineOpen = Boolean(text) && !newline;
  }

  writeText(text) {
    const parts = String(text || "").split(/(\r\n|\r|\n)/);
    const maxWidth = Math.max(1, Math.floor(Number(this.columns ?? process.stdout.columns ?? 80) || 80));
    const prefixWidth = textWidth(CONTENT_PREFIX);
    let output = "";
    for (const part of parts) {
      if (!part) {
        continue;
      }
      if (part === "\r\n" || part === "\r" || part === "\n") {
        if (this.atLineStart) {
          output += CONTENT_PREFIX;
        }
        output += part;
        this.atLineStart = true;
        this.visibleColumn = 0;
        continue;
      }
      for (const segment of ansiSegments(part)) {
        if (segment.ansi) {
          if (this.atLineStart) {
            output += CONTENT_PREFIX;
            this.atLineStart = false;
            this.visibleColumn = prefixWidth;
          }
          output += segment.text;
          continue;
        }
        for (const grapheme of graphemes(segment.text)) {
          const segmentWidth = textWidth(grapheme);
          if (this.atLineStart) {
            output += CONTENT_PREFIX;
            this.atLineStart = false;
            this.visibleColumn = prefixWidth;
          }
          if (
            segmentWidth > 0
            && this.visibleColumn > prefixWidth
            && this.visibleColumn + segmentWidth > maxWidth
          ) {
            output += `\n${CONTENT_PREFIX}`;
            this.visibleColumn = prefixWidth;
          }
          output += grapheme;
          this.visibleColumn += segmentWidth;
        }
      }
    }
    if (output) {
      this.write(output);
    }
  }
}

function ansiSegments(value) {
  const segments = [];
  let position = 0;
  for (const match of value.matchAll(ANSI_SEQUENCE)) {
    if (match.index > position) {
      segments.push({ text: value.slice(position, match.index), ansi: false });
    }
    segments.push({ text: match[0], ansi: true });
    position = match.index + match[0].length;
  }
  if (position < value.length) {
    segments.push({ text: value.slice(position), ansi: false });
  }
  return segments;
}

function renderMarkdownishLine(line, color) {
  const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (heading) {
    return renderInline(heading[2], color, "heading");
  }

  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    return `${quote[1]}${dim("│ ", color)}${renderInline(quote[2], color)}`;
  }

  const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (list) {
    const marker = /^\d+\.$/.test(list[2]) ? list[2] : "•";
    return `${list[1]}${dim(`${marker} `, color)}${renderInline(list[3], color)}`;
  }

  return renderInline(line, color);
}

function renderInline(text, color, baseStyle = "") {
  const source = String(text || "");
  let output = "";
  let index = 0;
  for (const match of source.matchAll(INLINE_TOKEN_RE)) {
    output += styled(source.slice(index, match.index), color, baseStyle);
    output += renderInlineToken(match[0], color, baseStyle);
    index = match.index + match[0].length;
  }
  return output + styled(source.slice(index), color, baseStyle);
}

function renderInlineToken(token, color, baseStyle) {
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    return `${renderInline(link[1], color, baseStyle)} ${dim(`(${link[2]})`, color)}`;
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    return styled(token.slice(1, -1), color, "inlineCode");
  }
  if (token.startsWith("**") && token.endsWith("**")) {
    return styled(token.slice(2, -2), color, baseStyle || "emphasis");
  }
  return token;
}

function isPlainLine(line) {
  if (!line) {
    return true;
  }
  if (PLAIN_TEXT_RE.test(line)) {
    return false;
  }
  const stripped = line.trimStart();
  return !stripped.match(/^([-*+]|\d+\.)\s+/);
}

function isTableLine(line, inCodeBlock) {
  const stripped = line.trim();
  return !inCodeBlock && stripped.includes("|") && stripped.split("|").length > 2;
}

function parseTableRow(line) {
  let stripped = line.trim();
  if (stripped.startsWith("|")) {
    stripped = stripped.slice(1);
  }
  if (stripped.endsWith("|")) {
    stripped = stripped.slice(0, -1);
  }
  return stripped.split("|").map((cell) => cell.trim());
}

function codeOpenLabel(label) {
  return label ? `┌ code ${label}` : "┌ code";
}

function styled(text, color, style) {
  if (!text || !color || !style) {
    return text;
  }
  const codes = {
    codeBlock: "38;5;110",
    emphasis: "1;38;5;221",
    heading: "1;38;5;81",
    inlineCode: "38;5;215",
    tableHeader: "1;38;5;81",
  };
  const code = codes[style] || codes.emphasis;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text, color) {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}
