import { clipCells, middleClipCells, textWidth, wrapTextCells } from "./text-width.js";
import { paint, flavorSwatch } from "./theme.js";

const MAX_STARTUP_BANNER_WIDTH = 80;
const MAX_COMPOSER_WIDTH = 78;
const MAX_FILE_CHANGE_LINES = 20;

export function startupText(info = {}, width) {
  const header = startupBannerText(info, width);
  const goal = goalText(info.goal, true);
  const preview = resumePreviewText(info.resume_preview);
  const sections = [header, goal, preview ? `${accent("◆")} ${bold("Recent context")}\n${preview}` : ""];
  return sections.filter(Boolean).join("\n\n");
}

export function promptText(info = {}, _stats = {}, state = {}, frameWidth) {
  return inputPromptFrame(promptHeaderLine(info, frameWidth), state, frameWidth);
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

export function userInputText(text, width) {
  const lines = messageLines(text);
  if (!lines.length) {
    return "";
  }
  const contentWidth = userInputContentWidth(width);
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
  const lines = [
    sectionRule("Controls"),
    helpRow("enter", "send / steer", "tab", "queue follow-up"),
    helpRow("↑ / ↓", "history", "← / →", "move cursor"),
    helpRow("home / end", "line edges", "del / backspace", "edit text"),
    helpRow("ctrl+c", "interrupt or quit", "?", "show shortcuts"),
    helpRow("ctrl+b", "task monitor", "esc", "close monitor"),
    helpRow("ctrl+o", "toggle tool detail", "", ""),
  ];
  const deckItems = Array.isArray(commands)
    ? commands.filter((item) => item && typeof item === "object")
    : [];
  if (deckItems.length) {
    lines.push("", sectionRule("Commands", `${deckItems.length} available`), ...commandDeckText(deckItems));
  }
  return lines.join("\n");
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
    case "theme":
      return slashThemeText(display);
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

export function taskMonitorTabs(page = "background", backgroundCount = 0, delegateCount = 0, width = 76) {
  const background = Math.max(0, Math.floor(Number(backgroundCount) || 0));
  const delegates = Math.max(0, Math.floor(Number(delegateCount) || 0));
  const tabs = [
    { page: "background", label: `Background [${background}]` },
    { page: "delegates", label: `Delegates [${delegates}]` },
  ].map((tab) => tab.page === page
    ? bold(accent(`› ${tab.label}`))
    : dim(`  ${tab.label}`));
  const inline = tabs.join("    ");
  return textWidth(inline) <= Math.max(1, Number(width) || 76)
    ? inline
    : tabs.join("\n");
}

export function choiceMenuText(options, selectedIndex = 0) {
  return choiceMenuTextWithTitle(options, selectedIndex, "Choices");
}

export function sessionMenuText(options, selectedIndex = 0) {
  return choiceMenuTextWithTitle(options, selectedIndex, "Sessions");
}

export function questionMenuFrame(
  options,
  selectedIndex = 0,
  customInput = "",
  editing = false,
  customLabel = "Type your own answer",
  width = 76,
) {
  const entries = [
    ...(Array.isArray(options) ? options : []),
    { label: customLabel, description: "" },
  ];
  const visible = menuWindow(entries, selectedIndex);
  if (!visible.items.length) {
    return { text: "", cursor: null };
  }
  const lines = [dim(choiceMenuTitle(visible, "Answers"))];
  let cursor = null;
  for (const [index, option] of visible.items.entries()) {
    const active = index === visible.activeIndex;
    const marker = active ? accent("›") : dim("·");
    const labelLines = wrapQuestionLines(option.label, Math.max(1, width - 4));
    const labelStyle = active ? bold : dim;
    for (const [lineIndex, labelLine] of labelLines.entries()) {
      const prefix = lineIndex === 0 ? `  ${marker} ` : "    ";
      lines.push(`${prefix}${labelStyle(labelLine)}`);
    }
    if (active && editing && option.label === customLabel) {
      const lastLine = lines.length - 1;
      const input = clipCells(
        `: ${String(customInput || "")}`,
        Math.max(1, width - textWidth(lines[lastLine])),
      );
      lines[lastLine] += input;
      cursor = {
        line: lastLine,
        column: textWidth(lines[lastLine]),
      };
    }
    if (option.description) {
      const descriptionLines = wrapQuestionLines(option.description, Math.max(1, width - 6));
      for (const [lineIndex, descriptionLine] of descriptionLines.entries()) {
        lines.push(dim(`${lineIndex === 0 ? "    ↳ " : "      "}${descriptionLine}`));
      }
    } else if (option.label === customLabel && !editing) {
      lines.push(dim("    ↳ press Tab to type"));
    }
  }
  lines.push(dim("    ↑↓ select · enter confirm · esc cancel"));
  return { text: `${lines.join("\n")}\n`, cursor };
}

function wrapQuestionLines(value, width) {
  const text = String(value || "").replace(/\r?\n/g, " ").trim();
  return wrapTextCells(text, Math.max(1, width), Math.max(1, width)).map((chunk) => chunk.text);
}

export function backgroundMonitorText(tasks = [], selectedIndex = 0, selectedTask = null, width = 76) {
  const items = Array.isArray(tasks) ? tasks : [];
  const lines = [dim("  ←→ page · ↑↓/j/k select · esc/ctrl+b close")];
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

export function delegateMonitorText(delegates = [], selectedIndex = 0, selectedDelegate = null, width = 76) {
  const items = Array.isArray(delegates) ? delegates : [];
  const lines = [dim("  ←→ page · ↑↓/j/k select · esc/ctrl+b close")];
  if (!items.length) {
    lines.push(dim("  No delegates."));
    return lines.join("\n");
  }
  for (const [index, delegate] of items.entries()) {
    const active = index === selectedIndex;
    const marker = active ? accent("›") : dim("·");
    const agent = padRight(clipSingleLine(delegate?.agent_id, 28), 28);
    const status = padRight(clipSingleLine(delegate?.status, 10), 10);
    const task = clipSingleLine(delegate?.task, Math.max(12, width - 44));
    lines.push(`  ${marker} ${agent} ${status} ${dim(task)}`.trimEnd());
  }
  lines.push("");
  const delegate = selectedDelegate || items[selectedIndex];
  if (!delegate) {
    return lines.join("\n");
  }
  const heading = `${singleLine(delegate.agent_id) || "unknown"} · ${singleLine(delegate.status) || "unknown"}`;
  lines.push(dim(`  ${heading}`));
  const task = clipSingleLine(delegate.task, width);
  if (task) {
    lines.push(dim(`  task: ${task}`));
  }
  const summary = clipSingleLine(delegate.summary, width);
  if (summary) {
    lines.push(dim(`  ↳ ${summary}`));
  }
  return lines.join("\n");
}

function choiceMenuTextWithTitle(options, selectedIndex = 0, title = "Choices") {
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
    lines.push(`  ${marker} ${name}`);
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
  const goal = goalText(info.goal, true);
  const preview = resumePreviewText(info.resume_preview);
  const lines = [startupBannerText(info), "", `${green("✓")} ${bold("Session switched")}`];
  lines.push(dim(`    session ${sessionId}`));
  if (model) {
    lines.push(dim(`    model ${model}`));
  }
  if (goal) {
    lines.push("", goal);
  }
  if (preview) {
    lines.push("", `${accent("◆")} ${bold("Recent context")}`, preview);
  }
  return lines.join("\n");
}

export function goalText(goal, includeHint = false) {
  if (!goal || typeof goal !== "object") {
    return "";
  }
  const status = singleLine(goal.status) || "unknown";
  const objective = clipSingleLine(goal.objective, 96);
  const lines = [`${accent("◆")} ${bold("Goal")} ${dim(`· ${status}`)}`];
  if (objective) {
    lines.push(dim(`    ${objective}`));
  }
  if (includeHint && status === "active") {
    lines.push(dim("    resume manually with /goal resume"));
  }
  return lines.join("\n");
}

export function goalCommandText(goal, action = "get") {
  const labels = {
    get: "Goal status",
    set: "Goal started",
    pause: "Goal paused",
    resume: "Goal resumed",
    clear: "Goal cleared",
  };
  const label = labels[action] || "Goal updated";
  if (!goal) {
    return commandResultText(label, "No active goal");
  }
  return commandResultText(label, `${goal.status} · ${clipSingleLine(goal.objective, 80)}`);
}

export function modelListErrorText(error, currentModel = "") {
  const current = clipSingleLine(currentModel, 96);
  const detail = clipSingleLine(error, 96);
  return notice(
    "Model list unavailable",
    current ? `current: ${current}` : "",
    detail,
    "use /model set <name> to switch manually",
  );
}

export function turnCompletedLine(event, tools = { completed: 0, failed: 0 }) {
  const duration = formatDuration(event.duration_ms);
  const summary = toolSummary(tools);
  return summary
    ? `${green("─")} ${bold("Worked for")} ${duration} ${dim(`· ${summary}`)}`
    : `${green("─")} ${bold("Worked for")} ${duration}`;
}

export function interruptText() {
  return notice("Interrupt requested", "ctrl+c again to quit");
}

export function cancelledText() {
  return notice("Interrupted", "session preserved; resume with -c");
}

export function commandResultText(text, detail = "") {
  const extra = clipSingleLine(detail, 96);
  return `${green("✓")} ${bold(clipSingleLine(text, 96))}${extra ? dim(` — ${extra}`) : ""}`;
}

export function modelUsageText() {
  return notice("Model command", "/model set <name>");
}

export function contextBuiltLine(event) {
  const decisions = event.decisions && typeof event.decisions === "object" ? event.decisions : {};
  if (!decisions.rind_docs_truncated) {
    return "";
  }
  const scopes = Array.isArray(decisions.rind_docs_truncated_scopes)
    ? decisions.rind_docs_truncated_scopes.join(", ")
    : "unknown";
  return notice("Context trimmed", `RIND.md: ${clipSingleLine(scopes, 96)}`);
}

export function unknownCommandText() {
  return notice("Unknown command", "type / to browse commands or ? for shortcuts");
}

function notice(label, ...details) {
  const lines = [`${accent("◆")} ${bold(label)}`];
  for (const detail of details.flat()) {
    if (detail) {
      lines.push(dim(`    ${detail}`));
    }
  }
  return lines.join("\n");
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

export function errorLine(error) {
  const detail = clipSingleLine(error, 120);
  return detail
    ? `${red("⊘")} ${bold("Turn failed")}\n${dim(detailLine(detail))}`
    : `${red("⊘")} ${bold("Turn failed")}`;
}

export function questionText(event = {}) {
  return [
    `${accent("◆")} ${bold("Choice required")}`,
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
  if (name === "delegate") {
    return clipSingleLine(args.agent_id, 96);
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
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const name = padRight(`/${clipSingleLine(item.name, 22)}`, 16);
    const description = clipSingleLine(item.description, slashContentWidth() - 20);
    rows.push(`  ${accent(name)}${dim(description)}`.trimEnd());
  }
  return rows;
}

function slashHelpText(display, commands) {
  const command = display.command && typeof display.command === "object" ? display.command : null;
  if (command) {
    const lines = [sectionRule(`/${clipSingleLine(command.name, 32)}`)];
    const description = clipSingleLine(command.description, slashContentWidth());
    if (description) {
      lines.push(`  ${description}`);
    }
    lines.push("");
    lines.push(kvRow("usage", clipSingleLine(command.usage || `/${command.name}`, slashContentWidth() - 14), 10));
    const aliases = slashAliases(command.aliases);
    if (aliases) {
      lines.push(kvRow("aliases", aliases, 10));
    }
    return lines.join("\n");
  }

  const items = (Array.isArray(display.commands) && display.commands.length ? display.commands : commands)
    .filter((item) => item && typeof item === "object");
  const lines = [sectionRule("Commands", `${items.length} available`)];
  for (const item of items) {
    const name = padRight(`/${clipSingleLine(item.name, 22)}`, 16);
    const description = clipSingleLine(item.description, slashContentWidth() - 20);
    lines.push(`  ${accent(name)}${dim(description)}`.trimEnd());
  }
  lines.push("");
  lines.push(dim("  use /help <command> for usage"));
  return lines.join("\n");
}

function slashStatusText(display) {
  const lines = [sectionRule("Status")];
  lines.push(kvRow("session", clipSingleLine(display.session, 48)));
  lines.push(kvRow("model", clipSingleLine(display.model, 52)));
  lines.push(kvRow("messages", `${singleLine(display.messages) || "unknown"} · debug ${display.debug ? "on" : "off"}`));
  const git = display.git && typeof display.git === "object" ? display.git : null;
  if (git) {
    const state = git.dirty ? "dirty" : "clean";
    lines.push(kvRow("git", `${clipSingleLine(git.branch, 48)} · ${state}`));
  }
  for (const usage of Array.isArray(display.usage) ? display.usage : []) {
    lines.push("", sectionRule(sectionLabel(usage.label) || "Sampling"));
    const windowTokens = Number(usage.context_window_tokens) || 0;
    if (windowTokens > 0) {
      lines.push(kvRow("context", `${usageMeter(usage.context_usage_percent)} ${dim(formatPercent(usage.context_usage_percent))}`));
      lines.push(kvRow("input", `${formatCount(usage.input_tokens)} ${dim(`/ ${formatCount(windowTokens)} tokens`)}`));
    } else {
      lines.push(kvRow("input", formatCount(usage.input_tokens)));
    }
    lines.push(kvRow("cached", `${formatCount(usage.cached_input_tokens)} ${dim(`· ${formatPercent(usage.cache_hit_rate)} hit`)}`));
    lines.push(kvRow("output", formatCount(usage.output_tokens)));
  }
  return lines.join("\n");
}

function slashDoctorText(display) {
  const failures = Number(display.failures || 0);
  const warnings = Number(display.warnings || 0);
  const summary = failures || warnings
    ? `${failures} fail · ${warnings} warn`
    : "all checks passed";
  const checks = (Array.isArray(display.checks) ? display.checks : [])
    .filter((check) => check && typeof check === "object");
  const widths = checks.map((check) => visibleLength(clipSingleLine(check.name, 28)));
  const nameWidth = Math.min(24, Math.max(10, ...(widths.length ? widths : [10])));
  const lines = [sectionRule("Doctor", summary)];
  for (const check of checks) {
    const status = singleLine(check.status).toLowerCase();
    const marker = doctorMarker(status);
    const name = padRight(clipSingleLine(check.name, 28), nameWidth);
    const detail = clipSingleLine(check.detail, Math.max(12, slashContentWidth() - nameWidth - 8));
    lines.push(`  ${marker} ${name}  ${dim(detail)}`.trimEnd());
  }
  const nextSteps = Array.isArray(display.next_steps) ? display.next_steps : [];
  if (nextSteps.length) {
    lines.push("", sectionRule("Next steps"));
    for (const step of nextSteps) {
      lines.push(`  ${dim(clipSingleLine(step, slashContentWidth()))}`);
    }
  }
  return lines.join("\n");
}

function slashSessionsText(display) {
  const sessions = Array.isArray(display.sessions) ? display.sessions : [];
  const lines = [sectionRule("Sessions", sessions.length ? `${sessions.length} recent` : "")];
  if (!sessions.length) {
    lines.push(dim("  no recent sessions"));
  }
  for (const session of sessions) {
    if (!session || typeof session !== "object") {
      continue;
    }
    const marker = session.current ? accent("›") : dim("·");
    const current = session.current ? dim(" · current") : "";
    const id = middleClip(session.id, 32);
    const updated = clipSingleLine(session.updated_at, 28);
    lines.push(`  ${marker} ${id}${current}${updated ? dim(` · ${updated}`) : ""}`);
    const title = clipSingleLine(session.title, slashContentWidth());
    const size = sessionSizeText(session);
    const summary = [title, size].filter(Boolean).join(" · ");
    if (summary) {
      lines.push(dim(`      ${summary}`));
    }
    const preview = clipSingleLine(session.preview, slashContentWidth());
    if (preview) {
      lines.push(dim(`      ${preview}`));
    }
  }
  const resume = clipSingleLine(display.resume_command, slashContentWidth());
  if (resume) {
    lines.push("", dim(`  resume: ${resume}`));
  }
  return lines.join("\n");
}

function slashSkillsText(display) {
  const skills = (Array.isArray(display.skills) ? display.skills : [])
    .filter((skill) => skill && typeof skill === "object");
  const widths = skills.map((skill) => visibleLength(clipSingleLine(skill.name, 30)));
  const nameWidth = Math.min(26, Math.max(12, ...(widths.length ? widths : [12])));
  const lines = [sectionRule("Skills", skills.length ? `${skills.length} available` : "")];
  if (!skills.length) {
    lines.push(dim("  no skills found"));
  }
  for (const skill of skills) {
    const name = padRight(clipSingleLine(skill.name, 30), nameWidth);
    const scope = clipSingleLine(skill.scope, 18);
    const description = clipSingleLine(
      skill.description,
      Math.max(18, slashContentWidth() - nameWidth - (scope ? scope.length + 6 : 0)),
    );
    lines.push(`  ${bold(name)}${scope ? dim(`  [${scope}]`) : ""}${description ? `  ${dim(description)}` : ""}`.trimEnd());
    const path = middleClip(skill.path, slashContentWidth());
    if (path) {
      lines.push(dim(`      ${path}`));
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
  const entries = (Array.isArray(display.entries) ? display.entries : [])
    .filter((entry) => entry && typeof entry === "object");
  const lines = [sectionRule("Config", entries.length ? `${entries.length} ${entries.length === 1 ? "key" : "keys"}` : "")];
  for (const entry of entries) {
    const label = clipSingleLine(entry.label, 22);
    const rawValue = entry.label === "settings"
      ? middleClip(entry.value, Math.max(18, slashContentWidth() - visibleLength(label) - 6))
      : clipSingleLine(entry.value, Math.max(18, slashContentWidth() - visibleLength(label) - 6));
    const state = entry.state ? dim(`  (${clipSingleLine(entry.state, 18)})`) : "";
    lines.push(`  ${dim(padRight(label, 18))}${rawValue}${state}`.trimEnd());
  }
  return lines.join("\n");
}

function slashThemeText(display) {
  const flavors = Array.isArray(display.flavors) ? display.flavors : [];
  const current = singleLine(display.current) || "mocha";
  const meta = display.changed && display.previous
    ? `${singleLine(display.previous)} → ${current}`
    : current;
  const lines = [sectionRule("Theme", meta)];
  if (!flavors.length) {
    lines.push(dim(`  active: ${current}`));
    return lines.join("\n");
  }
  const labelWidth = Math.min(
    16,
    Math.max(8, ...flavors.map((flavor) => visibleLength(clipSingleLine(flavor?.label, 16)))),
  );
  for (const flavor of flavors) {
    if (!flavor || typeof flavor !== "object") {
      continue;
    }
    const isCurrent = Boolean(flavor.current);
    const marker = isCurrent ? accent("›") : dim("·");
    const label = padRight(clipSingleLine(flavor.label || flavor.name, 16), labelWidth);
    const tag = isCurrent ? dim(" · current") : "";
    lines.push(`  ${marker} ${isCurrent ? bold(label) : dim(label)}  ${flavorSwatch(flavor.name)}${tag}`);
  }
  lines.push("");
  lines.push(dim("  /theme <latte | frappe | macchiato | mocha>"));
  return lines.join("\n");
}

function sectionRule(title, meta = "") {
  const titleText = clipSingleLine(title, 48);
  const metaText = meta ? clipSingleLine(meta, 48) : "";
  const head = metaText ? `${titleText} ${dim(`· ${metaText}`)}` : titleText;
  const fill = Math.max(3, slashContentWidth() - visibleLength(head) - 6);
  return `  ${dim("──")} ${head} ${dim("─".repeat(fill))}`;
}

function kvRow(label, value, labelWidth = 12) {
  return `  ${dim(padRight(label, labelWidth))}${value}`;
}

function usageMeter(ratio) {
  const cells = 10;
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.min(cells, Math.round(clamped * cells));
  const tone = clamped >= 0.85 ? red : clamped >= 0.6 ? accent : (text) => text;
  return `${tone("▮".repeat(filled))}${dim("▯".repeat(cells - filled))}`;
}

function sectionLabel(value) {
  return singleLine(value).replace(/:\s*$/, "");
}

function slashAliases(value) {
  return Array.isArray(value) ? value.map((alias) => `/${clipSingleLine(alias, 18)}`).join(", ") : "";
}

function slashContentWidth() {
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return 96;
  }
  return Math.max(28, Math.min(96, columns - 6));
}

function doctorMarker(status) {
  if (status === "ok") {
    return green("✓");
  }
  if (status === "fail") {
    return red("⊘");
  }
  return paint.warning("!");
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
  if (name === "delegate") {
    return `  ↳ agent: ${detail}`;
  }
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

function userInputContentWidth(width) {
  const columns = Number(width ?? process.stdout.columns);
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

function startupBannerText(info, frameWidth) {
  const width = startupBannerWidth(frameWidth);
  const modelLine = `model ${singleLine(info.model) || "unknown"} · session ${singleLine(info.session_id) || "unknown"}`;
  const version = singleLine(info.version) || "unknown";
  const cwd = middleClip(info.cwd || process.cwd(), width - 4);
  return [
    startupBannerBorder("┌", "┐", width),
    startupBannerLine(`${bold("Rind")} ${dim(`v${version}`)}`, width),
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

function startupBannerWidth(frameWidth) {
  const columns = Number(frameWidth ?? process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return MAX_STARTUP_BANNER_WIDTH;
  }
  return Math.max(44, Math.min(MAX_STARTUP_BANNER_WIDTH, columns - 2));
}

function helpRow(leftKey, leftText, rightKey = "", rightText = "") {
  const left = `${padRight(leftKey, 12)} ${leftText}`;
  if (!rightKey && !rightText) {
    return dim(`  ${left}`);
  }
  const right = `${padRight(rightKey, 14)} ${rightText}`;
  return dim(`  ${padRight(left, 33)} ${right}`);
}

function inputPromptFrame(header = "", state = {}, frameWidth) {
  const lines = [""];
  const activity = promptActivityLine(state);
  if (activity) {
    lines.push(activity);
  }
  lines.push(...pendingInputLines(state.pendingInputs, frameWidth));
  if (header) {
    lines.push(header);
  }
  lines.push(inputDivider(frameWidth));
  lines.push("  ▷ ");
  return lines.join("\n");
}

function inputDivider(frameWidth) {
  return dim(`  ${"─".repeat(dividerWidth(frameWidth))}`);
}

function dividerWidth(frameWidth) {
  const columns = Number(frameWidth ?? process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return MAX_COMPOSER_WIDTH;
  }
  return Math.max(1, Math.floor(columns) - 2);
}

function pendingInputLines(entries, frameWidth) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const width = composerWidth(frameWidth);
  const lines = entries.flatMap((entry) => {
    const input = singleLine(entry?.input);
    if (!input) {
      return [];
    }
    const label = entry.mode === "steering" ? "Steering" : "Queue";
    return dim(`  ${label}: ${clipSingleLine(input, Math.max(1, width - visibleLength(label) - 4))}`);
  });
  const hints = [];
  if (entries.some((entry) => entry?.mode === "follow_up")) {
    hints.push("alt+up recall queue");
  }
  if (entries.some((entry) => entry?.mode === "steering")) {
    hints.push("alt+down recall steer");
  }
  if (hints.length) {
    lines.push(dim(`    ${hints.join(" · ")}`));
  }
  return lines;
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

function promptHeaderLine(info, frameWidth) {
  const backgroundCount = Number(info.background_count);
  const delegateCount = Number(info.delegate_count);
  const taskHints = [];
  if (backgroundCount > 0) {
    taskHints.push(`[bg:${backgroundCount}]`);
  }
  if (delegateCount > 0) {
    taskHints.push(`[delegate:${delegateCount}]`);
  }
  const taskHint = taskHints.length
    ? " · " + dim(`${taskHints.join(" ")} (ctrl+b monitor)`)
    : "";
  const model = singleLine(info.model);
  const cwd = middleClip(info.cwd, 56);
  const width = composerWidth(frameWidth);
  if (model && cwd) {
    const separator = " · ";
    const pathWidth = width - visibleLength(model) - visibleLength(separator) - visibleLength(taskHint);
    if (pathWidth > 0) {
      return `  ${promptModel(clipSingleLine(model, width))}${dim(separator)}${promptPath(clipSingleLine(cwd, pathWidth))}${taskHint}`;
    }
  }
  if (model) {
    return `  ${promptModel(clipSingleLine(model, width))}${taskHint}`;
  }
  return cwd ? `  ${promptPath(clipSingleLine(cwd, width))}${taskHint}` : "";
}

function composerWidth(frameWidth) {
  const columns = Number(frameWidth ?? process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return MAX_COMPOSER_WIDTH;
  }
  return Math.max(1, Math.min(MAX_COMPOSER_WIDTH, columns - 4));
}

function bold(text) {
  return paint.bold(text);
}

function dim(text) {
  return paint.dim(text);
}

function accent(text) {
  return paint.accent(text);
}

function green(text) {
  return paint.success(text);
}

function red(text) {
  return paint.danger(text);
}

function promptModel(text) {
  return paint.bold(paint.accent(text));
}

function promptPath(text) {
  return paint.path(text);
}
