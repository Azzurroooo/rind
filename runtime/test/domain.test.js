import test from "node:test";
import assert from "node:assert/strict";
import {
  CancellationTokenSource,
  CancelledError,
  normalizeGoal,
  normalizePlanItems,
  parseToolArgs,
  validateCompactHandoffBoundary,
  validateModelMessageBoundary,
  buildSystemPrompt,
  buildGoalPolicyPrompt,
  buildGoalCheckpointPrompt,
  RIND_VERSION,
} from "../dist/index.js";

test("CancellationTokenSource propagates reason, notifies callbacks, and rejects wait()", async () => {
  const source = new CancellationTokenSource();
  assert.equal(source.token.isCancelled, false);
  let called = false;
  const unregister = source.token.registerCallback(() => {
    called = true;
  });
  unregister();
  source.token.registerCallback(() => {
    called = true;
  });

  const waitPromise = source.token.wait();
  source.cancel("user_interrupt");
  assert.equal(source.token.isCancelled, true);
  assert.equal(source.token.reason, "user_interrupt");
  assert.equal(called, true);
  await assert.rejects(waitPromise, err => err instanceof CancelledError && err.message === "user_interrupt");
});

test("normalizePlanItems validates statuses and strips whitespace", () => {
  const plan = normalizePlanItems([
    { step: "  Read code  ", status: "completed" },
    { step: "Write tests", status: "in_progress" },
    { step: "Run suite", status: "pending" },
  ]);
  assert.deepEqual(plan, [
    { step: "Read code", status: "completed" },
    { step: "Write tests", status: "in_progress" },
    { step: "Run suite", status: "pending" },
  ]);
  assert.throws(
    () => normalizePlanItems([{ step: "   ", status: "pending" }]),
    /non-empty step/i,
  );
  assert.throws(
    () => normalizePlanItems([{ step: "A", status: "blocked" }]),
    /invalid status/i,
  );
});

test("normalizeGoal validates objective and status", () => {
  const state = normalizeGoal({
    objective: " Complete migration ",
    status: "active",
  });
  assert.equal(state.objective, "Complete migration");
  assert.equal(state.status, "active");
  assert.throws(
    () => normalizeGoal({ objective: "", status: "active" }),
    /objective/i,
  );
});

test("validateModelMessageBoundary enforces system-prefix and tool-call pairing", () => {
  assert.deepEqual(
    validateModelMessageBoundary([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]),
    { ok: true, detail: {} },
  );

  const orphanTool = validateModelMessageBoundary([
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]);
  assert.equal(orphanTool.ok, false);

  const missingToolResult = validateModelMessageBoundary([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "user", content: "next" },
  ]);
  assert.equal(missingToolResult.ok, false);
});

test("validateCompactHandoffBoundary checks continuation and handoff structure", () => {
  const valid = validateCompactHandoffBoundary([
    { role: "system", content: "sys" },
    { role: "user", content: "Continue from compacted context." },
    { role: "assistant", content: "Summary of prior work" },
  ]);
  assert.equal(valid.ok, true);
});

test("parseToolArgs handles valid JSON, empty string, and malformed JSON", () => {
  assert.deepEqual(parseToolArgs('{"path":"a.ts"}'), [{ path: "a.ts" }, null]);
  assert.deepEqual(parseToolArgs(""), [{}, null]);
  const [parsed, err] = parseToolArgs("{bad");
  assert.deepEqual(parsed, {});
  assert.ok(typeof err === "string" && err.length > 0);
});

test("system prompts and version constants are well-formed", () => {
  assert.match(RIND_VERSION, /^\d+\.\d+\.\d+/);
  const sys = buildSystemPrompt({
    environment: "<environment_context>\nCurrent Working Directory (Project Root): /fixture\n</environment_context>",
  });
  assert.match(sys, /You are Rind/);
  assert.match(sys, /update_plan/);
  assert.match(sys, /\/fixture/);
  assert.match(buildGoalPolicyPrompt(), /update_goal/);
  assert.match(buildGoalCheckpointPrompt("Ship feature X"), /Ship feature X/);
});
