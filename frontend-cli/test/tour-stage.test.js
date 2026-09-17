import test from "node:test";
import assert from "node:assert/strict";

import { createTourStage } from "../lib/tour/stage.js";

const INFO = { version: "0.8.0", model: "zai/glm-4.7", session_id: "s1", cwd: "~/demo" };

function stepSet() {
  return [
    { kind: "shell", command: "rind", note: ["why the shell", "second line"] },
    { kind: "startup", info: INFO },
    { kind: "type", text: "hello" },
    { kind: "submit", mode: "send" },
    { kind: "tool", name: "read_file", detail: "src/a.js", outcome: { status: "ok", output: "ok", durationMs: 120 } },
    { kind: "assistant", text: "line one\nline two" },
    { kind: "turn-done", durationMs: 3200, completed: 1, failed: 0 },
    { kind: "exit" },
  ];
}

// Drives a step exactly like the player does: begin, tick to exhaustion, settle.
function animate(stage, step) {
  stage.beginStep(step);
  let guard = 0;
  while (stage.tick()) {
    guard += 1;
    assert.ok(guard < 1000, "tick loop must terminate");
  }
  stage.settleStep(step);
}

function animatedSnapshot(steps, through) {
  const stage = createTourStage();
  for (let index = 0; index <= through; index += 1) {
    animate(stage, steps[index]);
  }
  return stage.snapshot();
}

test("shell typing reveals characters, then commits a command block", () => {
  const stage = createTourStage();
  const step = { kind: "shell", command: "rind" };
  stage.beginStep(step);
  assert.equal(stage.snapshot().shell.typing.revealed, 0);
  stage.tick();
  stage.tick();
  assert.equal(stage.snapshot().shell.typing.revealed, 2);
  assert.equal(stage.tick(), true);
  assert.equal(stage.tick(), false, "four characters, so the fifth tick reports no remainder");
  stage.settleStep(step);
  const snapshot = stage.snapshot();
  assert.equal(snapshot.shell.typing, null);
  assert.deepEqual(snapshot.shell.blocks, [{ kind: "command", command: "rind" }]);
});

test("submit echoes the composer text and starts running; turn-done clears both", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  stage.beginStep({ kind: "type", text: "do work" });
  while (stage.tick());
  stage.settleStep({ kind: "type", text: "do work" });
  stage.beginStep({ kind: "submit", mode: "send" });
  stage.settleStep({ kind: "submit", mode: "send" });

  let snapshot = stage.snapshot();
  assert.deepEqual(snapshot.rind.blocks[0], { kind: "user", text: "do work" });
  assert.equal(snapshot.rind.composer.running, true);
  assert.equal(snapshot.rind.composer.text, "");

  stage.beginStep({ kind: "turn-done", durationMs: 10, completed: 0, failed: 0 });
  stage.settleStep({ kind: "turn-done", durationMs: 10, completed: 0, failed: 0 });
  snapshot = stage.snapshot();
  assert.equal(snapshot.rind.composer.running, false);
});

test("submitting a slash command echoes it without starting the turn", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  stage.beginStep({ kind: "type", text: "/team create" });
  stage.settleStep({ kind: "type", text: "/team create" });
  stage.beginStep({ kind: "submit", mode: "send" });
  stage.settleStep({ kind: "submit", mode: "send" });

  const snapshot = stage.snapshot();
  assert.deepEqual(snapshot.rind.blocks[0], { kind: "user", text: "/team create" });
  assert.equal(snapshot.rind.composer.running, false, "slash commands never run a turn");
});

test("queue and steer modes park the text in the composer pending list", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });

  stage.beginStep({ kind: "submit", mode: "queue" });
  stage.settleStep({ kind: "submit", mode: "queue" });
  assert.deepEqual(stage.snapshot().rind.composer.pending, [{ mode: "follow_up", input: "" }]);

  stage.beginStep({ kind: "submit", mode: "steer" });
  stage.settleStep({ kind: "submit", mode: "steer" });
  const pending = stage.snapshot().rind.composer.pending;
  assert.equal(pending.length, 2);
  assert.equal(pending[1].mode, "steering");

  stage.beginStep({ kind: "turn-done", durationMs: 1, completed: 0, failed: 0 });
  stage.settleStep({ kind: "turn-done", durationMs: 1, completed: 0, failed: 0 });
  assert.equal(stage.snapshot().rind.composer.pending.length, 2, "finishing a turn must not erase pending input");
  animate(stage, { kind: "consume", mode: "steering" });
  animate(stage, { kind: "consume", mode: "follow_up" });
  assert.deepEqual(stage.snapshot().rind.composer.pending, []);
  assert.equal(stage.snapshot().rind.composer.running, true, "queued input starts another turn");
});

test("tool step animates as running and settles into its outcome", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  const step = { kind: "tool", name: "bash", detail: "npm test", outcome: { status: "ok", output: "all green", durationMs: 900 } };
  stage.beginStep(step);
  assert.equal(stage.snapshot().rind.blocks.at(-1).running, true);
  stage.settleStep(step);
  const block = stage.snapshot().rind.blocks.at(-1);
  assert.equal(block.running, false);
  assert.equal(block.outcome.output, "all green");
});

test("assistant streams text chunks; menu tick moves to target", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });

  const assistant = { kind: "assistant", text: "a\nb\nc" };
  stage.beginStep(assistant);
  assert.equal(stage.tick(), true);
  assert.equal(stage.snapshot().rind.blocks.at(-1).reveal, 3);
  while (stage.tick());
  stage.settleStep(assistant);
  assert.equal(stage.snapshot().rind.blocks.at(-1).reveal, 5);

  const menu = { kind: "menu", menu: { kind: "model", items: [{ name: "a" }, { name: "b" }, { name: "c" }], selected: 0, target: 2 } };
  stage.beginStep(menu);
  assert.equal(stage.tick(), true);
  assert.equal(stage.snapshot().rind.composer.menu.selected, 1);
  assert.equal(stage.tick(), false);
  stage.settleStep(menu);
  assert.equal(stage.snapshot().rind.composer.menu.selected, 2);
});

test("startup replaces the rind area; exit hides the composer and appends goodbye", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  stage.beginStep({ kind: "result", text: "ok", detail: "" });
  stage.settleStep({ kind: "result", text: "ok", detail: "" });

  const secondInfo = { ...INFO, session_id: "s2" };
  stage.beginStep({ kind: "startup", info: secondInfo });
  stage.settleStep({ kind: "startup", info: secondInfo });
  assert.equal(stage.snapshot().rind.blocks.length, 0);
  assert.equal(stage.snapshot().rind.info.session_id, "s2");

  stage.beginStep({ kind: "exit" });
  stage.settleStep({ kind: "exit" });
  const composer = stage.snapshot().rind.composer;
  assert.equal(composer.hidden, true);
  assert.equal(stage.snapshot().rind.blocks.at(-1).kind, "goodbye");
});

test("note steps replace the caption and the caption persists across steps", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "note", lines: ["first note"] });
  stage.settleStep({ kind: "note", lines: ["first note"] });
  assert.deepEqual(stage.snapshot().caption, ["first note"]);

  stage.beginStep({ kind: "shell", command: "ls", note: ["shell note"] });
  stage.settleStep({ kind: "shell", command: "ls" });
  assert.deepEqual(stage.snapshot().caption, ["shell note"]);

  stage.beginStep({ kind: "shell-out", lines: ["a"] });
  stage.settleStep({ kind: "shell-out", lines: ["a"] });
  assert.deepEqual(stage.snapshot().caption, ["shell note"], "steps without a note keep the previous caption");
});

test("rebuildTo reproduces the animated path exactly", () => {
  const steps = stepSet();
  for (let through = 0; through < steps.length; through += 1) {
    const rebuilt = createTourStage();
    rebuilt.rebuildTo(steps, through);
    assert.deepEqual(
      rebuilt.snapshot(),
      animatedSnapshot(steps, through),
      `rebuildTo(${through}) must equal the animated snapshot`,
    );
  }
});

test("rebuildTo with -1 resets to an empty stage", () => {
  const stage = createTourStage();
  animate(stage, { kind: "shell", command: "ls" });
  stage.rebuildTo([], -1);
  assert.deepEqual(stage.snapshot(), {
    history: [],
    expanded: false,
    shell: { blocks: [], typing: null },
    rind: null,
    caption: null,
  });
});

test("grapheme text reveals without splitting surrogate pairs", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  const step = { kind: "type", text: "a😀b中文" };
  stage.beginStep(step);
  while (stage.tick());
  stage.settleStep(step);
  assert.equal(stage.snapshot().rind.composer.text, "a😀b中文");
});
