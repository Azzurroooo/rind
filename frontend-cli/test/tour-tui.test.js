import test from "node:test";
import assert from "node:assert/strict";

import { runTour } from "../lib/tour/run-tour.js";
import { findTourPage } from "../lib/tour/pages/index.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
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
    get pendingCount() { return pending.size; },
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

test("pasted example text cannot navigate or quit the tour", async () => {
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
  input.send("\x1b[200~q\x1b[201~");
  await settle();
  let screen = (await output.flushAndGetViewport()).join("\n");
  assert.ok(screen.includes("Tour · Work inside the team"), "pasted q leaves the page intact");
  input.send("\x03");
  await running;
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

test("a completed lesson keeps title, takeaway and navigation on an 80x24 terminal", async () => {
  const output = createVirtualOutput({ columns: 80, rows: 24 });
  const input = createVirtualInput();
  const clock = fakeClock();
  let completed = 0;
  const running = runTour({ input, output: output.output, startPageId: "start.hello", schedule: clock.schedule, cancel: clock.cancel, onPageComplete: () => completed++ });
  try {
    await settle();
    // Walk all beats of the first lesson with terminal input, not private player APIs.
    for (let i = 1; i < findTourPage("start.hello").steps.length; i++) input.send("\x1b[C");
    await settle();
    let screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("Tour · Your first turn"), screen);
    assert.ok(screen.includes("Try it: exit this tour"), screen);
    assert.ok(screen.includes("COMPLETE"), screen);
    assert.equal(completed, 1);
    assert.equal(clock.pendingCount, 0);
    input.send("\x1b[5~");
    input.send("\x1b[5~");
    input.send("\x1b[5~");
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("Try it:"), "scrolling keeps the caption visible");
    input.send("?");
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("Tour controls"));
    input.send("\r");
    output.resize(40, 16);
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("Tour · Your first turn"), screen);
    assert.ok(screen.includes("COMPLETE"), screen);
  } finally {
    input.send("\x03");
    await running;
  }
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(clock.pendingCount, 0);
});

test("closing input cleans up a playing tour", async () => {
  const input = createVirtualInput();
  const output = createVirtualOutput();
  const clock = fakeClock();
  const running = runTour({ input, output: output.output, startPageId: "start.hello", schedule: clock.schedule, cancel: clock.cancel });
  input.send(" ");
  input.emit("end");
  await running;
  assert.equal(clock.pendingCount, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("end"), 0);
});

test("terminal clearly distinguishes an explanation stop from an automatic countdown", async () => {
  const input = createVirtualInput();
  const output = createVirtualOutput({ columns: 80, rows: 24 });
  const clock = fakeClock();
  const running = runTour({ input, output: output.output, startPageId: "start.hello", schedule: clock.schedule, cancel: clock.cancel, now: clock.now });
  try {
    await settle();
    let screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("PAUSED · Read this explanation"), screen);
    assert.ok(screen.includes("space continue"));
    assert.ok(screen.includes("Step 1/"));
    input.send(" ");
    clock.advance(96); // "rind" has just finished typing; hold for 300ms.
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("AUTO · next step in 0.3s"), screen);
    clock.advance(150);
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("AUTO · next step in 0.2s"), screen);
    input.send(" ");
    clock.advance(5000);
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("PAUSED · You paused playback"), screen);
    assert.ok(!screen.includes("next step in"));
    output.resize(36, 14);
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("PAUSED · You paused playback"), screen);
    assert.ok(screen.includes("Step 2/"));
    input.send(" ");
    clock.advance(150);
    await settle();
    screen = (await output.flushAndGetViewport()).join("\n");
    assert.ok(screen.includes("Step 3/"), "resume uses the remaining 150ms");
  } finally {
    input.send("\x03");
    await running;
  }
  assert.equal(clock.pendingCount, 0);
});
