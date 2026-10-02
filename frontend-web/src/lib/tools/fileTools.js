// Formatters for the file tools: read_file, write_file, edit_file, grep, glob.
// Each returns the row model `{kind, verb, target, targetIsPath, meta, body,
// openFile}`; the shared status/error handling lives in toolDisplay.js.
import { CAPS, meta } from "./caps.js";
import { firstText, plural, textLines } from "./parse.js";

export function filePath(args, parts) {
  const metaFile = Array.isArray(parts.meta.files) ? parts.meta.files[0]?.path : "";
  return firstText(args.path, args.file_path, parts.meta.path, metaFile);
}

export function formatReadFile(tool, args, parts) {
  const path = filePath(args, parts);
  return {
    kind: "read",
    verb: "Read",
    target: path,
    targetIsPath: true,
    meta: meta(readRange(args, parts)),
    body: null, // never the file contents; the row opens the Files tab instead
    openFile: path || "",
  };
}

function readRange(args, parts) {
  const offset = Number(parts.meta.offset ?? args.offset);
  const next = Number(parts.meta.next_offset);
  if (Number.isFinite(offset) && offset > 0 && Number.isFinite(next) && next > offset) return `L${offset}-${next - 1}`;
  const count = textLines(parts.text).length;
  if (count) return plural(count, "line");
  const limit = Number(args.limit);
  if (Number.isFinite(offset) && offset > 0) return Number.isFinite(limit) && limit > 0 ? `L${offset}-${offset + limit - 1}` : `from L${offset}`;
  return "";
}

export function formatWriteFile(tool, args, parts) {
  const path = filePath(args, parts);
  const stats = changeStats(tool, parts);
  const content = typeof args.content === "string" ? args.content : "";
  const lines = textLines(content);
  const added = stats.length ? stats.reduce((sum, file) => sum + file.added, 0) : lines.length;
  const diff = diffText(tool, parts);
  const body = lines.length
    ? { type: "code", lines, ...CAPS.code }
    : diff ? { type: "diff", diff, ...CAPS.diff } : null;
  return {
    kind: "write",
    verb: "Wrote",
    target: path,
    targetIsPath: true,
    meta: added ? meta(`+${added}`, "success") : [],
    body,
    change: { added, removed: 0 },
  };
}

export function formatEditFile(tool, args, parts) {
  const path = filePath(args, parts);
  const stats = changeStats(tool, parts);
  const added = stats.reduce((sum, file) => sum + file.added, 0);
  const removed = stats.reduce((sum, file) => sum + file.removed, 0);
  const diff = diffText(tool, parts);
  // While arguments stream the diff does not exist yet: show the new text.
  const streamed = typeof args.new_string === "string" ? textLines(args.new_string) : [];
  const body = diff
    ? { type: "diff", diff, ...CAPS.diff }
    : streamed.length && tool?.status === "running" ? { type: "code", lines: streamed, ...CAPS.code } : null;
  const counts = added || removed ? [...meta(`+${added}`, "success"), ...meta(`-${removed}`, "danger")] : [];
  return {
    kind: "edit",
    verb: "Edited",
    target: path,
    targetIsPath: true,
    meta: counts,
    body,
    change: { added, removed },
  };
}

export function formatGrep(tool, args, parts) {
  const pattern = firstText(args.pattern, parts.meta.pattern);
  const hits = parts.list.length ? parts.list : textHits(parts.text);
  const done = tool?.status !== "running";
  const count = Number(parts.meta.count ?? parts.meta.matches);
  const matches = Number.isFinite(count) && count >= 0 ? count : hits.length;
  const files = groupHits(hits);
  let metaText = "";
  if (done && !matches) metaText = "No matches";
  else if (done) metaText = `${plural(matches, "match", "matches")} in ${plural(files.length || 1, "file")}`;
  const items = files.map((file) => ({ title: file.file, detail: plural(file.lines.length, "match", "matches"), lines: file.lines }));
  return {
    kind: "search",
    verb: "Searched",
    target: pattern,
    meta: meta(metaText),
    body: items.length ? { type: "list", items, pathTitles: true, ...CAPS.list } : null,
  };
}

function textHits(text) {
  return textLines(text).map((line) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    return match ? { file: match[1], line: Number(match[2]), text: match[3] } : null;
  }).filter(Boolean);
}

function groupHits(hits) {
  const order = [];
  const byFile = new Map();
  for (const hit of hits) {
    const file = String(hit?.file || hit?.path || "");
    if (!file) continue;
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    const text = String(hit?.text ?? "").replace(/\t/g, " ").trim();
    byFile.set(file, [...byFile.get(file), `${hit?.line ?? ""}: ${text}`]);
  }
  return order.map((file) => ({ file, lines: byFile.get(file) }));
}

export function formatGlob(tool, args, parts) {
  const pattern = firstText(args.pattern, parts.meta.pattern);
  const paths = (parts.list.length ? parts.list : textLines(parts.text))
    .map((item) => String(item?.path ?? item ?? ""))
    .filter(Boolean);
  const count = Number(parts.meta.count);
  const total = Number.isFinite(count) && count >= 0 ? count : paths.length;
  const done = tool?.status !== "running";
  return {
    kind: "search",
    verb: "Found",
    target: pattern,
    meta: meta(done ? (total ? plural(total, "file") : "No files") : ""),
    body: paths.length ? { type: "list", items: paths.map((path) => ({ title: path })), pathTitles: true, ...CAPS.list } : null,
  };
}

// Unified diff text from meta.files, else the +/- lines of the file_change event.
export function diffText(tool, parts) {
  const files = Array.isArray(parts.meta.files) ? parts.meta.files : [];
  const diffs = files.map((file) => String(file?.diff || "")).filter(Boolean);
  if (diffs.length) return diffs.join("\n");
  const lines = Array.isArray(tool?.fileChange?.lines) ? tool.fileChange.lines : [];
  return lines
    .map((change) => `${change?.kind === "added" ? "+" : change?.kind === "removed" ? "-" : " "}${change?.text ?? ""}`)
    .join("\n");
}

// Files touched with +/- counts: meta.files entries, else counted from the diff.
export function changeStats(tool, parts) {
  const files = Array.isArray(parts.meta.files) ? parts.meta.files : [];
  if (files.length) {
    return files
      .map((file) => ({ path: String(file?.path || ""), added: Number(file?.added_lines) || 0, removed: Number(file?.removed_lines) || 0 }))
      .filter((file) => file.path);
  }
  const diff = diffText(tool, parts);
  const path = String(tool?.file || "");
  if (!diff) return path ? [{ path, added: 0, removed: 0 }] : [];
  const counted = diff.split("\n").reduce((acc, line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return acc;
    if (line.startsWith("+")) return { ...acc, added: acc.added + 1 };
    if (line.startsWith("-")) return { ...acc, removed: acc.removed + 1 };
    return acc;
  }, { added: 0, removed: 0 });
  return [{ path, ...counted }];
}
