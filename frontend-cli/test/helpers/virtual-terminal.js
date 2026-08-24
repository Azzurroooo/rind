import { EventEmitter } from "node:events";
import xtermModule from "@xterm/headless";

const XtermTerminal = xtermModule.Terminal ?? xtermModule.default?.Terminal;

export function createVirtualOutput({ columns = 80, rows = 24 } = {}) {
  const xterm = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  });
  const events = new EventEmitter();
  let currentColumns = columns;
  let currentRows = rows;

  const output = {
    write(chunk) {
      if (chunk) {
        xterm.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      }
      return true;
    },
    on(name, listener) {
      events.on(name, listener);
      return output;
    },
    off(name, listener) {
      events.off(name, listener);
      return output;
    },
    get columns() {
      return currentColumns;
    },
    get rows() {
      return currentRows;
    },
  };

  return {
    output,
    resize(nextColumns, nextRows) {
      currentColumns = nextColumns;
      currentRows = nextRows;
      xterm.resize(nextColumns, nextRows);
      events.emit("resize");
    },
    async flush() {
      await new Promise((resolve) => {
        xterm.write("", resolve);
      });
    },
    getViewport() {
      const lines = [];
      const buffer = xterm.buffer.active;
      for (let index = 0; index < xterm.rows; index += 1) {
        const line = buffer.getLine(buffer.viewportY + index);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines;
    },
    async flushAndGetViewport() {
      await this.flush();
      return this.getViewport();
    },
    getScrollBuffer() {
      const lines = [];
      const buffer = xterm.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines;
    },
    getCursorPosition() {
      const buffer = xterm.buffer.active;
      return { x: buffer.cursorX, y: buffer.cursorY };
    },
  };
}

export function createVirtualInput() {
  const state = {
    raw: false,
    encoding: null,
    resumed: false,
  };
  const events = new EventEmitter();
  const input = Object.assign(events, {
    isRaw: false,
    setRawMode(value) {
      state.raw = Boolean(value);
      input.isRaw = state.raw;
      return input;
    },
    setEncoding(encoding) {
      state.encoding = encoding;
      return input;
    },
    resume() {
      state.resumed = true;
      return input;
    },
    pause() {
      state.resumed = false;
      return input;
    },
    send(data) {
      events.emit("data", data);
    },
  });
  return input;
}
