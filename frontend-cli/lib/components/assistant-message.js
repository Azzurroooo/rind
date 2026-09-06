import { wrapTextWithAnsi } from "../text-width.js";
import {
  codeOpenLabel,
  consumeTableLine,
  createTableState,
  finishTableState,
  dim,
  isPlainLine,
  renderTableBlock,
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
    this.tableState = createTableState();
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
      if (this.classifyFinalize(line)) {
        this.cacheItems.length = 0;
      }
    }
    this.cacheLines = null;
  }

  finish() {
    if (this.pending) {
      const line = this.pending;
      this.pending = "";
      this.classifyFinalize(line);
    }
    this.flushTableState();
    this.cacheItems.length = 0;
    this.cacheLines = null;
  }

  get isEmpty() {
    return !this.finalized.length && !this.pending && !this.tableState.candidate.length && !this.tableState.rows;
  }

  classifyFinalize(line) {
    const result = consumeTableLine(this.tableState, line, this.inCodeBlock);
    if (result.type === "hold") {
      return false;
    }
    if (result.type === "start") {
      for (const line of result.lines || []) {
        this.classifyNonTable(line);
      }
      this.pushItem({ kind: "table", rows: this.tableState.rows });
      return true;
    }
    if (result.type === "append") {
      return true;
    }
    if (result.type === "flush") {
      this.classifyNonTable(result.line);
      return true;
    }
    if (result.type === "flush_candidate") {
      for (const candidate of result.lines) {
        this.classifyNonTable(candidate);
      }
      if (result.line !== undefined) {
        this.classifyNonTable(result.line);
      }
      return false;
    }
    this.classifyNonTable(line);
    return false;
  }

  classifyNonTable(line) {
    if (line.trim().startsWith("```")) {
      this.finalizeCodeFence(line);
      return;
    }
    if (this.inCodeBlock) {
      this.pushItem({ kind: "code", raw: line });
      return;
    }
    if (isPlainLine(line)) {
      if (line) {
        this.pushItem({ kind: "plain", raw: line });
      } else {
        this.finalized.push("");
      }
      return;
    }
    this.pushItem({ kind: "markdown", raw: line });
  }

  flushTableState() {
    const result = finishTableState(this.tableState);
    if (!result) {
      return;
    }
    if (result.type === "flush_candidate") {
      for (const line of result.lines) {
        this.classifyNonTable(line);
      }
    }
  }

  finalizeCodeFence(line) {
    const opening = !this.inCodeBlock;
    this.inCodeBlock = opening;
    const label = opening ? line.trim().slice(3).trim().slice(0, 32) : "";
    this.pushItem({ kind: "fence", label });
  }

  // Items keep the raw source; styling happens per render so theme switches
  // recolor history without rebuilding blocks.
  pushItem(item) {
    this.finalized.push(item);
  }

  styleItem(item, width) {
    switch (item.kind) {
      case "table":
        return renderTableBlock(item.rows, this.color, Math.max(1, width - CONTENT_PREFIX.length));
      case "fence":
        return dim(item.label ? codeOpenLabel(item.label) : "└ end", this.color);
      case "code":
        return styled(item.raw, this.color, "codeBlock");
      case "plain":
        return item.raw;
      default:
        return renderMarkdownishLine(item.raw, this.color);
    }
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
      const item = this.finalized[this.cacheItems.length];
      const logical = typeof item === "string" ? item : this.styleItem(item, width);
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
