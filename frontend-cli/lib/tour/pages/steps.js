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

export function shell(command, note = null) {
  return { kind: "shell", command: String(command), note: noteLines(note) };
}

export function shellOut(lines) {
  return { kind: "shell-out", lines: textLines(lines) };
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

export function result(text, detail = "") {
  return { kind: "result", text: String(text), detail: String(detail || "") };
}

export function slashResult(displayResult) {
  return {
    kind: "result",
    text: String(displayResult?.text || ""),
    detail: "",
    display: displayResult?.display || null,
  };
}

export function tool(name, detail, outcome) {
  return { kind: "tool", name: String(name), detail: String(detail || ""), outcome };
}

export function assistant(text, note = null) {
  return { kind: "assistant", text: String(text), note: noteLines(note) };
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
