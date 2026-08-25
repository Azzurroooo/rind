import { graphemes, textWidth } from "./text-width.js";
import {
  codeOpenLabel,
  dim,
  isPlainLine,
  isTableLine,
  parseTableRow,
  renderInline,
  renderMarkdownishLine,
  styled,
} from "./markdown-lines.js";

const CONTENT_PREFIX = "  ";
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export { CONTENT_PREFIX };

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
