import assert from "node:assert/strict";
import test from "node:test";

import { renderLedgerRow, renderLiveDock, renderOutcomeLine, renderSummaryLine } from "../lib/activity-renderer.js";
import { textWidth } from "../lib/text-width.js";

test("renders a readable live dock at supported widths", () => {
  const activity = { kind: "inspect", target: "agent/auth.py", startedAt: 0, durationMs: 2000 };
  for (const width of [40, 60, 80, 120]) {
    const output = renderLiveDock(activity, width, 2000);
    assert.ok(output.split("\n").every((line) => textWidth(line) <= width), `${width}: ${output}`);
    assert.match(output, /inspect/);
  }
});

test("shows concurrent work without adding another activity frame", () => {
  const line = renderLiveDock({ kind: "run", target: "npm test", startedAt: 0, runningCount: 4 }, 80, 2000);
  assert.match(line, /\+3 running/);
  assert.doesNotMatch(line, /ctrl\+c stop/);
});

test("renders ledger rows with semantic status and failure guidance", () => {
  const success = renderLedgerRow({ kind: "check", target: "pytest tests", status: "done", durationMs: 1800, metrics: { testsPassed: 12, testsFailed: 0 }, fileChanges: [] }, 80);
  assert.match(success, /check/);
  assert.match(success, /pass/);
  assert.match(success, /12\/12/);
  const failure = renderLedgerRow({ kind: "run", target: "npm test", status: "fail", durationMs: 1200, errorType: "ExitCode", metrics: { output: "expected 200, got 401", exitCode: 1 }, fileChanges: [] }, 80);
  assert.match(failure, /fail/);
  assert.match(failure, /next/);
});

test("keeps ledger rows inside narrow terminal widths", () => {
  const activity = { kind: "search", target: "refreshToken in agent/", status: "done", durationMs: 1800, metrics: { hits: 12, files: 4 }, fileChanges: [] };
  for (const width of [40, 59, 60, 80, 120]) {
    assert.ok(renderLedgerRow(activity, width).split("\n").every((line) => textWidth(line) <= width), String(width));
  }
});

test("renders a compact turn receipt", () => {
  assert.equal(renderSummaryLine({ changedFiles: 2, added: 18, removed: 6, testsPassed: 12, testsFailed: 0, failed: 0, durationMs: 8400 }), "summary 2 files changed | +18 -6 | 12 tests passed | 8.4s");
});

test("renders turn failures and cancellation as formal rows", () => {
  assert.match(renderOutcomeLine("note", "turn", "fail", 0, "provider unavailable", 80), /note.*fail/);
  assert.match(renderOutcomeLine("note", "turn", "stop", 0, "user interrupted", 80), /note.*stop/);
});

test("does not emit ANSI controls in the default non-TTY renderer", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const line = renderLiveDock({ kind: "run", target: "npm test", startedAt: 0 }, 80, 1000);
    assert.doesNotMatch(line, /\x1b\[/);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
