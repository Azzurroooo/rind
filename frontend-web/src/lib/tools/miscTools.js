// Formatters for web, creation, goal and unknown tools.
import { CAPS, meta } from "./caps.js";
import { firstLine, firstText, plural, singleLine, textLines, urlParts } from "./parse.js";

const GENERIC_VALUE_MAX = 160;
const FETCH_PARAGRAPH_LINES = 6;

export function formatSearchWeb(tool, args, parts) {
  const results = parts.list.filter((item) => item && typeof item === "object");
  const count = Number(parts.meta.matches ?? parts.meta.count);
  const total = Number.isFinite(count) && count >= 0 ? count : results.length;
  const done = tool?.status !== "running";
  const items = results.map((item) => ({
    title: singleLine(item.title) || singleLine(item.url),
    detail: urlParts(item.url).domain,
    href: /^https?:\/\//i.test(String(item.url || "")) ? String(item.url) : "",
  }));
  return {
    kind: "web",
    verb: "Searched the web",
    target: firstText(args.query, args.search, parts.meta.query),
    meta: meta(done ? (total ? plural(total, "result") : "No results") : ""),
    body: items.length ? { type: "list", items, ...CAPS.web } : null,
  };
}

export function formatFetchWebPage(tool, args, parts) {
  const url = firstText(args.url, parts.meta.url);
  const { domain, path } = urlParts(url);
  const lines = textLines(parts.text);
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
  const title = firstText(parts.meta.title, heading ? heading.replace(/^#+\s+/, "") : "");
  const paragraph = firstParagraph(lines, heading);
  const body = title || paragraph.length
    ? { type: "text", title, lines: paragraph, cap: FETCH_PARAGRAPH_LINES, expandedCap: FETCH_PARAGRAPH_LINES }
    : null;
  return {
    kind: "fetch",
    verb: "Read",
    target: `${domain}${path}`,
    targetLabel: domain,
    mono: true,
    meta: meta(title),
    body,
    href: /^https?:\/\//i.test(url) ? url : "",
  };
}

// First prose paragraph: skip headings, images and link-only lines.
function firstParagraph(lines, heading) {
  const start = heading ? lines.indexOf(heading) + 1 : 0;
  const rest = lines.slice(start);
  const begin = rest.findIndex((line) => line.trim() && !/^(#|!\[|\[[^\]]*\]\([^)]*\)\s*$|[-*_]{3,}\s*$)/.test(line.trim()));
  if (begin < 0) return [];
  const after = rest.slice(begin);
  const end = after.findIndex((line) => !line.trim());
  return (end < 0 ? after : after.slice(0, end)).slice(0, FETCH_PARAGRAPH_LINES);
}

export function formatCreate(noun) {
  return (tool, args, parts) => {
    const { record } = parts;
    const name = firstText(args.name, record.name, record.agent_id);
    const about = firstLine(args.role || args.description || args.instructions || record.description || "");
    const rows = [
      ...(name ? [{ label: "name", value: name }] : []),
      ...(about ? [{ label: noun === "agent" ? "role" : "description", value: about }] : []),
    ];
    return {
      kind: "create",
      noun,
      verb: `Created ${noun}`,
      target: name,
      meta: [],
      body: rows.length ? { type: "kv", rows } : null,
    };
  };
}

export function formatSkill(tool, args, parts) {
  return {
    kind: "skill",
    verb: "Loaded skill",
    target: firstText(args.name, args.skill, parts.record.name),
    meta: [],
    body: null,
  };
}

export function formatUpdateGoal(tool, args, parts) {
  const { record } = parts;
  const goal = String(args.goal || args.objective || args.text || record.goal || record.objective || "").trim();
  return {
    kind: "goal",
    verb: "Updated goal",
    target: "",
    meta: meta(singleLine(args.status || record.status)),
    body: goal ? { type: "text", title: "", lines: textLines(goal), cap: CAPS.generic.cap, expandedCap: CAPS.generic.cap } : null,
  };
}

// Unknown tools: raw name, key/value arguments, capped result, raw JSON toggle.
export function formatGeneric(tool, args, parts) {
  const rows = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({ label, value: clip(typeof value === "string" ? singleLine(value) : JSON.stringify(value)) }));
  const output = parts.text ? textLines(parts.text) : parts.data !== undefined && parts.data !== null ? textLines(pretty(parts.data)) : [];
  const hasBody = rows.length || output.length;
  return {
    kind: "other",
    verb: String(tool?.name || "tool"),
    target: firstText(rows[0]?.value),
    mono: true,
    meta: [],
    body: hasBody
      ? { type: "kv", rows, output, ...CAPS.generic, raw: { args: pretty(tool?.args), result: pretty(tool?.result ?? tool?.output) } }
      : null,
  };
}

function clip(text) {
  const value = String(text ?? "");
  return value.length > GENERIC_VALUE_MAX ? `${value.slice(0, GENERIC_VALUE_MAX - 1)}…` : value;
}

function pretty(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
