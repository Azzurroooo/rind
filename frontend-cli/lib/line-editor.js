import { graphemes, textWidth } from "./text-width.js";

export function createLineEditor(initialValue = "") {
  let text = String(initialValue || "");
  let cursor = graphemes(text).length;

  return {
    input() {
      return text;
    },
    cursor() {
      return cursor;
    },
    setInput(value) {
      text = String(value || "");
      cursor = graphemes(text).length;
    },
    handleKey(chunk, key = {}) {
      if (key.name === "left") {
        return moveCursor(-1);
      }
      if (key.name === "right") {
        return moveCursor(1);
      }
      if (key.name === "home") {
        cursor = 0;
        return "move";
      }
      if (key.name === "end") {
        cursor = graphemes(text).length;
        return "move";
      }
      if (key.name === "backspace") {
        return removeBeforeCursor();
      }
      if (key.name === "delete") {
        return removeAtCursor();
      }
      if (isPrintable(chunk, key)) {
        insertText(String(chunk));
        return "edit";
      }
      return "";
    },
  };

  function moveCursor(delta) {
    const length = graphemes(text).length;
    cursor = Math.max(0, Math.min(length, cursor + delta));
    return "move";
  }

  function removeBeforeCursor() {
    if (cursor <= 0) {
      return "edit";
    }
    const chars = graphemes(text);
    chars.splice(cursor - 1, 1);
    cursor -= 1;
    text = chars.join("");
    return "edit";
  }

  function removeAtCursor() {
    const chars = graphemes(text);
    if (cursor >= chars.length) {
      return "edit";
    }
    chars.splice(cursor, 1);
    text = chars.join("");
    return "edit";
  }

  function insertText(value) {
    const chars = graphemes(text);
    const inserted = graphemes(value);
    chars.splice(cursor, 0, ...inserted);
    cursor += inserted.length;
    text = chars.join("");
  }
}

export function trailingCellWidth(text, cursor) {
  return graphemes(text)
    .slice(cursor)
    .reduce((width, segment) => width + textWidth(segment), 0);
}

function isPrintable(chunk, key) {
  return Boolean(chunk && !key.ctrl && !key.meta && String(chunk) >= " ");
}
