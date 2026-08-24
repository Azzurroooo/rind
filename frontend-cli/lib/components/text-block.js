import { wrapTextWithAnsi } from "../text-width.js";

export class TextBlock {
  constructor(text, options = {}) {
    this.text = String(text ?? "");
    this.leading = Boolean(options.leading);
    this.cacheWidth = 0;
    this.cacheLines = null;
  }

  setText(text) {
    const next = String(text ?? "");
    if (next === this.text) {
      return;
    }
    this.text = next;
    this.cacheLines = null;
  }

  render(width) {
    if (this.cacheLines && this.cacheWidth === width) {
      return this.cacheLines;
    }
    const source = this.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = [];
    if (this.leading && source.trim()) {
      lines.push("");
    }
    for (const logicalLine of source.split("\n")) {
      if (!logicalLine) {
        lines.push("");
        continue;
      }
      lines.push(...wrapTextWithAnsi(logicalLine, width));
    }
    while (lines.length > 1 && lines.at(-1) === "") {
      lines.pop();
    }
    this.cacheWidth = width;
    this.cacheLines = lines;
    return lines;
  }

  invalidate() {
    this.cacheLines = null;
  }
}
