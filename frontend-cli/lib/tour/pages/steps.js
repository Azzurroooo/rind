// Step constructors: the only vocabulary tour pages may use. Every step is
// plain data so pages stay serializable and replayable.

function noteLines(note) {
  if (!note) {
    return null;
  }
  return (Array.isArray(note) ? note : [note]).map((line) => String(line));
}

function textLines(lines) {
  return (Array.isArray(lines) ? lines : [lines]).map((line) => String(line));
}

export function shell(command, note = null, cwd = null) {
  return { kind: "shell", command: String(command), note: noteLines(note), ...(cwd ? { cwd } : {}) };
}

export function shellOut(lines, note = null) {
  return { kind: "shell-out", lines: textLines(lines), ...(note ? { note: noteLines(note) } : {}) };
}

export function startup(info, note = null) {
  return { kind: "startup", info, note: noteLines(note) };
}

export function type(text, note = null) {
  return { kind: "type", text: String(text), note: noteLines(note) };
}

export function submit(mode = "send") {
  return { kind: "submit", mode };
}

export function result(text, detail = "", note = null) {
  return { kind: "result", text: String(text), detail: String(detail || ""), ...(note ? { note: noteLines(note) } : {}) };
}

export function slashResult(displayResult, note = null) {
  return {
    kind: "slash-result",
    text: String(displayResult?.text || ""),
    detail: "",
    display: displayResult?.display || null,
    ...(note ? { note: noteLines(note) } : {}),
  };
}

export function tool(name, detail, outcome, args = null, note = null) {
  return { kind: "tool", name: String(name), detail: String(detail || ""), outcome, ...(args ? { arguments: args } : {}), ...(note ? { note: noteLines(note) } : {}) };
}

export function assistant(text, note = null) {
  return { kind: "assistant", text: Array.isArray(text) ? text.join("\n") : String(text), note: noteLines(note) };
}

export function turnDone(durationMs = 4200, completed = 0, failed = 0) {
  return { kind: "turn-done", durationMs, completed, failed };
}

export function exitRind() {
  return { kind: "exit" };
}

export function note(lines) {
  return { kind: "note", lines: textLines(lines) };
}

export function menu(spec, note = null) {
  return { kind: "menu", menu: spec, note: noteLines(note) };
}

// A plain snapshot, not a connection to the management service.
export function agents(screen, note = null) {
  return { kind: "agents", screen, note: noteLines(note) };
}

export const info = (value, clear = false) => ({ kind: "info", info: value, clear });
export const closeMenu = (key = "Esc") => ({ kind: "close-menu", key });
export const consume = (mode, note = null) => ({ kind: "consume", mode, ...(note ? { note: noteLines(note) } : {}) });
export const turnStart = (input = "") => ({ kind: "turn-start", input });
export const expandTools = (expanded = true, note = null) => ({ kind: "expand-tools", expanded, ...(note ? { note: noteLines(note) } : {}) });
export const prefill = (text, note = null) => ({ kind: "prefill", text, ...(note ? { note: noteLines(note) } : {}) });
