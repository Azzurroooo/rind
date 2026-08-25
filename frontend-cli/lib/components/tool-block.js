import {
  parseToolArguments,
  renderToolFinished,
  renderToolRunning,
} from "../tool-display.js";

const TICKER_TOOLS = new Set(["bash", "bash_output", "delegate", "search_web", "fetch_web_page"]);

export class ToolBlock {
  constructor({ event, onRequestRender, leading = false }) {
    this.name = event?.tool_name || "tool";
    this.args = parseToolArguments(event);
    this.phase = "running";
    this.startedAt = Date.now();
    this.progressMessage = "";
    this.fileChange = null;
    this.resultEvent = null;
    this.expanded = false;
    this.leading = Boolean(leading);
    this.timer = null;
    this.onRequestRender = onRequestRender;
    if (TICKER_TOOLS.has(this.name)) {
      this.timer = setInterval(() => {
        this.onRequestRender?.();
      }, 1000);
      this.timer.unref?.();
    }
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
      this.onRequestRender?.();
    }
  }

  finish(event, fileChange) {
    this.phase = "done";
    this.resultEvent = event || this.resultEvent || { status: "completed", result: "" };
    this.fileChange = fileChange || null;
    this.clearTimer();
    this.onRequestRender?.();
  }

  setExpanded(expanded) {
    const next = Boolean(expanded);
    if (this.expanded === next) {
      return;
    }
    this.expanded = next;
    this.onRequestRender?.();
  }

  get isRunning() {
    return this.phase === "running";
  }

  clearTimer() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  invalidate() {
    // No cached render state (blocks restyle every frame); keep the
    // elapsed-time ticker alive across full repaints.
  }

  render(width) {
    let lines;
    if (this.phase === "running") {
      lines = renderToolRunning({
        name: this.name,
        args: this.args,
        phase: "running",
        elapsedMs: Date.now() - this.startedAt,
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
      return ["", ...lines];
    }
    return lines;
  }
}
