import { textWidth } from "../text-width.js";

export const CURSOR_MARKER = "\x1b_pi:c\x07";

export function renderFrame(children, width, previousSegments = []) {
  const segments = [];
  let length = 0;
  let unchangedPrefix = 0;
  let cursor = null;
  for (let index = 0; index < children.length; index++) {
    const rendered = children[index].render(width);
    const source = Array.isArray(rendered) ? rendered : [];
    const previous = previousSegments[index];
    const content = Object.isFrozen(source) && previous?.source === source
      ? previous.content : normalize(source);
    if (unchangedPrefix === length && previous?.content === content && previous.start === length) {
      unchangedPrefix += content.lines.length;
    }
    segments.push({ source, content, start: length });
    if (content.cursor) cursor = { row: length + content.cursor.row, col: content.cursor.col };
    length += content.lines.length;
  }
  return {
    segments, length, unchangedPrefix, cursor,
    at(row) {
      let low = 0, high = segments.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        const segment = segments[mid];
        if (row < segment.start) high = mid - 1;
        else if (row >= segment.start + segment.content.lines.length) low = mid + 1;
        else return segment.content.lines[row - segment.start];
      }
      return undefined;
    },
  };
}

function normalize(source) {
  let cursor = null;
  const lines = source.map((value, row) => {
    let line = String(value ?? "");
    const marker = line.indexOf(CURSOR_MARKER);
    if (marker !== -1) {
      cursor = { row, col: textWidth(line.slice(0, marker)) };
      line = line.slice(0, marker) + line.slice(marker + CURSOR_MARKER.length);
    }
    return line.includes("\x1b[") ? `${line}\x1b[0m` : line;
  });
  return { lines, cursor };
}
