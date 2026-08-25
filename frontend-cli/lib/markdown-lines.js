const INLINE_TOKEN_RE = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
const PLAIN_TEXT_RE = /[`*#>|\[]/;

export function renderMarkdownishLine(line, color) {
  const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (heading) {
    return renderInline(heading[2], color, "heading");
  }

  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    return `${quote[1]}${dim("│ ", color)}${renderInline(quote[2], color)}`;
  }

  const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (list) {
    const marker = /^\d+\.$/.test(list[2]) ? list[2] : "–";
    return `${list[1]}${dim(`${marker} `, color)}${renderInline(list[3], color)}`;
  }

  return renderInline(line, color);
}

export function renderInline(text, color, baseStyle = "") {
  const source = String(text || "");
  let output = "";
  let index = 0;
  for (const match of source.matchAll(INLINE_TOKEN_RE)) {
    output += styled(source.slice(index, match.index), color, baseStyle);
    output += renderInlineToken(match[0], color, baseStyle);
    index = match.index + match[0].length;
  }
  return output + styled(source.slice(index), color, baseStyle);
}

export function renderInlineToken(token, color, baseStyle) {
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    return `${renderInline(link[1], color, baseStyle)} ${dim(`(${link[2]})`, color)}`;
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    return styled(token.slice(1, -1), color, "inlineCode");
  }
  if (token.startsWith("**") && token.endsWith("**")) {
    return styled(token.slice(2, -2), color, baseStyle || "emphasis");
  }
  return token;
}

export function isPlainLine(line) {
  if (!line) {
    return true;
  }
  if (PLAIN_TEXT_RE.test(line)) {
    return false;
  }
  const stripped = line.trimStart();
  return !stripped.match(/^([-*+]|\d+\.)\s+/);
}

export function isTableLine(line, inCodeBlock) {
  const stripped = line.trim();
  return !inCodeBlock && stripped.includes("|") && stripped.split("|").length > 2;
}

export function parseTableRow(line) {
  let stripped = line.trim();
  if (stripped.startsWith("|")) {
    stripped = stripped.slice(1);
  }
  if (stripped.endsWith("|")) {
    stripped = stripped.slice(0, -1);
  }
  return stripped.split("|").map((cell) => cell.trim());
}

export function codeOpenLabel(label) {
  return label ? `┌ code ${label}` : "┌ code";
}

export function styled(text, color, style) {
  if (!text || !color || !style) {
    return text;
  }
  const codes = {
    codeBlock: "38;5;110",
    emphasis: "1;38;5;221",
    heading: "1;38;5;81",
    inlineCode: "38;5;215",
    tableHeader: "1;38;5;81",
  };
  const code = codes[style] || codes.emphasis;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function dim(text, color) {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}
