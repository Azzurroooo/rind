import { graphemes, stripAnsi, textWidth, wrapTextCells } from "./text-width.js";

const DEFAULT_COLUMNS = 80;
const INPUT_MARKER = "\n  › ";
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SGR_SEQUENCE = /^\x1b\[([0-9;]*)m$/;

export function prepareComposerFrame(frame = {}, columns = DEFAULT_COLUMNS) {
  const width = terminalColumns(columns);
  const block = splitPromptBlock(frame.prompt);
  const input = String(frame.inputText || "");
  const display = input || String(frame.placeholder || "");
  const position = cursorPosition(frame, input);
  const leadingLines = wrapRenderedLines(block.leading, width);
  const inputLines = wrapInputLines(block.prefix, display, width);
  const cursor = visualCursor(block.prefix, input, position, width, inputLines);
  const menuLines = wrapRenderedLines(frame.menuText, width);
  const trailingLines = wrapRenderedLines(block.trailing, width);
  const lines = [...leadingLines, ...inputLines, ...menuLines, ...trailingLines];
  const cursorRow = leadingLines.length + cursor.row;
  const selectedMenuRow = menuLines.findIndex((line) => stripAnsi(line).startsWith("  › "));

  return {
    lines,
    cursorRow,
    cursorColumn: cursor.column,
    focusRow: selectedMenuRow === -1
      ? cursorRow
      : leadingLines.length + inputLines.length + selectedMenuRow,
  };
}

function wrapInputLines(prefix, text, columns) {
  const logicalLines = String(text || "").split("\n");
  const lines = [];
  for (const [index, logicalLine] of logicalLines.entries()) {
    const linePrefix = index === 0 ? prefix : "";
    if (logicalLine.includes("\x1b")) {
      lines.push(...wrapLine(linePrefix, logicalLine, columns));
      continue;
    }
    const chunks = wrapTextCells(
      logicalLine,
      Math.max(1, columns - textWidth(linePrefix)),
      columns,
    );
    lines.push(...chunks.map((chunk, chunkIndex) => `${chunkIndex === 0 ? linePrefix : ""}${chunk.text}`));
  }
  return lines.length ? lines : [String(prefix || "")];
}

function visualCursor(prefix, input, position, columns, inputLines) {
  const logicalLines = String(input).split("\n");
  const width = Math.max(1, columns);
  const visualLines = [];
  for (const [lineIndex, logicalLine] of logicalLines.entries()) {
    const prefixWidth = lineIndex === 0 ? textWidth(prefix) : 0;
    const chunks = wrapTextCells(
      logicalLine,
      Math.max(1, width - prefixWidth),
      width,
    );
    for (const [chunkIndex, chunk] of chunks.entries()) {
      visualLines.push({
        startColumn: chunk.startColumn,
        length: chunk.length,
        allowsEnd: chunk.allowsEnd,
        line: lineIndex,
        prefixWidth: lineIndex === 0 && chunkIndex === 0 ? prefixWidth : 0,
      });
    }
    const lastChunk = chunks.at(-1);
    if (lineIndex === logicalLines.length - 1 && !lastChunk.allowsEnd) {
      visualLines.push({
        startColumn: lastChunk.startColumn + lastChunk.length,
        length: 0,
        allowsEnd: true,
        line: lineIndex,
        prefixWidth: 0,
      });
    }
  }

  let row = visualLines.length - 1;
  for (const [index, visualLine] of visualLines.entries()) {
    if (visualLine.line !== position.line) {
      continue;
    }
    const offset = position.column - visualLine.startColumn;
    if (offset >= 0 && (offset < visualLine.length || (visualLine.allowsEnd && offset === visualLine.length))) {
      row = index;
      break;
    }
  }
  while (inputLines.length <= row) {
    inputLines.push("");
  }
  const visualLine = visualLines[row];
  const text = graphemes(logicalLines[position.line])
    .slice(visualLine.startColumn, position.column)
    .join("");
  return {
    row,
    column: visualLine.prefixWidth + textWidth(text),
  };
}

function wrapLine(prefix, text, columns) {
  const lines = [];
  let line = "";
  let width = 0;
  let activeStyle = "";
  for (const segment of displaySegments(`${prefix || ""}${text || ""}`)) {
    const sgr = segment.match(SGR_SEQUENCE);
    if (sgr) {
      line += segment;
      const codes = (sgr[1] || "0").split(";").map((code) => code || "0");
      const resetIndex = codes.lastIndexOf("0");
      activeStyle = resetIndex === codes.length - 1
        ? ""
        : resetIndex >= 0
          ? segment
          : `${activeStyle}${segment}`;
      continue;
    }
    const segmentWidth = textWidth(segment);
    if (width > 0 && width + segmentWidth > columns) {
      lines.push(line);
      line = activeStyle;
      width = 0;
    }
    line += segment;
    width += segmentWidth;
  }
  lines.push(line);
  return lines;
}

function displaySegments(value) {
  const text = String(value || "");
  const segments = [];
  let position = 0;
  for (const match of text.matchAll(ANSI_SEQUENCE)) {
    segments.push(...graphemes(text.slice(position, match.index)), match[0]);
    position = match.index + match[0].length;
  }
  segments.push(...graphemes(text.slice(position)));
  return segments;
}

function cursorPosition(frame, input) {
  const lines = String(input).split("\n");
  const line = Math.min(lines.length - 1, Math.max(0, Math.floor(Number(frame.cursor?.line) || 0)));
  return {
    line,
    column: Math.min(
      graphemes(lines[line]).length,
      Math.max(0, Math.floor(Number(frame.cursor?.column) || 0)),
    ),
  };
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

function wrapRenderedLines(text, columns) {
  const value = String(text || "");
  if (!value) {
    return [];
  }
  const lines = value.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.flatMap((line) => wrapLine("", line, columns));
}
