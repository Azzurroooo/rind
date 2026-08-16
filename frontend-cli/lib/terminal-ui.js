import { textWidth } from "./text-width.js";

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const SYNCHRONIZED_OUTPUT_START = "\x1b[?2026h";
const SYNCHRONIZED_OUTPUT_END = "\x1b[?2026l";
const LINE_RESET = "\x1b[0m";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_INPUT_TIMEOUT_MS = 10;
const DEFAULT_RENDER_INTERVAL_MS = 16;
const FULL_SCREEN_CLEAR = /\x1b\[(?:2|3)J|\x1bc/;

export function createTerminalUI(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const renderFrame = typeof options.render === "function" ? options.render : () => [];
  const schedule = options.setTimeout || setTimeout;
  const cancelSchedule = options.clearTimeout || clearTimeout;
  const now = options.now || Date.now;

  let started = false;
  let rawModeBeforeStart = false;
  let inputHandler = () => {};
  let pasteHandler = () => {};
  let resizeHandler;
  let inputBuffer = "";
  let inputTimer = null;
  let pasteMode = false;
  let pasteBuffer = "";
  let renderRequested = false;
  let renderForceRequested = false;
  let renderTimer = null;
  let renderMicrotaskQueued = false;
  let lastRenderAt = 0;
  let hasRendered = false;
  let capturing = false;
  let previousLines = [];
  let previousWidth = 0;
  let previousHeight = 0;
  let cursor = { row: 0, column: 0 };
  let rendered = false;

  function columns() {
    return finitePositive(output.columns, DEFAULT_COLUMNS);
  }

  function rows() {
    return finitePositive(output.rows, DEFAULT_ROWS);
  }

  function write(value) {
    if (value) {
      output.write(value);
    }
  }

  function start(startOptions = {}) {
    if (started) {
      return;
    }
    started = true;
    if (typeof startOptions.onInput === "function") {
      inputHandler = startOptions.onInput;
    }
    if (typeof startOptions.onPaste === "function") {
      pasteHandler = startOptions.onPaste;
    }

    rawModeBeforeStart = Boolean(input.isRaw);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.setEncoding("utf8");
    input.resume();
    input.on("data", handleInputData);

    resizeHandler = () => {
      requestRender(true);
    };
    output.on("resize", resizeHandler);

    write("\x1b[?2004h");
    requestRender();
  }

  function stop() {
    if (!started) {
      return;
    }
    started = false;
    clearInputTimer();
    clearRenderTimer();
    clearFrame();
    input.off("data", handleInputData);
    if (resizeHandler) {
      output.off("resize", resizeHandler);
      resizeHandler = undefined;
    }
    input.pause();
    if (typeof input.setRawMode === "function") {
      input.setRawMode(rawModeBeforeStart);
    }
    write("\x1b[?2004l");
    clearInputBuffer();
  }

  function handleInputData(data) {
    feedInput(data);
  }

  function feedInput(data) {
    const value = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
    if (!value && !inputBuffer) {
      return;
    }
    inputBuffer += value;
    processInputBuffer();
  }

  function flushInput() {
    clearInputTimer();
    if (pasteMode) {
      return;
    }
    if (!inputBuffer) {
      return;
    }
    const value = inputBuffer;
    inputBuffer = "";
    emitInput(value);
  }

  function clearInputBuffer() {
    clearInputTimer();
    inputBuffer = "";
    pasteMode = false;
    pasteBuffer = "";
  }

  function processInputBuffer() {
    if (pasteMode) {
      pasteBuffer += inputBuffer;
      inputBuffer = "";
      const endIndex = pasteBuffer.indexOf(PASTE_END);
      if (endIndex === -1) {
        return;
      }
      const content = pasteBuffer.slice(0, endIndex);
      const remaining = pasteBuffer.slice(endIndex + PASTE_END.length);
      pasteMode = false;
      pasteBuffer = "";
      pasteHandler(content);
      if (remaining) {
        feedInput(remaining);
      }
      return;
    }

    const pasteIndex = inputBuffer.indexOf(PASTE_START);
    if (pasteIndex !== -1) {
      const buffered = inputBuffer;
      const beforePaste = buffered.slice(0, pasteIndex);
      if (beforePaste) {
        emitSequences(beforePaste);
      }
      inputBuffer = buffered.slice(pasteIndex + PASTE_START.length);
      pasteMode = true;
      pasteBuffer = inputBuffer;
      inputBuffer = "";
      const endIndex = pasteBuffer.indexOf(PASTE_END);
      if (endIndex !== -1) {
        const content = pasteBuffer.slice(0, endIndex);
        const remaining = pasteBuffer.slice(endIndex + PASTE_END.length);
        pasteMode = false;
        pasteBuffer = "";
        pasteHandler(content);
        if (remaining) {
          feedInput(remaining);
        }
      }
      return;
    }

    emitSequences(inputBuffer);
  }

  function emitSequences(value) {
    const parsed = splitSequences(value);
    inputBuffer = parsed.remainder;
    for (const sequence of parsed.sequences) {
      emitInput(sequence);
    }
    if (inputBuffer) {
      clearInputTimer();
      inputTimer = schedule(() => {
        inputTimer = null;
        flushInput();
      }, DEFAULT_INPUT_TIMEOUT_MS);
    } else {
      clearInputTimer();
    }
  }

  function emitInput(sequence) {
    if (sequence) {
      inputHandler(sequence);
    }
  }

  function clearInputTimer() {
    if (inputTimer === null) {
      return;
    }
    cancelSchedule(inputTimer);
    inputTimer = null;
  }

  function requestRender(force = false) {
    const immediate = force === true;
    renderRequested = true;
    renderForceRequested ||= immediate;
    if (immediate) {
      clearRenderTimer();
      queueRenderMicrotask(true);
      return;
    }
    if (renderMicrotaskQueued || renderTimer !== null) {
      return;
    }
    queueRenderMicrotask(false);
  }

  function clearRenderTimer() {
    if (renderTimer === null) {
      return;
    }
    cancelSchedule(renderTimer);
    renderTimer = null;
  }

  function queueRenderMicrotask(force) {
    if (renderMicrotaskQueued) {
      return;
    }
    renderMicrotaskQueued = true;
    queueMicrotask(() => {
      renderMicrotaskQueued = false;
      const forceRender = renderForceRequested || force;
      renderForceRequested = false;
      scheduleRender(forceRender);
    });
  }

  function scheduleRender(force) {
    if (!renderRequested || !started) {
      return;
    }
    if (force) {
      renderTimer = schedule(() => {
        renderTimer = null;
        flushRender();
      }, 0);
      return;
    }
    const elapsed = hasRendered ? now() - lastRenderAt : DEFAULT_RENDER_INTERVAL_MS;
    const delay = Math.max(0, DEFAULT_RENDER_INTERVAL_MS - elapsed);
    renderTimer = schedule(() => {
      renderTimer = null;
      flushRender();
    }, delay);
  }

  function flushRender() {
    if (!renderRequested || !started) {
      return;
    }
    renderRequested = false;
    lastRenderAt = now();
    hasRendered = true;
    renderFrameNow();
    if (renderRequested) {
      queueRenderMicrotask(false);
    }
  }

  function renderFrameNow() {
    const width = columns();
    const height = rows();
    const frame = fitFrame(normalizeFrame(renderFrame(width, height), width), height);
    if (!frame.lines.length) {
      if (rendered) {
        clearFrame();
      }
      previousLines = [];
      previousWidth = frame.width;
      previousHeight = height;
      cursor = frame.cursor;
      return;
    }
    if (!rendered || frame.width !== previousWidth || height !== previousHeight) {
      if (rendered) {
        clearFrame();
      }
      renderFull(frame);
      return;
    }
    renderDiff(frame);
  }

  function renderFull(frame) {
    let buffer = SYNCHRONIZED_OUTPUT_START;
    buffer += frameBody(frame);
    buffer += SYNCHRONIZED_OUTPUT_END;
    write(buffer);
    commitFrame(frame);
  }

  function frameBody(frame) {
    const lines = frame.lines;
    let buffer = "";
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) {
        buffer += "\r\n";
      }
      buffer += "\x1b[2K";
      buffer += lines[index];
      buffer += LINE_RESET;
    }
    buffer += cursorSequence(frame.cursor, lines.length - 1, lines.length ? visibleLineWidth(lines.at(-1)) : 0);
    return buffer;
  }

  function commitFrame(frame) {
    previousLines = frame.lines;
    previousWidth = frame.width;
    previousHeight = rows();
    cursor = frame.cursor;
    rendered = true;
    lastRenderAt = now();
    hasRendered = true;
  }

  function resetFrameState() {
    previousLines = [];
    previousWidth = 0;
    previousHeight = 0;
    cursor = { row: 0, column: 0 };
    rendered = false;
  }

  function renderDiff(frame) {
    const nextLines = frame.lines;
    const appendedLines = nextLines.length > previousLines.length;
    const shrinking = nextLines.length < previousLines.length;
    let firstChanged = -1;
    let lastChanged = -1;
    const lineCount = Math.max(previousLines.length, nextLines.length);
    for (let index = 0; index < lineCount; index += 1) {
      if ((previousLines[index] || "") !== (nextLines[index] || "")) {
        firstChanged = firstChanged === -1 ? index : firstChanged;
        lastChanged = index;
      }
    }
    if (appendedLines) {
      firstChanged = firstChanged === -1 ? previousLines.length : firstChanged;
      lastChanged = nextLines.length - 1;
    }
    if (firstChanged === -1 && cursor.row === frame.cursor.row && cursor.column === frame.cursor.column) {
      return;
    }

    let buffer = SYNCHRONIZED_OUTPUT_START;
    if (firstChanged !== -1) {
      const appendStart = appendedLines && firstChanged === previousLines.length && firstChanged > 0;
      const firstRenderRow = appendStart ? firstChanged - 1 : firstChanged;
      buffer += moveRows(firstRenderRow - cursor.row);
      buffer += appendStart ? "\r\n" : "\r";
      const renderEnd = Math.min(lastChanged, nextLines.length - 1);
      for (let index = firstChanged; index <= renderEnd; index += 1) {
        if (index > firstChanged) {
          buffer += "\r\n";
        }
        buffer += "\x1b[2K";
        buffer += nextLines[index] || "";
        buffer += LINE_RESET;
      }
      const currentRow = renderEnd >= firstChanged ? renderEnd : firstRenderRow;
      const currentColumn = renderEnd >= firstChanged
        ? visibleLineWidth(nextLines[renderEnd] || "")
        : 0;
      if (shrinking) {
        buffer += "\x1b[J";
      }
      buffer += cursorSequence(frame.cursor, currentRow, currentColumn);
      buffer += SYNCHRONIZED_OUTPUT_END;
      write(buffer);
    } else {
      buffer += moveRows(frame.cursor.row - cursor.row);
      buffer += `\x1b[${frame.cursor.column + 1}G`;
      buffer += SYNCHRONIZED_OUTPUT_END;
      write(buffer);
    }
    previousLines = nextLines;
    cursor = frame.cursor;
  }

  function cursorSequence(target, currentRow, currentColumn) {
    const rowDelta = target.row - currentRow;
    const columnDelta = target.column - currentColumn;
    let buffer = moveRows(rowDelta);
    if (columnDelta !== 0 || rowDelta !== 0) {
      buffer += `\x1b[${target.column + 1}G`;
    }
    return buffer;
  }

  function moveRows(delta) {
    if (delta > 0) {
      return `\x1b[${delta}B`;
    }
    if (delta < 0) {
      return `\x1b[${-delta}A`;
    }
    return "";
  }

  function clearFrame() {
    if (!rendered) {
      return;
    }
    let buffer = SYNCHRONIZED_OUTPUT_START;
    buffer += moveRows(-cursor.row);
    buffer += "\r\x1b[J";
    buffer += SYNCHRONIZED_OUTPUT_END;
    write(buffer);
    resetFrameState();
  }

  // Emits external output above the live frame as ONE terminal write: erase
  // the old frame, print the payload, repaint the frame beneath it. A single
  // write means terminals never paint an intermediate blank frame, so logs
  // streaming beside a live composer or monitor cannot flicker — even where
  // synchronized-output mode (2026) is unsupported, e.g. ConPTY.
  function withSuspended(action, options = {}) {
    if (capturing) {
      return action();
    }
    if (!started) {
      return action();
    }
    const repaint = options.render !== false;
    capturing = true;
    const originalWrite = output.write;
    let payload = "";
    output.write = (chunk) => {
      payload += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      return true;
    };
    let result;
    try {
      result = action();
    } finally {
      output.write = originalWrite;
      capturing = false;
    }

    if (FULL_SCREEN_CLEAR.test(payload)) {
      write(payload);
      resetFrameState();
      return result;
    }
    if (!rendered) {
      write(payload);
      if (repaint) {
        requestRender(true);
      }
      return result;
    }

    printAboveFrame(payload, repaint);
    return result;
  }

  function printAboveFrame(payload, repaint) {
    if (FULL_SCREEN_CLEAR.test(payload)) {
      write(payload);
      resetFrameState();
      return;
    }
    if (!payload && repaint) {
      requestRender(true);
      return;
    }
    const width = columns();
    const height = rows();
    const frame = fitFrame(normalizeFrame(renderFrame(width, height), width), height);
    let buffer = SYNCHRONIZED_OUTPUT_START;
    buffer += moveRows(-cursor.row);
    buffer += "\r\x1b[J";
    buffer += payload.endsWith("\n") || !payload ? payload : `${payload}\n`;
    if (repaint && frame.lines.length) {
      buffer += `\r${frameBody(frame)}`;
      commitFrame(frame);
    } else {
      resetFrameState();
    }
    buffer += SYNCHRONIZED_OUTPUT_END;
    write(buffer);
    if (repaint && !frame.lines.length) {
      requestRender(true);
    }
  }

  return {
    start,
    stop,
    requestRender,
    withSuspended,
  };
}

function splitSequences(value) {
  const sequences = [];
  let position = 0;
  while (position < value.length) {
    if (value[position] !== ESC) {
      const codePoint = value.codePointAt(position);
      const character = String.fromCodePoint(codePoint);
      sequences.push(character);
      position += character.length;
      continue;
    }

    const end = findEscapeEnd(value, position);
    if (end === -1) {
      return { sequences, remainder: value.slice(position) };
    }
    sequences.push(value.slice(position, end));
    position = end;
  }
  return { sequences, remainder: "" };
}

function findEscapeEnd(value, start) {
  if (start + 1 >= value.length) {
    return -1;
  }
  const type = value[start + 1];
  if (type === "[") {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index + 1;
      }
    }
    return -1;
  }
  if (type === "O") {
    return start + 3 <= value.length ? start + 3 : -1;
  }
  if (type === "]" || type === "P" || type === "_") {
    const bell = value.indexOf("\x07", start + 2);
    const stringTerminator = value.indexOf(`${ESC}\\`, start + 2);
    if (bell === -1 && stringTerminator === -1) {
      return -1;
    }
    if (bell !== -1 && (stringTerminator === -1 || bell < stringTerminator)) {
      return bell + 1;
    }
    return stringTerminator + 2;
  }
  return start + 1 + String.fromCodePoint(value.codePointAt(start + 1)).length;
}

function normalizeFrame(frame, fallbackWidth = DEFAULT_COLUMNS) {
  const lines = Array.isArray(frame?.lines)
    ? frame.lines.map((line) => String(line ?? ""))
    : [];
  const width = fallbackWidth;
  const fallbackRow = Math.max(0, lines.length - 1);
  const row = clampInteger(frame?.cursorRow, 0, Math.max(0, lines.length - 1), fallbackRow);
  const fallbackColumn = lines.length ? visibleLineWidth(lines[row]) : 0;
  const cursor = {
    row,
    column: clampInteger(frame?.cursorColumn, 0, fallbackColumn, fallbackColumn),
  };
  const focusRow = clampInteger(frame?.focusRow, 0, Math.max(0, lines.length - 1), row);
  const fixedPrefixRows = clampInteger(frame?.fixedPrefixRows, 0, lines.length, 0);
  return { lines, width, cursor, focusRow, fixedPrefixRows };
}

function fitFrame(frame, height) {
  const lineCount = finitePositive(height, DEFAULT_ROWS);
  if (frame.lines.length <= lineCount) {
    return frame;
  }
  if (frame.fixedPrefixRows > 0 && frame.fixedPrefixRows < lineCount && frame.focusRow >= frame.fixedPrefixRows) {
    const focusLineCount = lineCount - frame.fixedPrefixRows;
    const focusStart = Math.min(
      Math.max(frame.fixedPrefixRows, frame.focusRow - focusLineCount + 1),
      frame.lines.length - focusLineCount,
    );
    return {
      ...frame,
      lines: [
        ...frame.lines.slice(0, frame.fixedPrefixRows),
        ...frame.lines.slice(focusStart, focusStart + focusLineCount),
      ],
      focusRow: frame.fixedPrefixRows + frame.focusRow - focusStart,
    };
  }
  const firstFocusRow = Math.min(frame.cursor.row, frame.focusRow);
  const lastFocusRow = Math.max(frame.cursor.row, frame.focusRow);
  if (lastFocusRow - firstFocusRow >= lineCount && lineCount > 1) {
    const focusLineCount = lineCount - 1;
    const focusStart = Math.min(
      Math.max(0, frame.focusRow - focusLineCount + 1),
      frame.lines.length - focusLineCount,
    );
    return {
      ...frame,
      lines: [
        frame.lines[frame.cursor.row],
        ...frame.lines.slice(focusStart, focusStart + focusLineCount),
      ],
      cursor: {
        row: 0,
        column: frame.cursor.column,
      },
      focusRow: 1 + frame.focusRow - focusStart,
    };
  }
  const start = Math.min(firstFocusRow, frame.lines.length - lineCount);
  return {
    ...frame,
    lines: frame.lines.slice(start, start + lineCount),
    cursor: {
      row: frame.cursor.row - start,
      column: frame.cursor.column,
    },
    focusRow: frame.focusRow - start,
  };
}

function visibleLineWidth(line) {
  return textWidth(line);
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}
