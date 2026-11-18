import test from "node:test";
import assert from "node:assert/strict";
import {
  CancellationTokenSource,
  CancelledError,
  normalizeGoal,
  normalizePlan,
  parseToolArgs,
  validateCompactHandoffBoundary,
  validateModelMessageBoundary,
  buildSystemPrompt,
  buildGoalPolicyPrompt,
  buildGoalCheckpointPrompt,
  RIND_VERSION,
} from "../dist/index.js";
import { refreshSystemPrompt } from "../dist/prompts.js";
import { buildUserQuestionEvent, runUserQuestion } from "../dist/application/tool-processor.js";
import {
  normalizeQuestionAnswers,
  normalizeUserQuestions,
  parseOptionLabel,
} from "../dist/protocol/runtime-protocol.js";

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

test("normalizePlan validates statuses and strips whitespace", () => {
  const plan = normalizePlan([
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
    () => normalizePlan([{ step: "   ", status: "pending" }]),
    /non-empty step/i,
  );
  assert.throws(
    () => normalizePlan([{ step: "A", status: "blocked" }]),
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

test("system prompts adapt conditionally to enabled tools and refresh cleanly", () => {
  const env = "<environment_context>\nCurrent Working Directory (Project Root): /fixture\n</environment_context>";
  const defaultSys = buildSystemPrompt({ environment: env });
  assert.match(defaultSys, /ask_user_question/);
  assert.match(defaultSys, /update_plan/);
  assert.match(defaultSys, /Precision, Verification & Safety/);

  const noQuestionSys = buildSystemPrompt({
    environment: env,
    tools: ["read_file", "bash"],
    enableUserQuestion: false,
  });
  assert.ok(!noQuestionSys.includes("ask_user_question"));
  assert.ok(!noQuestionSys.includes("update_plan"));
  assert.match(noQuestionSys, /concise, direct question in plain text/);

  const refreshed = refreshSystemPrompt(defaultSys, { enableUserQuestion: false });
  assert.ok(!refreshed.includes("ask_user_question"));
  assert.match(refreshed, /\/fixture/);
});

test("multi-question ask_user_question event validation, label badge parsing, and structured answer output", async () => {
  assert.deepEqual(parseOptionLabel("SQLite (Recommended)"), { text: "SQLite", recommended: true });
  assert.deepEqual(parseOptionLabel("暗色主题（推荐）"), { text: "暗色主题", recommended: true });
  assert.deepEqual(parseOptionLabel("PostgreSQL"), { text: "PostgreSQL", recommended: false });

  const sessionStub = { sessionId: "s1", nowIso: () => "2026-11-18T00:00:00Z" };
  const ev = buildUserQuestionEvent({
    session: sessionStub,
    turnId: "t1",
    call: { call_id: "call-1", name: "ask_user_question", arguments: "{}" },
    parsedArgs: {
      questions: [
        {
          header: "Storage",
          question: "Which storage engine should we use?",
          options: [
            { label: "SQLite (Recommended)", description: "Zero-config local database" },
            { label: "PostgreSQL", description: "External relational server" },
          ],
        },
        {
          header: "Surfaces",
          question: "Which surfaces should receive the update?",
          multiple: true,
          options: [
            { label: "CLI", description: "Terminal interface" },
            { label: "Web", description: "Browser interface" },
          ],
        },
      ],
    },
  });
  assert.equal(ev.questions.length, 2);
  assert.equal(ev.questions[0].header, "Storage");
  assert.equal(ev.questions[1].multiple, true);
  assert.equal(normalizeUserQuestions(ev).length, 2);

  assert.throws(
    () =>
      buildUserQuestionEvent({
        session: sessionStub,
        turnId: "t1",
        call: { call_id: "call-2", name: "ask_user_question", arguments: "{}" },
        parsedArgs: { questions: [1, 2, 3, 4, 5].map(n => ({ question: `Q${n}?` })) },
      }),
    /at most 4 questions/,
  );

  const [okStatus, okPayload] = await runUserQuestion(
    async () => [["SQLite (Recommended)"], ["CLI", "Web"]],
    ev,
  );
  assert.equal(okStatus, "completed");
  const parsed = JSON.parse(okPayload);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.answers, [
    {
      header: "Storage",
      question: "Which storage engine should we use?",
      answers: ["SQLite (Recommended)"],
    },
    {
      header: "Surfaces",
      question: "Which surfaces should receive the update?",
      answers: ["CLI", "Web"],
    },
  ]);

  const [skipStatus, skipPayload, skipErr] = await runUserQuestion(async () => [], ev);
  assert.equal(skipStatus, "failed");
  assert.equal(skipErr, "UserQuestionEmptyAnswer");
  assert.match(skipPayload, /UserQuestionEmptyAnswer/);
  assert.deepEqual(normalizeQuestionAnswers([[], [""]], 2), []);
});
