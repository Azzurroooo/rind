import { textWidth, truncateToWidth } from "../text-width.js";
import { createInputBuffer } from "./input-buffer.js";

export const CURSOR_MARKER = "\x1b_pi:c\x07";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const LINE_RESET = "\x1b[0m";
const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_RENDER_INTERVAL_MS = 16;

export function createTui(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const schedule = options.setTimeout || setTimeout;
  const cancelSchedule = options.clearTimeout || clearTimeout;
  const now = options.now || Date.now;
  const minRenderIntervalMs = Number.isFinite(options.renderIntervalMs)
    ? Math.max(0, options.renderIntervalMs)
    : DEFAULT_RENDER_INTERVAL_MS;

  let started = false;
  let stopped = false;
  let rawModeBeforeStart = false;
  let inputHandler = null;
  let pasteHandler = null;

  let children = [];
  let renderRequested = false;
  let renderForceRequested = false;
  let renderMicrotaskQueued = false;
  let renderTimer = null;
  let lastRenderAt = 0;

  let previousLines = [];
  let previousWidth = 0;
  let previousHeight = 0;
  let cursorRow = 0;
  let hardwareCursorRow = 0;
  let maxLinesRendered = 0;
  let previousViewportTop = 0;

  let clearOnShrink = false;
  let cursorVisible = false;
  let replayRequested = false;
  const inputBuffer = createInputBuffer({
    onSequence: (sequence) => inputHandler?.(sequence),
    onPaste: (payload) => pasteHandler?.(payload),
    setTimeout: schedule,
    clearTimeout: cancelSchedule,
  });

  function columns() {
    return finitePositive(output.columns, DEFAULT_COLUMNS);
  }

  function rows() {
    return finitePositive(output.rows, DEFAULT_ROWS);
  }

  function addChild(child) {
    children.push(child);
    requestRender();
    return child;
  }

  function removeChild(child) {
    const index = children.indexOf(child);
    if (index !== -1) {
      children.splice(index, 1);
      requestRender();
    }
  }

  function clearChildren() {
    if (!children.length) {
      return;
    }
    children = [];
    requestRender();
  }

  function renderRoot(width) {
    const lines = [];
    for (const child of children) {
      const rendered = child.render(width);
      if (Array.isArray(rendered)) {
        for (const line of rendered) {
          lines.push(typeof line === "string" ? line : String(line ?? ""));
        }
      }
    }
    return lines;
  }

  function onData(handler) {
    inputHandler = typeof handler === "function" ? handler : null;
  }

  function onPaste(handler) {
    pasteHandler = typeof handler === "function" ? handler : null;
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    stopped = false;
    rawModeBeforeStart = Boolean(input.isRaw);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    if (typeof input.setEncoding === "function") {
      input.setEncoding("utf8");
    }
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.on === "function") {
      input.on("data", handleInputData);
    }
    if (typeof output.on === "function") {
      output.on("resize", handleResize);
    }
    write(PASTE_ENABLE);
    hideCursor();
    requestRender();
  }

  function stop() {
    if (!started) {
      return;
    }
    started = false;
    stopped = true;
    if (renderTimer !== null) {
      cancelSchedule(renderTimer);
      renderTimer = null;
    }
    if (previousLines.length > 0) {
      const targetRow = previousLines.length;
      const delta = targetRow - hardwareCursorRow;
      let tail = "";
      if (delta > 0) {
        tail += `\x1b[${delta}B`;
      } else if (delta < 0) {
        tail += `\x1b[${-delta}A`;
      }
      tail += "\r\n";
      write(tail);
    }
    showCursor();
    if (typeof output.off === "function") {
      output.off("resize", handleResize);
    }
    if (typeof input.off === "function") {
      input.off("data", handleInputData);
    }
    if (typeof input.pause === "function") {
      input.pause();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(rawModeBeforeStart);
    }
    write(PASTE_DISABLE);
    inputBuffer.clear();
  }

  function handleInputData(data) {
    inputBuffer.feed(data);
  }

  function handleResize() {
    requestRender();
  }

  // Repaint the entire transcript (viewport + scrollback) with current
  // component state — used after appearance changes like theme switches.
  function replayAll() {
    replayRequested = true;
    requestRender(true);
  }

  // "force" only bypasses the render throttle so the next frame paints on
  // the following tick. It never resets diff bookkeeping: clearing the
  // screen is decided by doRender's geometry checks alone, so a burst of
  // forced repaints at startup can never wipe existing terminal content.
  function requestRender(force = false) {
    if (stopped) {
      return;
    }
    renderRequested = true;
    if (force === true) {
      renderForceRequested = true;
      if (renderTimer !== null) {
        cancelSchedule(renderTimer);
        renderTimer = null;
      }
    } else if (renderMicrotaskQueued || renderTimer !== null) {
      return;
    }
    queueRenderMicrotask();
  }

  function queueRenderMicrotask() {
    if (renderMicrotaskQueued) {
      return;
    }
    renderMicrotaskQueued = true;
    queueMicrotask(() => {
      renderMicrotaskQueued = false;
      scheduleRender();
    });
  }

  function scheduleRender() {
    if (stopped || renderTimer !== null || !renderRequested) {
      return;
    }
    const delay = renderForceRequested
      ? 0
      : Math.max(0, minRenderIntervalMs - (now() - lastRenderAt));
    renderTimer = schedule(() => {
      renderTimer = null;
      flushRender();
    }, delay);
  }

  function flushRender() {
    if (stopped || !renderRequested) {
      return;
    }
    renderRequested = false;
    renderForceRequested = false;
    lastRenderAt = now();
    doRender();
    if (renderRequested) {
      queueRenderMicrotask();
    }
  }

  function doRender() {
    if (!started || stopped) {
      return;
    }
    if (replayRequested) {
      // Full repaint (e.g. theme switch): drop caches so components restyle,
      // then reuse the resize machinery — clear screen + scrollback and
      // replay every line under the active palette.
      replayRequested = false;
      for (const child of children) {
        child.invalidate?.();
      }
      previousLines = [];
      previousWidth = -1;
      previousHeight = -1;
      cursorRow = 0;
      hardwareCursorRow = 0;
      maxLinesRendered = 0;
      previousViewportTop = 0;
    }
    const width = columns();
    const height = rows();
    const widthChanged = previousWidth !== 0 && previousWidth !== width;
    const heightChanged = previousHeight !== 0 && previousHeight !== height;
    const previousBufferLength = previousHeight > 0 ? previousViewportTop + previousHeight : height;
    let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : previousViewportTop;
    let viewportTop = prevViewportTop;
    let localHardwareCursorRow = hardwareCursorRow;
    const computeLineDiff = (targetRow) => {
      const currentScreenRow = localHardwareCursorRow - prevViewportTop;
      const targetScreenRow = targetRow - viewportTop;
      return targetScreenRow - currentScreenRow;
    };

    let newLines = renderRoot(width);
    const cursorPos = extractCursorPosition(newLines, height);
    newLines = applyLineResets(newLines);

    const fullRender = (clear) => {
      let buffer = SYNC_START;
      if (clear) {
        buffer += "\x1b[2J\x1b[H\x1b[3J";
      }
      for (let index = 0; index < newLines.length; index += 1) {
        if (index > 0) {
          buffer += "\r\n";
        }
        buffer += writableLine(newLines[index], width);
      }
      buffer += SYNC_END;
      write(buffer);
      cursorRow = Math.max(0, newLines.length - 1);
      hardwareCursorRow = cursorRow;
      maxLinesRendered = clear ? newLines.length : Math.max(maxLinesRendered, newLines.length);
      const bufferLength = Math.max(height, newLines.length);
      previousViewportTop = Math.max(0, bufferLength - height);
      positionHardwareCursor(cursorPos, newLines);
      previousLines = newLines;
      previousWidth = width;
      previousHeight = height;
    };

    if (previousLines.length === 0 && !widthChanged && !heightChanged) {
      logRedraw("first render");
      fullRender(false);
      return;
    }

    if (widthChanged) {
      logRedraw(`terminal width changed (${previousWidth} -> ${width})`);
      fullRender(true);
      return;
    }

    if (heightChanged) {
      logRedraw(`terminal height changed (${previousHeight} -> ${height})`);
      fullRender(true);
      return;
    }

    if (clearOnShrink && newLines.length < maxLinesRendered) {
      logRedraw(`clearOnShrink (maxLinesRendered=${maxLinesRendered})`);
      fullRender(true);
      return;
    }

    let firstChanged = -1;
    let lastChanged = -1;
    const maxLines = Math.max(newLines.length, previousLines.length);
    for (let index = 0; index < maxLines; index += 1) {
      const oldLine = index < previousLines.length ? previousLines[index] : "";
      const newLine = index < newLines.length ? newLines[index] : "";
      if (oldLine !== newLine) {
        if (firstChanged === -1) {
          firstChanged = index;
        }
        lastChanged = index;
      }
    }
    const appendedLines = newLines.length > previousLines.length;
    if (appendedLines) {
      if (firstChanged === -1) {
        firstChanged = previousLines.length;
      }
      lastChanged = newLines.length - 1;
    }
    const appendStart = appendedLines && firstChanged === previousLines.length && firstChanged > 0;

    if (firstChanged === -1) {
      positionHardwareCursor(cursorPos, newLines);
      previousViewportTop = prevViewportTop;
      previousHeight = height;
      return;
    }

    if (firstChanged >= newLines.length) {
      if (previousLines.length > newLines.length) {
        const targetRow = Math.max(0, newLines.length - 1);
        if (targetRow < prevViewportTop) {
          logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
          fullRender(true);
          return;
        }
        const extraLines = previousLines.length - newLines.length;
        if (extraLines > height) {
          logRedraw(`extraLines > height (${extraLines} > ${height})`);
          fullRender(true);
          return;
        }
        let buffer = SYNC_START;
        const lineDiff = computeLineDiff(targetRow);
        if (lineDiff > 0) {
          buffer += `\x1b[${lineDiff}B`;
        } else if (lineDiff < 0) {
          buffer += `\x1b[${-lineDiff}A`;
        }
        buffer += "\r";
        const clearStartOffset = newLines.length === 0 ? 0 : 1;
        if (extraLines > 0 && clearStartOffset > 0) {
          buffer += `\x1b[${clearStartOffset}B`;
        }
        for (let index = 0; index < extraLines; index += 1) {
          buffer += "\r\x1b[2K";
          if (index < extraLines - 1) {
            buffer += "\x1b[1B";
          }
        }
        const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
        if (moveBack > 0) {
          buffer += `\x1b[${moveBack}A`;
        }
        buffer += SYNC_END;
        write(buffer);
        cursorRow = targetRow;
        hardwareCursorRow = targetRow;
      }
      positionHardwareCursor(cursorPos, newLines);
      previousLines = newLines;
      previousWidth = width;
      previousHeight = height;
      previousViewportTop = prevViewportTop;
      return;
    }

    if (firstChanged < prevViewportTop) {
      logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
      fullRender(true);
      return;
    }

    let buffer = SYNC_START;
    const prevViewportBottom = prevViewportTop + height - 1;
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(0, Math.min(height - 1, localHardwareCursorRow - prevViewportTop));
      const moveToBottom = height - 1 - currentScreenRow;
      if (moveToBottom > 0) {
        buffer += `\x1b[${moveToBottom}B`;
      }
      const scrollCount = moveTargetRow - prevViewportBottom;
      buffer += "\r\n".repeat(scrollCount);
      prevViewportTop += scrollCount;
      viewportTop += scrollCount;
      localHardwareCursorRow = moveTargetRow;
    }

    const lineDiff = computeLineDiff(moveTargetRow);
    if (lineDiff > 0) {
      buffer += `\x1b[${lineDiff}B`;
    } else if (lineDiff < 0) {
      buffer += `\x1b[${-lineDiff}A`;
    }

    buffer += appendStart ? "\r\n" : "\r";

    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let index = firstChanged; index <= renderEnd; index += 1) {
      if (index > firstChanged) {
        buffer += "\r\n";
      }
      buffer += "\x1b[2K";
      buffer += writableLine(newLines[index], width);
    }

    let finalCursorRow = renderEnd;
    if (previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer += `\x1b[${moveDown}B`;
        finalCursorRow = newLines.length - 1;
      }
      const extraLines = previousLines.length - newLines.length;
      for (let index = newLines.length; index < previousLines.length; index += 1) {
        buffer += "\r\n\x1b[2K";
      }
      buffer += `\x1b[${extraLines}A`;
    }

    buffer += SYNC_END;
    write(buffer);

    cursorRow = Math.max(0, newLines.length - 1);
    hardwareCursorRow = finalCursorRow;
    maxLinesRendered = Math.max(maxLinesRendered, newLines.length);
    previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
    positionHardwareCursor(cursorPos, newLines);
    previousLines = newLines;
    previousWidth = width;
    previousHeight = height;
  }

  function writableLine(line, width) {
    let value = typeof line === "string" ? line : String(line ?? "");
    if (value.includes("\n") || value.includes("\r")) {
      value = value.replace(/\r?\n/g, " ");
    }
    const measured = textWidth(value);
    if (measured > width) {
      value = truncateToWidth(value, width);
    }
    return value;
  }

  function applyLineResets(lines) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      lines[index] = line.includes("\x1b[") ? `${line}${LINE_RESET}` : line;
    }
    return lines;
  }

  function extractCursorPosition(lines, height) {
    const viewportTop = Math.max(0, lines.length - height);
    for (let row = lines.length - 1; row >= viewportTop; row -= 1) {
      const line = lines[row];
      const markerIndex = line.indexOf(CURSOR_MARKER);
      if (markerIndex === -1) {
        continue;
      }
      const beforeMarker = line.slice(0, markerIndex);
      const col = textWidth(beforeMarker);
      lines[row] = beforeMarker + line.slice(markerIndex + CURSOR_MARKER.length);
      return { row, col };
    }
    return null;
  }

  function positionHardwareCursor(cursorPos, lines) {
    const totalLines = lines.length;
    if (!cursorPos || totalLines <= 0) {
      if (cursorVisible) {
        hideCursor();
      }
      return;
    }
    let targetRow;
    let targetCol;
    targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
    targetCol = Math.max(0, cursorPos.col);
    const rowDelta = targetRow - hardwareCursorRow;
    let buffer = "";
    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A`;
    }
    buffer += `\x1b[${targetCol + 1}G`;
    write(buffer);
    hardwareCursorRow = targetRow;
    showCursor();
  }

  function hideCursor() {
    write("\x1b[?25l");
    cursorVisible = false;
  }

  function showCursor() {
    write("\x1b[?25h");
    cursorVisible = true;
  }

  function write(value) {
    if (value) {
      output.write(value);
    }
  }

  function logRedraw(reason) {
    if (process.env.RIND_DEBUG_REDRAW !== "1") {
      return;
    }
    process.stderr.write(
      `[rind-tui] fullRedraw: ${reason} (prev=${previousLines.length}, height=${rows()})\n`,
    );
  }

  return {
    start,
    stop,
    requestRender,
    replayAll,
    addChild,
    removeChild,
    clearChildren,
    onData,
    onPaste,
    setClearOnShrink(value) {
      clearOnShrink = Boolean(value);
    },
    get started() {
      return started;
    },
    get columns() {
      return columns();
    },
    get rows() {
      return rows();
    },
  };
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
