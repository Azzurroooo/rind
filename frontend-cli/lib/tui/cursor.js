import { CURSOR_MARKER } from "./tui.js";
import { graphemes, textWidth } from "../text-width.js";

const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function insertCursorMarker(line, column) {
  const text = String(line || "");
  const target = Math.max(0, Math.floor(Number(column) || 0));
  let width = 0;
  let position = 0;
  while (position < text.length) {
    if (text[position] === "\x1b") {
      const match = text.slice(position).match(ANSI_SEQUENCE);
      if (match && match.index === 0) {
        position += match[0].length;
        continue;
      }
    }
    const codePoint = text.codePointAt(position);
    const segment = String.fromCodePoint(codePoint);
    const segmentWidth = textWidth(segment);
    if (width + segmentWidth > target) {
      break;
    }
    width += segmentWidth;
    position += segment.length;
  }
  return `${text.slice(0, position)}${CURSOR_MARKER}${text.slice(position)}`;
}
