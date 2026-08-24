export class MonitorStack {
  constructor({ composer, monitor, rows }) {
    this.composer = composer;
    this.monitor = monitor;
    this.rows = rows;
  }

  render(width) {
    const composerLines = this.composer.render(width);
    const monitorFrame = typeof this.monitor?.frame === "function" && this.monitor.isMonitoring()
      ? this.monitor.frame(width)
      : null;
    const monitorLines = Array.isArray(monitorFrame?.lines) ? monitorFrame.lines : [];
    if (!monitorLines.length) {
      return composerLines;
    }
    const totalHeight = Number(this.rows?.()) || 24;
    if (composerLines.length + monitorLines.length <= totalHeight) {
      return [...composerLines, ...monitorLines];
    }
    const available = Math.max(1, totalHeight - Math.min(composerLines.length, Math.max(1, totalHeight - 1)));
    const focusRow = clampIndex(monitorFrame.focusRow, monitorLines.length);
    let start = Math.min(Math.max(0, focusRow - available + 1), monitorLines.length - available);
    start = Math.max(0, start);
    return [...composerLines, ...monitorLines.slice(start, start + available)];
  }
}

function clampIndex(value, length) {
  const index = Math.floor(Number(value) || 0);
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.max(0, Math.min(length - 1, index));
}
