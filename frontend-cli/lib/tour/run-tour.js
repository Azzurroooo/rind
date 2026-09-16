import { parseTerminalKey } from "../terminal-key.js";
import { Component } from "../tui/component.js";
import { createTui } from "../tui/tui.js";
import { findTourPage, TOUR_TOPICS, tourPages } from "./pages/index.js";
import { renderTourCatalog, renderTourPage, cursorMarker } from "./render.js";
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
    const state = this.player.state();
    const out = state.view === "catalog"
      ? renderTourCatalog(state, width, this.rows?.() ?? 24)
      : renderTourPage(this.stage.snapshot(), state, width);
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
    onRender: () => tui.requestRender(),
  });
  tui.addChild(new TourScreen(player, stage, () => tui.rows));
  tui.onData((sequence) => player.key(parseTerminalKey(sequence)));
  // Terminals (and automation) may deliver text as bracketed paste; the tour
  // treats it the same as typed letters.
  tui.onPaste((text) => player.key({ kind: "text", name: "", text: String(text || "") }));
  tui.start();
  player.start();
  await player.finished;
  tui.stop();
  return true;
}
