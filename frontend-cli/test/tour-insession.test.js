import test from "node:test";
import assert from "node:assert/strict";

import { Component } from "../lib/tui/component.js";
import { createTui } from "../lib/tui/tui.js";
import { runTour } from "../lib/tour/run-tour.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";

// Mirrors the in-session /tour flow: the main TUI owns a transcript, stops,
// the tour plays below it, and after the tour the main TUI replays itself.
class StaticBlock extends Component {
  constructor(lines) {
    super();
    this.lines = lines;
  }

  render() {
    return this.lines;
  }
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) {
          break;
        }
        const [id, timer] = due[0];
        now = Math.max(now, timer.at);
        pending.delete(id);
        timer.fn();
      }
      now = target;
    },
  };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test("in-session recovery: stop main tui, run tour, replay main tui", async () => {
  const { output, input } = { output: createVirtualOutput({ columns: 80, rows: 30 }), input: createVirtualInput() };
  const main = createTui({ input, output: output.output });
  const transcript = [
    "Rind v0.8.0",
    "model deepseek-flash · session 20260917_024116_91240551",
    "▷ You",
    "  /tour team.work",
  ];
  main.addChild(new StaticBlock(transcript));
  main.start();
  await settle();

  main.stop();
  const clock = fakeClock();
  const running = runTour({
    input,
    output: output.output,
    startPageId: "start.monitor",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  await settle();
  let screen = (await output.flushAndGetViewport()).join("\n");
  assert.ok(screen.includes("Demo · Background monitor"), "tour renders below the stopped main content");

  input.send(" ");
  await settle();
  clock.advance(2000);
  await settle();
  input.send("q");
  await settle();
  input.send("q");
  await running;

  main.start();
  main.replayAll();
  await settle();
  screen = (await output.flushAndGetViewport()).join("\n");
  for (const line of transcript) {
    assert.ok(screen.includes(line), `replayed transcript keeps: ${line}`);
  }
  assert.ok(!screen.includes("Demo ·"), "tour content is gone after the replay");
  assert.ok(!screen.includes("TOUR GUIDE"), "tour controls are also gone after replay");
});
