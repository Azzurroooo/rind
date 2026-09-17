import { AssistantMessage } from "../components/assistant-message.js";
import { prepareComposerFrame } from "../composer-terminal.js";
import {
  assistantHeaderText,
  authChoiceFrame,
  authSecretFrame,
  backgroundMonitorText,
  choiceMenuText,
  commandResultText,
  contextBoardText,
  delegateMonitorText,
  inputHintText,
  modelMenuText,
  promptPlaceholderText,
  promptText,
  sessionMenuText,
  slashMenuText,
  slashResultText,
  startupText,
  themeMenuText,
  taskMonitorTabs,
  turnCompletedLine,
  userInputText,
  usageBoardText,
} from "../rendering.js";
import { paint, currentTheme, setTheme } from "../theme.js";
import { clipCells, graphemes, stripAnsi, textWidth, wrapTextWithAnsi } from "../text-width.js";
import { insertCursorMarker } from "../tui/cursor.js";
import { renderToolRunning, renderToolFinished } from "../tool-display.js";

const MIN_INNER = 1;

// Framed page body: everything the audience sees lives inside a Tour panel so
// the simulation reads as a simulation, and body content is wrapped (never
// clipped) to the panel's inner width.
function frameBlock({ title, badge, body, inner }) {
  const badgeText = badge ? ` ${badge} ` : "";
  const headText = clipCells(` ${title} `, Math.max(1, inner - badgeText.length - 4));
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
  const idWidth = Math.max(...pages.map((page) => page.id.length));
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
  const budget = Math.max(1, rows - 8);
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
    const marker = selected ? paint.accent("›") : state.completed?.includes(row.page.id) ? paint.success("✓") : paint.dim("·");
    const title = selected ? paint.bold(row.page.title) : paint.dim(row.page.title);
    const id = inner >= 70 ? `${paint.dim(row.page.id.padEnd(idWidth))}  ` : "";
    body.push(clipCells(`  ${marker} ${paint.dim(`${index + 1}.`.padEnd(4))}${id}${title}`, inner));
  }
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
  const budget = Math.max(1, height - captionRows.length - footer.length - 4);
  const maxScroll = Math.max(0, wrapped.length - budget);
  const menu = snapshot.rind?.composer.menu;
  const menuTop = rows.slice(0, menuStart).flatMap((row) => wrapTextWithAnsi(row, inner, inner)).length;
  const automaticOffset = menu ? Math.max(0, maxScroll - menuTop) : 0;
  const offset = Math.min(state.scrollOffset ?? automaticOffset, maxScroll);
  const start = Math.max(0, wrapped.length - budget - offset);
  const visible = wrapped.slice(start, start + budget);
  const action = demoAction(state.page.steps?.[state.stepIndex]);
  const label = clipCells(`DEMO${action ? ` · ${action}` : ""}${maxScroll ? " · PgUp/PgDn" : ""}`, inner);
  const body = [paint.dim(label), ...visible, playbackBanner(state, inner), ...captionRows];
  const lines = frameBlock({
    title: `Tour · ${state.page.title}`,
    badge: `${state.pageIndex + 1}/${state.pageCount}`,
    body,
    inner,
  }, width);
  const focused = mapped && mapped.row >= start && mapped.row < start + visible.length
    ? { line: mapped.row - start + 2, column: mapped.column + 2 } : null;
  lines.push(...footer);
  return { lines, inner, cursor: focused, maxScroll, offset };
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
    for (const line of startupText(rind.info, state.inner).split("\n")) {
      write(line);
    }
    write("");
    for (const block of rind.blocks) {
      for (const line of blockLines(block, state.inner, state.expanded)) write(line);
    }
  }
  appendComposer(rows, rind, state, write, point);
}

function blockLines(block, inner, expanded) {
  switch (block.kind) {
    case "user":
      return userInputText(block.text, inner, block.source).split("\n");
    case "assistant":
      return assistantLines(block, inner);
    case "result":
      return commandResultText(block.text, block.detail).split("\n");
    case "slash-result":
      return slashResultText({ text: block.text, display: block.display }, []).split("\n");
    case "tool":
      return toolLines(block, inner, expanded);
    case "turn-done":
      return turnCompletedLine(
        { duration_ms: block.durationMs },
        { completed: block.completed, failed: block.failed },
      ).split("\n");
    case "goodbye":
      return ["Goodbye."];
    default:
      return [];
  }
}

function assistantLines(block, inner) {
  const message = new AssistantMessage({ color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined });
  message.append(graphemes(block.text).slice(0, block.reveal).join(""));
  message.finish();
  return [assistantHeaderText(), ...message.render(inner)];
}

function toolLines(block, width, expanded) {
  const context = { name: block.name, args: toolArgs(block), expanded, fileChange: block.outcome.fileChange };
  if (block.running) {
    return renderToolRunning(context, width);
  }
  const failed = block.outcome.status === "failed";
  const data = block.outcome.data ?? (block.name === "read_file" ? block.outcome.output : {
    status: "completed", exit_code: failed ? 1 : 0, stdout: block.outcome.output || "",
    agent_id: block.detail, summary: block.outcome.output || "",
  });
  return renderToolFinished({ ...context, event: {
    status: failed ? "failed" : "completed",
    error_type: failed ? "tool_error" : "",
    duration_ms: block.outcome.durationMs,
    result: JSON.stringify({ data }),
  } }, width);
}

function toolArgs(block) {
  if (block.name === "bash") {
    return { command: block.detail };
  }
  if (block.name === "bash_output") return { bg_id: block.detail };
  if (block.name === "delegate" || block.name === "agent_create") {
    return { agent_id: block.detail };
  }
  return { file_path: block.detail };
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
    label = "Ⅱ PAUSED · Read this explanation";
    style = paint.warning;
  } else if (state.paused) {
    label = state.pauseReason === "review" ? "Ⅱ PAUSED · Reviewing this step"
      : state.pauseReason === "resize" ? "Ⅱ PAUSED · Terminal resized"
        : "Ⅱ PAUSED · You paused playback";
    style = paint.warning;
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
