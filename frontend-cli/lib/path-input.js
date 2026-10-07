import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

// Folder inputs accept absolute paths, ~ and paths relative to where the user
// opened Rind. The service runs elsewhere, so the client always resolves.
export function resolveInputPath(input, base = process.cwd(), platform = process.platform) {
  const text = String(input || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (/^~[\\/]/.test(text)) return path.join(os.homedir(), text.slice(2));
  // "C:" alone means the current folder of drive C to Windows; people mean the drive.
  if (platform === "win32" && /^[A-Za-z]:$/.test(text)) return path.win32.resolve(text + "\\");
  return path.resolve(base, text);
}

const SEPARATOR = /[\\/]/;
const lastSeparator = text => Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));

// Directory names completing the last segment of `input`, most likely first.
// Values keep the user's own prefix (~, relative or absolute) and end with a
// separator so another Tab descends into the folder.
export async function folderSuggestions(input, base = process.cwd(), limit = 8) {
  const text = String(input || "");
  const cut = lastSeparator(text);
  const head = cut >= 0 ? text.slice(0, cut + 1) : "";
  const partial = cut >= 0 ? text.slice(cut + 1) : text;
  if (text === "~") return [{ name: "~", value: "~" + path.sep }];
  const directory = resolveInputPath(head || ".", base);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const lower = partial.toLowerCase();
  const separator = head.match(SEPARATOR)?.[0] || path.sep;
  return entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .filter(entry => (partial.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().startsWith(lower))
    .sort((a, b) => Number(!a.name.startsWith(partial)) - Number(!b.name.startsWith(partial)) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(entry => ({ name: entry.name, value: head + entry.name + separator }));
}

// Longest prefix shared by every suggestion, for a shell-style Tab.
export function commonCompletion(input, suggestions) {
  if (!suggestions.length) return input;
  if (suggestions.length === 1) return suggestions[0].value;
  let prefix = suggestions[0].value;
  for (const { value } of suggestions) while (!value.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  return prefix.length > String(input).length ? prefix : input;
}

export async function inspectFolder(input, base = process.cwd()) {
  const resolved = resolveInputPath(input, base);
  if (!resolved) return { path: "", kind: "empty" };
  try {
    if (!(await stat(resolved)).isDirectory()) return { path: resolved, kind: "file" };
  } catch { return { path: resolved, kind: "missing" }; }
  const git = await stat(path.join(resolved, ".git")).then(() => true, () => false);
  return { path: resolved, kind: "folder", git };
}

// Folder names created by the service must be a single plain segment.
export function checkFolderName(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  if (!/^[\p{L}\p{N}_.-]+$/u.test(text) || text === "." || text === "..") return "Use letters, numbers, - _ or . (no slashes or spaces).";
  return "";
}
