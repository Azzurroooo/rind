import test from "node:test";
import assert from "node:assert/strict";

import { accumulateUsage, usageTotals } from "../lib/usage.js";
import {
  contextBreakdownText,
  loadMeter,
  promptText,
  turnCompletedLine,
  usageText,
} from "../lib/rendering.js";

test("usage totals seed from persisted worker totals and ignore invalid values", () => {
  const totals = usageTotals({
    input_tokens: 1200,
    cached_input_tokens: 300,
    output_tokens: 400,
    reasoning_output_tokens: -5,
    total_tokens: 1600,
    samplings: 3,
    unexpected: "dropped",
  });
  assert.deepEqual(totals, {
    input_tokens: 1200,
    cached_input_tokens: 300,
    output_tokens: 400,
    reasoning_output_tokens: 0,
    total_tokens: 1600,
    samplings: 3,
  });
  assert.deepEqual(usageTotals(null).samplings, 0);
});

test("usage totals accumulate one entry per sampling", () => {
  const totals = usageTotals();
  accumulateUsage(totals, { input_tokens: 100, output_tokens: 10 });
  accumulateUsage(totals, { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 });
  accumulateUsage(totals, null);
  assert.equal(totals.input_tokens, 150);
  assert.equal(totals.cached_input_tokens, 40);
  assert.equal(totals.output_tokens, 15);
  assert.equal(totals.samplings, 2);
});

test("load meter fills cells and escalates tone with load", () => {
  assert.equal(loadMeter(0), "▯▯▯▯▯▯▯▯▯▯");
  assert.equal(loadMeter(0.31), "▮▮▮▯▯▯▯▯▯▯");
  assert.equal(loadMeter(1), "▮▮▮▮▮▮▮▮▮▮");
  assert.equal(loadMeter(0.4, 5), "▮▮▯▯▯");
});

const SAMPLE_STATS = {
  input_tokens: 62000,
  cached_input_tokens: 58000,
  cache_hit_rate: 0.93,
  output_tokens: 1800,
  context_window_tokens: 200000,
  context_usage_percent: 0.31,
};

test("prompt header renders the context meter between effort and path", () => {
  const frame = promptText(
    { model: "test-model", reasoning_effort: "high", cwd: "/tmp/proj" },
    SAMPLE_STATS,
    {},
    100,
  );
  const header = frame.split("\n").find((line) => line.includes("test-model"));
  assert.match(header, /test-model · high · ▮▮▮▯▯▯▯▯▯▯ 31% · \/tmp\/proj/);
});

test("prompt header omits the meter without usage data", () => {
  const frame = promptText({ model: "test-model", cwd: "/tmp/proj" }, {}, {}, 100);
  const header = frame.split("\n").find((line) => line.includes("test-model"));
  assert.equal(header.includes("▯"), false);
  assert.equal(header.includes("ctx"), false);
});

test("prompt header falls back to a token count without a context window", () => {
  const frame = promptText(
    { model: "test-model", cwd: "/tmp/proj" },
    { input_tokens: 62000 },
    {},
    100,
  );
  const header = frame.split("\n").find((line) => line.includes("test-model"));
  assert.match(header, /62k ctx/);
});

test("usage panel reports context, cache, last turn, and session totals", () => {
  const text = usageText({
    stats: SAMPLE_STATS,
    totals: usageTotals({
      input_tokens: 412900,
      cached_input_tokens: 381200,
      output_tokens: 38200,
      reasoning_output_tokens: 12000,
      total_tokens: 451100,
      samplings: 27,
    }),
    lastTurn: { input_tokens: 12300, output_tokens: 1800 },
  });
  assert.match(text, /── Usage · 27 samplings/);
  assert.match(text, /context\s+▮▮▮▯▯▯▯▯▯▯ 31% · 62k \/ 200k/);
  assert.match(text, /cache\s+58k · 93\.0% hit/);
  assert.match(text, /last turn\s+↑12\.3k ↓1\.8k/);
  assert.match(text, /input\s+413k · cached 381k/);
  assert.match(text, /output\s+38\.2k · reasoning 12k/);
});

test("usage panel explains itself before any turn ran", () => {
  const text = usageText({ stats: {}, totals: usageTotals() });
  assert.match(text, /no token usage yet/);
});

test("context panel breaks the window into sorted parts with shares", () => {
  const text = contextBreakdownText({
    message_count: 46,
    estimated_input_tokens: 62400,
    system_tokens: 4200,
    conversation_tokens: 38100,
    tool_tokens: 12600,
    context_window_tokens: 200000,
    context_usage_percent: 0.312,
    auto_compact_token_limit: 180000,
  });
  assert.match(text, /── Context · 62\.4k \/ 200k/);
  assert.match(text, /▮▮▮▯▯▯▯▯▯▯ 31% · compact at 180k/);
  const conversationRow = text.split("\n").find((line) => line.includes("conversation"));
  const toolsRow = text.split("\n").find((line) => line.includes("tools"));
  const systemRow = text.split("\n").find((line) => line.includes("system"));
  assert.ok(conversationRow.indexOf("38.1k") < conversationRow.indexOf("▮"), "tokens before meter");
  assert.match(conversationRow, /61%/);
  assert.match(toolsRow, /12\.6k/);
  assert.match(toolsRow, /20%/);
  assert.match(systemRow, /4\.2k/);
  const freeRow = text.split("\n").find((line) => line.includes("free"));
  assert.match(freeRow, /138k/);
  assert.match(text, /46 messages in context/);
});

test("context panel asks for a turn before measurements exist", () => {
  const text = contextBreakdownText(null);
  assert.match(text, /no measurements yet/);
});

test("turn summary line appends the per-turn token delta", () => {
  const line = turnCompletedLine(
    { duration_ms: 45000, usage: { input_tokens: 12300, output_tokens: 1800 } },
    { completed: 3, failed: 0 },
  );
  assert.match(line, /Worked for 45\.00s · ↑12\.3k ↓1\.8k · 3 completed/);

  const plain = turnCompletedLine({ duration_ms: 1000 }, { completed: 0, failed: 0 });
  assert.doesNotMatch(plain, /↑/);
});
