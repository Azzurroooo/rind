import { graphemes, wrapTextCells } from "./text-width.js";

const HISTORY_LIMIT = 100;
const UNDO_LIMIT = 100;
const INPUT_PREFIX_WIDTH = 4;

export function createLineEditor(initialValue = "") {
  let lines = splitLines(initialValue);
  let cursorLine = lines.length - 1;
  let cursorColumn = graphemes(lines[cursorLine]).length;
  const history = [];
  let historyIndex = -1;
  let historyDraft = null;
  const undoStack = [];
  let killedText = "";
  let viewportWidth = 80;
  let preferredVisualColumn = null;

  const editor = {
    input() {
      return lines.join("\n");
    },
    cursorPosition() {
      return { line: cursorLine, column: cursorColumn };
    },
    setInput(value) {
      setText(value);
    },
    setViewportWidth(value) {
      const width = Math.max(1, Math.floor(Number(value) || 0));
      if (width !== viewportWidth) {
        viewportWidth = width;
        preferredVisualColumn = null;
      }
    },
    handleInput(event = {}) {
      if (event.kind === "paste") {
        insertText(cleanPaste(event.text));
        return "edit";
      }
      if (event.kind === "text") {
        insertText(event.text);
        return "edit";
      }
      return editor.handleKey(event.text || "", event);
    },
    handleKey(chunk, key = {}) {
      if (key.name !== "up" && key.name !== "down") {
        preferredVisualColumn = null;
      }
      if (key.name === "enter" || key.name === "return") {
        if (key.shift || key.ctrl) {
          insertNewline();
          return "edit";
        }
        return "submit";
      }
      if (key.name === "left") {
        return key.ctrl || key.alt ? moveWord(-1) : moveHorizontal(-1);
      }
      if (key.name === "right") {
        return key.ctrl || key.alt ? moveWord(1) : moveHorizontal(1);
      }
      if (key.ctrl && key.name === "b") {
        return moveHorizontal(-1);
      }
      if (key.ctrl && key.name === "f") {
        return moveHorizontal(1);
      }
      if (key.alt && key.name === "b") {
        return moveWord(-1);
      }
      if (key.alt && key.name === "f") {
        return moveWord(1);
      }
      if (key.name === "up") {
        if (key.ctrl || key.alt || key.shift) {
          return "";
        }
        return moveUp();
      }
      if (key.name === "down") {
        if (key.ctrl || key.alt || key.shift) {
          return "";
        }
        return moveDown();
      }
      if (key.name === "home") {
        cursorColumn = 0;
        return "move";
      }
      if (key.name === "end") {
        cursorColumn = lineLength();
        return "move";
      }
      if (key.name === "backspace") {
        return key.ctrl || key.alt ? deleteWordBackward() : deleteBackward();
      }
      if (key.name === "delete") {
        return key.ctrl || key.alt ? deleteWordForward() : deleteForward();
      }
      if (key.ctrl && key.name === "a") {
        cursorColumn = 0;
        return "move";
      }
      if (key.ctrl && key.name === "e") {
        cursorColumn = lineLength();
        return "move";
      }
      if (key.ctrl && key.name === "w") {
        return deleteWordBackward();
      }
      if (key.ctrl && key.name === "d") {
        return deleteForward();
      }
      if (key.alt && key.name === "d") {
        return deleteWordForward();
      }
      if (key.ctrl && key.name === "u") {
        return deleteToStart();
      }
      if (key.ctrl && key.name === "k") {
        return deleteToEnd();
      }
      if (key.ctrl && key.name === "y") {
        return yank();
      }
      if (key.ctrl && (key.name === "-" || key.name === "_")) {
        return undo();
      }
      if (key.name === "j" && key.ctrl) {
        insertNewline();
        return "edit";
      }
      if (isPrintable(chunk, key)) {
        insertText(chunk);
        return "edit";
      }
      return "";
    },
    addToHistory(value = "") {
      const text = String(value || "").trim();
      if (!text || history[0] === text) {
        resetHistory();
        return;
      }
      history.unshift(text);
      if (history.length > HISTORY_LIMIT) {
        history.length = HISTORY_LIMIT;
      }
      resetHistory();
    },
  };
  return editor;

  function setText(value) {
    lines = splitLines(value);
    cursorLine = lines.length - 1;
    cursorColumn = lineLength();
    preferredVisualColumn = null;
    resetHistory();
    undoStack.length = 0;
  }

  function splitLines(value) {
    const result = normalizeText(value).split("\n");
    return result.length ? result : [""];
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  }

  function cleanPaste(value) {
    return normalizeText(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  }

  function lineLength(line = cursorLine) {
    return graphemes(lines[line] || "").length;
  }

  function isEditorEmpty() {
    return lines.length === 1 && lines[0] === "";
  }

  function moveHorizontal(delta) {
    if (delta < 0 && cursorColumn === 0 && cursorLine > 0) {
      cursorLine -= 1;
      cursorColumn = lineLength();
      return "move";
    }
    if (delta > 0 && cursorColumn === lineLength() && cursorLine < lines.length - 1) {
      cursorLine += 1;
      cursorColumn = 0;
      return "move";
    }
    cursorColumn = Math.max(0, Math.min(lineLength(), cursorColumn + delta));
    return "move";
  }

  function moveUp() {
    const visual = visualLineState();
    if (visual.index > 0) {
      return moveVertical(-1, visual);
    }
    if (isEditorEmpty() || historyIndex > -1 || cursorColumn === 0) {
      return navigateHistory(-1);
    }
    return moveToLineStart();
  }

  function moveDown() {
    const visual = visualLineState();
    if (visual.index < visual.lines.length - 1) {
      return moveVertical(1, visual);
    }
    if (historyIndex > -1) {
      return navigateHistory(1);
    }
    return moveToLineEnd();
  }

  function moveVertical(delta, visual) {
    const current = visual.lines[visual.index];
    const targetIndex = visual.index + delta;
    const target = visual.lines[targetIndex];
    const currentColumn = cursorColumn - current.startColumn;
    const currentMax = visualLineMaxColumn(visual.lines, visual.index);
    const targetMax = visualLineMaxColumn(visual.lines, targetIndex);
    cursorLine = target.line;
    cursorColumn = target.startColumn + verticalTargetColumn(currentColumn, currentMax, targetMax);
    return "move";
  }

  function visualLineState() {
    const visualLines = [];
    for (const [lineIndex, text] of lines.entries()) {
      const firstWidth = lineIndex === 0
        ? Math.max(1, viewportWidth - INPUT_PREFIX_WIDTH)
        : viewportWidth;
      const chunks = wrapTextCells(text, firstWidth, viewportWidth);
      for (const chunk of chunks) {
        visualLines.push({
          line: lineIndex,
          startColumn: chunk.startColumn,
          length: chunk.length,
          allowsEnd: chunk.allowsEnd,
        });
      }
      const lastChunk = chunks.at(-1);
      if (lineIndex === lines.length - 1 && !lastChunk.allowsEnd) {
        visualLines.push({
          line: lineIndex,
          startColumn: lastChunk.startColumn + lastChunk.length,
          length: 0,
          allowsEnd: true,
        });
      }
    }

    let index = visualLines.length - 1;
    for (let candidate = 0; candidate < visualLines.length; candidate += 1) {
      const visualLine = visualLines[candidate];
      if (visualLine.line !== cursorLine) {
        continue;
      }
      const offset = cursorColumn - visualLine.startColumn;
      if (offset >= 0 && (offset < visualLine.length || (visualLine.allowsEnd && offset === visualLine.length))) {
        index = candidate;
        break;
      }
    }
    return { lines: visualLines, index };
  }

  function visualLineMaxColumn(visualLines, index) {
    const visualLine = visualLines[index];
    return visualLine.allowsEnd ? visualLine.length : Math.max(0, visualLine.length - 1);
  }

  function verticalTargetColumn(current, currentMax, targetMax) {
    const cursorInMiddle = current < currentMax;
    const targetTooShort = targetMax < current;
    if (preferredVisualColumn === null || cursorInMiddle) {
      if (targetTooShort) {
        preferredVisualColumn = current;
        return targetMax;
      }
      preferredVisualColumn = null;
      return current;
    }
    if (targetTooShort || targetMax < preferredVisualColumn) {
      return targetMax;
    }
    const target = preferredVisualColumn;
    preferredVisualColumn = null;
    return target;
  }

  function moveToLineStart() {
    preferredVisualColumn = null;
    cursorColumn = 0;
    return "move";
  }

  function moveToLineEnd() {
    preferredVisualColumn = null;
    cursorColumn = lineLength();
    return "move";
  }

  function moveWord(delta) {
    const chars = graphemes(lines[cursorLine]);
    if (delta < 0) {
      if (cursorColumn === 0) {
        return moveHorizontal(-1);
      }
      let next = cursorColumn;
      while (next > 0 && /\s/.test(chars[next - 1])) {
        next -= 1;
      }
      while (next > 0 && !/\s/.test(chars[next - 1])) {
        next -= 1;
      }
      cursorColumn = next;
      return "move";
    }
    if (cursorColumn >= chars.length) {
      return moveHorizontal(1);
    }
    let next = cursorColumn;
    while (next < chars.length && /\s/.test(chars[next])) {
      next += 1;
    }
    while (next < chars.length && !/\s/.test(chars[next])) {
      next += 1;
    }
    cursorColumn = next;
    return "move";
  }

  function insertText(value) {
    const text = normalizeText(value);
    if (!text) {
      return;
    }
    preferredVisualColumn = null;
    pushUndoSnapshot();
    const inserted = text.split("\n");
    const current = graphemes(lines[cursorLine]);
    const before = current.slice(0, cursorColumn).join("");
    const after = current.slice(cursorColumn).join("");
    if (inserted.length === 1) {
      lines[cursorLine] = before + inserted[0] + after;
      cursorColumn = graphemes(before + inserted[0]).length;
    } else {
      lines.splice(cursorLine, 1, `${before}${inserted[0]}`, ...inserted.slice(1, -1), `${inserted.at(-1)}${after}`);
      cursorLine += inserted.length - 1;
      cursorColumn = graphemes(inserted.at(-1)).length;
    }
    resetHistory();
  }

  function insertNewline() {
    insertText("\n");
  }

  function deleteBackward() {
    if (cursorColumn === 0 && cursorLine === 0) {
      return "edit";
    }
    pushUndoSnapshot();
    if (cursorColumn === 0) {
      const previousLength = lineLength(cursorLine - 1);
      lines[cursorLine - 1] += lines[cursorLine];
      lines.splice(cursorLine, 1);
      cursorLine -= 1;
      cursorColumn = previousLength;
    } else {
      const chars = graphemes(lines[cursorLine]);
      chars.splice(cursorColumn - 1, 1);
      lines[cursorLine] = chars.join("");
      cursorColumn -= 1;
    }
    resetHistory();
    return "edit";
  }

  function deleteForward() {
    if (cursorColumn === lineLength() && cursorLine === lines.length - 1) {
      return "edit";
    }
    pushUndoSnapshot();
    if (cursorColumn === lineLength()) {
      lines[cursorLine] += lines[cursorLine + 1];
      lines.splice(cursorLine + 1, 1);
    } else {
      const chars = graphemes(lines[cursorLine]);
      chars.splice(cursorColumn, 1);
      lines[cursorLine] = chars.join("");
    }
    resetHistory();
    return "edit";
  }

  function deleteWordBackward() {
    const chars = graphemes(lines[cursorLine]);
    if (cursorColumn === 0) {
      return deleteBackward();
    }
    let next = cursorColumn;
    while (next > 0 && /\s/.test(chars[next - 1])) {
      next -= 1;
    }
    while (next > 0 && !/\s/.test(chars[next - 1])) {
      next -= 1;
    }
    pushUndoSnapshot();
    killedText = chars.slice(next, cursorColumn).join("");
    lines[cursorLine] = chars.slice(0, next).concat(chars.slice(cursorColumn)).join("");
    cursorColumn = next;
    resetHistory();
    return "edit";
  }

  function deleteWordForward() {
    const chars = graphemes(lines[cursorLine]);
    if (cursorColumn >= chars.length) {
      return deleteForward();
    }
    let next = cursorColumn;
    while (next < chars.length && /\s/.test(chars[next])) {
      next += 1;
    }
    while (next < chars.length && !/\s/.test(chars[next])) {
      next += 1;
    }
    pushUndoSnapshot();
    killedText = chars.slice(cursorColumn, next).join("");
    lines[cursorLine] = chars.slice(0, cursorColumn).concat(chars.slice(next)).join("");
    resetHistory();
    return "edit";
  }

  function deleteToStart() {
    if (cursorColumn === 0) {
      return "edit";
    }
    pushUndoSnapshot();
    killedText = graphemes(lines[cursorLine]).slice(0, cursorColumn).join("");
    lines[cursorLine] = graphemes(lines[cursorLine]).slice(cursorColumn).join("");
    cursorColumn = 0;
    resetHistory();
    return "edit";
  }

  function deleteToEnd() {
    if (cursorColumn === lineLength()) {
      return "edit";
    }
    pushUndoSnapshot();
    killedText = graphemes(lines[cursorLine]).slice(cursorColumn).join("");
    lines[cursorLine] = graphemes(lines[cursorLine]).slice(0, cursorColumn).join("");
    resetHistory();
    return "edit";
  }

  function yank() {
    if (!killedText) {
      return "move";
    }
    insertText(killedText);
    return "edit";
  }

  function undo() {
    const snapshot = undoStack.pop();
    if (!snapshot) {
      return "move";
    }
    lines = snapshot.lines;
    cursorLine = snapshot.cursorLine;
    cursorColumn = snapshot.cursorColumn;
    resetHistory();
    return "edit";
  }

  function pushUndoSnapshot() {
    undoStack.push({
      lines: [...lines],
      cursorLine,
      cursorColumn,
    });
    if (undoStack.length > UNDO_LIMIT) {
      undoStack.shift();
    }
  }

  function resetHistory() {
    historyIndex = -1;
    historyDraft = null;
  }

  function navigateHistory(direction) {
    if (!history.length) {
      return "move";
    }
    const nextIndex = historyIndex - direction;
    if (nextIndex < -1 || nextIndex >= history.length) {
      return "move";
    }
    if (historyIndex === -1 && nextIndex >= 0) {
      pushUndoSnapshot();
      historyDraft = snapshot();
    }
    preferredVisualColumn = null;
    historyIndex = nextIndex;
    if (historyIndex === -1) {
      restore(historyDraft || { lines: [""], cursorLine: 0, cursorColumn: 0 });
      historyDraft = null;
    } else {
      const value = history[historyIndex];
      lines = splitLines(value);
      cursorLine = direction < 0 ? 0 : lines.length - 1;
      cursorColumn = direction < 0 ? 0 : lineLength();
    }
    return "edit";
  }

  function snapshot() {
    return { lines: [...lines], cursorLine, cursorColumn };
  }

  function restore(value) {
    lines = [...value.lines];
    cursorLine = value.cursorLine;
    cursorColumn = value.cursorColumn;
  }
}

function isPrintable(chunk, key) {
  return Boolean(chunk && !key.ctrl && !key.alt && String(chunk) >= " ");
}
