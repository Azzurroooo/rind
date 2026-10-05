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

  const sgrMouse = value.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (sgrMouse) {
    return mouseEvent(Number(sgrMouse[1]), Number(sgrMouse[2]), Number(sgrMouse[3]), sgrMouse[4] === "m");
  }
  if (value.startsWith("\x1b[M") && value.length === 6) {
    return mouseEvent(value.charCodeAt(3) - 32, value.charCodeAt(4) - 32, value.charCodeAt(5) - 32, false);
  }

  const kitty = value.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
  if (kitty) {
    const codepoint = Number(kitty[1]);
    const shiftedCodepoint = kitty[2] ? Number(kitty[2]) : codepoint;
    const modifier = Number(kitty[4] || 1);
    if (kitty[5] === "3") {
      return null;
    }
    const special = kittySpecialKey(codepoint, modifier);
    if (special) {
      return special;
    }
    if (codepoint < 32 || codepoint === 127) {
      return null;
    }
    const character = String.fromCodePoint(shiftedCodepoint);
    if (modifier === 1 || modifier === 2) {
      return { kind: "text", name: "", text: character };
    }
    return key(character.toLowerCase(), modifier);
  }

  const modifiedArrow = value.match(/^\x1b\[1;([0-9]+)(?::([1-3]))?([ABCDHF])$/);
  if (modifiedArrow) {
    if (modifiedArrow[2] === "3") {
      return null;
    }
    return key(ARROW_KEYS[modifiedArrow[3]], Number(modifiedArrow[1]));
  }
  const tilde = value.match(/^\x1b\[([0-9]+)(?:;([0-9]+))?(?::([1-3]))?~$/);
  if (tilde) {
    if (tilde[3] === "3") {
      return null;
    }
    const name = { 1: "home", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" }[Number(tilde[1])];
    return name ? key(name, Number(tilde[2] || 1)) : null;
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

function mouseEvent(code, column, row, released) {
  if (!Number.isSafeInteger(code) || !Number.isSafeInteger(column) || !Number.isSafeInteger(row) || column < 1 || row < 1) return null;
  const wheel = Boolean(code & 64);
  const button = wheel ? (code & 1 ? "down" : "up") : ["left", "middle", "right"][code & 3];
  if (!button || code & 32) return null;
  return { kind: "mouse", name: released ? "release" : wheel ? "scroll" : "press", button, x: column - 1, y: row - 1,
    shift: Boolean(code & 4), alt: Boolean(code & 8), ctrl: Boolean(code & 16), text: "" };
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

function kittySpecialKey(codepoint, modifier) {
  if (codepoint === 13) {
    return key("enter", modifier);
  }
  if (codepoint === 9) {
    return key("tab", modifier);
  }
  if (codepoint === 127) {
    return key("backspace", modifier);
  }
  if (codepoint === 27) {
    return key("escape", modifier);
  }
  return null;
}
