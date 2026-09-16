import test from "node:test";
import assert from "node:assert/strict";

import { startPages } from "../lib/tour/pages/start.js";
import { teamPages } from "../lib/tour/pages/team.js";

const STEP_KINDS = new Set([
  "shell", "shell-out", "startup", "type", "submit", "result",
  "tool", "assistant", "menu", "turn-done", "exit", "note",
]);
const MENU_KINDS = new Set([
  "slash", "model", "theme", "sessions", "choice",
  "monitor", "delegates", "board", "auth-choice", "auth-secret",
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
    for (const field of ["version", "model", "session_id", "cwd"]) {
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
    if (typeof step.menu?.target === "number") {
      assert.ok(step.menu.target >= (step.menu.selected || 0), `${where}: menu target behind selected`);
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
  for (const page of [...startPages, ...teamPages]) {
    validatePage(page, seen);
  }
});
