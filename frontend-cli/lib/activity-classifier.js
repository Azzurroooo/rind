import { clipCells, middleClipCells } from "./text-width.js";

const TOOL_KINDS = new Map([
  ["read_file", "inspect"],
  ["view_image", "inspect"],
  ["list_directory", "inspect"],
  ["glob", "search"],
  ["grep", "search"],
  ["search_files", "search"],
  ["find", "search"],
  ["web_search", "research"],
  ["web_fetch", "research"],
  ["apply_patch", "change"],
  ["write", "change"],
  ["write_file", "change"],
  ["edit", "change"],
  ["bash_output", "run"],
]);

const CHECK_COMMAND = /(?:^|\s)(?:pytest|py\.test|npm\s+(?:test|run\s+(?:test|lint|build|check))|yarn\s+(?:test|lint|build)|pnpm\s+(?:test|lint|build)|cargo\s+(?:test|check|build|clippy)|go\s+test|(?:ruff|eslint|mypy|tsc|jest|vitest))(?:\s|$)/i;

export function classifyTool(name, argsPreview = "") {
  const toolName = String(name || "unknown").trim().toLowerCase();
  const explicit = TOOL_KINDS.get(toolName);
  if (explicit) {
    return explicit;
  }
  if (toolName === "bash" || toolName === "shell" || toolName === "exec" || toolName.includes("command")) {
    const args = parseArgsPreview(argsPreview);
    return CHECK_COMMAND.test(String(args.command || "")) ? "check" : "run";
  }
  if (/(?:test|lint|build|check|verify)/i.test(toolName)) {
    return "check";
  }
  if (/(?:search|grep|find|glob|list)/i.test(toolName)) {
    return "search";
  }
  if (/(?:read|view|inspect|stat)/i.test(toolName)) {
    return "inspect";
  }
  if (/(?:patch|write|edit|create|delete|move|rename)/i.test(toolName)) {
    return "change";
  }
  if (/(?:web|http|url|fetch|browse)/i.test(toolName)) {
    return "research";
  }
  return "note";
}

export function parseArgsPreview(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function activityTarget(name, argsPreview, kind = classifyTool(name, argsPreview)) {
  const args = parseArgsPreview(argsPreview);
  const path = firstValue(args, ["file_path", "path", "filename"]);
  const query = firstValue(args, ["query", "pattern", "search"]) || firstValue(args, ["command"]);
  const url = firstValue(args, ["url"]);
  if (kind === "run" || kind === "check") {
    return clipCells(firstValue(args, ["command", "cmd", "script", "bg_id"]) || humanName(name), 160);
  }
  if (kind === "search") {
    const scope = path || firstValue(args, ["directory", "cwd", "root"]);
    if (query && scope) {
      return clipCells(`${query} in ${middleClipCells(scope, 96)}`, 160);
    }
    return clipCells(query || scope || humanName(name), 160);
  }
  if (kind === "research") {
    return clipCells(url || query || humanName(name), 160);
  }
  if (kind === "change" || kind === "inspect") {
    return clipCells(path || url || query || humanName(name), 160);
  }
  return clipCells(path || query || url || humanName(name), 160);
}

export function humanToolName(name) {
  return String(name || "tool").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "tool";
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = String(object?.[key] || "").replace(/\s+/g, " ").trim();
    if (value) {
      return value;
    }
  }
  return "";
}
