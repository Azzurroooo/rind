import { ANSI_SEQUENCE } from "./text-width.js";
import { graphemes, textWidth } from "./text-width.js";
import {
  codeOpenLabel,
  consumeTableLine,
  createTableState,
  dim,
  finishTableState,
  isPlainLine,
  renderTableBlock,
  renderMarkdownishLine,
  styled,
} from "./markdown-lines.js";

const CONTENT_PREFIX = "  ";

export { CONTENT_PREFIX };

export class AssistantRenderer {
  constructor(write, options = {}) {
    this.write = write;
    this.color = options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
    this.pending = "";
    this.inCodeBlock = false;
    this.tableState = createTableState();
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
    const table = finishTableState(this.tableState);
    if (table?.type === "flush") {
      this.writeTable(table.rows);
    } else if (table?.type === "flush_candidate") {
      table.lines.forEach((line) => this.renderNormalLine(line, true));
    }
    if (this.lineOpen) {
      this.writeText("\n");
      this.lineOpen = false;
    }
  }

  flushPlainPending() {
    if (!this.pending || this.inCodeBlock || this.tableState.candidate.length || this.tableState.rows || !isPlainLine(this.pending)) {
      return;
    }
    this.writePlain(this.pending, false);
    this.pending = "";
  }

  renderLine(line, newline) {
    const result = consumeTableLine(this.tableState, line, this.inCodeBlock);
    if (result.type === "hold" || result.type === "append") {
      return;
    }
    if (result.type === "start") {
      result.lines?.forEach((candidate) => this.renderNormalLine(candidate, true));
      return;
    }
    if (result.type === "flush") {
      this.writeTable(result.rows);
      if (result.line === undefined) return;
      this.renderNormalLine(result.line, newline);
      return;
    }
    if (result.type === "flush_candidate") {
      result.lines.forEach((candidate) => this.renderNormalLine(candidate, true));
      if (result.line !== undefined) this.renderNormalLine(result.line, newline);
      return;
    }
    this.renderNormalLine(line, newline);
  }

  renderNormalLine(line, newline) {
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

  writeTable(rows) {
    const table = renderTableBlock(
      rows,
      this.color,
      Math.max(1, Math.floor(Number(this.columns ?? process.stdout.columns ?? 80) || 80) - CONTENT_PREFIX.length),
    );
    if (table) {
      this.writeStyled(table, true);
    }
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
