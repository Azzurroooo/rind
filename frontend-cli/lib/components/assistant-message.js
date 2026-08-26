import { textWidth, wrapTextWithAnsi } from "../text-width.js";
import {
  codeCloseLabel,
  codeOpenLabel,
  dim,
  isPlainLine,
  isTableLine,
  isTableSeparatorRow,
  parseTableRow,
  renderInline,
  renderMarkdownishLine,
  styled,
} from "../markdown-lines.js";

const CONTENT_PREFIX = "  ";
const COLUMN_SEPARATOR_CELLS = 3;

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
      const cells = parseTableRow(line);
      if (cells.length && !isTableSeparatorRow(cells)) {
        this.pushItem({ kind: "table", raw: line });
      }
      return;
    }
    if (line.trim().startsWith("```")) {
      const opening = !this.inCodeBlock;
      this.inCodeBlock = opening;
      const label = opening ? line.trim().slice(3).trim().slice(0, 32) : "";
      this.pushItem({ kind: "fence", label });
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
        this.pushItem("");
      }
      return;
    }
    this.pushItem({ kind: "markdown", raw: line });
  }

  // finalized keeps raw sources for width-change restyling; cacheItems keeps
  // wrapped output so streaming frames only style new lines.
  pushItem(item) {
    this.finalized.push(item);
    ensureRenderWidth(this);
    if (item === "") {
      this.cacheItems.push({ lines: [""] });
      return;
    }
    if (item.kind === "table") {
      this.cacheItems.push({ tableRun: true, cells: parseTableRow(item.raw), lines: [] });
      this.repadLastTableRun();
      return;
    }
    this.cacheItems.push({ lines: this.wrapLogical(this.styleItem(item), this.cacheWidth) });
  }

  // Re-pad the trailing table run so a newly streamed row widens earlier
  // columns; runs are short, so restyling stays local.
  repadLastTableRun() {
    let start = this.cacheItems.length - 1;
    while (start > 0 && this.cacheItems[start - 1].tableRun) {
      start -= 1;
    }
    this.repadTableRun(start, this.cacheItems.length);
  }

  repadTableRun(start, end) {
    const run = this.cacheItems.slice(start, end);
    const widths = [];
    for (const row of run) {
      row.cells.forEach((cell, columnIndex) => {
        widths[columnIndex] = Math.max(widths[columnIndex] || 0, textWidth(cell));
      });
    }
    const usable = Math.max(8, this.cacheWidth - CONTENT_PREFIX.length);
    const aligned = widths.reduce((sum, w) => sum + w, 0) + COLUMN_SEPARATOR_CELLS * (widths.length - 1) <= usable;
    for (const [index, entry] of run.entries()) {
      const joined = tableRowText(entry.cells, widths, aligned, index === 0, this.color);
      entry.lines = this.wrapLogical(joined, this.cacheWidth);
    }
  }

  styleItem(item) {
    switch (item.kind) {
      case "fence":
        return dim(item.label ? codeOpenLabel(item.label) : codeCloseLabel(), this.color);
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
      this.restyleAll(width);
    }
    const lines = [];
    for (const item of this.cacheItems) {
      lines.push(...item.lines);
    }
    if (this.pending) {
      lines.push(...this.wrapLogical(previewPending(this.pending, this.inCodeBlock, this.color), width));
    }
    this.cacheLines = lines;
    return lines;
  }

  // Terminal resize: drop caches and restyle history under the new width.
  restyleAll(width) {
    this.cacheWidth = width;
    this.cacheItems = [];
    for (const item of this.finalized) {
      if (item === "") {
        this.cacheItems.push({ lines: [""] });
      } else if (item.kind === "table") {
        this.cacheItems.push({ tableRun: true, cells: parseTableRow(item.raw), lines: [] });
      } else {
        const logical = this.styleItem(item);
        this.cacheItems.push({ lines: logical ? this.wrapLogical(logical, width) : [""] });
      }
    }
    let index = 0;
    while (index < this.cacheItems.length) {
      if (!this.cacheItems[index].tableRun) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < this.cacheItems.length && this.cacheItems[end].tableRun) {
        end += 1;
      }
      this.repadTableRun(index, end);
      index = end;
    }
    this.cacheLines = null;
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
    this.cacheLines = null;
  }
}

function tableRowText(cells, widths, aligned, isHeader, color) {
  const rendered = cells.map((cell, columnIndex) => {
    const painted = renderInline(cell, color, isHeader ? "tableHeader" : "");
    const isLastColumn = columnIndex === cells.length - 1;
    return aligned && !isLastColumn ? painted + " ".repeat(widths[columnIndex] - textWidth(cell)) : painted;
  });
  return rendered.join(dim(" | ", color));
}

function ensureRenderWidth(message) {
  if (message.cacheWidth < 0) {
    message.cacheWidth = Number(process.stdout.columns) || 80;
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
