export const TITLE_RESERVE = 200;
export const CHOICE_LIMIT = 5;
export const TITLE_MAX_CHARS = 48;

const SENTENCE_BOUNDARY = /(?<=[。！？；;!?])|(?<=\.)\s|\n/;

export function firstLineTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  return [...firstLine].slice(0, TITLE_MAX_CHARS).join("");
}

export function unitLength(text: string, lenUnit: "chars" | "utf16" = "chars"): number {
  if (lenUnit === "utf16") {
    return text.length;
  }
  let count = 0;
  for (const _cp of text) {
    count += 1;
  }
  return count;
}

export function splitText(
  text: string,
  maxTextLength: number,
  lenUnit: "chars" | "utf16" = "chars",
): string[] {
  const cap = Math.max(1, maxTextLength - TITLE_RESERVE);
  if (unitLength(text, lenUnit) <= cap) {
    return [text];
  }
  const pieces: string[] = [];
  let current = "";
  for (const block of paragraphs(text)) {
    if (unitLength(block, lenUnit) <= cap) {
      const candidate = current ? `${current}\n\n${block}` : block;
      if (current && unitLength(candidate, lenUnit) <= cap) {
        current = candidate;
        continue;
      }
      if (current) {
        pieces.push(current);
      }
      current = block;
      continue;
    }
    for (const piece of splitBlock(block, cap, lenUnit)) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (current && unitLength(candidate, lenUnit) <= cap) {
        current = candidate;
        continue;
      }
      if (current) {
        pieces.push(current);
      }
      current = piece;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

function paragraphs(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && !line.trim()) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function splitBlock(block: string, cap: number, lenUnit: "chars" | "utf16"): string[] {
  if (unitLength(block, lenUnit) <= cap) {
    return [block];
  }
  const pieces: string[] = [];
  let current = "";
  for (const rawPart of block.split(SENTENCE_BOUNDARY)) {
    const part = rawPart.replace(/^\n+/, "");
    if (!part) {
      continue;
    }
    const subPieces =
      unitLength(part, lenUnit) > cap ? hardCut(part, cap, lenUnit) : [part];
    for (const piece of subPieces) {
      const candidate = current ? `${current}${piece}` : piece;
      if (current && unitLength(candidate, lenUnit) > cap) {
        pieces.push(current);
        current = piece;
        continue;
      }
      current = candidate;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

function hardCut(text: string, cap: number, lenUnit: "chars" | "utf16"): string[] {
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  // Iterating with `for..of` iterates full Unicode code points, so cuts never split surrogate pairs.
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const size = lenUnit === "utf16" && cp > 0xffff ? 2 : 1;
    if (current && used + size > cap) {
      pieces.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += size;
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

// --- markdown degrade (markdown === "none" channels) -------------------------

export function degradeMarkdown(text: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line.trim() ? `    ${line}` : "");
      continue;
    }
    let stripped = line.trimStart();
    if (stripped.startsWith("#")) {
      stripped = stripped.replace(/^#+/, "").trim();
    }
    lines.push(degradeInline(stripped));
  }
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

function degradeInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/__/g, "");
}

// --- choices rendering -------------------------------------------------------

export function renderChoices(choices: readonly string[]): string {
  const labels = choices.slice(0, CHOICE_LIMIT);
  const hidden = choices.length - labels.length;
  const lines = labels.map((label, index) => `${index + 1}. ${label}`);
  if (hidden > 0) {
    lines.push(`(${hidden} more omitted)`);
  }
  lines.push("");
  lines.push("Reply with a number");
  return lines.join("\n");
}
