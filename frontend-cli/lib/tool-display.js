import { clipCells } from "./text-width.js";

const ACCENT_CODE = "38;5;81";
const GREEN_CODE = "38;5;113";
const RED_CODE = "38;5;203";

function stylize(text, code) {
  if (!text) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function accent(text) {
  return stylize(text, ACCENT_CODE);
}

function green(text) {
  return stylize(text, GREEN_CODE);
}

function red(text) {
  return stylize(text, RED_CODE);
}

function dim(text) {
  return text ? `\x1b[2m${text}\x1b[0m` : text;
}

function bold(text) {
  return text ? `\x1b[1m${text}\x1b[0m` : text;
}

const COLLAPSED_BODY_CAPS = {
  bash: 5,
  bash_output: 5,
  edit_file: 20,
  write_file: 20,
  grep: 0,
  glob: 0,
  delegate: 1,
};

const EXPANDED_HARD_CAPS = {
  bash: 400,
  bash_output: 400,
  edit_file: 400,
  write_file: 400,
  grep: 200,
  glob: 200,
  read_file: 40,
  fetch_web_page: 24,
  delegate: 24,
  search_web: 16,
};

const ELAPSED_TITLE_TOOLS = new Set(["bash", "bash_output", "delegate", "search_web", "fetch_web_page"]);
const DURATION_TITLE_TOOLS = new Set(["bash", "bash_output", "delegate"]);

export function parseToolArguments(event) {
  if (event && typeof event.arguments === "object" && event.arguments !== null) {
    return event.arguments;
  }
  try {
    const parsed = JSON.parse(String(event?.args_preview || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseToolResult(result) {
  try {
    const parsed = JSON.parse(String(result || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

// Blocks created from argless events (bare announce, session replay) can
// recover their key arguments from the result payload at finish time.
export function argsFromResult(name, result) {
  const { data = {}, meta = {} } = resultDataFromRaw(result);
  const derived = {};
  const put = (key, value) => {
    if (value !== undefined && value !== null && value !== "" && derived[key] === undefined) {
      derived[key] = value;
    }
  };
  switch (name) {
    case "read_file":
      put("path", meta.path);
      break;
    case "write_file":
    case "edit_file":
      put("file_path", Array.isArray(meta.files) ? meta.files[0]?.path : undefined);
      break;
    case "glob":
      put("pattern", meta.pattern);
      put("path", meta.path);
      break;
    case "grep":
      put("pattern", meta.pattern);
      put("path", meta.path);
      put("glob", meta.glob);
      break;
    case "search_web":
      put("query", meta.query);
      break;
    case "fetch_web_page":
      put("url", meta.url);
      break;
    case "bash_output":
      put("bg_id", data.bg_id);
      break;
    case "delegate":
      put("agent_id", data.agent_id);
      break;
    case "skill":
    case "skill_create":
      put("name", data.name);
      break;
    case "agent_create":
      put("name", data.name);
      put("agent_id", data.agent_id);
      break;
    default:
      break;
  }
  return derived;
}

function resultDataFromRaw(result) {
  const payload = parseToolResult(result);
  return {
    payload,
    data: payload.data && typeof payload.data === "object" ? payload.data : {},
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
  };
}

export function renderToolRunning(context, width) {
  const renderer = TOOL_RENDERERS[context.name] || GENERIC_RENDERER;
  const elapsedSeconds = Math.floor((context.elapsedMs || 0) / 1000);
  const elapsed = ELAPSED_TITLE_TOOLS.has(context.name) ? dim(` · ${elapsedSeconds}s`) : "";
  const lines = [
    clipCells(`${runningGlyph()} ${renderer.runningMain(context, width)}${elapsed}`, Math.max(1, width)),
  ];
  if (context.progressMessage) {
    lines.push(dim(`    ↳ ${clipText(context.progressMessage, width, 8)}`));
  }
  return lines;
}

export function renderToolFinished(context, width) {
  const renderer = TOOL_RENDERERS[context.name] || GENERIC_RENDERER;
  const state = finishState(context.event);
  const lines = [clipCells(renderer.finished(context, width, state), Math.max(1, width))];
  if (state.kind === "error") {
    const detail = errorDetail(context.event, width);
    if (detail) {
      lines.push(detail);
    }
    return lines;
  }
  const bodyLimit = context.expanded ? EXPANDED_HARD_CAPS[context.name] ?? 200 : COLLAPSED_BODY_CAPS[context.name] ?? 0;
  const produced = renderer.body ? renderer.body(context, width, bodyLimit) : [];
  const normalized = normalizeBody(produced);
  if (!normalized.lines.length) {
    if (normalized.total > 0) {
      lines.push(bodyFooter(normalized.total, context.expanded));
    }
    return lines;
  }
  lines.push(...normalized.lines);
  const hidden = Math.max(0, normalized.total - normalized.lines.length);
  if (hidden > 0) {
    lines.push(bodyFooter(hidden, context.expanded));
  }
  return lines;
}

function normalizeBody(produced) {
  if (Array.isArray(produced)) {
    return { lines: produced, total: produced.length };
  }
  return {
    lines: Array.isArray(produced?.lines) ? produced.lines : [],
    total: Number.isFinite(produced?.total) ? produced.total : (Array.isArray(produced?.lines) ? produced.lines.length : 0),
  };
}

function finishState(event) {
  const status = String(event?.status || "completed");
  if (status === "completed") {
    return { kind: "ok", status };
  }
  if (status === "cancelled") {
    return { kind: "cancelled", status };
  }
  return { kind: "error", status };
}

function runningGlyph() {
  return accent("◌");
}

function okGlyph() {
  return green("◉");
}

function errorGlyph() {
  return red("⊘");
}

function cancelledGlyph() {
  return dim("◌");
}

function titleFor(state, main) {
  if (state.kind === "error") {
    return `${errorGlyph()} ${main}`;
  }
  if (state.kind === "cancelled") {
    return `${cancelledGlyph()} ${main} ${dim("(cancelled)")}`;
  }
  return `${okGlyph()} ${main}`;
}

function durationPart(name, event) {
  if (!DURATION_TITLE_TOOLS.has(name)) {
    return "";
  }
  return dim(` · ${formatDuration(event?.duration_ms)}`);
}

function formatDuration(durationMs) {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0ms";
  }
  if (value < 1000) {
    return `${Math.trunc(value)}ms`;
  }
  if (value >= 60000) {
    const totalSeconds = Math.round(value / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}m ${seconds}s`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function clipText(value, width, reserve = 4) {
  return clipCells(singleLineText(value), Math.max(1, width - reserve));
}

function singleLineText(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function bodyFooter(hidden, expanded) {
  const hint = expanded ? "" : " · ctrl+o to expand";
  return dim(`    … (${hidden} more lines${hint})`);
}

function errorDetail(event, width) {
  const payload = parseToolResult(event?.result);
  const message = singleLineText(payload.error || event?.error_type || "");
  return message ? dim(`    ↳ ${clipText(message, width, 8)}`) : "";
}

function resultData(context) {
  const payload = parseToolResult(context.event?.result);
  return {
    payload,
    data: payload.data && typeof payload.data === "object" ? payload.data : {},
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
  };
}

function shellOutputLines(context, limit) {
  const { payload, data, meta } = resultData(context);
  const combined = `${data.stdout || ""}\n${data.stderr || ""}`;
  const all = combined.split(/\r\n|\r|\n/).map((line) => line.replace(/\t/g, "  "));
  while (all.length && !all.at(-1).trim()) {
    all.pop();
  }
  const lines = all.slice(-limit).map((line) => dim(`    ${clipText(line, context.width ?? 80, 6)}`));
  if (meta.truncated && meta.total_bytes) {
    lines.push(dim(`    … output truncated (${Number(meta.total_bytes)} bytes total)`));
  }
  return { lines, total: all.length };
}

function diffCountSuffix(context) {
  let added = 0;
  let removed = 0;
  const changes = Array.isArray(context.fileChange?.lines) ? context.fileChange.lines : [];
  if (changes.length) {
    for (const change of changes) {
      if (change?.kind === "added") added += 1;
      else if (change?.kind === "removed") removed += 1;
    }
  } else {
    const { meta } = resultData(context);
    const files = Array.isArray(meta.files) ? meta.files : [];
    for (const file of files) {
      added += Number(file?.added_lines) || 0;
      removed += Number(file?.removed_lines) || 0;
    }
  }
  if (!added && !removed) {
    return "";
  }
  return `${dim(" (")}${green(`+${added}`)} ${red(`-${removed}`)}${dim(")")}`;
}

function diffBodyLines(context, limit) {
  const changes = Array.isArray(context.fileChange?.lines)
    ? context.fileChange.lines.map((change) => ({ kind: change?.kind, text: String(change?.text ?? "") }))
    : unifiedDiffLines(context);
  return {
    lines: changes.slice(0, limit).map((change) => diffLine(change, context.width ?? 80)),
    total: changes.length,
  };
}

function unifiedDiffLines(context) {
  const { meta } = resultData(context);
  const files = Array.isArray(meta.files) ? meta.files : [];
  const lines = [];
  for (const file of files) {
    for (const raw of String(file?.diff || "").split(/\r\n|\r|\n/)) {
      if (!raw || raw.startsWith("---") || raw.startsWith("+++")) {
        continue;
      }
      const kind = raw.startsWith("+") ? "added" : raw.startsWith("-") ? "removed" : "context";
      lines.push({ kind, text: raw.slice(1) });
    }
  }
  return lines;
}

function diffLine(change, width) {
  const added = change.kind === "added";
  const removed = change.kind === "removed";
  const marker = added ? "+" : removed ? "-" : " ";
  const style = added ? green : removed ? red : (text) => dim(text);
  return `${dim(`    ${marker} `)}${style(clipText(change.text, width, 8))}`;
}

function matchCount(context, key = "count") {
  const { payload, meta } = resultData(context);
  const explicit = Number(meta[key]);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return Array.isArray(payload.data) ? payload.data.length : 0;
}

const BASH_RENDERER = {
  runningMain(context, width) {
    return `${bold("$")} ${commandArg(context.args.command, width, 8)}`;
  },
  finished(context, width, state) {
    const command = commandArg(context.args.command, width, 12);
    const { data } = resultData(context);
    if (state.kind === "ok" && String(data.status) === "running") {
      return `${runningGlyph()} ${bold("$")} ${command}`;
    }
    let main = `${bold("$")} ${command}`;
    const exitCode = Number(data.exit_code);
    if (state.kind !== "cancelled" && Number.isInteger(exitCode) && exitCode !== 0) {
      main += ` ${red(`exit ${exitCode}`)}`;
    }
    return titleFor(state, main) + durationPart("bash", context.event);
  },
  body(context, width, limit) {
    const { data } = resultData(context);
    if (String(data.status) === "running") {
      const bgId = singleLineText(data.bg_id);
      const line = bgId ? `command running in background (bg ${bgId})` : "command running in background";
      return [dim(`    ↳ ${clipText(line, width, 8)}`)];
    }
    return shellOutputLines(context, limit);
  },
};

const BASH_OUTPUT_RENDERER = {
  runningMain(context, width) {
    return `${bold("bg")} ${bgIdArg(context.args.bg_id, width, 10)}`;
  },
  finished(context, width, state) {
    const { data } = resultData(context);
    const id = context.args.bg_id || data.bg_id;
    let main = `${bold("bg")} ${bgIdArg(id, width, 14)}`;
    if (state.kind === "cancelled") {
      main += ` ${dim("(cancelled)")}`;
    }
    const waitMs = Number(data.wait_ms ?? data.elapsed_ms);
    const waited = state.kind === "ok" && Number.isFinite(waitMs) && waitMs > 0
      ? dim(` · waited ${formatDuration(waitMs)}`)
      : "";
    return titleFor(state, main) + waited + durationPart("bash_output", context.event);
  },
  body(context, width, limit) {
    return shellOutputLines(context, limit);
  },
};

const READ_RENDERER = {
  runningMain(context, width) {
    return `read ${accentPath(context.args.path || context.args.file_path, width, 10)}`;
  },
  finished(context, width, state) {
    const range = readRange(context.args);
    const main = `read ${accentPath(context.args.path || context.args.file_path, width, 18)}${range}`;
    if (state.kind !== "ok") {
      return titleFor(state, main);
    }
    const { meta } = resultData(context);
    const morePages = meta.truncated || (meta.next_offset !== undefined && meta.next_offset !== null);
    return titleFor(state, morePages ? `${main} ${dim("(more pages)")}` : main);
  },
  body(context, width, limit) {
    if (limit <= 0) {
      return { lines: [], total: 0 };
    }
    const { payload } = resultData(context);
    const content = typeof payload.data === "string" ? payload.data : "";
    const lines = content.split(/\r\n|\r|\n/).filter((line) => line.trim());
    return {
      lines: lines.slice(0, limit).map((line) => dim(`    ${clipText(line, width, 6)}`)),
      total: lines.length,
    };
  },
};

function readRange(args) {
  const offset = Number(args.offset);
  if (!Number.isFinite(offset) || offset <= 0) {
    return "";
  }
  const limit = Number(args.limit);
  return dim(`:${offset}${Number.isFinite(limit) && limit > 0 ? `-${offset + limit}` : "+"}`);
}

function mutationRenderer(verb) {
  return {
    runningMain(context, width) {
      return `${verb} ${accentPath(context.args.file_path, width, 10)}`;
    },
    finished(context, width, state) {
      const main = `${verb} ${accentPath(context.args.file_path, width, 18)}${diffCountSuffix(context)}`;
      return titleFor(state, main);
    },
    body(context, width, limit) {
      return diffBodyLines(context, limit);
    },
  };
}

const GREP_RENDERER = {
  runningMain(context, width) {
    return searchTitle(context, width);
  },
  finished(context, width, state) {
    const base = searchTitle(context, width);
    const count = matchCount(context);
    return titleFor(state, count ? `${base} ${dim(`· ${count} matches`)}` : base);
  },
  body(context, width, limit) {
    const { payload } = resultData(context);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return {
      lines: rows.slice(0, limit).map((row) => dim(
        `    ${clipText(`${row?.file}:${row?.line}: ${String(row?.text ?? "").replace(/\t/g, " ")}`, width, 6)}`,
      )),
      total: rows.length,
    };
  },
};

function searchTitle(context, width) {
  const pattern = clipText(context.args.pattern, Math.max(12, Math.floor(width / 2)), 4);
  const location = context.args.path ? dim(` in ${clipText(context.args.path, Math.max(8, Math.floor(width / 3)), 4)}`) : "";
  const glob = context.args.glob ? dim(` (${clipText(context.args.glob, 24, 0)})`) : "";
  return `grep ${accent(`/${pattern}/`)}${location}${glob}`;
}

const GLOB_RENDERER = {
  runningMain(context, width) {
    return globTitle(context, width);
  },
  finished(context, width, state) {
    const base = globTitle(context, width);
    const count = matchCount(context);
    return titleFor(state, count ? `${base} ${dim(`· ${count} matches`)}` : base);
  },
  body(context, width, limit) {
    const { payload } = resultData(context);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return {
      lines: rows.slice(0, limit).map((row) => dim(`    ${clipText(row?.path, width, 6)}`)),
      total: rows.length,
    };
  },
};

function globTitle(context, width) {
  const pattern = clipText(context.args.pattern, Math.max(12, Math.floor(width / 2)), 4);
  const location = context.args.path ? dim(` in ${clipText(context.args.path, Math.max(8, Math.floor(width / 3)), 4)}`) : "";
  return `glob ${accent(pattern)}${location}`;
}

const SEARCH_WEB_RENDERER = {
  runningMain(context, width) {
    return `search ${quoteArg(context.args.query, width)}`;
  },
  finished(context, width, state) {
    const base = `search ${quoteArg(context.args.query, width)}`;
    const count = matchCount(context, "matches");
    return titleFor(state, count ? `${base} ${dim(`· ${count} results`)}` : base);
  },
  body(context, width, limit) {
    const { payload } = resultData(context);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const maxEntries = Math.ceil(limit / 2);
    const lines = [];
    for (const row of rows.slice(0, maxEntries)) {
      lines.push(`    ${clipText(row?.title, width, 6)}`);
      lines.push(dim(`    ${clipText(row?.url, width, 6)}`));
      if (lines.length >= limit) {
        break;
      }
    }
    return { lines: lines.slice(0, limit), total: rows.length * 2 };
  },
};

const FETCH_WEB_PAGE_RENDERER = {
  runningMain(context, width) {
    return `fetch ${accent(clipText(context.args.url, width, 10))}`;
  },
  finished(context, width, state) {
    const { payload, meta } = resultData(context);
    const size = typeof payload.data === "string" && payload.data ? dim(` · ${payload.data.length} chars`) : "";
    const truncated = meta.truncated ? dim(" · truncated") : "";
    return titleFor(state, `fetch ${accent(clipText(context.args.url, width, 14))}${size}${truncated}`);
  },
  body(context, width, limit) {
    const { payload } = resultData(context);
    const content = typeof payload.data === "string" ? payload.data : "";
    const lines = content.split(/\r\n|\r|\n/).filter((line) => line.trim());
    return {
      lines: lines.slice(0, limit).map((line) => dim(`    ${clipText(line, width, 6)}`)),
      total: lines.length,
    };
  },
};

const DELEGATE_RENDERER = {
  runningMain(context, width) {
    return `delegate → ${agentArg(context.args.agent_id, width)}`;
  },
  finished(context, width, state) {
    const { data } = resultData(context);
    const status = singleLineText(data.status) || (state.kind === "ok" ? "completed" : "");
    const agentId = context.args.agent_id || data.agent_id;
    const main = `delegate → ${agentArg(agentId, width)}${status ? dim(` · ${status}`) : ""}`;
    return titleFor(state, main) + durationPart("delegate", context.event);
  },
  body(context, width, limit) {
    const { data } = resultData(context);
    const summaryLines = String(data.summary || "").split(/\r\n|\r|\n/).filter((line) => line.trim());
    const lines = summaryLines.slice(0, limit).map((line) => dim(`    ${clipText(line, width, 6)}`));
    const published = Array.isArray(data.published_paths) ? data.published_paths.length : 0;
    if (published && lines.length < limit) {
      lines.push(dim(`    published ${published} path${published === 1 ? "" : "s"}`));
    }
    return { lines, total: summaryLines.length + (published ? 1 : 0) };
  },
};

const AGENT_CREATE_RENDERER = {
  runningMain(context, width) {
    return `agent-create ${agentArg(context.args.name || context.args.agent_id, width)}`;
  },
  finished(context, width, state) {
    const { data } = resultData(context);
    const root = singleLineText(data.workspace_root);
    const name = agentArg(context.args.name || data.agent_id, width);
    const rootPart = root ? dim(` · ${clipText(root, Math.max(8, width - 24), 0)}`) : "";
    return titleFor(state, `agent-create ${name}${rootPart}`);
  },
};

function skillRenderer(verb) {
  return {
    runningMain(context, width) {
      return `${verb} ${agentArg(context.args.name, width)}`;
    },
    finished(context, width, state) {
      const { data } = resultData(context);
      const path = singleLineText(data.path);
      const pathPart = path ? dim(` · ${clipText(path, Math.max(8, width - 16), 0)}`) : "";
      const overwritten = data.overwritten ? dim(" · overwritten") : "";
      const name = agentArg(context.args.name || data.name, width);
      return titleFor(state, `${verb} ${name}${pathPart}${overwritten}`);
    },
  };
}

const GENERIC_RENDERER = {
  runningMain(context, width) {
    const label = humanToolName(context.name);
    const arg = firstKeyArg(context.args, width);
    return `${label}${arg ? ` ${arg}` : ""}`;
  },
  finished(context, width, state) {
    const label = humanToolName(context.name);
    const arg = firstKeyArg(context.args, width);
    return titleFor(state, `${label}${arg ? ` ${dim(arg)}` : ""}`);
  },
};

function humanToolName(name) {
  return String(name || "tool").replace(/[_-]+/g, " ").trim() || "tool";
}

function firstKeyArg(args, width) {
  for (const key of ["file_path", "path", "query", "url", "pattern", "command", "bg_id", "name", "agent_id"]) {
    const value = singleLineText(args?.[key]);
    if (value) {
      return clipText(value, width, 8);
    }
  }
  return "";
}

function accentPath(value, width, reserve) {
  const text = singleLineText(value);
  return text ? accent(clipText(text, width, reserve)) : dim("…");
}

function agentArg(value, width) {
  const text = singleLineText(value);
  return text ? accent(clipText(text, Math.min(32, width), 0)) : dim("…");
}

function quoteArg(value, width) {
  const text = singleLineText(value);
  return `"${text ? clipText(text, width, 8) : ""}"`;
}

function commandArg(value, width, reserve) {
  const text = singleLineText(value);
  return text ? clipText(text, width, reserve) : dim("…");
}

function bgIdArg(value, width, reserve) {
  const text = singleLineText(value);
  return text ? clipText(text, width, reserve) : dim("…");
}

export const TOOL_RENDERERS = {
  bash: BASH_RENDERER,
  bash_output: BASH_OUTPUT_RENDERER,
  read_file: READ_RENDERER,
  edit_file: mutationRenderer("edit"),
  write_file: mutationRenderer("write"),
  grep: GREP_RENDERER,
  glob: GLOB_RENDERER,
  search_web: SEARCH_WEB_RENDERER,
  fetch_web_page: FETCH_WEB_PAGE_RENDERER,
  delegate: DELEGATE_RENDERER,
  agent_create: AGENT_CREATE_RENDERER,
  skill: skillRenderer("skill"),
  skill_create: skillRenderer("skill-create"),
};
