import { wrapTextWithAnsi } from "../text-width.js";
import {
  codeOpenLabel,
  dim,
  isPlainLine,
  isTableLine,
  parseTableRow,
  renderInline,
  renderMarkdownishLine,
  styled,
} from "../markdown-lines.js";

const CONTENT_PREFIX = "  ";

export class AssistantMessage {
  constructor(options = {}) {
    this.color = Boolean(options.color);
    this.finalized = [];
    this.pending = "";
    this.inCodeBlock = false;
    this.cacheWidth = -1;
    this.cacheItems = [];
    this.cacheLines = null;
  }

  append(delta) {
    this.pending += String(delta || "");
    for (;;) {
      const newlineIndex = this.pending.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      this.classifyFinalize(line);
    }
    this.cacheLines = null;
  }

  finish() {
    if (this.pending) {
      const line = this.pending;
      this.pending = "";
      this.classifyFinalize(line);
    }
    this.cacheLines = null;
  }

  get isEmpty() {
    return !this.finalized.length && !this.pending;
  }

  classifyFinalize(line) {
    if (isTableLine(line, this.inCodeBlock)) {
      this.finalizeTable(line);
      return;
    }
    if (line.trim().startsWith("```")) {
      this.finalizeCodeFence(line);
      return;
    }
    if (this.inCodeBlock) {
      this.finalize(styled(line, this.color, "codeBlock"));
      return;
    }
    if (isPlainLine(line)) {
      if (line) {
        this.finalize(line);
      } else {
        this.finalized.push("");
      }
      return;
    }
    this.finalize(renderMarkdownishLine(line, this.color));
  }

  finalizeTable(line) {
    const cells = parseTableRow(line);
    if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      return;
    }
    const rendered = cells.map((cell, index) =>
      renderInline(cell, this.color, index === 0 ? "tableHeader" : "")
    );
    this.finalize(rendered.join(dim(" | ", this.color)));
  }

  finalizeCodeFence(line) {
    const opening = !this.inCodeBlock;
    this.inCodeBlock = opening;
    const label = opening ? line.trim().slice(3).trim().slice(0, 32) : "";
    this.finalize(dim(opening ? codeOpenLabel(label) : "└ end", this.color));
  }

  finalize(logicalLine) {
    this.finalized.push(String(logicalLine ?? ""));
  }

  render(width) {
    if (this.cacheLines && this.cacheWidth === width && !this.pending) {
      return this.cacheLines;
    }
    if (this.cacheWidth !== width) {
      this.cacheItems.length = 0;
      this.cacheWidth = width;
    }
    while (this.cacheItems.length < this.finalized.length) {
      const logical = this.finalized[this.cacheItems.length];
      this.cacheItems.push(this.wrapLogical(logical, width));
    }
    const lines = [];
    for (const item of this.cacheItems) {
      lines.push(...item);
    }
    if (this.pending) {
      lines.push(...this.wrapLogical(previewPending(this.pending, this.inCodeBlock, this.color), width));
    }
    this.cacheLines = lines;
    return lines;
  }

  wrapLogical(logical, width) {
    if (!logical) {
      return [""];
    }
    const contentWidth = Math.max(1, width - CONTENT_PREFIX.length);
    return wrapTextWithAnsi(logical, contentWidth, contentWidth)
      .map((line) => `${CONTENT_PREFIX}${line}`);
  }

  invalidate() {
    this.cacheWidth = -1;
    this.cacheItems.length = 0;
    this.cacheLines = null;
  }
}

function previewPending(text, inCodeBlock, color) {
  if (inCodeBlock) {
    return text;
  }
  if (text.trim().startsWith("```")) {
    return "";
  }
  if (isPlainLine(text)) {
    return text;
  }
  return renderMarkdownishLine(text, color);
}
