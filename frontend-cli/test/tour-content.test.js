import test from "node:test";
import assert from "node:assert/strict";

import { tourPages } from "../lib/tour/pages/index.js";
import { createTourStage } from "../lib/tour/stage.js";

const STEP_KINDS = new Set([
  "shell", "shell-out", "startup", "type", "submit", "result", "slash-result",
  "tool", "assistant", "menu", "turn-done", "exit", "note",
  "info", "close-menu", "consume", "turn-start", "expand-tools", "prefill",
  "agents",
]);
const MENU_KINDS = new Set([
  "slash", "model", "theme", "sessions", "choice",
  "monitor", "board", "auth-choice", "auth-secret", "auth-input",
]);
const CLOSING_KINDS = new Set(["turn-done", "result", "exit", "note", "assistant"]);
const SUBMIT_MODES = new Set(["send", "queue", "steer"]);

function validLines(lines, where) {
  assert.ok(Array.isArray(lines) && lines.length > 0, `${where} needs content`);
  for (const line of lines) {
    assert.equal(typeof line, "string", `${where} lines must be strings`);
    assert.ok(line.trim(), `${where} has a blank line`);
  }
}

function validateStep(step, where) {
  assert.ok(STEP_KINDS.has(step.kind), `${where}: unknown kind ${step.kind}`);
  if (step.kind === "shell") {
    assert.ok(String(step.command).trim(), `${where}: command required`);
  }
  if (step.kind === "shell-out" || step.kind === "note") {
    validLines(step.lines, where);
  }
  if (step.kind === "startup") {
    assert.equal(Object.hasOwn(step.info, "version"), false, `${where}: version must be injected at runtime`);
    for (const field of ["model", "session_id", "cwd"]) {
      assert.ok(step.info?.[field], `${where}: startup info.${field} required`);
    }
  }
  if (step.kind === "type" || step.kind === "assistant") {
    assert.ok(String(step.text).trim(), `${where}: text required`);
  }
  if (step.kind === "submit") {
    assert.ok(SUBMIT_MODES.has(step.mode || "send"), `${where}: invalid submit mode`);
  }
  if (step.kind === "result") {
    assert.ok(String(step.text).trim() || step.display, `${where}: text or display required`);
  }
  if (step.kind === "tool") {
    assert.ok(String(step.name).trim(), `${where}: tool name required`);
    assert.ok(["ok", "failed"].includes(step.outcome?.status), `${where}: outcome.status must be ok|failed`);
    assert.equal(typeof step.outcome?.durationMs, "number", `${where}: outcome.durationMs required`);
  }
  if (step.kind === "menu") {
    assert.ok(MENU_KINDS.has(step.menu?.kind), `${where}: unknown menu kind`);
    if (step.menu?.target !== undefined) {
      assert.equal(typeof step.menu.target, "number", `${where}: menu target must be numeric`);
    }
    if (Array.isArray(step.menu?.items)) {
      assert.ok(step.menu.items.length > 0, `${where}: menu items required`);
    }
  }
  if (step.kind === "agents") {
    if (step.screen !== null) {
      assert.ok(step.screen?.snapshot && step.screen?.page, `${where}: management scene required`);
      assert.deepEqual(JSON.parse(JSON.stringify(step.screen)), step.screen, `${where}: scene must be plain data`);
    }
  }
  if (step.kind === "turn-done") {
    assert.equal(typeof step.durationMs, "number", `${where}: durationMs required`);
  }
  if (step.note) {
    validLines(step.note, `${where} note`);
  }
}

function validatePage(page, seen) {
  assert.ok(typeof page.feature === "string" && page.feature.trim(), `${page.id}: feature name required`);
  assert.match(page.id, /^[a-z0-9]+\.[a-z0-9-]+$/, `${page.id}: id shape`);
  assert.ok(!seen.has(page.id), `duplicate page id ${page.id}`);
  seen.add(page.id);
  assert.ok(page.steps.length >= 3, `${page.id}: needs at least 3 steps`);
  let noteCount = 0;
  for (const [index, step] of page.steps.entries()) {
    validateStep(step, `${page.id} step ${index}`);
    if (step.kind === "note" || step.note) {
      noteCount += 1;
    }
  }
  assert.ok(noteCount >= 1, `${page.id}: needs at least one note`);
  assert.ok(CLOSING_KINDS.has(page.steps.at(-1).kind), `${page.id}: last step must close cleanly`);
}

test("tour pages are well-formed and uniquely identified", () => {
  const seen = new Set();
  for (const page of tourPages()) {
    validatePage(page, seen);
  }
  assert.ok(seen.size >= 16, `expected the full catalog, found ${seen.size} pages`);
});

test("background lesson uses managed shell tasks and no removed delegate monitor", () => {
  const page = tourPages().find(page => page.id === "start.monitor");
  const launch = page.steps.find(step => step.kind === "tool" && step.name === "bash");
  assert.equal(launch.arguments.notify, "on_exit");
  assert.equal(launch.outcome.data.task_id, "task-demo");
  const control = page.steps.find(step => step.name === "task_control");
  assert.deepEqual(control.arguments, { action: "read", task_id: "task-demo" });
  const monitor = page.steps.find(step => step.menu?.kind === "monitor").menu;
  assert.equal(monitor.task.bg_id, monitor.task.task_id);
  assert.doesNotMatch(JSON.stringify(page), /Delegates|bash_output|bg-1/);
  assert.match(JSON.stringify(page), /separate from the team tasks/);
});

test("every scene replays deterministically and ends without lost input or a running turn", () => {
  for (const page of tourPages()) {
    const stage = createTourStage();
    for (const [index, step] of page.steps.entries()) {
      const before = stage.snapshot();
      if (["tool", "assistant"].includes(step.kind)) {
        assert.equal(before.rind?.composer.running, true, `${page.id}: ${step.kind} needs a running turn`);
      }
      if (step.kind === "type") assert.equal(before.rind?.composer.menu, null, `${page.id}: close menu before typing`);
      stage.beginStep(step);
      while (stage.tick());
      stage.settleStep(step);
      const rebuilt = createTourStage();
      rebuilt.rebuildTo(page.steps, index);
      assert.deepEqual(stage.snapshot(), rebuilt.snapshot(), `${page.id} step ${index}`);
    }
    const final = stage.snapshot();
    if (final.rind) {
      assert.equal(final.rind.composer.running, false, page.id);
      assert.deepEqual(final.rind.composer.pending, [], page.id);
      assert.equal(final.rind.composer.menu, null, page.id);
    }
  }
});

test("fork demonstrates user-message boundary and editable prefill", () => {
  const page = tourPages().find((page) => page.id === "sessions.fork");
  const stage = createTourStage();
  stage.rebuildTo(page.steps, page.steps.length - 1);
  assert.equal(stage.snapshot().rind.composer.text, "Now add tests for it");
  assert.ok(!stage.snapshot().rind.info.resume_preview.includes("Now add tests for it"));
  const choices = page.steps.find((step) => step.kind === "menu").menu.items;
  assert.match(choices[0], /keep full history/);
  assert.ok(choices.every((choice) => !choice.includes("Assistant")));
});

test("agents lessons cover arbitrary folders, explicit sharing and tracked delivery", () => {
  const pages = tourPages().filter(page => page.id.startsWith("agents."));
  const text = JSON.stringify(pages);
  assert.doesNotMatch(text, /agent_create|team blueprint|agents\/main-agent/);
  assert.match(text, /explicitly share/);
  assert.match(text, /assignTask/);
  assert.match(text, /worktree/);
  assert.match(text, /Unconfirmed/);
  assert.match(text, /does not automatically resume an ordinary direct chat/);
  assert.match(text, /after the parent's turn ends/);
  assert.doesNotMatch(JSON.stringify(tourPages()), /Delegates|team blueprint|\/team\b|bash_output/);
  assert.ok(pages.every(page => !page.steps.some(step => ["shell", "shell-out"].includes(step.kind))));
  assert.doesNotMatch(text, /rind agents\b/);
});
