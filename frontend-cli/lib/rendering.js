import { clipCells, middleClipCells, textWidth, wrapTextCells } from "./text-width.js";

const MAX_STARTUP_BANNER_WIDTH = 80;
const MAX_COMPOSER_WIDTH = 78;
const MAX_FILE_CHANGE_LINES = 20;

export function startupText(info = {}) {
  const header = startupBannerText(info);
  const preview = resumePreviewText(info.resume_preview);
  return preview ? `${header}\n\n${accent("•")} ${bold("Recent context")}\n${preview}` : header;
}

export function promptText(info = {}, _stats = {}, state = {}) {
  return inputPromptFrame(promptHeaderLine(info), state);
}

export function promptActivityLine(state = {}) {
  if (!state.running) {
    return "";
  }
  const elapsed = formatActivityDuration(state.elapsedMs);
  const label = singleLine(state.label) || "Working";
  return `  ${accent(activityFrame(state.frame))} ${bold(label)} ${dim(`(${elapsed}) ctrl+c interrupt`)}`;
}

export function promptPlaceholderText() {
  return "Ask Rind to do anything";
}

export function userInputText(text) {
  const lines = messageLines(text);
  if (!lines.length) {
    return "";
  }
  const contentWidth = userInputContentWidth();
  const physicalLines = lines.flatMap((line) => (
    wrapTextCells(line, contentWidth, contentWidth).map((chunk) => `  ${chunk.text}`)
  ));
  return `${accent("▷")} ${bold("You")}\n${physicalLines.join("\n")}`;
}

export function assistantHeaderText() {
  return `${accent("◁")} ${bold("Assistant")}`;
}

export function outputBlockText(text, leading = false) {
  const body = String(text || "").trimEnd();
  return body ? `${leading ? "\n" : ""}${body}\n` : "";
}

export function helpText(commands = []) {
  return [
    `${accent("•")} Controls`,
    helpRow("enter", "send message", "/", "open commands"),
    helpRow("↑ / ↓", "history", "← / →", "move cursor"),
    helpRow("home / end", "line edges", "del / backspace", "edit text"),
    helpRow("ctrl+c", "interrupt or quit", "?", "show shortcuts"),
    helpRow("ctrl+b", "background tasks", "esc", "close monitor"),
    "",
    `${accent("•")} Command deck`,
    ...commandDeckText(commands),
  ].join("\n");
}

export function slashDisplayText(display, commands = []) {
  if (!display || typeof display !== "object") {
    return "";
  }
  switch (display.type) {
    case "help":
      return slashHelpText(display, commands);
    case "status":
      return slashStatusText(display);
    case "doctor":
      return slashDoctorText(display);
    case "sessions":
      return slashSessionsText(display);
    case "skills":
      return slashSkillsText(display);
    case "config":
      return slashConfigText(display);
    default:
      return "";
  }
}

export function slashResultText(result, commands = []) {
  if (!result || typeof result !== "object") {
    return "";
  }
  return slashDisplayText(result.display, commands) || String(result.text || "");
}

export function answerPromptText() {
  return `\n  ${accent("▷")} `;
}

export function answerPlaceholderText() {
  return "Type your answer";
}

export function inputHintText(placeholder) {
  const text = singleLine(placeholder);
  return text ? dim(text) : "";
}

export function slashMenuText(items, selectedIndex = 0) {
  const visible = menuWindow(items, selectedIndex);
  if (!visible.items.length) {
    return "";
  }
  const lines = [dim(slashMenuTitle(visible))];
  for (const [index, item] of visible.items.entries()) {
    const active = index === visible.activeIndex;
    const marker = active ? accent("›") : dim("·");
    const name = active ? bold(`/${item.name}`) : dim(`/${item.name}`);
    const description = dim(clipSingleLine(item.description, 46));
    lines.push(`  ${marker} ${padRight(name, 14)} ${description}`);
  }
  lines.push(dim("    ↑↓ select · enter run · esc close · backspace edit"));
  return `${lines.join("\n")}\n`;
}

export function modelMenuText(items, selectedIndex = 0) {
  const visible = menuWindow(items, selectedIndex);
  if (!visible.items.length) {
    return "";
  }
  const lines = [dim(modelMenuTitle(visible))];
  for (const [index, item] of visible.items.entries()) {
    const active = index === visible.activeIndex;
    const marker = active ? accent("›") : dim("·");
    const name = active ? bold(item.name) : dim(item.name);
    const suffix = item.current ? dim("current") : "";
    lines.push(`  ${marker} ${padRight(name, 34)} ${suffix}`.trimEnd());
  }
  lines.push(dim("    ↑↓ select · enter use · esc cancel"));
  return `${lines.join("\n")}\n`;
}

export function choiceMenuText(options, selectedIndex = 0, recommended = "") {
  return choiceMenuTextWithTitle(options, selectedIndex, recommended, "Choices");
}

export function sessionMenuText(options, selectedIndex = 0) {
  return choiceMenuTextWithTitle(options, selectedIndex, "", "Sessions");
}

export function backgroundMonitorText(tasks = [], selectedIndex = 0, selectedTask = null, width = 76) {
  const items = Array.isArray(tasks) ? tasks : [];
  const lines = [bold("Background tasks"), dim("  ↑↓/j/k select · esc/ctrl+b close")];
  if (!items.length) {
    lines.push(dim("  No background tasks."));
    return lines.join("\n");
  }
  for (const [index, task] of items.entries()) {
    const active = index === selectedIndex;
    const marker = active ? accent("›") : dim("·");
    const status = singleLine(task?.status) || "unknown";
    const bgId = singleLine(task?.bg_id) || "unknown";
    const command = clipSingleLine(task?.command, Math.max(12, width - 34));
    lines.push(`  ${marker} ${padRight(bgId, 12)} ${padRight(status, 10)} ${dim(command)}`.trimEnd());
  }
  lines.push("");
  const task = selectedTask || items[selectedIndex];
  if (!task) {
    return lines.join("\n");
  }
  const heading = `${singleLine(task.bg_id) || "unknown"} · ${singleLine(task.status) || "unknown"}`;
  lines.push(dim(`  ${heading}`));
  const rawOutput = [task.stdout, task.stderr]
    .filter((value) => String(value || ""))
    .join("\n")
  const visibleOutput = rawOutput ? rawOutput.split(/\r?\n/).slice(-18) : [];
  if (!rawOutput) {
    lines.push(dim("  (no output)"));
  } else {
    lines.push(...visibleOutput.map((line) => `  ${clipSingleLine(line, width)}`));
  }
  if (task.truncated) {
    lines.push(dim("  … output truncated"));
  }
  return lines.join("\n");
}

function choiceMenuTextWithTitle(options, selectedIndex = 0, recommended = "", title = "Choices") {
  const visible = menuWindow(options, selectedIndex);
  if (!visible.items.length) {
    return "";
  }
  const lines = [dim(choiceMenuTitle(visible, title))];
  for (const [index, option] of visible.items.entries()) {
    const active = index === visible.activeIndex;
    const marker = active ? accent("›") : dim("·");
    const label = clipSingleLine(option, 60);
    const name = active ? bold(label) : dim(label);
    const suffix = option === recommended ? dim("recommended") : "";
    lines.push(`  ${marker} ${padRight(name, 34)} ${suffix}`.trimEnd());
  }
  lines.push(dim("    ↑↓ select · enter confirm · esc cancel"));
  return `${lines.join("\n")}\n`;
}

function choiceMenuTitle(visible, title = "Choices") {
  if (visible.total <= visible.items.length) {
    return `  ${title}`;
  }
  return `  ${title} ${visible.start + 1}-${visible.start + visible.items.length}/${visible.total}`;
}

export function sessionSwitchedText(info = {}) {
  const sessionId = singleLine(info.session_id) || "unknown";
  const model = singleLine(info.model);
  const preview = resumePreviewText(info.resume_preview);
  const lines = [startupBannerText(info), "", `${green("✓")} ${bold("Session switched")}`, dim(detailLine(sessionId))];
  if (model) {
    lines.push(dim(detailLine(`model ${model}`)));
  }
  if (preview) {
    lines.push("", `${accent("•")} ${bold("Recent context")}`, preview);
  }
  return lines.join("\n");
}

export function modelListErrorText(error, currentModel = "") {
  const lines = [`${accent("•")} ${bold("Model list unavailable")}`];
  const current = clipSingleLine(currentModel, 96);
  if (current) {
    lines.push(dim(detailLine(`current: ${current}`)));
  }
  const detail = clipSingleLine(error, 96);
  if (detail) {
    lines.push(dim(detailLine(detail)));
  }
  lines.push(dim(detailLine("use /model set <name> to switch manually")));
  return lines.join("\n");
}

export function queuedInputText(text = "") {
  const preview = clipSingleLine(text, 96);
  const lines = [`${accent("•")} ${bold("Queued follow-up")}`];
  if (preview) {
    lines.push(dim(detailLine(preview)));
  }
  lines.push(dim(detailLine("runs after the current turn")));
  return lines.join("\n");
}

export function turnCompletedLine(event, tools = { completed: 0, failed: 0 }) {
  const duration = formatDuration(event.duration_ms);
  const summary = toolSummary(tools);
  return summary
    ? `${green("─")} ${bold("Worked for")} ${duration} ${dim(`· ${summary}`)}`
    : `${green("─")} ${bold("Worked for")} ${duration}`;
}

export function interruptText() {
  return `${accent("•")} ${bold("Interrupt requested")}\n${dim(detailLine("ctrl+c again to quit"))}`;
}

export function cancelledText() {
  return `${accent("•")} ${bold("Interrupted")}\n${dim(detailLine("session preserved; resume with -c"))}`;
}

export function commandResultText(text, detail = "") {
  const line = `${green("✓")} ${bold(clipSingleLine(text, 96))}`;
  const extra = clipSingleLine(detail, 96);
  return extra ? `${line}\n${dim(detailLine(extra))}` : line;
}

export function modelUsageText() {
  return `${accent("•")} ${bold("Model command")}\n${dim(detailLine("/model set <name>"))}`;
}

export function contextBuiltLine(event) {
  const decisions = event.decisions && typeof event.decisions === "object" ? event.decisions : {};
  if (!decisions.rind_docs_truncated) {
    return "";
  }
  const scopes = Array.isArray(decisions.rind_docs_truncated_scopes)
    ? decisions.rind_docs_truncated_scopes.join(", ")
    : "unknown";
  return `${accent("•")} ${bold("Context trimmed")}\n${dim(detailLine(`RIND.md: ${clipSingleLine(scopes, 96)}`))}`;
}

export function unknownCommandText() {
  return `${accent("•")} ${bold("Unknown command")}\n${dim(detailLine("type / to browse commands or ? for shortcuts"))}`;
}

export function toolRequestedLine(event) {
  const name = event.tool_name || "unknown";
  const detail = toolDetail(name, parseJsonObject(event.args_preview));
  const label = toolLabel(name);
  const line = `${accent("◌")} ${bold("Tool")} ${dim("·")} ${toolActiveVerb(name)} ${label}`;
  return detail ? `${line}\n${dim(toolDetailLine(name, detail))}` : line;
}

export function toolStartedLine(event) {
  const name = event.tool_name || "tool";
  return `${accent("◌")} ${bold("Tool")} ${dim("·")} ${toolActiveVerb(name)} ${toolLabel(name)}`;
}

export function toolResultLine(event, fileChange) {
  const name = event.tool_name || "unknown";
  const label = toolLabel(name);
  const duration = formatDuration(event.duration_ms);
  if (event.status === "failed") {
    const suffix = event.error_type ? ` (${event.error_type})` : "";
    const detail = toolErrorDetail(event.result);
    const line = `${red("⊘")} ${bold("Tool")} ${dim("·")} ${label} failed in ${duration}${suffix}`;
    return detail ? `${line}\n${dim(detailLine(detail))}` : line;
  }
  const result = toolResultSummary(event.result);
  if (result.status === "running" && (name === "bash" || name === "bash_output")) {
    const runningText = name === "bash_output"
      ? "command output read; command still running in background"
      : "command running in background";
    const line = `${accent("◌")} ${bold("Tool")} ${dim("·")} ${runningText} in ${duration}`;
    const output = result.output;
    return [line, output ? dim(detailLine(output)) : "", fileChangeLine(fileChange)]
      .filter(Boolean)
      .join("\n");
  }
  const line = result.exitCode
    ? `${red("⊘")} ${bold("Tool")} ${dim("·")} ${label} exited ${result.exitCode} in ${duration}`
    : `${green("◉")} ${bold("Tool")} ${dim("·")} ${completedToolText(name, label)} in ${duration}`;
  const output = result.output;
  return [line, output ? dim(detailLine(output)) : "", fileChangeLine(fileChange)]
    .filter(Boolean)
    .join("\n");
}

export function planUpdatedLine(plan) {
  const items = Array.isArray(plan) ? plan : [];
  if (!items.length) {
    return `${green("◉")} ${bold("Plan cleared")}`;
  }

  const lines = [`${green("◉")} ${bold("Plan updated")}`];
  for (const item of items) {
    const step = clipSingleLine(item?.step, detailTextWidth());
    if (step) {
      lines.push(`  ${planStatusIcon(item?.status)} ${step}`);
    }
  }
  return lines.join("\n");
}

export function toolProgressLine(event) {
  const name = event.tool_name || "tool";
  const message = progressMessage(event.payload);
  return message ? `${accent("◌")} ${bold("Tool")} ${dim("·")} ${toolLabel(name)}\n${dim(`  ↳ ${message}`)}` : "";
}

export function skillLine(event) {
  return `${accent("•")} ${bold("Using skill")} ${dim(event.skill_name || "unknown")}`;
}

export function errorLine(error) {
  const detail = clipSingleLine(error, 120);
  return detail
    ? `${red("⊘")} ${bold("Turn failed")}\n${dim(detailLine(detail))}`
    : `${red("⊘")} ${bold("Turn failed")}`;
}

export function questionText(event = {}) {
  return [
    `${accent("•")} ${bold("Choice required")}`,
    "",
    `  ${clipSingleLine(event.question || "Input required", 76)}`,
  ].join("\n");
}

function toolDetail(name, args) {
  if (name === "bash") {
    return clipSingleLine(args.command, 96);
  }
  if (name === "bash_output") {
    const bgId = clipSingleLine(args.bg_id, 96);
    return bgId ? `bg ${bgId}` : "";
  }
  for (const key of ["file_path", "path", "query", "url"]) {
    const value = clipSingleLine(args[key], 96);
    if (value) {
      return value;
    }
  }
  return "";
}

function commandDeckText(commands) {
  const items = Array.isArray(commands) ? commands : [];
  if (!items.length) {
    return [
      dim("  /status  /sessions  /skill  /init  /plan  /compact"),
      dim("  /model set <name>  /draft  /doctor  /config  /login"),
      dim("  /clear  /exit"),
    ];
  }
  const names = items.map((command) => `/${clipSingleLine(command?.name, 22)}`);
  const lines = [];
  for (let index = 0; index < names.length; index += 4) {
    const row = names.slice(index, index + 4).map((name) => padRight(name, 14)).join("  ").trimEnd();
    lines.push(dim(`  ${row}`));
  }
  return lines;
}

function slashHelpText(display, commands) {
  const command = display.command && typeof display.command === "object" ? display.command : null;
  if (command) {
    const lines = [`${accent("•")} ${bold(`/${clipSingleLine(command.name, 32)}`)}`];
    const description = clipSingleLine(command.description, slashContentWidth());
    if (description) {
      lines.push(slashDetailLine(description));
    }
    const usage = clipSingleLine(command.usage || `/${command.name}`, slashContentWidth());
    if (usage) {
      lines.push(slashDetailLine(`usage: ${usage}`));
    }
    const aliases = slashAliases(command.aliases);
    if (aliases) {
      lines.push(slashDetailLine(`aliases: ${aliases}`));
    }
    return lines.join("\n");
  }

  const items = Array.isArray(display.commands) && display.commands.length ? display.commands : commands;
  const lines = [`${accent("•")} ${bold("Commands")}`];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const name = `/${clipSingleLine(item.name, 22)}`;
    const description = clipSingleLine(item.description, slashDescriptionWidth());
    lines.push(`  ${padRight(name, 16)} ${dim(description)}`.trimEnd());
  }
  lines.push(slashDetailLine("use /help <command> for usage"));
  return lines.join("\n");
}

function slashStatusText(display) {
  const lines = [`${accent("•")} ${bold("Status")}`];
  lines.push(slashDetailLine(`session ${clipSingleLine(display.session, 42)}`));
  lines.push(slashDetailLine(`model ${clipSingleLine(display.model, 48)}`));
  lines.push(slashDetailLine(`messages ${singleLine(display.messages) || "unknown"} · debug ${display.debug ? "on" : "off"}`));
  const git = display.git && typeof display.git === "object" ? display.git : null;
  if (git) {
    const state = git.dirty ? "dirty" : "clean";
    lines.push(slashDetailLine(`git ${clipSingleLine(git.branch, 48)} · ${state}`));
  }
  for (const usage of Array.isArray(display.usage) ? display.usage : []) {
    lines.push("");
    lines.push(`${accent("•")} ${bold(clipSingleLine(usage.label || "Usage", 48))}`);
    const input = usage.context_window_tokens > 0
      ? `${formatCount(usage.input_tokens)} / ${formatCount(usage.context_window_tokens)}`
      : formatCount(usage.input_tokens);
    lines.push(slashDetailLine(`input ${input} · ${formatPercent(usage.context_usage_percent)}`));
    lines.push(slashDetailLine(`cached ${formatCount(usage.cached_input_tokens)} · ${formatPercent(usage.cache_hit_rate)}`));
    lines.push(slashDetailLine(`output ${formatCount(usage.output_tokens)}`));
  }
  return lines.join("\n");
}

function slashDoctorText(display) {
  const failures = Number(display.failures || 0);
  const warnings = Number(display.warnings || 0);
  const summary = failures || warnings
    ? `${failures} fail · ${warnings} warn`
    : "all checks passed";
  const lines = [`${accent("•")} ${bold("Doctor")} ${dim(`· ${summary}`)}`];
  for (const check of Array.isArray(display.checks) ? display.checks : []) {
    if (!check || typeof check !== "object") {
      continue;
    }
    const status = singleLine(check.status).toLowerCase();
    const marker = doctorMarker(status);
    const name = clipSingleLine(check.name, slashDoctorNameWidth());
    const detail = clipSingleLine(check.detail, slashDoctorDetailWidth(name));
    lines.push(`  ${marker} ${padRight(status || "unknown", 5)} ${name}${detail ? dim(` · ${detail}`) : ""}`);
  }
  const nextSteps = Array.isArray(display.next_steps) ? display.next_steps : [];
  if (nextSteps.length) {
    lines.push("");
    lines.push(`${accent("•")} ${bold("Next steps")}`);
    for (const step of nextSteps) {
      lines.push(slashDetailLine(step));
    }
  }
  return lines.join("\n");
}

function slashSessionsText(display) {
  const sessions = Array.isArray(display.sessions) ? display.sessions : [];
  const lines = [`${accent("•")} ${bold("Recent sessions")}`];
  if (!sessions.length) {
    lines.push(slashDetailLine("no recent sessions"));
  }
  for (const session of sessions) {
    if (!session || typeof session !== "object") {
      continue;
    }
    const marker = session.current ? accent("›") : dim("·");
    const current = session.current ? dim(" current") : "";
    const id = middleClip(session.id, 32);
    const updated = clipSingleLine(session.updated_at, 28);
    lines.push(`  ${marker} ${id}${current}${updated ? dim(` · ${updated}`) : ""}`);
    const title = clipSingleLine(session.title, slashContentWidth());
    const size = sessionSizeText(session);
    lines.push(slashDetailLine([title, size].filter(Boolean).join(" · ")));
    const preview = clipSingleLine(session.preview, slashContentWidth());
    if (preview) {
      lines.push(slashDetailLine(preview));
    }
  }
  const resume = clipSingleLine(display.resume_command, slashContentWidth());
  if (resume) {
    lines.push(slashDetailLine(`resume: ${resume}`));
  }
  return lines.join("\n");
}

function slashSkillsText(display) {
  const skills = Array.isArray(display.skills) ? display.skills : [];
  const lines = [`${accent("•")} ${bold("Skills")}`];
  if (!skills.length) {
    lines.push(slashDetailLine("no skills found"));
  }
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") {
      continue;
    }
    const name = clipSingleLine(skill.name, 30);
    const source = clipSingleLine(skill.source, 18);
    const description = clipSingleLine(skill.description, slashDescriptionWidth());
    lines.push(`  ${dim("·")} ${bold(name)}${source ? dim(` [${source}]`) : ""}${description ? dim(` ${description}`) : ""}`);
    const path = middleClip(skill.path, slashContentWidth());
    if (path) {
      lines.push(slashDetailLine(path));
    }
  }
  return lines.join("\n");
}

function sessionSizeText(session) {
  const messages = optionalNonnegativeNumber(session.messages);
  const tools = optionalNonnegativeNumber(session.tool_calls);
  if (messages === null || tools === null) {
    return "unknown size";
  }
  return `${formatCount(messages)} msg, ${formatCount(tools)} tool`;
}

function optionalNonnegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function slashConfigText(display) {
  const lines = [`${accent("•")} ${bold("Config")}`];
  for (const entry of Array.isArray(display.entries) ? display.entries : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const label = clipSingleLine(entry.label, 22);
    const rawValue = entry.label === "settings"
      ? middleClip(entry.value, Math.max(18, slashContentWidth() - visibleLength(label) - 4))
      : clipSingleLine(entry.value, Math.max(18, slashContentWidth() - visibleLength(label) - 4));
    const state = entry.state ? ` (${clipSingleLine(entry.state, 18)})` : "";
    lines.push(slashDetailLine(`${label}: ${rawValue}${state}`));
  }
  return lines.join("\n");
}

function slashAliases(value) {
  return Array.isArray(value) ? value.map((alias) => `/${clipSingleLine(alias, 18)}`).join(", ") : "";
}

function slashDetailLine(value) {
  return dim(detailLine(clipSingleLine(value, slashContentWidth())));
}

function slashContentWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return 96;
  }
  return Math.max(28, Math.min(96, columns - 6));
}

function slashDescriptionWidth() {
  return Math.max(18, slashContentWidth() - 20);
}

function slashDoctorNameWidth() {
  return Math.max(10, Math.min(28, slashContentWidth() - 18));
}

function slashDoctorDetailWidth(name) {
  return Math.max(12, slashContentWidth() - visibleLength(name) - 12);
}

function doctorMarker(status) {
  if (status === "ok") {
    return green("✓");
  }
  if (status === "fail") {
    return red("⊘");
  }
  return accent("!");
}

function menuWindow(items, selectedIndex) {
  const entries = Array.isArray(items) ? items : [];
  const total = entries.length;
  if (!total) {
    return { items: [], activeIndex: 0, start: 0, total: 0 };
  }
  const limit = 8;
  const selected = Math.max(0, Math.min(total - 1, Number(selectedIndex) || 0));
  const start = total <= limit ? 0 : Math.min(Math.max(0, selected - 3), total - limit);
  return {
    items: entries.slice(start, start + limit),
    activeIndex: selected - start,
    start,
    total,
  };
}

function slashMenuTitle(visible) {
  if (visible.total <= visible.items.length) {
    return "  Command deck";
  }
  return `  Command deck ${visible.start + 1}-${visible.start + visible.items.length}/${visible.total}`;
}

function modelMenuTitle(visible) {
  if (visible.total <= visible.items.length) {
    return "  Model deck";
  }
  return `  Model deck ${visible.start + 1}-${visible.start + visible.items.length}/${visible.total}`;
}

function toolDetailLine(name, detail) {
  return name === "bash" ? `  $ ${detail}` : `  ↳ ${detail}`;
}

function detailLine(text) {
  return `  ↳ ${text}`;
}

function toolLabel(name) {
  if (name === "bash") {
    return "command";
  }
  if (name === "bash_output") {
    return "command output";
  }
  const labels = {
    edit_file: "file edit",
    read_file: "file read",
    search_files: "file search",
    view_image: "image",
    web_search: "web search",
  };
  return labels[name] || humanToolName(name);
}

function toolActiveVerb(name) {
  if (name === "bash") {
    return "Running";
  }
  if (name === "bash_output") {
    return "Reading";
  }
  return "Calling";
}

function completedToolText(name, label) {
  if (name === "bash") {
    return `Ran ${label}`;
  }
  if (name === "bash_output") {
    return `Read ${label}`;
  }
  return `Called ${label}`;
}

function humanToolName(name) {
  return singleLine(name).replace(/[_-]+/g, " ") || "tool";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolErrorDetail(result) {
  const payload = parseJsonObject(result);
  return clipSingleLine(payload.error, 120);
}

function toolResultSummary(result) {
  const payload = parseJsonObject(result);
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return {
    status: singleLine(data.status).toLowerCase(),
    exitCode: nonZeroExitCode(data.exit_code),
    output: clipSingleLine(data.stdout || data.stderr || data.message, 120),
  };
}

function nonZeroExitCode(value) {
  const code = Number(value);
  return Number.isInteger(code) && code !== 0 ? code : 0;
}

function progressMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  for (const key of ["message", "status", "text"]) {
    const value = clipSingleLine(payload[key], 120);
    if (value) {
      return value;
    }
  }
  return "";
}

function fileChangeLine(fileChange) {
  if (!fileChange || typeof fileChange !== "object") {
    return "";
  }
  const changes = Array.isArray(fileChange.lines)
    ? fileChange.lines.filter((line) => line?.kind === "added" || line?.kind === "removed")
    : [];
  if (!changes.length) {
    return "";
  }
  const path = middleClip(fileChange.file_path, fileChangePathWidth());
  const shown = changes.slice(0, MAX_FILE_CHANGE_LINES);
  const lines = [`${dim("  ↳")} ${path}`];
  for (const change of shown) {
    lines.push(fileChangeDiffLine(change));
  }
  const hidden = changes.length - shown.length;
  if (hidden > 0) {
    lines.push(dim(`    … ${hidden} more changed lines`));
  }
  return lines.join("\n");
}

function fileChangeDiffLine(change) {
  const added = change.kind === "added";
  const marker = added ? "+" : "-";
  const style = added ? green : red;
  return `${dim(`    ${marker} `)}${style(clipCells(change.text, detailTextWidth()))}`;
}

function fileChangePathWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return 48;
  }
  return Math.max(18, Math.min(48, columns - 32));
}

function detailTextWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return 96;
  }
  return Math.max(12, Math.min(96, columns - 6));
}

function planStatusIcon(status) {
  switch (status) {
    case "in_progress":
      return accent("◐");
    case "completed":
      return green("●");
    case "cancelled":
      return dim("⊖");
    default:
      return dim("○");
  }
}

function clipSingleLine(value, maxLength) {
  const text = singleLine(value);
  return clipCells(text, maxLength);
}

function middleClip(value, maxLength) {
  const text = singleLine(value);
  return middleClipCells(text, maxLength);
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function messageLines(value) {
  const text = String(value || "").replace(/\r/g, "").trim();
  return text ? text.split("\n").map((line) => line.trimEnd()) : [];
}

function userInputContentWidth() {
  const columns = Number(process.stdout.columns);
  return Number.isFinite(columns) && columns > 0 ? Math.max(1, Math.floor(columns - 2)) : 78;
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

function formatActivityDuration(durationMs) {
  const value = Math.max(0, Number(durationMs || 0));
  if (!Number.isFinite(value) || value < 60000) {
    return `${Math.floor(value / 1000)}s`;
  }
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function toolSummary(tools) {
  const completed = Number(tools.completed || 0);
  const failed = Number(tools.failed || 0);
  const parts = [];
  if (completed > 0) {
    parts.push(`${completed} completed`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  return parts.join(", ");
}

function formatCount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "0";
  }
  if (Math.abs(number) >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }
  return String(Math.trunc(number));
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "0.0%";
  }
  return `${(number * 100).toFixed(1)}%`;
}

function resumePreviewText(value) {
  const lines = String(value || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.map(resumePreviewLine).join("\n");
}

function resumePreviewLine(line) {
  const message = line.match(/^-?\s*(user|assistant):\s*(.*)$/i);
  if (message) {
    const role = message[1].toLowerCase();
    const marker = role === "user" ? accent("▷") : dim("◁");
    const label = role === "user" ? "You" : "Assistant";
    return `${marker} ${label} ${dim("·")} ${clipSingleLine(message[2], 72)}`;
  }
  return dim(`  ${clipSingleLine(line, 78)}`);
}

function startupBannerText(info) {
  const width = startupBannerWidth();
  const modelLine = `model ${singleLine(info.model) || "unknown"} · session ${singleLine(info.session_id) || "unknown"}`;
  const cwd = middleClip(info.cwd || process.cwd(), width - 4);
  return [
    startupBannerBorder("┌", "┐", width),
    startupBannerLine(`${bold("Rind")} ${dim("workbench online")}`, width),
    startupBannerLine(modelLine, width),
    startupBannerLine(cwd, width),
    startupBannerBorder("└", "┘", width),
  ].join("\n");
}

function startupBannerBorder(left, right, width) {
  return dim(`${left}${"─".repeat(width - 2)}${right}`);
}

function startupBannerLine(text, frameWidth) {
  const clean = String(text || "").replace(/[\r\n\t]+/g, " ").trimEnd();
  const width = frameWidth - 4;
  const content =
    visibleLength(clean) <= width
      ? clean
      : clipCells(clean, width);
  return `${dim("│")} ${padRight(content, width)} ${dim("│")}`;
}

function startupBannerWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return MAX_STARTUP_BANNER_WIDTH;
  }
  return Math.max(44, Math.min(MAX_STARTUP_BANNER_WIDTH, columns - 2));
}

function helpRow(leftKey, leftText, rightKey, rightText) {
  const left = `${padRight(leftKey, 12)} ${leftText}`;
  const right = `${padRight(rightKey, 14)} ${rightText}`;
  return dim(`  ${padRight(left, 33)} ${right}`);
}

function inputPromptFrame(header = "", state = {}) {
  const lines = [""];
  const activity = promptActivityLine(state);
  if (activity) {
    lines.push(activity);
  }
  if (header) {
    lines.push(header);
  }
  lines.push(inputDivider());
  lines.push("  ▷ ");
  return lines.join("\n");
}

function inputDivider() {
  return dim(`  ${"─".repeat(composerWidth())}`);
}

function activityFrame(frame) {
  const frames = ["◐", "◓", "◑", "◒"];
  const index = Math.abs(Number(frame) || 0) % frames.length;
  return frames[index];
}

function padRight(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function visibleLength(text) {
  return textWidth(text);
}

function promptHeaderLine(info) {
  const backgroundCount = Number(info.background_count);
  const backgroundHint = backgroundCount > 0
    ? " · " + dim("[bg:" + backgroundCount + "] (ctrl+b monitor)")
    : "";
  const model = singleLine(info.model);
  const cwd = middleClip(info.cwd, 56);
  const width = composerWidth();
  if (model && cwd) {
    const separator = " · ";
    const pathWidth = width - visibleLength(model) - visibleLength(separator) - visibleLength(backgroundHint);
    if (pathWidth > 0) {
      return `  ${promptModel(clipSingleLine(model, width))}${dim(separator)}${promptPath(clipSingleLine(cwd, pathWidth))}${backgroundHint}`;
    }
  }
  if (model) {
    return `  ${promptModel(clipSingleLine(model, width))}${backgroundHint}`;
  }
  return cwd ? `  ${promptPath(clipSingleLine(cwd, width))}${backgroundHint}` : "";
}

function composerWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return MAX_COMPOSER_WIDTH;
  }
  return Math.max(1, Math.min(MAX_COMPOSER_WIDTH, columns - 4));
}

function styled(text, code) {
  if (!Boolean(process.stdout.isTTY) || process.env.NO_COLOR) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function bold(text) {
  return styled(text, "1");
}

function dim(text) {
  return styled(text, "2");
}

function accent(text) {
  return styled(text, "38;5;81");
}

function green(text) {
  return styled(text, "38;5;113");
}

function red(text) {
  return styled(text, "38;5;203");
}

function promptModel(text) {
  return styled(text, "1;38;5;81");
}

function promptPath(text) {
  return styled(text, "38;5;110");
}
