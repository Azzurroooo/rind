const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DEFAULT_INPUT_TIMEOUT_MS = 10;

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
  }

  function clearTimer() {
    if (timer === null) {
      return;
    }
    cancelSchedule(timer);
    timer = null;
  }

  function emit(sequence) {
    if (sequence) {
      onSequence(sequence);
    }
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

    const end = findEscapeEnd(value, position);
    if (end === -1) {
      return { sequences, remainder: value.slice(position) };
    }
    sequences.push(value.slice(position, end));
    position = end;
  }
  return { sequences, remainder: "" };
}

function findEscapeEnd(value, start) {
  if (start + 1 >= value.length) {
    return -1;
  }
  const type = value[start + 1];
  if (type === "[") {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index + 1;
      }
    }
    return -1;
  }
  if (type === "O") {
    return start + 3 <= value.length ? start + 3 : -1;
  }
  if (type === "]" || type === "P" || type === "_") {
    const bell = value.indexOf("\x07", start + 2);
    const stringTerminator = value.indexOf(`${ESC}\\`, start + 2);
    if (bell === -1 && stringTerminator === -1) {
      return -1;
    }
    if (bell !== -1 && (stringTerminator === -1 || bell < stringTerminator)) {
      return bell + 1;
    }
    return stringTerminator + 2;
  }
  return start + 1 + String.fromCodePoint(value.codePointAt(start + 1)).length;
}
