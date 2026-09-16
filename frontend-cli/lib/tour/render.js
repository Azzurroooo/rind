import { AssistantMessage } from "../components/assistant-message.js";
import { prepareComposerFrame } from "../composer-terminal.js";
import {
  assistantHeaderText,
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
  slashResultText,
  startupText,
  themeMenuText,
  toolRequestedLine,
  toolResultLine,
  turnCompletedLine,
  userInputText,
  usageBoardText,
} from "../rendering.js";
import { paint } from "../theme.js";
import { clipCells, graphemes, textWidth, wrapTextWithAnsi } from "../text-width.js";
import { insertCursorMarker } from "../tui/cursor.js";

const MIN_INNER = 24;

// Framed page body: everything the audience sees lives inside a Tour panel so
// the simulation reads as a simulation, and body content is wrapped (never
// clipped) to the panel's inner width.
function frameBlock({ title, badge, body, inner }) {
  const badgeText = badge ? ` ${badge} ` : "";
  const headText = clipCells(` ${title} `, Math.max(1, inner - badgeText.length - 4));
  const dashes = Math.max(1, inner - textWidth(headText) - badgeText.length);
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

function hintLine(keys, right, width) {
  const left = keys.join(" · ");
  const pad = width - 4 - textWidth(left) - textWidth(right);
  const tail = right && pad > 2 ? `${" ".repeat(pad)}${right}` : "";
  return paint.dim(clipCells(`  ${left}${tail}`, Math.max(1, width - 2)));
}

// --- catalog ---------------------------------------------------------------

// The catalog windows its rows like the app's own menus so it stays inside the
// viewport on short terminals; `rows` is the terminal height.
export function renderTourCatalog(state, width, rows = 24) {
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
  const budget = Math.max(6, rows - 8);
  const start = plan.length <= budget
    ? 0
    : Math.min(Math.max(0, selectedRow - 3), plan.length - budget);
  const visible = plan.slice(start, start + budget);

  const body = [paint.dim("  Guided walkthroughs — watch each Rind feature in action, step by step.")];
  if (start > 0) {
    body.push(paint.dim("  …"));
  }
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
    const marker = selected ? paint.accent("›") : paint.dim("·");
    const title = selected ? paint.bold(row.page.title) : paint.dim(row.page.title);
    body.push(`  ${marker} ${paint.dim(`${index + 1}.`.padEnd(4))}${paint.dim(row.page.id.padEnd(idWidth))}  ${title}  ${paint.dim(`${row.page.steps.length} steps`)}`);
  }
  if (start + budget < plan.length) {
    body.push(paint.dim("  …"));
  }
  const lines = frameBlock({
    title: "Rind Tour",
    badge: `${state.selected + 1}/${pages.length}`,
    body,
    inner,
  }, width);
  lines.push(hintLine(["↑↓ select", "enter play", "q quit"], "", width));
  return { lines, cursor: null };
}

// --- page ------------------------------------------------------------------

export function renderTourPage(snapshot, state, width) {
  const inner = Math.max(MIN_INNER, width - 4);
  const rows = [];
  let cursor = null;
  const write = (row) => {
    rows.push(row);
  };
  const point = (row, column) => {
    cursor = { row, column };
  };
  appendShell(rows, snapshot.shell, write, point);
  appendRind(rows, snapshot.rind, { ...state, inner }, write, point);
  appendCaption(rows, snapshot, { ...state, inner });
  const lines = frameBlock({
    title: `Tour · ${state.page.title}`,
    badge: `${state.pageIndex + 1}/${state.pageCount}`,
    body: rows,
    inner,
  }, width);
  const focused = cursor ? { line: cursor.row + 1, column: cursor.column + 2 } : null;
  lines.push(hintLine(statusKeys(state), statusRight(state), width));
  return { lines, inner, cursor: focused };
}

function appendShell(rows, shell, write, point) {
  const prompt = `${paint.path("~/demo")}${paint.dim(" $ ")}`;
  for (const block of shell.blocks) {
    if (block.kind === "command") {
      write(`${prompt}${block.command}`);
    } else {
      for (const line of block.lines.slice(0, block.shown)) {
        write(line);
      }
    }
  }
  if (shell.typing) {
    const revealed = graphemes(shell.typing.command).slice(0, shell.typing.revealed).join("");
    write(`${prompt}${revealed}`);
    point(rows.length - 1, textWidth(`${prompt}${revealed}`));
  }
}

function appendRind(rows, rind, state, write, point) {
  if (!rind) {
    return;
  }
  for (const line of startupText(rind.info, state.inner).split("\n")) {
    write(line);
  }
  write("");
  for (const block of rind.blocks) {
    for (const line of blockLines(block, state.inner)) {
      write(line);
    }
  }
  appendComposer(rows, rind, state, write, point);
}

function blockLines(block, inner) {
  switch (block.kind) {
    case "user":
      return userInputText(block.text, inner).split("\n");
    case "assistant":
      return assistantLines(block, inner);
    case "result":
      return slashResultText({ text: block.text, display: block.display }, []).split("\n");
    case "tool":
      return toolLines(block);
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
  const message = new AssistantMessage({ color: true });
  message.append(block.text.split("\n").slice(0, block.reveal).join("\n"));
  message.finish();
  return [assistantHeaderText(), ...message.render(inner)];
}

function toolLines(block) {
  if (block.running) {
    return toolRequestedLine({
      tool_name: block.name,
      args_preview: JSON.stringify(toolArgs(block)),
    }).split("\n");
  }
  const failed = block.outcome.status === "failed";
  return toolResultLine({
    tool_name: block.name,
    status: failed ? "failed" : "completed",
    error_type: failed ? "tool_error" : "",
    duration_ms: block.outcome.durationMs,
    result: JSON.stringify({
      data: { status: "completed", exit_code: failed ? 1 : 0, stdout: block.outcome.output || "" },
    }),
  }, null).split("\n");
}

function toolArgs(block) {
  if (block.name === "bash") {
    return { command: block.detail };
  }
  if (block.name === "delegate") {
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
      return { text: backgroundMonitorText(menu.tasks, 0, menu.task, inner) };
    case "delegates":
      return { text: delegateMonitorText(menu.delegates, 0, menu.delegate, inner) };
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
  const lines = state.phase === "end"
    ? [`End of ${state.page.title}`, "enter next page · r replay · q catalog"]
    : snapshot.caption;
  if (!lines?.length) {
    return;
  }
  rows.push("");
  rows.push(`  ${paint.accent("◆")} ${paint.bold(lines[0])}`);
  for (const line of lines.slice(1)) {
    rows.push(...wrapTextWithAnsi(line, state.inner - 4, state.inner - 4).map((segment) => `    ${paint.dim(segment)}`));
  }
}

function statusKeys(state) {
  if (state.phase === "waiting") {
    return ["space continue", "← back", "q catalog"];
  }
  if (state.phase === "end") {
    return ["enter next page", "r replay", "q catalog"];
  }
  if (state.paused) {
    return ["space resume", "← back", "q catalog"];
  }
  return ["space pause", "←→ step", "↑↓ speed", "enter skip", "q catalog"];
}

function statusRight(state) {
  const parts = [`${state.speed}×`];
  if (state.phase === "end") {
    parts.push(`page ${state.pageIndex + 1}/${state.pageCount}`);
  } else {
    parts.push(`step ${Math.min(state.stepIndex + 1, state.stepCount)}/${state.stepCount}`);
  }
  if (state.paused) {
    parts.push("paused");
  }
  return parts.join(" · ");
}

export function cursorMarker(lines, cursor) {
  if (!cursor || cursor.line < 0 || cursor.line >= lines.length) {
    return lines;
  }
  lines[cursor.line] = insertCursorMarker(lines[cursor.line] ?? "", cursor.column);
  return lines;
}
