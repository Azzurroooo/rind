import { textWidth, wrapTextWithAnsi } from "./text-width.js";

const INLINE_TOKEN_RE = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
const PLAIN_TEXT_RE = /[`*#>|\[]/;
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;

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

export function isTableSeparator(line, inCodeBlock = false) {
  if (!isTableLine(line, inCodeBlock)) {
    return false;
  }
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell));
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

export function createTableState() {
  return { candidate: [], rows: null };
}

export function consumeTableLine(state, line, inCodeBlock = false) {
  if (state.rows) {
    if (isTableLine(line, inCodeBlock)) {
      state.rows.push(parseTableRow(line));
      return { type: "append" };
    }
    const rows = state.rows;
    state.rows = null;
    return { type: "flush", rows, line };
  }
  if (state.candidate.length) {
    if (isTableSeparator(line, inCodeBlock)) {
      const header = state.candidate.at(-1);
      const lines = state.candidate.slice(0, -1);
      state.rows = [parseTableRow(header)];
      state.candidate = [];
      return { type: "start", lines };
    }
    const lines = state.candidate;
    state.candidate = [];
    return { type: "flush_candidate", lines, line };
  }
  if (isTableLine(line, inCodeBlock)) {
    state.candidate.push(line);
    return { type: "hold" };
  }
  return { type: "line", line };
}

export function finishTableState(state) {
  if (state.rows) {
    const rows = state.rows;
    state.rows = null;
    return { type: "flush", rows };
  }
  if (state.candidate.length) {
    const lines = state.candidate;
    state.candidate = [];
    return { type: "flush_candidate", lines };
  }
  return null;
}

export function renderTableBlock(rows, color, width) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }
  const columnCount = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0), 0);
  if (!columnCount) {
    return "";
  }
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => String(row?.[index] || "")));
  const header = normalizedRows[0];
  const bodyRows = normalizedRows.slice(1).filter((row) => !row.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell)));
  const displayRows = [header, ...bodyRows];
  const availableWidth = Math.max(1, Number(width) || 1);
  const borderOverhead = 3 * columnCount + 1;
  const availableCells = availableWidth - borderOverhead;
  if (availableCells < columnCount) {
    return normalizedRows.map((row) => row.map((cell) => renderInline(cell, color)).join(dim(" | ", color))).join("\n");
  }

  const naturalWidths = Array(columnCount).fill(1);
  const minimumWidths = Array(columnCount).fill(1);
  displayRows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const plain = renderInline(cell, false);
      naturalWidths[columnIndex] = Math.max(naturalWidths[columnIndex], textWidth(plain));
      minimumWidths[columnIndex] = Math.max(minimumWidths[columnIndex], longestWordWidth(plain, 30));
      if (rowIndex === 0) {
        minimumWidths[columnIndex] = Math.max(minimumWidths[columnIndex], 1);
      }
    });
  });

  const minimumTotal = minimumWidths.reduce((sum, value) => sum + value, 0);
  if (minimumTotal > availableCells) {
    minimumWidths.fill(1);
  }
  const columnWidths = minimumWidths.slice();
  let remaining = availableCells - columnWidths.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < columnCount && remaining > 0; index += 1) {
      if (columnWidths[index] < naturalWidths[index]) {
        columnWidths[index] += 1;
        remaining -= 1;
        grew = true;
      }
    }
    if (!grew) {
      break;
    }
  }

  const border = (left, joiner, right) => `${left}─${columnWidths.map((value) => "─".repeat(value)).join(`─${joiner}─`)}─${right}`;
  const lines = [border("┌", "┬", "┐")];
  displayRows.forEach((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      const rendered = renderInline(cell, color, rowIndex === 0 ? "tableHeader" : "");
      return wrapTextWithAnsi(rendered, columnWidths[columnIndex], columnWidths[columnIndex]);
    });
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const renderedCells = cells.map((cell, columnIndex) => {
        const value = cell[lineIndex] || "";
        return `${value}${" ".repeat(Math.max(0, columnWidths[columnIndex] - textWidth(value)))}`;
      });
      lines.push(`│ ${renderedCells.join(" │ ")} │`);
    }
    if (rowIndex === 0) {
      lines.push(border("├", "┼", "┤"));
    } else if (rowIndex < displayRows.length - 1) {
      lines.push(border("├", "┼", "┤"));
    }
  });
  lines.push(border("└", "┴", "┘"));
  return lines.join("\n");
}

function longestWordWidth(value, limit) {
  return Math.min(
    limit,
    Math.max(...String(value || "").split(/\s+/).map((word) => textWidth(word)), 1),
  );
}

export function codeOpenLabel(label) {
  return label ? `┌ code ${label}` : "┌ code";
}

import { paintRaw } from "./theme.js";

export function styled(text, color, style) {
  if (!text || !color || !style) {
    return text;
  }
  const roles = {
    codeBlock: "fence",
    emphasis: "warning",
    heading: "accent",
    inlineCode: "code",
    tableHeader: "accent",
  };
  const role = roles[style] || "warning";
  const painted = paintRaw[role](text);
  return style === "heading" || style === "tableHeader" || style === "emphasis"
    ? paintRaw.bold(painted)
    : painted;
}

export function dim(text, color) {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}
