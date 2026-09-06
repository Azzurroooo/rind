import { CURSOR_MARKER } from "./tui.js";

// Non-global: String.match must expose match.index for cursor placement.
const ANSI_SEQUENCE = /\[[0-?]*[ -/]*[@-~]/;
import { graphemes, textWidth } from "../text-width.js";


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
    const ansiIndex = text.indexOf("\x1b", position);
    const end = ansiIndex === -1 ? text.length : ansiIndex;
    const content = text.slice(position, end);
    if (!content) {
      position += 1;
      continue;
    }
    for (const segment of graphemes(content)) {
      const segmentWidth = textWidth(segment);
      if (width + segmentWidth > target) {
        return `${text.slice(0, position)}${CURSOR_MARKER}${text.slice(position)}`;
      }
      width += segmentWidth;
      position += segment.length;
    }
  }
  return `${text.slice(0, position)}${CURSOR_MARKER}${text.slice(position)}`;
}
