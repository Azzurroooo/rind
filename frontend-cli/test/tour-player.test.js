import test from "node:test";
import assert from "node:assert/strict";

import { createTourPlayer } from "../lib/tour/player.js";
import { createTourStage } from "../lib/tour/stage.js";
import { TOUR_TOPICS, tourPages } from "../lib/tour/pages/index.js";

const INFO = { version: "0.8.0", model: "zai/glm-4.7", session_id: "s1", cwd: "~/demo" };

// start.hello timeline at 1×: startup holds for 400ms, type ticks at
// 435/470, then submit and the explanation appear together without a hold.
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
    now: clock.now,
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
  assert.equal(player.state().stepIndex, 3, "finished typing submits and opens the explanation immediately");
  assert.equal(player.state().phase, "waiting", "note step waits for a key");
  clock.advance(2000);
  assert.equal(player.state().stepIndex, 3, "waiting ignores the clock");

  player.key(key("space"));
  assert.equal(player.state().stepIndex, 4, "space continues past the note");
  clock.advance(1500);
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
  assert.equal(stage.snapshot().rind.blocks.at(-1).text, "ab", "completed input is submitted before the explanation");
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
  expected.rebuildTo(TOPICS[0].pages[0].steps, 0);
  assert.deepEqual(stage.snapshot(), expected.snapshot(), "back clamps to a visible first step");
});

test("enter finishes animation and opens its explanation without a countdown", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(400);
  player.key(key("enter"));
  assert.equal(stage.snapshot().rind.blocks.at(-1).text, "ab", "type and submit settle instantly");
  assert.equal(player.state().stepIndex, 3);
  assert.equal(player.state().phase, "waiting");
  assert.equal(clock.pendingCount, 0);
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
  assert.equal(stage.snapshot().rind.blocks.at(-1).text, "ab", "fast ticks still complete the reveal");
  player.key(key("down"));
  assert.equal(player.state().speed, 2);
});

test("spinner only advances while the composer is running", () => {
  const stage = createTourStage();
  const { player, clock } = makePlayer({ startPageId: "start.hello", stage });
  player.start();
  clock.advance(469);
  assert.equal(stage.snapshot().rind.composer.running, false, "not running before submit");
  clock.advance(1); // submit and explanation follow the last typing tick
  assert.equal(stage.snapshot().rind.composer.running, true);
  const runningFrame = player.state().frame;
  clock.advance(200);
  assert.equal(player.state().frame, runningFrame, "explanation freezes the simulation too");
  player.key(key("space")); // past the note
  clock.advance(200);
  assert.ok(player.state().frame > runningFrame, "frame increments during active playback");
  clock.advance(1300); // result + turn-done
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
  clock.advance(1500);
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

test("leaving a paused page does not pause the next page", () => {
  const { player, clock, stage } = makePlayer({ startPageId: "start.hello" });
  player.start();
  player.key(key("space"));
  player.key(key("q"));
  player.key(key("down"));
  player.key(key("enter"));
  assert.equal(player.state().paused, false);
  clock.advance(500);
  assert.equal(stage.snapshot().rind.composer.hidden, true);
});

test("replay works mid-animation; speed stops at its limits", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(450);
  player.key({ kind: "text", text: "r" });
  assert.equal(player.state().stepIndex, 0);
  for (let i = 0; i < 8; i++) player.key(key("up"));
  assert.equal(player.state().speed, 4);
  for (let i = 0; i < 8; i++) player.key(key("down"));
  assert.equal(player.state().speed, 0.5);
});

test("finish cancels every timer and ignores subsequent keys", async () => {
  const { player, clock, stage } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(740);
  player.key(key("c", { ctrl: true }));
  await player.finished;
  const snapshot = stage.snapshot();
  assert.equal(clock.pendingCount, 0);
  player.key(key("r"));
  player.key(key("right"));
  clock.advance(10000);
  assert.deepEqual(stage.snapshot(), snapshot);
  assert.equal(clock.pendingCount, 0);
});

test("help freezes playback and restores the prior pause state", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(435);
  player.key({ kind: "text", text: "?" });
  assert.equal(player.state().help, true);
  clock.advance(10000);
  assert.equal(player.state().stepIndex, 1);
  player.key(key("escape"));
  assert.equal(player.state().help, false);
  assert.equal(player.state().paused, false);
  player.key(key("space"));
  player.key({ kind: "text", text: "?" });
  player.key(key("enter"));
  assert.equal(player.state().paused, true);
});

test("the final takeaway is complete without an extra empty end screen", () => {
  const stage = createTourStage();
  const clock = fakeClock();
  const completed = [];
  const player = createTourPlayer({
    stage, schedule: clock.schedule, cancel: clock.cancel,
    startPageId: "lesson.done",
    topics: [{ pages: [{ id: "lesson.done", steps: [{ kind: "note", lines: ["Try this now"] }] }] }],
    onPageComplete: (id) => completed.push(id),
  });
  player.start();
  assert.equal(player.state().phase, "end");
  assert.deepEqual(stage.snapshot().caption, ["Try this now"]);
  assert.equal(clock.pendingCount, 0);
  player.key(key("r"));
  assert.deepEqual(completed, ["lesson.done"]);
});

test("paused right stepping reveals a complete next step and stays paused", () => {
  const { player, clock, stage } = makePlayer({ startPageId: "start.hello" });
  player.start();
  player.key(key("space"));
  player.key(key("right"));
  assert.equal(stage.snapshot().rind.composer.text, "ab");
  clock.advance(2000);
  assert.equal(player.state().stepIndex, 1);
  assert.equal(player.state().paused, true);
});

test("batched scroll keys accumulate before the next render", () => {
  const { player } = makePlayer({ startPageId: "start.hello" });
  player.start();
  player.setScrollLimit(30, 0);
  player.key(key("pageup"));
  player.key(key("pageup"));
  assert.equal(player.state().scrollOffset, 10);
  player.key(key("pagedown"));
  assert.equal(player.state().scrollOffset, 5);
});

test("automatic holds expose a live deadline and resume from the remaining time", () => {
  const { player, clock, renders } = makePlayer({ startPageId: "start.hello" });
  player.start();
  assert.equal(player.state().remainingMs, 400);
  const rendered = renders.length;
  clock.advance(200);
  assert.ok(renders.length > rendered, "idle Rind still refreshes the tour countdown");
  assert.equal(player.state().remainingMs, 200);
  player.key(key("space"));
  clock.advance(10000);
  assert.equal(player.state().remainingMs, 200, "pause freezes the deadline");
  assert.equal(player.state().pauseReason, "manual");
  player.key(key("space"));
  clock.advance(199);
  assert.equal(player.state().stepIndex, 0);
  clock.advance(1);
  assert.equal(player.state().stepIndex, 1, "resume does not restart the entire hold");
});

test("speed changes scale only the remaining hold, including while paused", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(200);
  player.key(key("up"));
  assert.equal(player.state().remainingMs, 100);
  player.key(key("space"));
  player.key(key("down"));
  assert.equal(player.state().remainingMs, 200);
  player.key(key("space"));
  clock.advance(200);
  assert.equal(player.state().stepIndex, 1);
});

test("explanations have no countdown or automatic advance", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(970);
  assert.equal(player.state().phase, "waiting");
  assert.equal(player.state().remainingMs, null);
  assert.equal(clock.pendingCount, 0);
  clock.advance(30000);
  assert.equal(player.state().stepIndex, 3);
  player.key(key("enter"));
  assert.equal(player.state().phase, "after");
  assert.equal(player.state().remainingMs, 1200);
});

test("help preserves a countdown and rewinding discards the old deadline", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(200);
  player.key({ kind: "text", text: "?" });
  clock.advance(5000);
  player.key(key("enter"));
  assert.equal(player.state().remainingMs, 200);
  player.key(key("left"));
  assert.equal(player.state().pauseReason, "review");
  assert.equal(player.state().remainingMs, null);
  player.key(key("space"));
  assert.equal(player.state().remainingMs, 400, "rewound scene has its own full reading hold");
});

test("resuming a reviewed frame before an explanation pauses directly, including after help", () => {
  const { player, clock } = makePlayer({ startPageId: "start.hello" });
  player.start();
  clock.advance(470);
  player.key(key("left")); // review the submit before the note
  assert.equal(player.state().stepIndex, 2);
  player.key(key("help"));
  player.key(key("escape"));
  assert.equal(player.state().paused, true);
  player.key(key("space"));
  assert.equal(player.state().phase, "waiting");
  assert.equal(player.state().remainingMs, null);
  assert.equal(clock.pendingCount, 0);
});

test("every lesson countdown leads to playback, never an explanation pause", () => {
  for (const page of tourPages()) {
    for (const speedKeys of [[], ["up", "up"], ["down"]]) {
      const { player, clock } = makePlayer({ topics: TOUR_TOPICS, startPageId: page.id });
      player.start();
      for (const name of speedKeys) player.key(key(name));
      let transitions = 0;
      while (player.state().phase !== "end") {
        assert.ok(transitions++ < 10000, `${page.id} must finish`);
        const state = player.state();
        if (state.phase === "waiting") {
          assert.equal(state.remainingMs, null);
          assert.equal(clock.pendingCount, 0);
          player.key(key("space"));
        } else {
          assert.ok(state.remainingMs > 0, `${page.id}: playback needs a timer`);
          clock.advance(state.remainingMs);
          if (state.phase === "after") {
            assert.notEqual(player.state().phase, "waiting", `${page.id} step ${state.stepIndex}: countdown must not lead to PAUSED`);
          }
        }
      }
      assert.equal(clock.pendingCount, 0);
      player.dispose();
    }
  }
});

test("team creation waits for understanding before exit, workspace switch and verification", () => {
  const { player, clock, stage } = makePlayer({ topics: TOUR_TOPICS, startPageId: "team.create" });
  player.start();
  const originalSession = player.state().page.steps.find((step) => step.kind === "startup").info.session_id;
  const continueToExplanation = () => {
    player.key(key("space"));
    clock.advance(60000);
    assert.equal(player.state().phase, "waiting");
    assert.equal(player.state().remainingMs, null);
    assert.equal(clock.pendingCount, 0);
    const snapshot = stage.snapshot();
    clock.advance(60000);
    assert.deepEqual(stage.snapshot(), snapshot, "understanding time has no deadline");
    return snapshot;
  };

  const created = continueToExplanation();
  assert.equal(created.rind.info.cwd, "~/demo");
  assert.equal(created.rind.info.session_id, originalSession);
  assert.equal(created.rind.composer.hidden, false);
  assert.match(created.rind.blocks.at(-1).text, /Team project created/);
  assert.match(created.caption.join(" "), /does not switch workspaces/);
  assert.equal(created.rind.composer.text, "", "exit has not started typing");

  const shell = continueToExplanation();
  assert.equal(shell.rind, null, "the session has exited before explaining shell navigation");
  assert.equal(shell.history.at(-1).rind.composer.hidden, true);
  assert.deepEqual(shell.shell.blocks.at(-1).lines, ["main-agent"]);
  assert.ok(!shell.shell.blocks.some((block) => block.command?.startsWith("cd ")));
  assert.match(shell.caption.join(" "), /coordinator/);

  const directory = continueToExplanation();
  assert.equal(directory.rind, null, "restart waits for the directory explanation");
  assert.equal(directory.shell.blocks.at(-1).command, "cd agents/main-agent");
  assert.match(directory.caption.join(" "), /identity and team context/);

  const restarted = continueToExplanation();
  assert.equal(restarted.rind.info.cwd, "~/demo/agents/main-agent");
  assert.notEqual(restarted.rind.info.session_id, originalSession);
  assert.equal(restarted.rind.blocks.length, 0, "verification waits for the new session explanation");
  assert.match(restarted.caption.join(" "), /banner and status bar.*\[TEAM\]/);

  player.key(key("space"));
  clock.advance(60000);
  assert.equal(player.state().phase, "end");
  assert.match(stage.snapshot().rind.blocks.at(-1).text, /Team Agents:\n- main-agent/);
  assert.equal(clock.pendingCount, 0);
  player.dispose();
});
