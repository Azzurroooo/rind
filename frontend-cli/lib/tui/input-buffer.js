const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DEFAULT_INPUT_TIMEOUT_MS = 10;

function sequenceStatus(value) {
  if (!value.startsWith(ESC)) {
    return "not-escape";
  }
  if (value.length === 1) {
    return "incomplete";
  }

  const type = value[1];
  if (type === "[") {
    if (value.startsWith(`${ESC}[M`)) {
      return value.length >= 6 ? "complete" : "incomplete";
    }
    return csiStatus(value);
  }
  if (type === "O") {
    return value.length >= 3 ? "complete" : "incomplete";
  }
  if (type === "]" || type === "P" || type === "_") {
    return value.includes("\x07") || value.includes(`${ESC}\\`) ? "complete" : "incomplete";
  }
  const codepoint = value.codePointAt(1);
  if (codepoint >= 0xd800 && codepoint <= 0xdbff && value.length < 3) {
    return "incomplete";
  }
  return "complete";
}

function csiStatus(value) {
  if (value.length < 3) {
    return "incomplete";
  }
  const final = value.charCodeAt(value.length - 1);
  return final >= 0x40 && final <= 0x7e ? "complete" : "incomplete";
}

export function createInputBuffer(options = {}) {
  const onSequence = typeof options.onSequence === "function" ? options.onSequence : () => {};
  const onPaste = typeof options.onPaste === "function" ? options.onPaste : () => {};
  const schedule = options.setTimeout || setTimeout;
  const cancelSchedule = options.clearTimeout || clearTimeout;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_INPUT_TIMEOUT_MS;

  let buffer = "";
  let timer = null;
  let pasteMode = false;
  let pasteBuffer = "";
  let pendingKittyCodepoint = null;

  function feed(data) {
    const value = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
    if (!value && !buffer) {
      return;
    }
    buffer += value;
    processBuffer();
  }

  function flush() {
    clearTimer();
    if (pasteMode || !buffer) {
      return;
    }
    const value = buffer;
    buffer = "";
    emit(value);
  }

  function clear() {
    clearTimer();
    buffer = "";
    pasteMode = false;
    pasteBuffer = "";
    pendingKittyCodepoint = null;
  }

  function clearTimer() {
    if (timer === null) {
      return;
    }
    cancelSchedule(timer);
    timer = null;
  }

  function emit(sequence) {
    if (!sequence) {
      return;
    }
    if (pendingKittyCodepoint !== null) {
      const codepoint = sequence.codePointAt(0);
      if (!sequence.startsWith(ESC) && sequence.length === String.fromCodePoint(codepoint).length && codepoint === pendingKittyCodepoint) {
        pendingKittyCodepoint = null;
        return;
      }
      pendingKittyCodepoint = null;
    }
    onSequence(sequence);
    const kittyPrintable = sequence.match(/^\x1b\[(\d+)u$/);
    pendingKittyCodepoint = kittyPrintable ? Number(kittyPrintable[1]) : null;
  }

  function processBuffer() {
    if (pasteMode) {
      pasteBuffer += buffer;
      buffer = "";
      const endIndex = pasteBuffer.indexOf(PASTE_END);
      if (endIndex === -1) {
        return;
      }
      finishPaste(endIndex);
      return;
    }

    const pasteIndex = buffer.indexOf(PASTE_START);
    if (pasteIndex !== -1) {
      const beforePaste = buffer.slice(0, pasteIndex);
      const pasteContent = buffer.slice(pasteIndex + PASTE_START.length);
      if (beforePaste) {
        emitSequences(beforePaste);
      }
      pasteMode = true;
      pasteBuffer = pasteContent;
      buffer = "";
      pendingKittyCodepoint = null;
      const endIndex = pasteBuffer.indexOf(PASTE_END);
      if (endIndex !== -1) {
        finishPaste(endIndex);
      }
      return;
    }

    emitSequences(buffer);
  }

  function finishPaste(endIndex) {
    const content = pasteBuffer.slice(0, endIndex);
    const remaining = pasteBuffer.slice(endIndex + PASTE_END.length);
    pasteMode = false;
    pasteBuffer = "";
    pendingKittyCodepoint = null;
    onPaste(content);
    if (remaining) {
      feed(remaining);
    }
  }

  function emitSequences(value) {
    const parsed = splitSequences(value);
    buffer = parsed.remainder;
    for (const sequence of parsed.sequences) {
      emit(sequence);
    }
    if (buffer) {
      clearTimer();
      timer = schedule(() => {
        timer = null;
        flush();
      }, timeoutMs);
    } else {
      clearTimer();
    }
  }

  return { feed, flush, clear };
}

export function splitSequences(value) {
  const sequences = [];
  let position = 0;
  while (position < value.length) {
    if (value[position] !== ESC) {
      const codePoint = value.codePointAt(position);
      const character = String.fromCodePoint(codePoint);
      sequences.push(character);
      position += character.length;
      continue;
    }

    let end = findEscapeEnd(value, position);
    if (end === -1) {
      return { sequences, remainder: value.slice(position) };
    }
    if (value.slice(position, end) === `${ESC}${ESC}`) {
      const next = value[end];
      if (["[", "]", "O", "P", "_"].includes(next)) {
        sequences.push(ESC);
        position += 1;
        continue;
      }
    }
    sequences.push(value.slice(position, end));
    position = end;
  }
  return { sequences, remainder: "" };
}

function findEscapeEnd(value, start) {
  for (let end = start + 1; end <= value.length; end += 1) {
    const status = sequenceStatus(value.slice(start, end));
    if (status === "complete") {
      return end;
    }
    if (status === "not-escape") {
      return start + 1;
    }
  }
  return -1;
}
