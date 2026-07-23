const ARROW_KEYS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

export function parseTerminalKey(raw = "") {
  const value = String(raw || "");
  if (!value) {
    return null;
  }
  if (value === "\r" || value === "\x1bOM") {
    return key("enter");
  }
  if (value === "\n") {
    return key("j", 5);
  }
  if (value === "\t") {
    return key("tab");
  }
  if (value === "\b") {
    return key("backspace", process.platform === "win32" && process.env.WT_SESSION ? 5 : 1);
  }
  if (value === "\x7f") {
    return key("backspace");
  }
  if (value === "\x1f") {
    return key("-", 5);
  }
  if (value === "\x1b") {
    return key("escape");
  }
  if (value.length === 1) {
    const code = value.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return key(String.fromCharCode(96 + code), 5);
    }
    if (code < 32) {
      return null;
    }
    return { kind: "text", name: "", text: value };
  }

  const modifiedArrow = value.match(/^\x1b\[1;([2-8])([ABCDHF])$/);
  if (modifiedArrow) {
    return key(ARROW_KEYS[modifiedArrow[2]], Number(modifiedArrow[1]));
  }
  const tilde = value.match(/^\x1b\[([0-9]+)(?:;([2-8]))?~$/);
  if (tilde) {
    return Number(tilde[1]) === 3 ? key("delete", Number(tilde[2] || 1)) : null;
  }
  const csiKey = value.match(/^\x1b\[([ABCDHFZ])$/);
  if (csiKey) {
    return csiKey[1] === "Z" ? key("tab", 2) : key(ARROW_KEYS[csiKey[1]]);
  }
  const ss3Key = value.match(/^\x1bO([ABCDHF])$/);
  if (ss3Key) {
    return key(ARROW_KEYS[ss3Key[1]]);
  }
  const csiEnter = value.match(/^\x1b\[13;([2-8])u$/);
  if (csiEnter) {
    return key("enter", Number(csiEnter[1]));
  }
  const csiMinus = value.match(/^\x1b\[45;([2-8])u$/);
  if (csiMinus) {
    return key("-", Number(csiMinus[1]));
  }
  const modifiedEnter = value.match(/^\x1b\[27;([2-8]);13~$/);
  if (modifiedEnter) {
    return key("enter", Number(modifiedEnter[1]));
  }
  if (value === "\x1b\r") {
    return key("enter", 2);
  }
  if (value.startsWith("\x1b") && value.length === 2) {
    return key(value[1] === "\x7f" || value[1] === "\b" ? "backspace" : value[1], 3);
  }
  if (value.startsWith("\x1b")) {
    return null;
  }
  return { kind: "text", name: "", text: value };
}

function key(name, modifier = 1) {
  const bits = modifier - 1;
  return {
    kind: "key",
    name,
    shift: Boolean(bits & 1),
    alt: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
    text: "",
  };
}
