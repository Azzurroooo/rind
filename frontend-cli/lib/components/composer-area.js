import { prepareComposerFrame } from "../composer-terminal.js";
import { insertCursorMarker } from "../tui/cursor.js";

export class ComposerArea {
  constructor(getFrame) {
    this.getFrame = getFrame;
    this.cacheKey = null;
    this.cacheLines = null;
  }

  render(width) {
    const params = this.getFrame(width);
    if (!params) {
      this.cacheKey = null;
      this.cacheLines = null;
      return [];
    }
    const key = [
      width,
      params.showCaret !== false,
      params.prompt || "",
      params.inputText || "",
      params.placeholder || "",
      params.menuText || "",
      params.cursor?.line ?? 0,
      params.cursor?.column ?? 0,
      params.menuCursor ? params.menuCursor.line ?? 0 : -1,
      params.menuCursor ? params.menuCursor.column ?? 0 : -1,
    ];
    if (this.cacheLines && this.cacheKey && key.every((value, index) => value === this.cacheKey[index])) {
      return this.cacheLines;
    }
    const frame = prepareComposerFrame(params, width);
    const lines = frame.lines.slice();
    if (params.showCaret !== false) {
      const cursorRow = Math.min(frame.cursorRow, lines.length - 1);
      if (cursorRow >= 0 && lines.length) {
        lines[cursorRow] = insertCursorMarker(lines[cursorRow] ?? "", frame.cursorColumn);
      }
    }
    this.cacheKey = key;
    this.cacheLines = Object.freeze(lines);
    return this.cacheLines;
  }
}
