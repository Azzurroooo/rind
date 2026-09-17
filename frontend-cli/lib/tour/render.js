import { prepareComposerFrame } from "../composer-terminal.js";
import {
  authChoiceFrame,
  authSecretFrame,
  backgroundMonitorText,
  choiceMenuText,
  contextBoardText,
  delegateMonitorText,
  inputHintText,
  modelMenuText,
  promptPlaceholderText,
  promptText,
  sessionMenuText,
  slashMenuText,
  themeMenuText,
  taskMonitorTabs,
  usageBoardText,
} from "../rendering.js";
import { paint, currentTheme, setTheme } from "../theme.js";
import { clipCells, graphemes, stripAnsi, textWidth, wrapTextWithAnsi } from "../text-width.js";
import { insertCursorMarker } from "../tui/cursor.js";
import { renderTourTranscript } from "./transcript.js";

const MIN_INNER = 1;

// Shared border for tour cards and demo frames. Once simulation starts, only
// terminal content belongs in the demo frame; guidance stays outside it.
function frameBlock({ title, badge, body, inner }) {
  const badgeText = badge ? ` ${badge} ` : "";
  const headText = clipCells(` ${title} `, Math.max(1, inner - textWidth(badgeText)));
  const dashes = Math.max(1, inner + 1 - textWidth(headText) - textWidth(badgeText));
  const lines = [
    paint.dim(`┌─`) + paint.accent(headText) + paint.dim(`${"─".repeat(dashes)}${badgeText}┐`),
  ];
  for (const row of body) {
    for (const segment of wrapTextWithAnsi(row, inner, inner)) {
      lines.push(`${paint.dim("│")} ${padRight(segment, inner)} ${paint.dim("│")}`);
    }
  }
  lines.push(paint.dim(`└${"─".repeat(inner + 2)}┘`));
  return lines;
}

function padRight(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - textWidth(text)))}`;
}

// --- catalog ---------------------------------------------------------------

// The catalog windows its rows like the app's own menus so it stays inside the
// viewport on short terminals; `rows` is the terminal height.
export function renderTourCatalog(state, width, rows = 24) {
  if (width < 36 || rows < 14) return smallTerminal(width, rows);
  const inner = Math.max(MIN_INNER, width - 4);
  const pages = state.topics.flatMap((topic) => topic.pages);
  // Measure the whole catalog so columns don't shift when scrolling between
  // topics. Below 18 cells of description space, use a selected-item summary.
  const numberWidth = String(pages.length).length + 1;
  const featureWidth = Math.max(...pages.map((page) => textWidth(page.feature || page.title)));
  const prefixWidth = numberWidth + 5;
  const columns = inner - prefixWidth - featureWidth - 3 >= 18;
  const plan = [];
  for (const topic of state.topics) {
    if (plan.length) {
      plan.push({ blank: true });
    }
    plan.push({ header: topic.title.toUpperCase() });
    for (const page of topic.pages) {
      plan.push({ page });
    }
  }
  const selectedRow = plan.findIndex((row) => row.page === pages[state.selected]);
  const budget = Math.max(1, rows - (columns ? 8 : 9));
  const start = plan.length <= budget
    ? 0
    : Math.min(Math.max(0, selectedRow - 3), plan.length - budget);
  const visible = plan.slice(start, start + budget);

  const body = [paint.dim("Watch a demo, then try it in Rind.")];
  for (const row of visible) {
    if (row.blank) {
      body.push("");
      continue;
    }
    if (row.header) {
      body.push(`  ${paint.dim(row.header)}`);
      continue;
    }
    const index = pages.indexOf(row.page);
    const selected = index === state.selected;
    const marker = selected ? paint.accent("›") : state.completed?.includes(row.page.id) ? paint.success("✓") : " ";
    const feature = row.page.feature || row.page.title;
    const label = selected ? paint.bold(feature) : paint.dim(feature);
    const description = columns && row.page.feature
      ? paint.dim(" · ") + (selected ? row.page.title : paint.dim(row.page.title)) : "";
    body.push(clipCells(`  ${marker} ${paint.dim(`${index + 1}.`.padStart(numberWidth))} ${columns ? padRight(label, featureWidth) : label}${description}`, inner));
  }
  if (!columns) body.push(paint.accent(clipCells(`Selected: ${pages[state.selected].title}`, inner)));
  body.push(paint.dim(clipCells(`Open: /tour ${pages[state.selected].id}`, inner)));
  body.push(paint.dim(clipCells(`${state.completed?.length || 0}/${pages.length} viewed · simulated examples`, inner)));
  const lines = frameBlock({
    title: "Rind Tour",
    badge: `${state.selected + 1}/${pages.length}`,
    body,
    inner,
  }, width);
  lines.push(paint.dim(clipCells("↑↓ select · enter play · q quit · ? help", width)));
  return { lines, cursor: null };
}

// --- page ------------------------------------------------------------------

export function renderTourPage(snapshot, state, width, height = Infinity) {
  const previous = currentTheme().name;
  try {
    if (snapshot.rind?.info.theme) setTheme(snapshot.rind.info.theme);
    const out = renderPage(snapshot, state, width, height);
    if (process.env.NO_COLOR !== undefined) out.lines = out.lines.map(stripAnsi);
    return out;
  } finally {
    setTheme(previous);
  }
}

function renderPage(snapshot, state, width, height) {
  if (width < 36 || height < 14) return smallTerminal(width, height);
  const inner = Math.max(MIN_INNER, width - 4);
  const rows = [];
  let cursor = null;
  const write = (row) => {
    rows.push(row);
  };
  const point = (row, column) => {
    cursor = { row, column };
  };
  for (const past of snapshot.history || []) {
    appendShell(rows, past.shell, write, () => {});
    appendRind(rows, past.rind, { ...state, inner, expanded: snapshot.expanded }, write, () => {});
  }
  appendShell(rows, snapshot.shell, write, point);
  const menuStart = rows.length;
  appendRind(rows, snapshot.rind, { ...state, inner, expanded: snapshot.expanded }, write, point);
  // An explanation without terminal content is a tour card, wherever it
  // occurs in the lesson. Rewind/replay naturally restores this introduction.
  if (!rows.some((row) => stripAnsi(row).trim())) {
    return renderTourCard(snapshot, state, width, height, inner);
  }
  // Wrap before mapping the cursor or selecting a viewport. Otherwise a long
  // shell command moves the hardware cursor onto a completely different row.
  const wrapped = [];
  let mapped = null;
  rows.forEach((row, index) => {
    const segments = wrapTextWithAnsi(row, inner, inner);
    if (cursor?.row === index) {
      let column = cursor.column;
      let offset = 0;
      while (offset < segments.length - 1 && column >= textWidth(segments[offset])) {
        column -= textWidth(segments[offset++]);
      }
      mapped = { row: wrapped.length + offset, column: Math.min(column, inner - 1) };
    }
    wrapped.push(...segments);
  });
  const captions = [];
  appendCaption(captions, snapshot, { ...state, inner });
  const captionRows = captions.flatMap((row) => wrapTextWithAnsi(row, inner, inner));
  const footer = [
    paint.bold(clipCells(statusKeys(state, width).join(" · "), width)),
    progressLine(state, width),
  ];
  const guideGap = height >= 20 ? [""] : [];
  const budget = Math.max(1, height - captionRows.length - footer.length - 4 - guideGap.length);
  const maxScroll = Math.max(0, wrapped.length - budget);
  const menu = snapshot.rind?.composer.menu;
  const menuTop = rows.slice(0, menuStart).flatMap((row) => wrapTextWithAnsi(row, inner, inner)).length;
  const automaticOffset = menu ? Math.max(0, maxScroll - menuTop) : 0;
  const offset = Math.min(state.scrollOffset ?? automaticOffset, maxScroll);
  const start = Math.max(0, wrapped.length - budget - offset);
  const visible = wrapped.slice(start, start + budget);
  const action = demoAction(state.page.steps?.[state.stepIndex]);
  const lines = frameBlock({
    title: `Demo · ${state.page.feature || state.page.title}`,
    badge: `${state.pageIndex + 1}/${state.pageCount}`,
    body: visible,
    inner,
  }, width);
  const focused = mapped && mapped.row >= start && mapped.row < start + visible.length
    ? { line: mapped.row - start + 1, column: mapped.column + 2 } : null;
  const guideLabel = clipCells(`── TOUR GUIDE${maxScroll ? " · PgUp/PgDn" : ""}${width >= 80 && action ? ` · ${action}` : ""} ──`, width);
  lines.push(...guideGap, paint.dim(guideLabel), playbackBanner(state, width), ...captionRows, ...footer);
  return { lines, inner, cursor: focused, maxScroll, offset };
}

function renderTourCard(snapshot, state, width, height, inner) {
  const ready = state.phase === "waiting";
  const content = [
    ...wrapTextWithAnsi(paint.bold(state.page.title), inner, inner),
    "",
    ...wrapTextWithAnsi((snapshot.caption || ["Watch this demo, then try it in Rind."]).join(" "), inner, inner),
  ];
  const status = ready
    ? [paint.success(paint.bold("READY · Enter / Space to start"))]
    : [playbackBanner(state, inner), paint.bold(clipCells(statusKeys(state, inner).join(" · "), inner))];
  const step = Math.min(state.stepIndex + 1, Math.max(1, state.stepCount));
  const footer = [clipCells(`${paint.bold(`Step ${step}/${state.stepCount}`)} · q contents · ? help`, width)];
  // Keep the start action visible even on 36×14 screens. Long introductions
  // scroll from the top, using the same PgUp/PgDn coordinates as the demo.
  const gap = content.length + status.length + 6 <= height ? [""] : [];
  let budget = Math.max(1, height - 3 - status.length - footer.length - gap.length * 2);
  if (content.length > budget) {
    footer.unshift(paint.dim("PgUp/PgDn · more introduction"));
    budget = Math.max(1, budget - 1);
  }
  const maxScroll = Math.max(0, content.length - budget);
  const offset = Math.min(state.scrollOffset ?? maxScroll, maxScroll);
  const start = maxScroll - offset;
  const lines = frameBlock({
    title: `TOUR · ${state.page.feature || state.page.title}`,
    badge: `${state.pageIndex + 1}/${state.pageCount}`,
    body: [...gap, ...content.slice(start, start + budget), "", ...status, ...gap],
    inner,
  });
  lines.push(...footer);
  return { lines, inner, cursor: null, maxScroll, offset };
}

function smallTerminal(width, rows) {
  return { lines: ["PAUSED · terminal too small", "Tour needs 36 columns × 14 rows.", "Resize, then Space; Ctrl+C exits."].slice(0, rows).map((line) => clipCells(line, width)), cursor: null, maxScroll: 0 };
}

function demoAction(step) {
  if (!step) return "";
  if (step.kind === "submit") return step.mode === "queue" ? "Tab queues" : step.mode === "steer" ? "Enter steers" : "Enter submits";
  if (step.kind === "type") return "typing in Rind";
  if (step.kind === "shell") return "typing in the shell";
  if (step.kind === "close-menu") return step.key === "Enter" ? "Enter confirms selection" : "Esc closes menu";
  if (step.kind === "expand-tools") return "Ctrl+O toggles tool output";
  if (step.kind === "menu") return step.menu.kind === "monitor" || step.menu.kind === "delegates" ? "Ctrl+B opens monitor" : "menu preview";
  return "watch only";
}

export function renderTourHelp(width, rows = 24) {
  if (width < 36 || rows < 14) return smallTerminal(width, rows);
  return { lines: frameBlock({ title: "Tour controls", inner: width - 4, body: [
    "A demo, not a live session.",
    "No commands run or keys are saved.",
    "Space     pause / resume / next",
    "Enter     finish animation / next",
    "← / →     previous / next step",
    "↑ / ↓     faster / slower",
    "PgUp/PgDn scroll demo (pauses)",
    "r         replay this page",
    "q / Esc   contents; again to exit",
    "Ctrl+C    exit tour immediately",
    "? / Enter close this help",
  ].map((line) => clipCells(line, width - 4)) }), cursor: null };
}

function appendShell(rows, shell, write, point) {
  const prompt = (cwd) => `${paint.path(cwd || "~/demo")}${paint.dim(" $ ")}`;
  for (const block of shell.blocks) {
    if (block.kind === "command") {
      write(`${prompt(block.cwd)}${block.command}`);
    } else {
      for (const line of block.lines.slice(0, block.shown)) {
        write(line);
      }
    }
  }
  if (shell.typing) {
    const revealed = graphemes(shell.typing.command).slice(0, shell.typing.revealed).join("");
    write(`${prompt(shell.typing.cwd)}${revealed}`);
    point(rows.length - 1, textWidth(`${prompt(shell.typing.cwd)}${revealed}`));
  }
}

function appendRind(rows, rind, state, write, point) {
  if (!rind) {
    return;
  }
  // An open menu owns focus. Older transcript stays in stage state and returns
  // as soon as it closes, rather than pushing the choices off a short screen.
  if (!rind.composer.menu) {
    for (const line of renderTourTranscript(rind, state.inner, state.expanded)) write(line);
  }
  appendComposer(rows, rind, state, write, point);
}

function appendComposer(rows, rind, state, write, point) {
  const composer = rind.composer;
  if (composer.hidden) {
    return;
  }
  const menu = composer.menu;
  const menuText = menu ? menuFrame(menu, state.inner) : null;
  const prepared = prepareComposerFrame({
    showCaret: !composer.running && !menu,
    prompt: promptText(rind.info, {}, {
      running: composer.running,
      label: "Working",
      frame: state.frame,
      elapsedMs: state.elapsedMs,
      menuOpen: Boolean(menu),
      frameWidth: state.inner,
      pendingInputs: composer.pending,
    }, state.inner),
    inputText: menu?.input || composer.text,
    cursor: { line: 0, column: graphemes(menu?.input || composer.text).length },
    placeholder: composer.text || composer.running ? "" : inputHintText(promptPlaceholderText()),
    menuText: menuText?.text || "",
    menuCursor: menuText?.cursor || null,
  }, state.inner);
  const base = rows.length;
  for (const line of prepared.lines) {
    write(line);
  }
  if (!composer.running && !menu) {
    point(base + prepared.cursorRow, prepared.cursorColumn);
  }
}

function menuFrame(menu, inner) {
  const selected = Number(menu.selected) || 0;
  switch (menu.kind) {
    case "slash":
      return { text: slashMenuText(menu.items, selected) };
    case "model":
      return { text: modelMenuText(menu.items, selected) };
    case "theme":
      return { text: themeMenuText(menu.items, selected) };
    case "sessions":
      return { text: sessionMenuText(menu.items, selected) };
    case "choice":
      return { text: choiceMenuText(menu.items, selected) };
    case "monitor":
      return { text: taskMonitorTabs("background", menu.tasks.length, 0, inner) + "\n" + backgroundMonitorText(menu.tasks, selected, menu.task, inner) };
    case "delegates":
      return { text: taskMonitorTabs("delegates", 0, menu.delegates.length, inner) + "\n" + delegateMonitorText(menu.delegates, selected, menu.delegate, inner) };
    case "board": {
      const page = menu.pages[selected] || {};
      return { text: page.breakdown ? contextBoardText(page, inner) : usageBoardText(page, inner) };
    }
    case "auth-choice":
      return { text: authChoiceFrame({ title: menu.title, options: menu.options, selectedIndex: selected, width: inner }) };
    case "auth-secret": {
      const frame = authSecretFrame({
        title: menu.title,
        message: menu.message,
        kind: "secret",
        value: menu.value,
        width: inner,
      });
      return { text: frame.text, cursor: frame.cursor };
    }
    default:
      return { text: "" };
  }
}

function appendCaption(rows, snapshot, state) {
  const lines = snapshot.caption;
  if (!lines?.length) {
    return;
  }
  rows.push(...wrapTextWithAnsi(lines.join(" "), state.inner, state.inner).map((line) => paint.accent(line)));
}

function statusKeys(state, width) {
  const exit = width >= 60 ? ["q contents"] : [];
  if (state.phase === "waiting") {
    return ["space continue", "enter continue", ...exit];
  }
  if (state.phase === "end") {
    return [state.pageIndex + 1 === state.pageCount ? "enter contents" : "enter next page", "r replay", ...exit];
  }
  if (state.paused) {
    return ["space resume", "←→ step", ...exit];
  }
  if (state.phase === "after") return ["space pause", "enter next now", ...exit];
  return ["space pause", "enter skip", ...exit];
}

function playbackBanner(state, width) {
  let label;
  let style = paint.accent;
  if (state.phase === "end") {
    label = "✓ COMPLETE · Try it in Rind";
    style = paint.success;
  } else if (state.phase === "waiting") {
    label = "⏸ PAUSED · Read this explanation";
    style = paint.danger;
  } else if (state.paused) {
    label = state.pauseReason === "review" ? "⏸ PAUSED · Reviewing this step"
      : state.pauseReason === "resize" ? "⏸ PAUSED · Terminal resized"
        : "⏸ PAUSED · You paused playback";
    style = paint.danger;
  } else if (state.phase === "after") {
    label = Number.isFinite(state.remainingMs)
      ? `▶ AUTO · next step in ${(Math.max(1, Math.ceil(state.remainingMs / 100)) / 10).toFixed(1)}s`
      : "▶ AUTO · continuing shortly";
  } else {
    const kind = state.page.steps?.[state.stepIndex]?.kind;
    const action = { type: "Typing in Rind", shell: "Typing a command", assistant: "Streaming reply", tool: "Tool demonstration", menu: "Menu demonstration", "shell-out": "Showing output" }[kind] || "Demonstration";
    label = `▶ PLAYING · ${action}`;
  }
  return style(paint.bold(clipCells(label, width)));
}

function progressLine(state, width) {
  const total = Math.max(1, state.stepCount);
  const step = Math.min(state.stepIndex + 1, total);
  const cells = width >= 60 ? 12 : 6;
  const done = state.phase === "end" ? total : Math.max(0, step - 1);
  const filled = Math.floor(done / total * cells);
  const bar = paint.accent("━".repeat(filled)) + paint.dim("·".repeat(cells - filled));
  return clipCells(`${paint.bold(`Step ${step}/${total}`)} [${bar}] ${state.speed}× · ? help`, width);
}

export function cursorMarker(lines, cursor) {
  if (!cursor || cursor.line < 0 || cursor.line >= lines.length) {
    return lines;
  }
  lines[cursor.line] = insertCursorMarker(lines[cursor.line] ?? "", cursor.column);
  return lines;
}
