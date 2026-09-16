import test from "node:test";
import assert from "node:assert/strict";

import { createTourPlayer } from "../lib/tour/player.js";
import { createTourStage } from "../lib/tour/stage.js";

const INFO = { version: "0.8.0", model: "zai/glm-4.7", session_id: "s1", cwd: "~/demo" };

// start.hello timeline at 1×: startup settles at 0 (pause 400), type ticks at
// 435/470 (pause 250), submit settles at 720 (pause 250), note waits at 970.
const TOPICS = [
  {
    id: "start",
    title: "Start",
    pages: [
      {
        id: "start.hello",
        title: "Hello",
        steps: [
          { kind: "startup", info: INFO },
          { kind: "type", text: "ab" },
          { kind: "submit", mode: "send" },
          { kind: "note", lines: ["mid note"] },
          { kind: "result", text: "done", detail: "" },
          { kind: "turn-done", durationMs: 3200, completed: 0, failed: 0 },
        ],
      },
      { id: "start.steer", title: "Steer", steps: [{ kind: "startup", info: INFO }, { kind: "exit" }] },
    ],
  },
  { id: "team", title: "Team", pages: [{ id: "team.create", title: "Create", steps: [{ kind: "shell", command: "rind" }] }] },
];

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
    get pendingCount() {
      return pending.size;
    },
  };
}

function makePlayer({ startPageId = "", topics = TOPICS, stage = createTourStage(), clock = fakeClock() } = {}) {
  const renders = [];
  const player = createTourPlayer({
    topics,
    startPageId,
    stage,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onRender: () => renders.push(clock.pendingCount),
  });
  return { player, clock, stage, renders };
}

const key = (name, extra = {}) => ({ kind: "key", name, ctrl: false, alt: false, shift: false, ...extra });

test("steps auto-advance with animation, pauses and waits", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  assert.equal(player.state().view, "page");
  assert.equal(player.state().stepIndex, 0);
  assert.equal(player.state().stepCount, 6);

  clock.advance(400);
  assert.equal(player.state().stepIndex, 1, "typing starts after the startup pause");
  clock.advance(70);
  assert.equal(player.state().stepIndex, 1, "typing settles on the last character");
  clock.advance(250);
  assert.equal(player.state().stepIndex, 2, "submit settles right after typing");
  clock.advance(250);
  assert.equal(player.state().stepIndex, 3);
  assert.equal(player.state().phase, "waiting", "note step waits for a key");
  clock.advance(2000);
  assert.equal(player.state().stepIndex, 3, "waiting ignores the clock");

  player.key(key("space"));
  assert.equal(player.state().stepIndex, 4, "space continues past the note");
  clock.advance(1100);
  assert.equal(player.state().phase, "end", "last step ends the page");
});

test("typing animation reveals characters over time", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(400);
  assert.equal(stage.snapshot().rind.composer.text, "");
  clock.advance(35);
  assert.equal(stage.snapshot().rind.composer.text, "a");
  clock.advance(35);
  assert.equal(stage.snapshot().rind.composer.text, "ab", "typing completes");
});

test("space pauses and resumes the clock", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(400);
  player.key(key("space"));
  assert.equal(player.state().paused, true);
  const frozen = player.state().stepIndex;
  clock.advance(5000);
  assert.equal(player.state().stepIndex, frozen, "no progress while paused");
  player.key(key("space"));
  assert.equal(player.state().paused, false);
  clock.advance(5000);
  assert.ok(player.state().stepIndex > frozen, "progress resumes");
});

test("right skips ahead instantly, left rebuilds the previous step exactly", () => {
  const { player, clock, stage } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(970);
  const before = player.state().stepIndex;
  assert.equal(before, 3);

  player.key(key("right"));
  assert.equal(player.state().stepIndex, before + 1, "right jumps past the note");

  player.key(key("left"));
  assert.equal(player.state().stepIndex, before, "left returns to the note");
  assert.equal(player.state().phase, "waiting", "landing on a note waits again");
  assert.equal(player.state().paused, true, "left pauses for review");
  clock.advance(2000);
  assert.equal(player.state().stepIndex, before, "a paused note does not bounce forward");

  player.key(key("space"));
  assert.equal(player.state().paused, false, "space on a backed-away note resumes playback");
  assert.equal(player.state().stepIndex, before + 1);

  player.key(key("left"));
  assert.equal(player.state().stepIndex, before);
  player.key(key("left"));
  assert.equal(player.state().stepIndex, 2);
  player.key(key("left"));
  assert.equal(player.state().stepIndex, 1);
  player.key(key("left"));
  assert.equal(player.state().stepIndex, 0, "left clamps at the first step");

  player.key(key("left"));
  const expected = createTourStage();
  expected.rebuildTo(TOPICS[0].pages[0].steps, -1);
  assert.deepEqual(stage.snapshot(), expected.snapshot(), "back past the first step resets the stage");
});

test("enter settles the current step without advancing", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(400);
  player.key(key("enter"));
  assert.equal(stage.snapshot().rind.composer.text, "ab", "type step settles instantly");
  assert.equal(player.state().stepIndex, 1);
  clock.advance(250);
  assert.equal(player.state().stepIndex, 2, "flow continues after the settle pause");
});

test("speed controls scale the animation delays", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(469);
  assert.equal(player.state().stepIndex, 1);
  player.key(key("up"));
  player.key(key("up"));
  assert.equal(player.state().speed, 4);
  clock.advance(18); // one 4× tick is round(35/4) = 9ms
  assert.equal(stage.snapshot().rind.composer.text, "ab", "fast ticks still complete the reveal");
  player.key(key("down"));
  assert.equal(player.state().speed, 2);
});

test("spinner only advances while the composer is running", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(649);
  assert.equal(stage.snapshot().rind.composer.running, false, "not running before submit");
  clock.advance(71); // submit settles at 720
  assert.equal(stage.snapshot().rind.composer.running, true);
  const runningFrame = player.state().frame;
  clock.advance(200);
  assert.ok(player.state().frame > runningFrame, "frame increments while running");

  clock.advance(320);
  player.key(key("space")); // past the note
  clock.advance(1100); // result + turn-done
  assert.equal(stage.snapshot().rind.composer.running, false, "turn-done resets running");
});

test("catalog navigation opens pages and quits", async () => {
  const { player } = makePlayer({});
  player.start();
  assert.equal(player.state().view, "catalog");
  player.key(key("down"));
  player.key(key("down"));
  assert.equal(player.state().selected, 2, "selection wraps across topics");
  player.key(key("enter"));
  assert.equal(player.state().view, "page");
  assert.equal(player.state().pageIndex, 2);
  assert.equal(player.state().page.id, "team.create");
  player.key(key("q"));
  assert.equal(player.state().view, "catalog");
  assert.equal(player.state().selected, 2, "catalog reselects the visited page");
  player.key(key("escape"));
  await player.finished;
});

test("deep link starts on the requested page; end navigation walks pages", async () => {
  const { player, clock } = makePlayer({ startPageId: "start.steer" });
  player.start();
  assert.equal(player.state().pageIndex, 1);
  clock.advance(3000);
  assert.equal(player.state().phase, "end");
  player.key(key("enter"));
  assert.equal(player.state().pageIndex, 2);
  assert.equal(player.state().page.id, "team.create");
  clock.advance(3000);
  assert.equal(player.state().phase, "end");
  player.key(key("enter"));
  assert.equal(player.state().view, "catalog", "past the last page the catalog returns");
  player.key(key("q"));
  await player.finished;
});

test("r replays the page from the top", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(970);
  player.key(key("space"));
  clock.advance(1100);
  assert.equal(player.state().phase, "end");
  player.key(key("r"));
  assert.equal(player.state().phase, "after");
  assert.equal(player.state().stepIndex, 0);
  assert.equal(player.state().paused, false);
});

test("ctrl+c resolves the tour from any view", async () => {
  const { player } = makePlayer({ startPageId: "start.hello" });
  player.start();
  let resolved = false;
  player.finished.then(() => {
    resolved = true;
  });
  player.key(key("c", { ctrl: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, true);
});

test("text keystrokes are ignored", () => {
  const { player } = makePlayer({});
  player.start();
  player.key({ kind: "text", name: "", text: "x" });
  assert.equal(player.state().view, "catalog");
});

test("batched text chunks apply each letter and quit", async () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(970);
  player.key({ kind: "text", name: "", text: "xqy" });
  assert.equal(player.state().view, "catalog", "q inside a batched chunk still navigates");
  player.key({ kind: "text", name: "", text: "q" });
  await player.finished;
});
