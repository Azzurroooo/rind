import { CURSOR_MARKER } from "../tui/frame.js";

export class MonitorStack {
  constructor({ composer, monitor, rows }) {
    this.composer = composer;
    this.monitor = monitor;
    this.rows = rows;
  }

  render(width) {
    let composerLines = this.composer.render(width);
    if (typeof this.monitor?.frame !== "function" || !this.monitor.isMonitoring()) return composerLines;
    const rows = Math.max(1, Number(this.rows?.()) || 24);
    const composerHeight = Math.max(0, rows - Math.min(2, rows - 1));
    if (composerLines.length > composerHeight) {
      const cursorRow = Math.max(0, composerLines.findIndex((line) => line.includes(CURSOR_MARKER)));
      const start = Math.min(Math.max(0, cursorRow - composerHeight + 1), composerLines.length - composerHeight);
      composerLines = composerLines.slice(start, start + composerHeight);
    }
    const monitorFrame = this.monitor.frame(width, rows - composerLines.length);
    const monitorLines = Array.isArray(monitorFrame?.lines) ? monitorFrame.lines : [];
    return [...composerLines, ...monitorLines];
  }
}
