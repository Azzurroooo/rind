import test from "node:test";
import assert from "node:assert/strict";

import { runTour } from "../lib/tour/run-tour.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";

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

// The TUI engine renders on its own 16ms throttle, so give each burst of
// state changes a real tick to land in the virtual buffer.
function settle(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("tour plays on a real terminal buffer: catalog, page, return, exit", async () => {
  const { output, input } = { output: createVirtualOutput({ columns: 90, rows: 30 }), input: createVirtualInput() };
  const clock = fakeClock();
  const stderrLines = [];
  const running = runTour({
    input,
    output: output.output,
    stderr: { write: (text) => stderrLines.push(text) },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  await settle();
  let viewport = await output.flushAndGetViewport();
  assert.ok(viewport.join("\n").includes("Rind Tour"), "catalog renders");
  assert.ok(viewport.join("\n").includes("start.hello"), "first page listed");

  input.send("[B");
  await settle();
  viewport = await output.flushAndGetViewport();
  assert.ok(viewport.join("\n").includes("› 2."), "arrow moves the selection");

  input.send("\r");
  await settle();
  clock.advance(1200);
  await settle();
  viewport = await output.flushAndGetViewport();
  const screen = viewport.join("\n");
  assert.ok(screen.includes("Tour · Steer and queue"), "enter opens the selected page");
  assert.ok(screen.includes("space continue"), "opening note waits for a keypress");

  input.send(" ");
  await settle();
  clock.advance(1800);
  await settle();
  viewport = await output.flushAndGetViewport();
  assert.ok(
    viewport.join("\n").includes("Rind v0.8.0"),
    "startup banner appears once the clock runs",
  );

  input.send("q");
  await settle();
  viewport = await output.flushAndGetViewport();
  assert.ok(viewport.join("\n").includes("Rind Tour"), "q returns to the catalog");

  input.send("");
  await running;
  assert.deepEqual(stderrLines, []);
});

test("deep links jump straight into a page", async () => {
  const { output, input } = { output: createVirtualOutput({ columns: 90, rows: 30 }), input: createVirtualInput() };
  const clock = fakeClock();
  const running = runTour({
    input,
    output: output.output,
    startPageId: "team.work",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  await settle();
  clock.advance(1200);
  await settle();
  const screen = (await output.flushAndGetViewport()).join("\n");
  assert.ok(screen.includes("Tour · Work inside the team"), "deep-linked page opens directly");
  input.send("q");
  await settle();
  input.send("\x1b");
  await running;
});

test("unknown page ids report the catalog on stderr without rendering", async () => {
  const { output, input } = { output: createVirtualOutput(), input: createVirtualInput() };
  const chunks = [];
  const started = runTour({
    input,
    output: output.output,
    stderr: { write: (text) => chunks.push(text) },
    startPageId: "nope.nope",
  });
  assert.equal(await started, false);
  assert.ok(chunks.join("").includes("Unknown tour page: nope.nope"));
  assert.ok(chunks.join("").includes("team.work"));
  assert.equal(output.getScrollBuffer().join("").trim(), "", "nothing rendered");
});

test("pages wrap inside narrow terminals", async () => {
  const { output, input } = { output: createVirtualOutput({ columns: 60, rows: 40 }), input: createVirtualInput() };
  const clock = fakeClock();
  const running = runTour({
    input,
    output: output.output,
    startPageId: "start.monitor",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  await settle();
  clock.advance(2400);
  await settle();
  for (const line of await output.flushAndGetViewport()) {
    assert.ok(line.length <= 60, `line exceeds 60 columns: '${line}'`);
  }
  input.send("q");
  await settle();
  input.send("\x1b");
  await running;
});
