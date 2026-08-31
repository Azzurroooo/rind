export function MarkdownContent({ value, className = "" }) {
  const blocks = parseBlocks(value);
  return <div className={`message-content markdown-content ${className}`.trim()}>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function parseBlocks(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const fence = lines[index].match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1], value: code.join("\n") });
      continue;
    }
    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, value: heading[2] });
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (isTableHeader(lines[index], lines[index + 1])) {
      const rows = [splitTableRow(lines[index])];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    const list = lines[index].match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/);
        if (!item || /^\d/.test(item[2]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      blocks.push({ type: ordered ? "ordered-list" : "unordered-list", items });
      continue;
    }
    const quote = lines[index].match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      const values = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!item) break;
        values.push(item[1]);
        index += 1;
      }
      blocks.push({ type: "quote", value: values.join("\n") });
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && isBlockStart(lines, index)) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", value: paragraph.join("\n") });
  }
  return blocks;
}

function isBlockStart(lines, index) {
  return /^\s*```/.test(lines[index]) || /^\s{0,3}#{1,6}\s+/.test(lines[index]) || /^\s{0,3}>/.test(lines[index]) || /^(\s*)([-*+]\s+|\d+\.\s+)/.test(lines[index]) || isTableHeader(lines[index], lines[index + 1]);
}

function isTableHeader(header, separator) {
  if (!header || !separator || !header.includes("|") || !separator.includes("|")) return false;
  const cells = splitTableRow(separator);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(value) {
  let row = String(value || "").trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function renderBlock(block, key) {
  if (block.type === "code") return <pre className="markdown-code" key={key}><code data-language={block.language || undefined}>{block.value}</code></pre>;
  if (block.type === "heading") {
    const Tag = `h${Math.min(6, block.level)}`;
    return <Tag key={key}>{renderInline(block.value)}</Tag>;
  }
  if (block.type === "rule") return <hr key={key} />;
  if (block.type === "unordered-list" || block.type === "ordered-list") {
    const Tag = block.type === "ordered-list" ? "ol" : "ul";
    return <Tag key={key}>{block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</Tag>;
  }
  if (block.type === "quote") return <blockquote key={key}>{block.value.split("\n").map((line, index) => <span key={index}>{renderInline(line)}{index < block.value.split("\n").length - 1 && <br />}</span>)}</blockquote>;
  if (block.type === "table") return <table key={key}><thead><tr>{block.rows[0].map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{block.rows[0].map((_, index) => <td key={index}>{renderInline(row[index] || "")}</td>)}</tr>)}</tbody></table>;
  return <p key={key}>{block.value.split("\n").map((line, index) => <span key={index}>{renderInline(line)}{index < block.value.split("\n").length - 1 && <br />}</span>)}</p>;
}

function renderInline(value) {
  const source = String(value || "");
  const pattern = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g;
  const children = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) children.push(source.slice(last, match.index));
    if (match[0].startsWith("`") ) children.push(<code key={match.index}>{match[0].slice(1, -1)}</code>);
    else if (match[2]) children.push(<a key={match.index} href={safeHref(match[3])} target="_blank" rel="noreferrer">{renderInline(match[2])}</a>);
    else if (match[4] || match[5]) children.push(<strong key={match.index}>{renderInline(match[4] || match[5])}</strong>);
    else if (match[6]) children.push(<del key={match.index}>{renderInline(match[6])}</del>);
    else children.push(<em key={match.index}>{renderInline(match[7] || match[8])}</em>);
    last = match.index + match[0].length;
  }
  if (last < source.length) children.push(source.slice(last));
  return children;
}

function safeHref(value) {
  const href = String(value || "").trim();
  if (!href) return "#";
  try {
    const parsed = new URL(href, window.location.href);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol) || href.startsWith("#") || href.startsWith("/")) return parsed.href;
  } catch {
    return "#";
  }
  return "#";
}
