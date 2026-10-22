import { clipCells, graphemes, middleClipCells, stripAnsi, textWidth, wrapTextCells, wrapTextWithAnsi } from "./text-width.js";
import { formatDuration } from "./tool-display.js";
import { DEFAULT_THEME, colorEnabled, paint, paintRaw, flavorSwatch, themeNames, breathingAccent } from "./theme.js";
import { DEFAULT_SPINNER, isBriefMode, spinnerFrame, spinnerNames } from "./cli-state-store.js";
import { homedir } from "node:os";

const MAX_STARTUP_BANNER_WIDTH = 80;
const MAX_COMPOSER_WIDTH = 78;
const MAX_FILE_CHANGE_LINES = 20;
const BOARD_MIN_WIDTH = 60;
const BOARD_MAX_WIDTH = 100;
const BOARD_PALETTE_ROLES = ["accent", "success", "warning", "danger", "notice", "path", "code", "fence"];
const BOARD_SECTION_SHORT_LABELS = {
  chat_user: "user",
  chat_assistant: "chat",
  reasoning: "reasoning",
  system_prompt: "system",
  skill_catalog: "skills",
  tool_specs: "tools",
  rind_docs: "RIND",
  rind_docs_user: "RIND user",
  rind_docs_project: "RIND project",
  compaction_handoff: "compact",
  goal_policy: "goal",
  delegate: "delegate",
  team_agent_catalog: "team",
  tool_results: "results",
};

export function boardWidth(width) {
  const columns = Number(width ?? process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) {
    return BOARD_MAX_WIDTH;
  }
  return Math.max(BOARD_MIN_WIDTH, Math.min(BOARD_MAX_WIDTH, Math.floor(columns)));
}

export function occupancyTone(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) {
    return "neutral";
  }
  if (value > 0.85) {
    return "err";
  }
  if (value >= 0.6) {
    return "warn";
  }
  return "neutral";
}

const BOARD_FOOTER = "Tab switch page · Esc exit";

export function contextBoardText(page = {}, width) {
  const frameWidth = boardWidth(width);
  const breakdown = isBoardRecord(page.breakdown) ? page.breakdown : null;
  const usage = isBoardRecord(page.latest_usage) ? page.latest_usage : null;
  const plain = page.plain === true;
  const title = "Context · last sampling";
  if (!breakdown || !Array.isArray(breakdown.sections) || !breakdown.sections.length) {
    return boardPanel({
      title,
      lines: boardEmptyLines(frameWidth, "No context sampled yet"),
      footer: BOARD_FOOTER,
      page,
      frameWidth,
      plain,
    });
  }
  const windowTokens = boardNumber(breakdown.context_window_tokens);
  const estimated = boardNumber(breakdown.estimated_total);
  const measured = Math.max(0, boardNumber(usage?.input_tokens));
  const usedPercent = windowTokens > 0 ? estimated / windowTokens : 0;
  const groups = contextDisplayGroups(breakdown.sections);
  const sections = groups.flatMap((group) => group.sections);
  const lines = contextMetaLines(windowTokens, usedPercent, measured, frameWidth - 4);
  const innerWidth = frameWidth - 4;
  if (windowTokens > 0) {
    lines.push(stackedShareBar(sections, windowTokens, innerWidth));
    lines.push(...contextLegendRows(sections, estimated, innerWidth));
  }
  lines.push(...contextSectionRows(groups, estimated, innerWidth));
  return boardPanel({
    title: contextTitle(breakdown, title),
    lines,
    footer: BOARD_FOOTER,
    page,
    frameWidth,
    plain,
  });
}

export function usageBoardText(page = {}, width) {
  const frameWidth = boardWidth(width);
  const summary = isBoardRecord(page.summary) ? page.summary : {};
  const totals = isBoardRecord(summary.totals) ? summary.totals : {};
  const plain = page.plain === true;
  const days = boardNumber(summary.days) || 7;
  const title = `Token usage · last ${days} day${days === 1 ? "" : "s"}`;
  if (!boardNumber(totals.samples)) {
    return boardPanel({
      title,
      lines: boardEmptyLines(frameWidth, "No usage recorded yet"),
      footer: BOARD_FOOTER,
      page,
      frameWidth,
      plain,
    });
  }
  const lines = usageHeroLines(totals, frameWidth - 4);
  lines.push(dim(`${boardNumber(totals.samples)} samples`));
  const byDay = Array.isArray(summary.by_day) ? summary.by_day : [];
  if (byDay.length) {
    lines.push("", bold("By day"), ...byDayRows(byDay, frameWidth - 4));
  }
  const byModel = Array.isArray(summary.by_model) ? summary.by_model : [];
  if (byModel.length) {
    lines.push("", bold("By model"), ...rightRows(byModel.map((row) => [boardText(row?.model), boardCompact(row?.tokens)]), frameWidth - 4));
  }
  const sessions = Array.isArray(summary.recent_sessions) ? summary.recent_sessions : [];
  if (sessions.length) {
    lines.push(
      "",
      bold(`By session (latest ${sessions.length})`),
      ...rightRows(sessions.map((row) => [sessionRowLabel(row), boardCompact(row?.tokens)]), frameWidth - 4),
    );
  }
  const compactions = boardNumber(totals.compactions);
  const footer = compactions > 0
    ? `${formatBoardNumber(compactions)} compaction call${compactions === 1 ? "" : "s"} · ${BOARD_FOOTER}`
    : BOARD_FOOTER;
  return boardPanel({ title, lines, footer, page, frameWidth, plain });
}

function contextTitle(breakdown, fallback) {
  const turn = boardText(breakdown.turn_id);
  const time = boardText(breakdown.captured_at).slice(11, 19);
  const parts = [fallback];
  if (turn) {
    parts.push(`turn ${turn.slice(0, 4)}`);
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    parts.push(time);
  }
  return parts.join(" · ");
}

function contextMetaLines(windowTokens, usedPercent, measured, inner) {
  const tone = occupancyTone(usedPercent);
  const paintTone = tone === "err" ? red : tone === "warn" ? paint.warning : (text) => text;
  const windowPart = `Window ${formatBoardNumber(windowTokens)} · ${paintTone(`used ${Math.round(usedPercent * 100)}%`)}`;
  const measuredPart = measured > 0 ? `measured ${formatBoardNumber(measured)}` : "";
  if (measuredPart && textWidth(`${windowPart}   ${measuredPart}`) > inner) {
    return [windowPart, measuredPart];
  }
  return [measuredPart ? `${windowPart}   ${measuredPart}` : windowPart];
}

function stackedShareBar(sections, windowTokens, cells) {
  const spans = boardSpans(sections, windowTokens, cells);
  const remaining = Math.max(0, cells - spans.reduce((sum, span) => sum + span.cells, 0));
  const bar = spans.map((span, index) => (
    boardPalette(index)(BOARD_BAR_CELL.repeat(span.cells))
  )).join("");
  return `${bar}${dim(BOARD_REMAINDER_CELL.repeat(remaining))}`;
}

function boardSpans(sections, windowTokens, cells) {
  return sections.map((section, index) => ({
    ...section,
    paletteIndex: index,
    cells: Math.max(0, Math.round((boardNumber(section.tokens) / windowTokens) * cells)),
  }));
}

function contextDisplayGroups(sections) {
  const groups = [
    { label: "Core context", sections: [] },
    { label: "Conversation & Tools", sections: [] },
  ];
  let toolResults;
  for (const section of sections) {
    if (isToolResultSection(section)) {
      if (!toolResults) {
        toolResults = {
          key: "tool_results",
          label: "Tool results",
          tokens: 0,
          messages: 0,
        };
        groups[1].sections.push(toolResults);
      }
      toolResults.tokens += Math.max(0, boardNumber(section.tokens));
      toolResults.messages += Math.max(0, boardNumber(section.messages));
      continue;
    }
    (isCoreContextSection(section) ? groups[0] : groups[1]).sections.push(section);
  }
  return groups.filter((group) => group.sections.length);
}

function isToolResultSection(section) {
  return String(section?.key || "").startsWith("tool:");
}

function isCoreContextSection(section) {
  const key = String(section?.key || "");
  return key === "system_prompt"
    || key === "tool_specs"
    || key === "skill_catalog"
    || key === "goal_policy"
    || key === "delegate"
    || key === "team_agent_catalog"
    || key === "rind_init"
    || key.startsWith("rind_docs")
    || key.startsWith("kind:");
}

function contextLegendRows(sections, total, innerWidth) {
  const items = sections.map((section, index) => {
    const tokens = formatBoardNumber(section.tokens);
    const percent = total > 0 ? Math.round((boardNumber(section.tokens) / total) * 100) : 0;
    const label = clipSingleLine(boardShortLabel(section), 14);
    return `${boardPalette(index)("●")} ${label} ${tokens} ${percent}%`;
  });
  const rows = [];
  let row = "";
  for (const item of items) {
    const candidate = row ? `${row}   ${item}` : item;
    if (row && textWidth(candidate) > innerWidth) {
      rows.push(row);
      row = item;
    } else {
      row = candidate;
    }
  }
  if (row) {
    rows.push(row);
  }
  return rows;
}

function contextSectionRows(groups, total, innerWidth) {
  const flatSections = groups.flatMap((group) => group.sections);
  const nameWidth = Math.min(
    Math.max(12, ...flatSections.map((section) => textWidth(boardText(section.label)))),
    Math.max(12, innerWidth - 26),
  );
  const tokenTexts = flatSections.map((section) => formatBoardNumber(section.tokens));
  const tokenWidth = Math.max(6, ...tokenTexts.map(textWidth));
  const messageTexts = flatSections.map((section) => boardMessagesLabel(
    section.messages,
    section.key === "tool_specs" ? "tool" : section.key === "tool_results" ? "result" : "msg",
  ));
  const messageWidth = Math.max(6, ...messageTexts.map(textWidth));
  let sectionIndex = 0;
  return groups.flatMap((group) => {
    const rows = ["", bold(group.label)];
    for (const section of group.sections) {
      const index = sectionIndex;
      const percent = total > 0 ? Math.round((boardNumber(section.tokens) / total) * 100) : 0;
      const marker = `${boardPalette(index)("●")} `;
      rows.push([
        `${marker}${padRight(clipSingleLine(section.label, nameWidth), nameWidth)}`,
        padLeft(tokenTexts[index], tokenWidth),
        padLeft(`${percent}%`, 4),
        padLeft(messageTexts[index], messageWidth),
      ].join("  "));
      sectionIndex += 1;
    }
    return rows;
  });
}

function boardMessagesLabel(count, unit = "msg") {
  const value = Math.max(0, boardNumber(count));
  return `${formatBoardNumber(value)} ${value === 1 ? unit : `${unit}s`}`;
}

function usageHeroLine(totals) {
  const input = Math.max(0, boardNumber(totals.input));
  const cached = Math.max(0, boardNumber(totals.cached));
  const hit = input > 0 ? Math.round((cached / input) * 100) : 0;
  return [
    `Input ${boardCompact(totals.input)}`,
    `Cache hit ${boardCompact(cached)}·${hit}%`,
    `Output ${boardCompact(totals.output)}`,
    `Reasoning ${boardCompact(totals.reasoning)}`,
  ].join("   ");
}

function usageHeroLines(totals, inner) {
  const line = usageHeroLine(totals);
  if (textWidth(stripAnsi(line)) <= inner) {
    return [line];
  }
  return [
    `Input ${boardCompact(totals.input)}   Cache hit ${boardCompact(totals.cached)}`,
    `Output ${boardCompact(totals.output)}   Reasoning ${boardCompact(totals.reasoning)}`,
  ];
}

function byDayRows(byDay, innerWidth) {
  const values = byDay.map((row) => boardCompact(row?.tokens));
  const valueWidth = Math.max(5, ...values.map(textWidth));
  const peak = Math.max(1, ...byDay.map((row) => Math.max(0, boardNumber(row?.tokens))));
  const barCells = Math.max(3, innerWidth - 11 - valueWidth);
  return byDay.map((row, index) => {
    const filled = Math.max(row && boardNumber(row.tokens) > 0 ? 1 : 0, Math.round((Math.max(0, boardNumber(row?.tokens)) / peak) * barCells));
    const bar = accent(BOARD_BAR_CELL.repeat(Math.min(barCells, filled)));
    const region = bar + " ".repeat(Math.max(0, barCells - Math.min(barCells, filled)));
    return `  ${boardDayLabel(row?.day)}  ${region}  ${padLeft(values[index], valueWidth)}`;
  });
}

function boardDayLabel(day) {
  const text = boardText(day);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : " ".repeat(5);
}

function rightRows(rows, innerWidth) {
  const valueWidth = Math.max(5, ...rows.map((row) => textWidth(row[1])));
  const labelWidth = Math.max(1, innerWidth - 2 - valueWidth - 2);
  const clipped = rows.map((row) => clipSingleLine(row[0], labelWidth));
  const columnWidth = Math.max(1, ...clipped.map(textWidth));
  return rows.map((row, index) => `  ${padRight(clipped[index], columnWidth)}  ${padLeft(row[1], valueWidth)}`);
}

function sessionRowLabel(row) {
  const updated = boardText(row?.updated_at);
  const day = /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(5, 10) : "";
  return [day, boardText(row?.session_id)].filter(Boolean).join(" ");
}

function boardShortLabel(section) {
  if (BOARD_SECTION_SHORT_LABELS[section.key]) {
    return BOARD_SECTION_SHORT_LABELS[section.key];
  }
  const label = boardText(section.label);
  return label.split("·")[0].trim().slice(0, 12);
}

function boardPalette(index) {
  const painter = paint[BOARD_PALETTE_ROLES[index % BOARD_PALETTE_ROLES.length]];
  return typeof painter === "function" ? painter : (text) => text;
}

function boardPanel({ title, lines, footer, page, frameWidth, plain }) {
  const index = Math.max(1, boardNumber(page?.index) || 1);
  const count = Math.max(index, boardNumber(page?.count) || 1);
  if (plain) {
    // Interaction hints are meaningless in frame-less pipe output.
    return [bold(clipSingleLine(title, frameWidth)), ...lines].join("\n");
  }
  const inner = frameWidth - 4;
  const pageLabel = count > 1 ? `${index}/${count}` : "";
  const titlePart = ` ${clipSingleLine(title, inner - pageLabel.length - 4)} `;
  const dashes = Math.max(1, frameWidth - 2 - textWidth(titlePart) - (pageLabel ? pageLabel.length + 2 : 0));
  const top = `┌${accent(titlePart)}${dim("─".repeat(dashes))}${pageLabel ? ` ${dim(pageLabel)} ` : ""}┐`;
  const footerLines = footer ? [dim(footer)] : [];
  const bodyRows = [...lines, ...footerLines].map((line) => `${dim("│")} ${padRight(line, inner)} ${dim("│")}`);
  const bottom = `${dim("└")}${dim("─".repeat(frameWidth - 2))}${dim("┘")}`;
  return [top, ...bodyRows, bottom].join("\n");
}

function boardEmptyLines(frameWidth, label) {
  const inner = frameWidth - 4;
  return [
    boardCentered(bold(label || "Nothing sampled yet"), inner),
    boardCentered(dim("Send a message first, then try again."), inner),
  ];
}

function boardCentered(text, inner) {
  return `${" ".repeat(Math.max(0, Math.floor((inner - textWidth(text)) / 2)))}${text}`;
}

function isBoardRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boardText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boardNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatBoardNumber(value) {
  const number = Math.max(0, Math.round(boardNumber(value)));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function boardCompact(value) {
  const number = Math.max(0, boardNumber(value));
  if (number >= 1e6) {
    return `${(number / 1e6).toFixed(2)}M`;
  }
  if (number >= 1e5) {
    return `${Math.round(number / 1e3)}K`;
  }
  if (number >= 1e3) {
    return `${(number / 1e3).toFixed(1)}K`.replace(/\.0K$/, "K");
  }
  return String(Math.round(number));
}

const BOARD_BAR_CELL = "█";
const BOARD_REMAINDER_CELL = "░";

// Shown under the banner of a new conversation, and scrolls away with the first
// message. What it runs on, and the few next steps that apply here.
export function welcomeText(info = {}, cli = {}, frameWidth) {
  const width = Math.max(10, composerWidth(frameWidth));
  const folder = singleLine(String(info.workspace_root || info.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "this folder");
  const runsOn = [info.provider, info.model, info.reasoning_effort].map(singleLine).filter(Boolean).join(" · ");
  const tips = [
    info.has_rind_doc === false && ["/init", "write a RIND.md with notes for every conversation"],
    !cli.tourSeen && ["/tour", "a two-minute walkthrough"],
  ].filter(Boolean).slice(0, 3);
  if (!tips.length) tips.push(["/help", "commands · ← agents"]);
  const fit = text => clipCells(text, width);
  return [
    fit(`${accent("✦")} ${bold(`New conversation in ${folder}`)}`),
    ...(info.management_label ? [fit(`  ${dim(singleLine(info.management_label))}`)] : []),
    ...(runsOn ? [fit(`  ${dim(runsOn)}`)] : []),
    "",
    ...tips.map(([command, what]) => fit(`  ${accent(command)} ${dim(what)}`)),
  ].join("\n");
}

// A conversation opened again: one line about what it is, instead of a welcome.
export function resumeLineText(info = {}, now = Date.now(), frameWidth) {
  if (!info.session_id) return "";
  const count = Number(info.message_count) || 0;
  const parts = [
    singleLine(info.title) || singleLine(info.session_id),
    count ? `${count} message${count === 1 ? "" : "s"}` : "",
    ageText(info.updated_at, now),
  ].filter(Boolean);
  return clipCells(`${accent("↩")} ${bold("Resuming:")} ${dim(parts.join(" · "))}`, Math.max(10, composerWidth(frameWidth)));
}

function ageText(value, now) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

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
  if (!state.running && state.backgroundWait) {
    const waiting = state.backgroundWait;
    const seconds = Math.max(0, Math.floor((state.elapsedMs || 0) / 1000));
    const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    const detail = `${waiting.count} background task${waiting.count === 1 ? "" : "s"}`;
    const prefix = `  ${breathingAccent("Waiting", (state.frame || 0) * 300)} ${dim("·")} `;
    const suffix = ` ${dim("·")} ${dim(`running ${elapsed}`)}`;
    const width = composerWidth(state.frameWidth);
    return clipCells(prefix + dim(middleClipCells(detail, Math.max(0, width - textWidth(prefix + suffix)))) + suffix, width);
  }
  if (!state.running && state.delegatedWait?.length) {
    const names = [...new Set(state.delegatedWait.map(singleLine).filter(Boolean))];
    const detail = names.length ? names.join(", ") : "delegated work";
    const prefix = `  ${breathingAccent("Waiting", (state.frame || 0) * 300)} ${dim("·")} `;
    const suffix = ` ${dim("·")} ${dim("wakes on delivery")}`;
    const width = composerWidth(state.frameWidth);
    return clipCells(prefix + dim(middleClipCells(detail, Math.max(0, width - textWidth(prefix + suffix)))) + suffix, width);
  }
  if (!state.running) {
    return "";
  }
  const elapsed = formatActivityDuration(state.elapsedMs);
  const label = singleLine(state.label) || "Working";
  return `  ${accent(spinnerFrame(state.frame))} ${bold(label)} ${dim(`(${elapsed}) ctrl+c interrupt`)}`;
}

export function backgroundWaitingLine(count = 1) {
  const label = count > 1 ? `Waiting for ${count} background tasks` : "Waiting for background task";
  return `${dim("─")} ${bold(label)}\n  ${dim("Will continue automatically when finished. You can keep typing.")}`;
}

// A long conversation opens on its newest part; the rest loads on demand.
export function historyTruncatedText(hidden) {
  const count = Math.max(0, Number(hidden) || 0);
  return `${dim("…")} ${dim(`${count} earlier message${count === 1 ? "" : "s"} hidden`)} ${dim("·")} ${dim("/history loads more")}`;
}

// After the leader ends its turn with delegated work pending, that is the state
// to show: nothing in this window runs, and results arrive here by themselves.
export function delegatedWaitingLine(names = []) {
  const unique = [...new Set((Array.isArray(names) ? names : [names]).map(singleLine).filter(Boolean))];
  const label = unique.length ? `Waiting for ${unique.join(", ")}` : "Waiting for delegated work";
  return `${dim("─")} ${bold(label)}\n  ${dim("The results are delivered to this conversation when they settle. You can keep typing.")}`;
}

// A turn that runs on a delivered result: show what arrived, one page, wrapped.
export function deliveryBlockText(text, width = 80) {
  const room = Math.max(8, width - 2);
  const content = String(text || "").replace(/\r\n?/g, "\n").trimEnd();
  if (isBriefMode()) {
    const summary = clipSingleLine(content, Math.max(8, width - 14));
    return [summary ? `${dim("─")} ${bold("Delivery")} ${dim(`· ${summary}`)}` : `${dim("─")} ${bold("Delivery")}`];
  }
  const lines = content ? wrapTextWithAnsi(content, room).map(line => "  " + line) : [];
  return [`${dim("─")} ${bold("Delivery")}`, ...lines];
}

export function promptHintLine(state = {}) {
  if (state.menuOpen) {
    return "";
  }
  const text = state.leaveArmed
    ? "  ctrl+c again to leave Rind · agents keep running in the background"
    : state.inputMode === "question"
    ? "  ↑↓ choose · enter confirm · esc cancel"
    : state.emptyInput
      ? "  ← agents · / commands · ↑↓ history"
    : state.running
      ? "  enter steer · tab queue · ctrl+c stop · ctrl+b tasks"
      : "  enter send · ↑↓ history · / commands · ? help";
  return dim(clipCells(text, composerWidth(state.frameWidth)));
}

export function promptPlaceholderText() {
  return "Ask Rind to do anything";
}

export function userInputText(text, width, source = "") {
  const lines = messageLines(text);
  if (!lines.length) {
    return "";
  }
  const contentWidth = userInputContentWidth(width);
  const physicalLines = lines.flatMap((line) => (
    wrapTextCells(line, contentWidth, contentWidth).map((chunk) => `  ${chunk.text}`)
  ));
  const origin = source ? dim(` · via ${source}`) : "";
  return `${accent("▷")} ${bold("You")}${origin}\n${physicalLines.join("\n")}`;
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
    helpRow("ctrl+c", "stop · clear · leave", "?", "show shortcuts"),
    helpRow("ctrl+b", "task monitor", "esc", "close monitor"),
    helpRow("ctrl+o", "toggle tool detail", "← empty", "agents"),
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
    case "sessions":
      return slashSessionsText(display);
    case "skills":
      return slashSkillsText(display);
    case "theme":
      return slashThemeText(display);
    case "spinner":
      return slashSpinnerText(display);
    default:
      return "";
  }
}

export function slashResultNotice(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  if (result.display && typeof result.display === "object" && result.display.type === "brief") {
    const label = result.display.enabled ? "Brief output enabled" : "Brief output disabled";
    return {
      text: `${label} · applies globally across live turns and replayed sessions`,
      level: "info",
    };
  }
  if (slashDisplayText(result.display)) {
    return null;
  }
  const text = String(result.text || "").trim();
  if (!text) {
    return null;
  }
  return {
    text: String(result.text || ""),
    level: result.level || "info",
  };
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

// Shown in place of the deck when the typed command word matches nothing.
export function slashNoMatchText(input) {
  return dim(`  No command matches ${clipSingleLine(input, 40)} · backspace to edit · /help lists them`);
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
  const selected = visible.items[visible.activeIndex];
  const vision = selected?.image_input === true ? "supported" : selected?.image_input === false ? "unsupported" : "unknown";
  lines.push(dim(`  Image input: ${vision}`));
  for (const [index, item] of visible.items.entries()) {
    if (item.header) {
      lines.push(dim(`  ${item.name}`));
      continue;
    }
    const active = index === visible.activeIndex;
    const marker = active ? accent("›") : dim("·");
    const modelId = active ? bold(item.modelId) : dim(item.modelId);
    const suffix = item.current ? dim("current") : "";
    lines.push(`    ${marker} ${padRight(modelId, 34)} ${suffix}`.trimEnd());
  }
  lines.push(dim("    ↑↓ select · enter use · f folder default · g global default · esc cancel"));
  return `${lines.join("\n")}\n`;
}

export function settingsMenuText(items, selectedIndex = 0, level = "root") {
  if (level === "brief") {
    const visible = menuWindow(items, selectedIndex);
    if (!visible.items.length) {
      return "";
    }
    const lines = [dim("  Settings · Brief output")];
    const labelWidth = Math.max(6, ...items.map((item) => visibleLength(clipSingleLine(item?.label || item?.name, 24))));
    const descWidth = Math.max(12, ...items.map((item) => visibleLength(clipSingleLine(item?.description, 56))));
    for (const [index, item] of visible.items.entries()) {
      const active = index === visible.activeIndex;
      const marker = active ? accent("›") : dim("·");
      const label = padRight(clipSingleLine(item?.label || item?.name, 24), labelWidth);
      const name = active ? bold(label) : dim(label);
      const rawDesc = clipSingleLine(item?.description, 56);
      const desc = rawDesc ? dim(padRight(rawDesc, descWidth)) : "";
      const suffix = item?.current ? dim("current") : "";
      lines.push(`  ${marker} ${name}${desc ? `  ${desc}` : ""}${suffix ? `  ${suffix}` : ""}`.trimEnd());
    }
    lines.push(dim("    ↑↓ select · enter apply · esc back"));
    return `${lines.join("\n")}\n`;
  }
  if (level === "theme") {
    const visible = menuWindow(items, selectedIndex);
    if (!visible.items.length) {
      return "";
    }
    const lines = [dim("  Settings · Theme")];
    const labelWidth = Math.max(12, ...items.map((item) => visibleLength(clipSingleLine(item?.label || item?.name, 24))));
    for (const [index, item] of visible.items.entries()) {
      const active = index === visible.activeIndex;
      const marker = active ? accent("›") : dim("·");
      const label = padRight(clipSingleLine(item?.label || item?.name, 24), labelWidth);
      const name = active ? bold(label) : dim(label);
      const suffix = item?.current ? dim("current") : "";
      lines.push(`  ${marker} ${name}  ${flavorSwatch(item?.name)}${suffix ? `  ${suffix}` : ""}`);
    }
    lines.push(dim("    ↑↓ select · enter apply · esc back"));
    return `${lines.join("\n")}\n`;
  }
  if (level === "spinner") {
    const visible = menuWindow(items, selectedIndex);
    if (!visible.items.length) {
      return "";
    }
    const lines = [dim("  Settings · Working spinner")];
    const labelWidth = Math.max(10, ...items.map((item) => visibleLength(clipSingleLine(item?.label || item?.name, 24))));
    const previewWidth = Math.max(12, ...items.map((item) => visibleLength(clipSingleLine(item?.preview || (Array.isArray(item?.frames) ? item.frames.join(" ") : ""), 48))));
    for (const [index, item] of visible.items.entries()) {
      const active = index === visible.activeIndex;
      const marker = active ? accent("›") : dim("·");
      const label = padRight(clipSingleLine(item?.label || item?.name, 24), labelWidth);
      const name = active ? bold(label) : dim(label);
      const rawPreview = clipSingleLine(item?.preview || (Array.isArray(item?.frames) ? item.frames.join(" ") : ""), 48);
      const paddedPreview = padRight(rawPreview, previewWidth);
      const preview = active || item?.current ? accent(paddedPreview) : dim(paddedPreview);
      const suffix = item?.current ? dim("current") : "";
      lines.push(`  ${marker} ${name}  ${preview}${suffix ? `  ${suffix}` : ""}`.trimEnd());
    }
    lines.push(dim("    ↑↓ select · enter apply · esc back"));
    return `${lines.join("\n")}\n`;
  }
  if (level === "import") {
    const labelWidth = Math.max(16, ...items.map((item) => visibleLength(item.label)));
    const lines = [dim("  Settings · Import skills into this conversation")];
    const pathWidth = Math.max(18, slashContentWidth() - labelWidth - 22);
    for (const [index, item] of items.entries()) {
      const active = index === selectedIndex;
      const marker = active ? accent("›") : dim("·");
      const box = item.chosen ? accent("[x]") : dim("[ ]");
      const label = padRight(item.label, labelWidth);
      const name = active ? bold(label) : dim(label);
      const paths = (Array.isArray(item.paths) ? item.paths : []).map(prettySkillLocation).join(" · ");
      const count = Number(item.count) || 0;
      const found = count ? `${count} ${count === 1 ? "skill" : "skills"}` : "—";
      lines.push(`  ${marker} ${box} ${name}  ${dim(padRight(clipSingleLine(paths, pathWidth), pathWidth))}  ${dim(found)}`);
    }
    lines.push(dim("    ↑↓ select · space toggle · enter apply · esc back"));
    return `${lines.join("\n")}\n`;
  }
  const labelWidth = Math.max(16, ...items.map((item) => visibleLength(item.label)));
  const valueWidth = Math.max(11, ...items.map((item) => visibleLength(item.value || "")));
  const lines = [dim("  Settings")];
  const descWidth = Math.max(18, slashContentWidth() - labelWidth - valueWidth - 10);
  for (const [index, item] of items.entries()) {
    const active = index === selectedIndex;
    const marker = active ? accent("›") : dim("·");
    const label = padRight(item.label, labelWidth);
    const name = active ? bold(label) : dim(label);
    const rawValue = String(item.value || "");
    const paddedValue = padRight(rawValue, valueWidth);
    const value = active ? accent(paddedValue) : dim(paddedValue);
    const description = item.description ? `  ${dim(clipSingleLine(item.description, descWidth))}` : "";
    lines.push(`  ${marker} ${name}  ${value}${description}`);
  }
  lines.push(dim("    ↑↓ select · enter open · esc cancel"));
  return `${lines.join("\n")}\n`;
}

export function remoteMenuText(remoteState, width = process.stdout.columns) {
  if (!remoteState) return "";
  const level = remoteState.level();
  if (level === "qr") {
    const qrView = remoteState.qrView();
    if (!qrView) return "";
    const lines = [
      dim(`  Remote access · QR code (${qrView.scopeLabel} · ${qrView.clientLabel})`),
    ];
    if (qrView.notice) {
      lines.push(`  ${accent(qrView.notice)}`);
    }
    if (qrView.qrBlock) {
      lines.push("");
      for (const qrLine of qrView.qrBlock.split("\n")) {
        lines.push(`  ${qrLine}`);
      }
      lines.push("");
    }
    lines.push(`  ${dim("Sign-in URL:")} ${accent(qrView.pairingUrl)}`);
    lines.push(`  ${dim("Address:")}     ${qrView.primaryAddress}`);
    if (qrView.alternates.length > 0) {
      lines.push(`  ${dim("Alternates:")}  ${dim(qrView.alternates.join(", "))}`);
    }
    lines.push(`  ${dim("Access code:")} ${bold(qrView.accessCode)}`);
    lines.push(dim("    r rotate code · ← back · esc close"));
    return `${lines.join("\n")}\n`;
  }
  const items = remoteState.items();
  const selectedIndex = remoteState.selectedIndex();
  if (level === "scope" || level === "address") {
    const visible = menuWindow(items, selectedIndex);
    if (!visible.items.length) return "";
    const title = level === "scope" ? "Remote access · Network scope" : "Remote access · Address";
    const lines = [dim(`  ${title}`)];
    const labelWidth = Math.max(12, ...items.map((item) => visibleLength(clipSingleLine(item?.label || item?.name, 36))));
    const descWidth = Math.max(16, ...items.map((item) => visibleLength(clipSingleLine(item?.description, 56))));
    for (const [index, item] of visible.items.entries()) {
      const active = index === visible.activeIndex;
      const marker = active ? accent("›") : dim("·");
      const label = padRight(clipSingleLine(item?.label || item?.name, 36), labelWidth);
      const name = active ? bold(label) : dim(label);
      const rawDesc = clipSingleLine(item?.description, 56);
      const desc = rawDesc ? dim(padRight(rawDesc, descWidth)) : "";
      const suffix = item?.current ? dim("current") : "";
      lines.push(`  ${marker} ${name}${desc ? `  ${desc}` : ""}${suffix ? `  ${suffix}` : ""}`.trimEnd());
    }
    lines.push(dim("    ↑↓ select · enter apply · esc back"));
    return `${lines.join("\n")}\n`;
  }
  if (!items.length) return "";
  const labelWidth = Math.max(18, ...items.map((item) => visibleLength(item.label)));
  const valueWidth = Math.max(11, ...items.map((item) => visibleLength(item.value || "")));
  const lines = [dim("  Remote access")];
  const columns = Number(width);
  const contentWidth = Number.isFinite(columns) && columns > 0 ? Math.max(28, Math.min(96, columns - 6)) : slashContentWidth();
  const descWidth = Math.max(18, contentWidth - labelWidth - valueWidth - 10);
  for (const [index, item] of items.entries()) {
    const active = index === selectedIndex;
    const marker = active ? accent("›") : dim("·");
    const label = padRight(item.label, labelWidth);
    const name = active ? bold(label) : dim(label);
    const rawValue = String(item.value || "");
    const paddedValue = padRight(rawValue, valueWidth);
    const value = active ? accent(paddedValue) : dim(paddedValue);
    const description = item.description ? `  ${dim(clipSingleLine(item.description, descWidth))}` : "";
    lines.push(`  ${marker} ${name}  ${value}${description}`);
  }
  lines.push(dim("    ↑↓ select · space/enter toggle or open · esc close"));
  return `${lines.join("\n")}\n`;
}

export function taskMonitorTabs(_page = "background", backgroundCount = 0) {
  return `${bold(accent("› Background"))} ${dim(`[${Math.max(0, Number(backgroundCount) || 0)}]`)}`;
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
  editorCursor = null,
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
    const isCustom = option.label === customLabel;
    const customText = String(customInput || "");
    const labelLines = isCustom && editing
      ? wrapQuestionLines(customText || `${customLabel}:`, Math.max(1, width - 4))
      : wrapQuestionLines(option.label, Math.max(1, width - 4));
    const labelStyle = isCustom && editing && !customText ? dim : active ? bold : dim;
    let firstPushedLine = -1;
    let lastPushedLine = -1;
    let firstPrefixWidth = 0;
    for (const [lineIndex, labelLine] of labelLines.entries()) {
      const prefix = lineIndex === 0 ? `  ${marker} ` : "    ";
      lines.push(`${prefix}${labelStyle(labelLine)}`);
      if (firstPushedLine === -1) {
        firstPushedLine = lines.length - 1;
        firstPrefixWidth = textWidth(prefix);
      }
      lastPushedLine = lines.length - 1;
    }
    if (active && editing && isCustom) {
      if (editorCursor) {
        cursor = customAnswerCursor(
          customText,
          editorCursor,
          Math.max(0, firstPushedLine),
          firstPrefixWidth,
          Math.max(1, width - 4),
        );
      } else {
        const cursorLine = customText ? Math.max(0, lastPushedLine) : Math.max(0, firstPushedLine);
        const cursorColumn = customText
          ? textWidth(lines[cursorLine])
          : firstPrefixWidth;
        cursor = {
          line: cursorLine,
          column: Math.max(0, cursorColumn),
        };
      }
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
  lines.push(dim("    ↑↓ select · enter confirm · esc skip"));
  return { text: `${lines.join("\n")}\n`, cursor };
}

function wrapQuestionLines(value, width) {
  const text = String(value || "").replace(/\r?\n/g, " ").trim();
  return wrapTextCells(text, Math.max(1, width), Math.max(1, width)).map((chunk) => chunk.text);
}

function customAnswerCursor(customText, editorCursor, firstRow, prefixWidth, labelWidth) {
  const rawLines = String(customText || "").split("\n");
  const line = Math.min(rawLines.length - 1, Math.max(0, Math.floor(Number(editorCursor.line) || 0)));
  const column = Math.min(
    graphemes(rawLines[line]).length,
    Math.max(0, Math.floor(Number(editorCursor.column) || 0)),
  );
  const before = [...rawLines.slice(0, line), graphemes(rawLines[line]).slice(0, column).join("")]
    .join(" ")
    .trim();
  const chunks = wrapTextCells(before, Math.max(1, labelWidth), Math.max(1, labelWidth));
  return {
    line: firstRow + chunks.length - 1,
    column: prefixWidth + textWidth(chunks[chunks.length - 1].text),
  };
}


export function authSecretFrame({
  title = "",
  message = "",
  kind = "text",
  value = "",
  width = 76,
  cursor = null,
} = {}) {
  const box = startupBannerWidth(width);
  const masked = kind === "secret";
  const prefix = "  ▷ ";
  const valueWidth = box - 2 - textWidth(prefix) - 1;
  const chars = graphemes(String(value || ""));
  const shown = chars.length
    ? clipCells(masked ? "•".repeat(chars.length) : chars.join(""), valueWidth)
    : dim(clipCells(masked ? "paste or type the key — hidden" : "type and press enter", valueWidth));
  const caret = Math.min(chars.length, Math.max(0, Math.floor(Number(cursor?.column) || 0)));
  const lines = [
    authFrameTitle(`Login · ${title}`.trim(), box),
    ...(message && message !== title ? [startupBannerLine(dim(clipCells(message, box - 4)), box)] : []),
    startupBannerLine(`${prefix}${shown}`, box),
    startupBannerLine("", box),
    startupBannerLine(dim("enter submit · esc cancel"), box),
    startupBannerBorder("└", "┘", box),
  ];
  const valueRow = (message && message !== title ? 2 : 1);
  const visibleCaret = chars.length
    ? Math.min(valueWidth, textWidth(chars.slice(0, caret).join("")))
    : 0;
  return {
    text: `${lines.join("\n")}\n`,
    cursor: { line: valueRow, column: 2 + textWidth(prefix) + visibleCaret },
  };
}

const AUTH_CHOICE_WINDOW = 9;

// A boxed list of choices; the message above it wraps in full, so a decision
// is never asked with its explanation cut off.
export function choiceDialogFrame({ title = "", message = "", options = [], selectedIndex = 0, width = 76 } = {}) {
  const box = startupBannerWidth(width);
  const inner = box - 4;
  const values = (Array.isArray(options) ? options : []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!values.length) {
    return "";
  }
  const start = values.length <= AUTH_CHOICE_WINDOW
    ? 0
    : Math.min(Math.max(0, selectedIndex - (AUTH_CHOICE_WINDOW - 2)), values.length - AUTH_CHOICE_WINDOW);
  const end = Math.min(values.length, start + AUTH_CHOICE_WINDOW);
  const explanation = String(message || "").trim()
    ? wrapTextWithAnsi(String(message).trim(), inner).map((line) => startupBannerLine(dim(line), box))
    : [];
  const lines = [authFrameTitle(title, box), ...explanation, ...(explanation.length ? [startupBannerLine("", box)] : [])];
  if (start > 0) {
    lines.push(startupBannerLine(dim("…"), box));
  }
  for (let index = start; index < end; index += 1) {
    const active = index === selectedIndex;
    const marker = active ? accent("›") : dim("·");
    const parts = values[index].split(" · ");
    const id = clipCells(parts[0] || "", Math.max(8, inner - 8));
    const rest = parts.length > 1 ? clipCells(`· ${parts.slice(1).join(" · ")}`, Math.max(0, inner - 6 - textWidth(id))) : "";
    const content = `${marker} ${active ? bold(id) : id}${rest ? ` ${dim(rest)}` : ""}`;
    lines.push(startupBannerLine(content, box));
  }
  if (end < values.length) {
    lines.push(startupBannerLine(dim("…"), box));
  }
  lines.push(startupBannerLine("", box));
  lines.push(startupBannerLine(dim("↑↓ select · enter choose · esc cancel"), box));
  lines.push(startupBannerBorder("└", "┘", box));
  return `${lines.join("\n")}\n`;
}

function authFrameTitle(title, box) {
  const label = clipCells(String(title || "").trim(), Math.max(1, box - 7));
  if (!label) {
    return startupBannerBorder("┌", "┐", box);
  }
  const dashes = Math.max(1, box - visibleLength(label) - 5);
  return dim(`┌─ ${label} ${"─".repeat(dashes)}┐`);
}

export function backgroundMonitorText(tasks = [], selectedIndex = 0, selectedTask = null, width = 76) {
  const items = Array.isArray(tasks) ? tasks : [];
  const lines = [dim("  ←→ page · ↑↓/j/k select · esc/ctrl+b close")];
  if (items.some((task) => task.task_id)) lines.push(dim("  r release wait · c cancel task"));
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
  const heading = `${singleLine(task.task_id || task.bg_id) || "unknown"} · ${singleLine(task.status) || "unknown"}${task.notify ? ` · ${task.notify} · ${Math.round((Number(task.elapsed_ms) || 0) / 1000)}s` : ""}`;
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

export function taskMonitorFrame({ page, backgroundCount, items, index, selected,
  foreground, foregroundIndex, foregroundCount, focus, preview, previewOffset, loading, error, width, height }) {
  const columns = Math.max(1, Math.floor(Number(width) || 80));
  const rows = Math.max(0, Math.floor(Number(height ?? 24) || 0));
  if (!rows) return { lines: [] };
  const inner = Math.max(1, columns - 4);
  const tabs = taskMonitorTabs(page, backgroundCount).split("\n");
  const foregroundLine = foreground && page === "background"
    ? `  ${focus === "foreground" ? accent("›") : dim("·")} ${dim(`Waiting ${foregroundIndex + 1}/${foregroundCount} · r background ·`)} ${clipSingleLine(foreground.command || foreground.bg_id, inner)}`
    : "";
  const footer = (rows >= 14 && columns >= 65 ? [
    "  ↑↓ select · tab focus · r release · c cancel",
    "  PgUp/PgDn output · End tail · esc/ctrl+b close",
  ] : [rows >= 7 && columns >= 60 ? "  ↑↓ select · tab focus · r release · c cancel · esc close" : "  esc close"]).map(dim);
  const list = Array.isArray(items) ? items : [];
  const emptyRow = dim("  No background tasks.");
  if (rows <= 2) {
    const selectedRow = focus === "foreground" && foregroundLine ? foregroundLine
      : list.length ? taskMonitorRow(page, selected, focus === "list", inner) : emptyRow;
    return { lines: rows === 1
      ? [columns > 4 ? `${clipCells(selectedRow, columns - 4)} ${dim("esc")}` : clipCells(dim("esc"), columns)]
      : [clipCells(selectedRow, columns), clipCells(footer[0], columns)] };
  }
  const lines = [];
  if (rows >= 8) lines.push(...tabs);
  else if (rows >= 5) lines.push(tabs.length === 1 ? tabs[0] : tabs[0]);
  if (foregroundLine) lines.push(foregroundLine);
  const status = error ? dim(`  ${error}`) : loading ? dim("  Loading tasks…") : "";
  const statusRows = status && rows - lines.length - footer.length >= 2 ? 1 : 0;
  const capacity = Math.max(0, rows - lines.length - footer.length - statusRows);
  const detailRows = selected && capacity >= 3 ? 1 : 0;
  const positionRows = list.length > 1 && capacity >= 4 ? 1 : 0;
  const previewReserve = detailRows ? Math.min(6, Math.max(0, capacity - detailRows - positionRows - 1)) : 0;
  const listSize = Math.min(5, list.length || 1,
    Math.max(0, capacity - detailRows - positionRows - previewReserve));
  const start = Math.min(Math.max(0, index - Math.floor(listSize / 2)), Math.max(0, list.length - listSize));
  if (positionRows) lines.push(dim(`  ${index + 1}/${list.length}`));
  if (list.length) {
    for (const [offset, item] of list.slice(start, start + listSize).entries()) {
      lines.push(taskMonitorRow(page, item, focus === "list" && start + offset === index, inner));
    }
  } else if (listSize) lines.push(emptyRow);
  if (detailRows) {
    const available = Math.max(0, rows - lines.length - footer.length - statusRows);
    lines.push(...(focus === "foreground"
      ? [dim("  ↑↓ select task · r release waiting task")]
      : taskMonitorDetail(page, selected, preview, previewOffset, inner, available)));
  }
  if (statusRows) lines.push(status);
  lines.push(...footer);
  return { lines: lines.map((line) => clipCells(line, columns)) };
}

function taskMonitorRow(page, item, active, width) {
  const marker = active ? accent("›") : dim("·");
  const label = item?.bg_id;
  const detail = item?.command;
  const prefix = `  ${marker} ${clipSingleLine(label, 14)}  ${clipSingleLine(item?.status, 10)}`;
  const rest = Math.max(0, width - visibleLength(prefix) - 2);
  return clipCells(`${prefix}  ${dim(clipSingleLine(detail, rest))}`.trimEnd(), width + 4);
}

function taskMonitorDetail(page, selected, preview, offset, width, maxRows) {
  if (!selected) return [];
  const heading = dim(`  ${clipSingleLine(`${selected.bg_id} · ${selected.status}`, width)}`);
  if (!preview) return [heading, dim("  Loading output…")].slice(0, maxRows);
  if (preview.error) return [heading, dim(`  Output unavailable: ${clipSingleLine(preview.error, width - 22)}`)].slice(0, maxRows);
  const output = [preview.stdout, preview.stderr].filter(Boolean).join("\n");
  const content = output ? output.split(/\r?\n/) : ["(no output)"];
  const warnings = [];
  if (preview.expired) warnings.push("Output expired; preview incomplete");
  else if (preview.limited) warnings.push("Earlier output outside preview");
  return [heading, ...previewWindow(content, offset, width, warnings, maxRows - 1)];
}

function previewWindow(content, offset, width, warnings, height) {
  if (height <= 0) return [];
  if (offset >= content.length) return [dim("  Earlier output unavailable in preview")];
  const warningRows = Math.min(warnings.length, Math.max(0, height - 1));
  const outputRows = Math.max(1, height - warningRows);
  const start = Math.max(0, content.length - Math.max(0, offset) - outputRows);
  const end = Math.max(start, content.length - Math.max(0, offset));
  return [
    ...content.slice(start, end).map((line) => `  ${clipSingleLine(line, width)}`),
    ...warnings.slice(0, warningRows).map((warning) => dim(`  ${warning}`)),
  ].slice(0, height);
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
  const sessionId = singleLine(info.session_id) || "new";
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
    return `${label} · No active goal`;
  }
  return `${label} · ${goal.status} · ${clipSingleLine(goal.objective, 80)}`;
}

export function modelListErrorText(error, currentModel = "") {
  const current = clipSingleLine(currentModel, 96);
  const detail = clipSingleLine(error, 96);
  return [
    detail ? `Model list unavailable: ${detail}` : "Model list unavailable",
    current ? `current: ${current}` : "",
    "use /model set <name> to switch manually",
  ].filter(Boolean).join("\n");
}

export function turnCompletedLine(event, tools = { completed: 0, failed: 0 }) {
  const duration = formatDuration(event.duration_ms);
  const summary = toolSummary(tools);
  return summary
    ? `${green("─")} ${bold("Worked for")} ${duration} ${dim(`· ${summary}`)}`
    : `${green("─")} ${bold("Worked for")} ${duration}`;
}

export function interruptText() {
  return "Interrupt requested · ctrl+c again to quit";
}

export function cancelledText() {
  return "Interrupted · session preserved; resume with -c";
}

const SYSTEM_NOTICE_PREFIX = "· System:";
const SYSTEM_NOTICE_HEAD_WIDTH = 12;
const SYSTEM_NOTICE_INDENT = " ".repeat(SYSTEM_NOTICE_HEAD_WIDTH);
const SYSTEM_NOTICE_NARROW_INDENT = "    ";

export function systemNoticeLines(text, { level = "info", width, color = colorEnabled() } = {}) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trimEnd();
  if (!normalized.trim()) {
    return [];
  }
  const formatFirstLine = (chunk) => {
    if (!color) {
      return chunk ? `  ${SYSTEM_NOTICE_PREFIX} ${chunk}` : `  ${SYSTEM_NOTICE_PREFIX}`;
    }
    if (level === "warning") {
      return chunk
        ? `  ${paintRaw.warning(SYSTEM_NOTICE_PREFIX)} ${paintRaw.dim(chunk)}`
        : `  ${paintRaw.warning(SYSTEM_NOTICE_PREFIX)}`;
    }
    if (level === "error") {
      return chunk
        ? `  ${paintRaw.danger(SYSTEM_NOTICE_PREFIX)} ${chunk}`
        : `  ${paintRaw.danger(SYSTEM_NOTICE_PREFIX)}`;
    }
    return `  ${paintRaw.dim(chunk ? `${SYSTEM_NOTICE_PREFIX} ${chunk}` : SYSTEM_NOTICE_PREFIX)}`;
  };
  const formatContinuationLine = (chunk, indent) => {
    if (!chunk) {
      return "";
    }
    if (!color || level === "error") {
      return `${indent}${chunk}`;
    }
    return `${indent}${paintRaw.dim(chunk)}`;
  };

  const logicalLines = normalized.split("\n");
  if (width === undefined) {
    return logicalLines.map((line, index) => (
      index === 0 ? formatFirstLine(line) : formatContinuationLine(line, SYSTEM_NOTICE_INDENT)
    ));
  }

  const columns = Math.max(1, Math.floor(Number(width) || 0));
  if (columns < SYSTEM_NOTICE_HEAD_WIDTH + 1) {
    const raw = `  ${SYSTEM_NOTICE_PREFIX} ${logicalLines.join(" ")}`;
    return wrapTextCells(raw, columns, columns).map(({ text: chunk }) => {
      if (!color || !chunk) return chunk;
      if (level === "warning") return paintRaw.warning(chunk);
      if (level === "error") return paintRaw.danger(chunk);
      return paintRaw.dim(chunk);
    });
  }

  const contIndent = columns - SYSTEM_NOTICE_HEAD_WIDTH < 16
    ? SYSTEM_NOTICE_NARROW_INDENT
    : SYSTEM_NOTICE_INDENT;
  const firstBodyWidth = Math.max(1, columns - SYSTEM_NOTICE_HEAD_WIDTH);
  const contBodyWidth = Math.max(1, columns - contIndent.length);
  const lines = [];
  for (const [index, logicalLine] of logicalLines.entries()) {
    if (index === 0) {
      if (!logicalLine) {
        lines.push(formatFirstLine(""));
        continue;
      }
      const firstCharWidth = textWidth(graphemes(logicalLine)[0] || "");
      if (firstCharWidth > firstBodyWidth) {
        lines.push(formatFirstLine(""));
        for (const chunk of wrapTextCells(logicalLine, contBodyWidth, contBodyWidth)) {
          lines.push(formatContinuationLine(chunk.text, contIndent));
        }
        continue;
      }
      const chunks = wrapTextCells(logicalLine, firstBodyWidth, contBodyWidth);
      lines.push(formatFirstLine(chunks[0].text));
      for (const chunk of chunks.slice(1)) {
        lines.push(formatContinuationLine(chunk.text, contIndent));
      }
      continue;
    }
    if (!logicalLine) {
      lines.push("");
      continue;
    }
    for (const chunk of wrapTextCells(logicalLine, contBodyWidth, contBodyWidth)) {
      lines.push(formatContinuationLine(chunk.text, contIndent));
    }
  }
  return lines;
}

export function systemNoticeLine(text, options = {}) {
  return systemNoticeLines(text, options).join("\n");
}

export function contextBuiltLine(event) {
  const decisions = event.decisions && typeof event.decisions === "object" ? event.decisions : {};
  if (!decisions.rind_docs_truncated) {
    return "";
  }
  const scopes = Array.isArray(decisions.rind_docs_truncated_scopes)
    ? decisions.rind_docs_truncated_scopes.join(", ")
    : "unknown";
  return `Context trimmed · RIND.md: ${clipSingleLine(scopes, 96)}`;
}

export function toolRequestedLine(event) {
  const name = event.tool_name || "unknown";
  const detail = toolDetail(name, parseJsonObject(event.args_preview));
  const label = toolLabel(name);
  const line = `${accent("◌")} ${bold("Tool")} ${dim("·")} ${toolActiveVerb(name)} ${label}`;
  return indentToolText(detail ? `${line}\n${dim(toolDetailLine(name, detail))}` : line);
}

export function toolStartedLine(event) {
  const name = event.tool_name || "tool";
  return indentToolText(`${accent("◌")} ${bold("Tool")} ${dim("·")} ${toolActiveVerb(name)} ${toolLabel(name)}`);
}

export function toolResultLine(event, fileChange) {
  const name = event.tool_name || "unknown";
  const label = toolLabel(name);
  const duration = formatDuration(event.duration_ms);
  if (event.status === "failed") {
    const suffix = event.error_type ? ` (${event.error_type})` : "";
    const detail = toolErrorDetail(event.result);
    const line = `${red("⊘")} ${bold("Tool")} ${dim("·")} ${label} failed in ${duration}${suffix}`;
    return indentToolText(detail ? `${line}\n${dim(detailLine(detail))}` : line);
  }
  const result = toolResultSummary(event.result);
  if (result.status === "running" && (name === "bash" || name === "bash_output")) {
    const runningText = name === "bash_output"
      ? "command output read; command still running in background"
      : "command running in background";
    const line = `${accent("◌")} ${bold("Tool")} ${dim("·")} ${runningText} in ${duration}`;
    const output = result.output;
    return indentToolText([line, output ? dim(detailLine(output)) : "", fileChangeLine(fileChange)]
      .filter(Boolean)
      .join("\n"));
  }
  const line = result.exitCode
    ? `${red("⊘")} ${bold("Tool")} ${dim("·")} ${label} exited ${result.exitCode} in ${duration}`
    : `${green("◉")} ${bold("Tool")} ${dim("·")} ${completedToolText(name, label)} in ${duration}`;
  const output = result.output;
  return indentToolText([line, output ? dim(detailLine(output)) : "", fileChangeLine(fileChange)]
    .filter(Boolean)
    .join("\n"));
}

function indentToolText(value) {
  return String(value || "")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function planUpdatedLine(plan) {
  if (isBriefMode()) {
    return "";
  }
  const items = Array.isArray(plan) ? plan : [];
  if (!items.length) {
    return `  ${green("◉")} ${bold("Plan cleared")}`;
  }

  const lines = [`  ${green("◉")} ${bold("Plan updated")}`];
  for (const item of items) {
    const step = clipSingleLine(item?.step, detailTextWidth());
    if (step) {
      lines.push(`    ${planStatusIcon(item?.status)} ${step}`);
    }
  }
  return lines.join("\n");
}

export function errorLine(error) {
  const detail = clipSingleLine(error, 120);
  return detail
    ? `${red("⊘")} ${bold("Turn failed")}\n${dim(detailLine(detail))}`
    : `${red("⊘")} ${bold("Turn failed")}`;
}

export function questionText(event = {}) {
  return `  Q: ${clipSingleLine(event.question || "Input required", 76)}`;
}

export function questionAnswerText(event = {}, answer = "") {
  const question = clipSingleLine(event.question || "Input required", 76);
  const value = clipSingleLine(String(answer || "").trim() || "(no answer)", 76);
  return [`  ${dim("Q:")} ${question}`, `  ${green("A:")} ${value}`].join("\n");
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
  const lines = [slashConfigText({ entries: display.entries })];
  lines.push("", sectionRule("Assistant sampling"));
  const usage = Array.isArray(display.usage) ? display.usage[0] : null;
  if (!usage) {
    lines.push(dim("  no completed sampling yet"));
    return lines.join("\n");
  }
  const windowTokens = Number(usage.context_window_tokens) || 0;
  if (windowTokens > 0) {
    lines.push(kvRow("context", `${usageMeter(usage.context_usage_percent)} ${dim(formatPercent(usage.context_usage_percent))}`));
    lines.push(kvRow("input", `${formatCount(usage.input_tokens)} ${dim(`/ ${formatCount(windowTokens)} tokens`)}`));
  } else {
    lines.push(kvRow("input", formatCount(usage.input_tokens)));
  }
  lines.push(kvRow("cached", `${formatCount(usage.cached_input_tokens)} ${dim(`· ${formatPercent(usage.cache_hit_rate)} hit`)}`));
  lines.push(kvRow("output", formatCount(usage.output_tokens)));
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

// Every Skill layer with what it contributes; switched-off imports stay one
// line so they can be found again, and problems close the list.
function slashSkillsText(display) {
  const sources = (Array.isArray(display.sources) ? display.sources : []).filter((source) => source && typeof source === "object");
  const problems = (Array.isArray(display.problems) ? display.problems : []).filter((problem) => problem && typeof problem === "object");
  const skillsOf = (source) => (Array.isArray(source.skills) ? source.skills : []).filter((skill) => skill && typeof skill === "object");
  const shown = sources.filter((source) => source.enabled ? skillsOf(source).length : source.importable);
  const enabled = shown.filter((source) => source.enabled);
  const disabled = shown.filter((source) => !source.enabled);
  const available = enabled.flatMap(skillsOf).filter((skill) => skill.status === "active" || skill.status === "hidden").length;
  const lines = [sectionRule("Skills", available ? `${available} available` : "")];
  if (!shown.length) lines.push(dim("  no skills found"));
  const width = slashContentWidth();
  const nameWidth = Math.min(24, Math.max(12, ...enabled.flatMap(skillsOf).map((skill) => visibleLength(clipSingleLine(skill.name, 24)))));
  const addSection = (...rows) => {
    if (lines.length > 1) lines.push("");
    lines.push(...rows);
  };
  for (const source of enabled) {
    const paths = middleClip(
      (Array.isArray(source.paths) ? source.paths : []).map(prettySkillLocation).filter(Boolean).join(" · "),
      Math.max(18, width - visibleLength(source.label) - 4),
    );
    const group = [paths ? `  ${bold(source.label)}  ${promptPath(paths)}` : `  ${bold(source.label)}`];
    for (const skill of skillsOf(source)) {
      group.push(skillRowText(skill, nameWidth, Math.max(18, width - nameWidth - 6)));
    }
    addSection(...group);
  }
  if (disabled.length) {
    const labelWidth = Math.max(nameWidth + 2, ...disabled.map((source) => visibleLength(source.label)));
    const counts = disabled.map((source) => {
      const count = skillsOf(source).length;
      return `off · ${count} ${count === 1 ? "skill" : "skills"}`;
    });
    const countWidth = Math.max(...counts.map(visibleLength));
    addSection(...disabled.map((source, index) => {
      const label = padRight(source.label, labelWidth);
      const status = padRight(counts[index], countWidth);
      return `  ${dim(`${label}  ${status} · `)}${accent("/settings")}${dim(" to enable")}`;
    }));
  }
  if (problems.length) {
    addSection(
      `  ${paint.warning(bold("Problems"))}`,
      ...problems.map((problem) => {
        const location = prettySkillLocation(problem.location);
        const colWidth = Math.max(nameWidth, visibleLength(location));
        const message = clipSingleLine(problem.message, Math.max(18, width - colWidth - 6));
        return `    ${promptPath(padRight(location, colWidth))}  ${dim(message)}`;
      }),
    );
  }
  return lines.join("\n");
}

function skillRowText(skill, nameWidth, noteWidth) {
  const name = padRight(clipSingleLine(skill.name, 24), nameWidth);
  if (skill.status === "overridden") {
    const note = middleClip(`overridden by ${prettySkillLocation(skill.overridden_by)}`, noteWidth);
    return `    ${dim(name)}  ${dim(note)}`;
  }
  if (skill.status === "hidden") {
    const prefix = "only via /skill:name";
    const clipped = clipSingleLine(skill.description ? `${prefix} · ${skill.description}` : prefix, noteWidth);
    const note = clipped.startsWith(prefix)
      ? `${paint.warning(prefix)}${dim(clipped.slice(prefix.length))}`
      : paint.warning(clipped);
    return `    ${accent(name)}  ${note}`;
  }
  return `    ${accent(name)}  ${dim(clipSingleLine(skill.description, noteWidth))}`;
}


// Paths read best compressed: collapse the home directory to "~" and drop the
// redundant SKILL.md filename that every entry shares.
function prettySkillLocation(value) {
  let location = String(value || "").trim();
  if (!location) {
    return "";
  }
  location = location.replace(/[\\/]+SKILL\.md$/i, "");
  const home = homedir();
  if (home && (location === home || location.startsWith(home))) {
    const rest = location.slice(home.length);
    location = rest ? `~${rest}` : "~";
  }
  return location;
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
  const lines = [sectionRule("Config")];
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
  const current = singleLine(display.current) || DEFAULT_THEME;
  const meta = display.changed && display.previous
    ? `${singleLine(display.previous)} → ${current}`
    : current;
  const lines = [sectionRule("Theme", meta)];
  if (!flavors.length) {
    lines.push(dim(`  active: ${current}`));
    return lines.join("\n");
  }
  const labelWidth = Math.min(
    24,
    Math.max(8, ...flavors.map((flavor) => visibleLength(clipSingleLine(flavor?.label, 24)))),
  );
  for (const flavor of flavors) {
    if (!flavor || typeof flavor !== "object") {
      continue;
    }
    const isCurrent = Boolean(flavor.current);
    const marker = isCurrent ? accent("›") : dim("·");
    const label = padRight(clipSingleLine(flavor.label || flavor.name, 24), labelWidth);
    const tag = isCurrent ? dim(" · current") : "";
    lines.push(`  ${marker} ${isCurrent ? bold(label) : dim(label)}  ${flavorSwatch(flavor.name)}${tag}`);
  }
  lines.push("");
  lines.push(dim(`  /settings theme <${themeNames().join(" | ")}>`));
  return lines.join("\n");
}

function slashSpinnerText(display) {
  const spinners = Array.isArray(display.spinners) ? display.spinners : [];
  const current = singleLine(display.current) || DEFAULT_SPINNER;
  const meta = display.changed && display.previous
    ? `${singleLine(display.previous)} → ${current}`
    : current;
  const lines = [sectionRule("Working spinner", meta)];
  if (!spinners.length) {
    lines.push(dim(`  active: ${current}`));
    return lines.join("\n");
  }
  const labelWidth = Math.min(
    24,
    Math.max(8, ...spinners.map((item) => visibleLength(clipSingleLine(item?.label, 24)))),
  );
  for (const item of spinners) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const isCurrent = Boolean(item.current);
    const marker = isCurrent ? accent("›") : dim("·");
    const label = padRight(clipSingleLine(item.label || item.name, 24), labelWidth);
    const preview = clipSingleLine(item.preview || (Array.isArray(item.frames) ? item.frames.join(" ") : ""), 48);
    const tag = isCurrent ? dim(" · current") : "";
    lines.push(`  ${marker} ${isCurrent ? bold(label) : dim(label)}  ${isCurrent ? accent(preview) : dim(preview)}${tag}`);
  }
  lines.push("");
  lines.push(dim(`  /settings spinner <${spinnerNames().join(" | ")}>`));
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
  const modelLine = `model ${singleLine(info.model) || "unknown"} · session ${singleLine(info.session_id) || "new"}`;
  const version = singleLine(info.version) || "unknown";
  const updateVersion = singleLine(info.update_available);
  const cwd = middleClip(info.cwd || process.cwd(), width - 4);
  const team = info.team_main;
  return [
    startupBannerBorder("┌", "┐", width),
    startupBannerLine(`${bold("Rind")} ${dim(`v${version}`)}${team ? `  ${teamBadge()}` : ""}`, width),
    ...(updateVersion ? [startupBannerLine(`${accent("↑")} ${bold(`Update available: v${version} → v${updateVersion}`)} ${dim("· run rind update")}`, width)] : []),
    ...(team ? [startupBannerLine(`${bold(singleLine(team.agent_id))}${dim(" · ")}${singleLine(team.project_name)}`, width)] : []),
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
  return Math.max(4, Math.min(MAX_STARTUP_BANNER_WIDTH, columns - 2));
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
  const activity = promptActivityLine({ ...state, frameWidth });
  if (activity) {
    lines.push(activity);
  }
  lines.push(...pendingInputLines(state.pendingInputs, frameWidth));
  if (header) {
    lines.push(header);
  }
  const hint = promptHintLine({ ...state, frameWidth });
  if (hint) {
    lines.push(hint);
  }
  lines.push(inputDivider(frameWidth));
  lines.push(`  ${accent("▷")} `);
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
    hints.push("alt+right steer now");
  }
  if (entries.some((entry) => entry?.mode === "steering")) {
    hints.push("alt+down recall steer");
  }
  if (hints.length) {
    lines.push(dim(`    ${hints.join(" · ")}`));
  }
  return lines;
}

function padRight(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function padLeft(text, width) {
  return `${" ".repeat(Math.max(0, width - visibleLength(text)))}${text}`;
}

function visibleLength(text) {
  return textWidth(text);
}

function promptHeaderLine(info, frameWidth) {
  const backgroundCount = Number(info.background_count);
  const taskHints = [];
  if (backgroundCount > 0) {
    taskHints.push(`[bg:${backgroundCount}]`);
  }
  const width = composerWidth(frameWidth);
  const badge = info.management_label ? `${bold(paint.notice(`[${singleLine(info.management_label)}]`))} ` : info.team_main ? `${teamBadge()} ` : "";
  const available = Math.max(0, width - visibleLength(badge));
  const counts = taskHints.length ? ` · ${taskHints.join(" ")}` : "";
  let taskHint = counts ? `${counts} (ctrl+b monitor)` : "";
  if (visibleLength(taskHint) + 20 > available) {
    taskHint = counts;
  }
  if (visibleLength(taskHint) + 8 > available) {
    taskHint = "";
  }
  const details = promptDetails(info, available - visibleLength(taskHint));
  const line = `${badge}${details}${dim(taskHint)}`.trimEnd();
  return line ? `  ${clipCells(line, width)}` : "";
}

function teamBadge() {
  return bold(paint.notice("[TEAM]"));
}

function promptDetails(info, width) {
  const model = singleLine(info.model);
  const cwd = singleLine(info.cwd);
  const remoteSegment = info.remote_running && (model || cwd) && width >= 8 ? `${dim(" · ")}${promptPath("⚯")}` : "";
  width = Math.max(0, width - visibleLength(remoteSegment));
  if (!model) {
    return !cwd ? (info.remote_running ? promptPath("⚯") : "") : `${promptPath(middleClip(cwd, width))}${remoteSegment}`;
  }
  const effort = singleLine(info.reasoning_effort);
  const effortSegment = effort && visibleLength(effort) + 3 + 8 <= width
    ? `${dim(" · ")}${promptModel(effort)}` : "";
  const remaining = width - visibleLength(effortSegment);
  const pathReserve = cwd && remaining >= 24 ? Math.min(visibleLength(cwd), 16) + 3 : 0;
  const modelText = clipSingleLine(model, Math.max(0, remaining - pathReserve));
  const pathWidth = remaining - visibleLength(modelText) - 3;
  const pathSegment = cwd && pathWidth >= 4
    ? `${dim(" · ")}${promptPath(middleClip(cwd, pathWidth))}` : "";
  return `${promptModel(modelText)}${effortSegment}${pathSegment}${remoteSegment}`;
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
