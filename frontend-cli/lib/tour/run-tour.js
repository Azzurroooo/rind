import { parseTerminalKey } from "../terminal-key.js";
import { Component } from "../tui/component.js";
import { createTui } from "../tui/tui.js";
import { findTourPage, TOUR_TOPICS, tourPages } from "./pages/index.js";
import { renderTourCatalog, renderTourPage, renderTourHelp, cursorMarker } from "./render.js";
import { createTourPlayer } from "./player.js";
import { createTourStage } from "./stage.js";

class TourScreen extends Component {
  constructor(player, stage, rows) {
    super();
    this.player = player;
    this.stage = stage;
    this.rows = rows;
  }

  render(width) {
    const height = this.rows?.() ?? 24;
    if (width < 36 || height < 14) this.player.pause("resize");
    const state = this.player.state();
    const out = state.help ? renderTourHelp(width, height) : state.view === "catalog"
      ? renderTourCatalog(state, width, height)
      : renderTourPage(this.stage.snapshot(), state, width, height);
    if (!state.help && state.view === "page") this.player.setScrollLimit(out.maxScroll || 0, out.offset || 0);
    return cursorMarker(out.lines, out.cursor);
  }
}

// Runs the guided tour on its own TUI instance below the current terminal
// content. Resolves once the visitor quits; returns false when startPageId
// does not name a page (nothing is rendered in that case).
export async function runTour({
  input,
  output,
  stderr = process.stderr,
  startPageId = "",
  schedule = setTimeout,
  cancel = clearTimeout,
  now = () => performance.now(),
  onPageComplete = () => {},
} = {}) {
  if (startPageId && !findTourPage(startPageId)) {
    stderr.write(`Unknown tour page: ${startPageId}\nAvailable pages:\n${tourPages().map((page) => `  ${page.id} — ${page.title}`).join("\n")}\n`);
    return false;
  }
  const stage = createTourStage();
  const tui = createTui({ input, output });
  const player = createTourPlayer({
    topics: TOUR_TOPICS,
    startPageId,
    stage,
    schedule,
    cancel,
    now,
    onPageComplete,
    onRender: () => tui.requestRender(),
  });
  tui.addChild(new TourScreen(player, stage, () => tui.rows));
  tui.onData((sequence) => {
    const scrollKey = { "\x1b[5~": "pageup", "\x1b[6~": "pagedown" }[sequence];
    player.key(scrollKey ? { kind: "key", name: scrollKey } : parseTerminalKey(sequence));
  });
  // Pasted commands are examples to read, never navigation instructions.
  tui.onPaste(() => {});
  input.on?.("end", player.dispose);
  input.on?.("close", player.dispose);
  try {
    tui.start();
    player.start();
    await player.finished;
  } finally {
    player.dispose();
    tui.stop();
    input.off?.("end", player.dispose);
    input.off?.("close", player.dispose);
  }
  return true;
}
