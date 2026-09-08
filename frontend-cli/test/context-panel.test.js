import test from "node:test";
import assert from "node:assert/strict";

import { contextBreakdownText, loadMeter, promptText, turnCompletedLine } from "../lib/rendering.js";

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

test("context panel lists assembly order with shares of the whole window", () => {
  const text = contextBreakdownText({
    message_count: 46,
    estimated_input_tokens: 62400,
    system_tokens: 6300,
    rind_docs_tokens: 1200,
    skill_catalog_tokens: 900,
    conversation_tokens: 38100,
    tool_tokens: 12600,
    context_window_tokens: 200000,
    context_usage_percent: 0.312,
    auto_compact_token_limit: 180000,
  });
  const rows = text.split("\n");
  const labels = rows
    .map((line) => line.trim().split(/\s{2,}/)[0])
    .filter((label) => ["system prompt", "rind docs", "skills", "conversation", "tools", "free"].includes(label));
  assert.deepEqual(labels, ["system prompt", "rind docs", "skills", "conversation", "tools", "free"]);

  const promptRow = rows.find((line) => line.includes("system prompt"));
  assert.match(promptRow, /system prompt\s+4\.2k\s+2%/);
  assert.match(rows.find((line) => line.includes("rind docs")), /1\.2k\s+1%/);
  assert.match(rows.find((line) => line.includes("skills")), /900\s+0%/);
  assert.match(rows.find((line) => line.includes("conversation")), /38\.1k\s+19%/);
  assert.match(rows.find((line) => line.includes("tools")), /12\.6k\s+6%/);
  assert.match(rows.find((line) => line.includes("free")), /138k\s+69%/);
  assert.doesNotMatch(text, /▯\n|▮\n/);
  assert.equal((text.match(/▮/g) || []).length, 3, "only the single window meter carries bars");
});

test("context panel falls back to a combined system row without split stats", () => {
  const text = contextBreakdownText({
    message_count: 46,
    estimated_input_tokens: 62400,
    system_tokens: 4200,
    conversation_tokens: 38100,
    tool_tokens: 12600,
    context_window_tokens: 200000,
    context_usage_percent: 0.312,
  });
  assert.match(text, /system\s+4\.2k\s+2%/);
  assert.doesNotMatch(text, /system prompt/);
  assert.doesNotMatch(text, /rind docs/);
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
