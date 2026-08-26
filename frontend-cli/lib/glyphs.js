// Single source of terminal glyphs. Legacy Windows consoles (conhost without
// Windows Terminal / VS Code) miss rounded box drawing, geometric spinner and
// meter shapes, so callers transparently receive ASCII equivalents.

const UNICODE = {
  user: "●",
  agent: "●",
  divider: "◆",
  notice: "◆",
  goal: "◆",
  running: "◌",
  done: "◉",
  fail: "⊘",
  cancelled: "◌",
  rule: "─",
  bar: "│",
  cornerOpen: "╭",
  cornerClose: "╰",
  headingBar: "▍",
  meterFull: "▮",
  meterEmpty: "▯",
  planPending: "○",
  planInProgress: "◐",
  planDone: "●",
  planCancelled: "⊖",
  spinner: ["◐", "◓", "◑", "◒"],
};

const ASCII = {
  user: "*",
  agent: "*",
  divider: "+",
  notice: "+",
  goal: "+",
  running: "o",
  done: "o",
  fail: "x",
  cancelled: "o",
  rule: "-",
  bar: "|",
  cornerOpen: ",",
  cornerClose: "'",
  headingBar: ">",
  meterFull: "#",
  meterEmpty: ".",
  planPending: "o",
  planInProgress: "@",
  planDone: "*",
  planCancelled: "-",
  spinner: ["|", "/", "-", "\\"],
};

let set = detectSet();

function detectSet() {
  if (process.env.RIND_UNICODE === "1") {
    return UNICODE;
  }
  if (process.env.RIND_UNICODE === "0" || process.env.NO_UNICODE === "1") {
    return ASCII;
  }
  if (process.platform !== "win32") {
    return UNICODE;
  }
  // Modern Windows terminals declare themselves; bare conhost does not.
  const modern = process.env.WT_SESSION
    || process.env.TERM_PROGRAM === "vscode"
    || process.env.TERM_PROGRAM === "WezTerm"
    || process.env.ANSICON;
  return modern || !process.stdout.isTTY ? UNICODE : ASCII;
}

export function glyph(name) {
  return set[name] ?? "";
}

export function spinnerFrame(index) {
  const frames = set.spinner;
  return frames[Math.abs(Number(index) || 0) % frames.length];
}
