import terminalKit from "terminal-kit";

import { graphemes, textWidth } from "./text-width.js";

const DEFAULT_COLUMNS = 80;
const INPUT_MARKER = "\n  › ";

export function createComposerTerminal(options = {}) {
  const output = options.output || process.stdout;
  const terminal = options.terminal || terminalKit.terminal;
  let rendered = false;
  let cursorRow = 0;

  return {
    render(frame = {}) {
      clear();
      const prepared = prepareComposerFrame(frame, output.columns || terminal.width);
      output.write(prepared.text);
      moveRows(terminal, prepared.endRow - prepared.cursorRow);
      terminal.column(prepared.cursorColumn + 1);
      cursorRow = prepared.cursorRow;
      rendered = true;
    },
    clear,
    dispose: clear,
  };

  function clear() {
    if (!rendered) {
      return;
    }
    if (cursorRow > 0) {
      terminal.up(cursorRow);
    }
    terminal.column(1);
    terminal.eraseDisplayBelow();
    rendered = false;
    cursorRow = 0;
  }
}

export function withTerminalCursorHidden(action, terminal = terminalKit.terminal) {
  terminal.hideCursor();
  try {
    action();
  } finally {
    terminal.hideCursor(false);
  }
}

export function prepareComposerFrame(frame = {}, columns = DEFAULT_COLUMNS) {
  const width = terminalColumns(columns);
  const block = splitPromptBlock(frame.prompt);
  const input = String(frame.inputText || "");
  const display = input || String(frame.placeholder || "");
  const cursor = visualPosition(block.prefix, input, frame.cursorIndex, width);
  const leadingLines = splitRenderedLines(block.leading);
  const inputLines = wrappedInputLines(block.prefix, display, width, cursor.row + 1);
  const menuLines = splitRenderedLines(frame.menuText);
  const trailingLines = splitRenderedLines(block.trailing);
  const lines = [...leadingLines, ...inputLines, ...menuLines, ...trailingLines];
  const endRow = Math.max(0, lines.length - 1);

  return {
    text: lines.join("\n"),
    cursorRow: leadingLines.length + cursor.row,
    cursorColumn: cursor.column,
    endRow,
  };
}

function moveRows(terminal, delta) {
  if (delta > 0) {
    terminal.up(delta);
  } else if (delta < 0) {
    terminal.down(-delta);
  }
}

function wrappedInputLines(prefix, text, columns, minRows) {
  const lines = [];
  let line = String(prefix || "");
  let width = textWidth(line);
  for (const segment of graphemes(text)) {
    const segmentWidth = textWidth(segment);
    if (width + segmentWidth > columns && width > 0) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += segment;
    width += segmentWidth;
  }
  lines.push(line);
  while (lines.length < minRows) {
    lines.push("");
  }
  return lines;
}

function visualPosition(prefix, text, cursor, columns) {
  const total = textWidth(prefix) + cursorCellWidth(text, cursor);
  return {
    row: Math.floor(total / columns),
    column: total % columns,
  };
}

function cursorCellWidth(text, cursor) {
  return graphemes(text)
    .slice(0, cursorIndex(cursor))
    .reduce((width, segment) => width + textWidth(segment), 0);
}

function cursorIndex(cursor) {
  const value = Number(cursor);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function terminalColumns(columns) {
  const value = Number(columns);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COLUMNS;
}

function splitPromptBlock(prompt) {
  const text = String(prompt || "");
  const index = text.lastIndexOf(INPUT_MARKER);
  if (index === -1) {
    return { leading: "", prefix: text, trailing: "" };
  }
  const inputStart = index + 1;
  const trailingStart = text.indexOf("\n", inputStart);
  if (trailingStart === -1) {
    return {
      leading: text.slice(0, inputStart),
      prefix: text.slice(inputStart),
      trailing: "",
    };
  }
  return {
    leading: text.slice(0, inputStart),
    prefix: text.slice(inputStart, trailingStart),
    trailing: text.slice(trailingStart + 1),
  };
}

function splitRenderedLines(text) {
  const value = String(text || "");
  if (!value) {
    return [];
  }
  const lines = value.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
