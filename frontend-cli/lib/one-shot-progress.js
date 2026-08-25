const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const NAME_COLUMN_MAX = 26;

export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function createOneShotProgress({ stderr, stream = null } = {}) {
  const tty = stream ?? { isTTY: false };
  const isTTY = Boolean(tty.isTTY);
  const useColor = isTTY && process.env.NO_COLOR === undefined;
  const c = useColor
    ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", reset: "\x1b[0m" }
    : { dim: "", red: "", green: "", reset: "" };

  const tools = new Map();
  let toolCounter = 0;
  let printedToolLines = 0;
  let lastPendingToolId = null;
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerLabel = "";
  let active = false;

  function emit(text) {
    stopSpinner();
    stderr(text);
  }

  function startSpinner(label) {
    spinnerLabel = label;
    if (!isTTY || spinnerTimer) return;
    spinnerFrame = 0;
    renderSpinner();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      renderSpinner();
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref?.();
  }

  function renderSpinner() {
    stderr(`\r${c.dim}${SPINNER_FRAMES[spinnerFrame]} ${spinnerLabel}${c.reset}\x1b[K`);
  }

  function stopSpinner() {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    if (isTTY) stderr("\r\x1b[K");
  }

  function resumeSpinner() {
    if (active && isTTY && spinnerLabel) startSpinner(spinnerLabel);
  }

  function toolLine(entry) {
    const index = String(entry.index).padStart(2, " ");
    const truncated = entry.name.length > NAME_COLUMN_MAX
      ? `${entry.name.slice(0, NAME_COLUMN_MAX - 1)}…`
      : entry.name;
    if (entry.finishedAt === null) {
      const pendingMark = isTTY ? `  ${c.dim}…${c.reset}` : "";
      return `  ${c.dim}${index}${c.reset}  ${truncated}${pendingMark}`;
    }
    const duration = c.dim + formatDuration(entry.durationMs) + c.reset;
    const mark = entry.ok ? "" : ` ${c.red}✗${c.reset}`;
    return `  ${c.dim}${index}${c.reset}  ${truncated}  ${duration}${mark}`;
  }

  return {
    begin() {
      active = true;
      startSpinner("starting runtime");
    },

    hasTool(toolCallId) {
      return tools.has(toolCallId);
    },

    get toolCount() {
      return tools.size;
    },

    session({ sessionId, model, baseUrl }) {
      const parts = [`session ${sessionId}`];
      if (model) parts.push(`model ${model}`);
      if (baseUrl) parts.push(`api ${baseUrl}`);
      emit(`${c.dim}·${c.reset} ${parts.join(`${c.dim} · ${c.reset}`)}\n`);
      startSpinner("working");
    },

    note(text) {
      emit(`${c.dim}· ${text}${c.reset}\n`);
      resumeSpinner();
    },

    toolStarted(toolCallId, toolName) {
      const name = toolName || "tool";
      toolCounter += 1;
      const entry = { index: toolCounter, name, finishedAt: null, durationMs: 0, ok: true };
      tools.set(toolCallId, entry);
      emit(`${toolLine(entry)}\n`);
      printedToolLines += 1;
      lastPendingToolId = toolCallId;
      resumeSpinner();
    },

    toolFinished(toolCallId, { ok, durationMs }) {
      const entry = tools.get(toolCallId);
      if (!entry || entry.finishedAt !== null) return;
      entry.finishedAt = Date.now();
      entry.durationMs = Number(durationMs) || 0;
      entry.ok = Boolean(ok);
      const canRewrite = isTTY && toolCallId === lastPendingToolId;
      if (canRewrite) {
        stopSpinner();
        stderr(`\x1b[1A\r\x1b[K${toolLine(entry)}\n`);
        lastPendingToolId = null;
        resumeSpinner();
        return;
      }
      if (!entry.ok) {
        emit(`  ${c.red}↳ ${entry.name} failed${c.reset} ${c.dim}${formatDuration(entry.durationMs)}${c.reset}\n`);
        resumeSpinner();
      }
      if (toolCallId === lastPendingToolId) lastPendingToolId = null;
    },

    done(elapsedMs) {
      active = false;
      if (printedToolLines > 0) emit("\n");
      emit(`${c.green}✓${c.reset} done in ${formatDuration(elapsedMs)}\n`);
    },

    fail(message) {
      active = false;
      emit(`${c.red}✗ ${message}${c.reset}\n`);
    },
  };
}
