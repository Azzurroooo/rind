import {
  argsFromResult,
  parseToolArguments,
  parseToolResult,
  renderToolFinished,
  renderToolRunning,
} from "../tool-display.js";

export class ToolBlock {
  constructor({ event, onRequestRender, leading = false, animate = true, now = Date.now }) {
    this.name = event?.tool_name || "tool";
    this.args = { ...parseToolArguments(event) };
    this.phase = "running";
    this.now = now;
    this.startedAt = now();
    this.progressMessage = "";
    this.fileChange = null;
    this.resultEvent = null;
    this.cache = null;
    this.expanded = false;
    this.leading = Boolean(leading);
    this.animate = animate;
    this.onRequestRender = onRequestRender;
  }

  setProgress(message) {
    if (this.phase !== "running") {
      return;
    }
    const next = String(message ?? "");
    if (next === this.progressMessage) {
      return;
    }
    this.progressMessage = next;
    this.invalidate();
    this.onRequestRender?.();
  }

  // The runtime streams tool_input_started (id+name only) before
  // tool_requested (full parsed arguments); merge late-arriving args into
  // an already-created block so titles gain their command/path/etc.
  enrichArgs(event) {
    const incoming = parseToolArguments(event);
    let changed = false;
    for (const [key, value] of Object.entries(incoming)) {
      const current = this.args?.[key];
      if ((current === undefined || current === null || current === "") && value !== undefined && value !== null && value !== "") {
        if (!this.args || typeof this.args !== "object") {
          this.args = {};
        }
        this.args[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.invalidate();
      this.onRequestRender?.();
    }
  }

  finish(event, fileChange) {
    this.phase = "done";
    const result = event || this.resultEvent || { status: "completed", result: "" };
    this.resultEvent = { ...result, result: parseToolResult(result.result) };
    this.enrichArgs({ arguments: argsFromResult(this.name, this.resultEvent.result) });
    this.fileChange = fileChange || null;
    this.invalidate();
    this.onRequestRender?.();
  }

  setExpanded(expanded) {
    const next = Boolean(expanded);
    if (this.expanded === next) {
      return;
    }
    this.expanded = next;
    this.invalidate();
    this.onRequestRender?.();
  }

  get isRunning() {
    return this.phase === "running";
  }

  invalidate() {
    this.cache = null;
  }

  render(width) {
    if (this.cache?.width === width) {
      return this.cache.lines;
    }
    let lines;
    if (this.phase === "running") {
      lines = renderToolRunning({
        name: this.name,
        args: this.args,
        phase: "running",
        elapsedMs: this.animate ? this.now() - this.startedAt : 0,
        progressMessage: this.progressMessage,
      }, width);
    } else {
      lines = renderToolFinished({
        name: this.name,
        args: this.args,
        phase: "done",
        expanded: this.expanded,
        event: this.resultEvent,
        fileChange: this.fileChange,
      }, width);
    }
    if (this.leading && lines.length) {
      lines = ["", ...lines];
    }
    if (!this.isRunning) {
      this.cache = { width, lines: Object.freeze(lines) };
    }
    return lines;
  }
}
