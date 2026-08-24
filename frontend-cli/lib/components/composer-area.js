import { prepareComposerFrame } from "../composer-terminal.js";
import { insertCursorMarker } from "../tui/cursor.js";

export class ComposerArea {
  constructor(getFrame) {
    this.getFrame = getFrame;
  }

  render(width) {
    const params = this.getFrame(width);
    if (!params) {
      return [];
    }
    const frame = prepareComposerFrame(params, width);
    const lines = frame.lines.slice();
    if (params.showCaret === false) {
      return lines;
    }
    const cursorRow = Math.min(frame.cursorRow, lines.length - 1);
    if (cursorRow >= 0 && lines.length) {
      lines[cursorRow] = insertCursorMarker(lines[cursorRow] ?? "", frame.cursorColumn);
    }
    return lines;
  }
}
