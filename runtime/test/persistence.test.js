import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonlSessionStore,
  ToolOutputStore,
  ToolResultNormalizer,
  appendUsageRecord,
  loadUsageRecords,
  summarizeUsage,
  writePlan,
  loadPlanIfExists,
  forkSession,
  FileLockHandle,
  loadSettings,
} from "../dist/index.js";

test("JsonlSessionStore defers disk creation until first user message, persists messages/tools/plan/goal, and supports fork", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-runtime-store-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "deepseek-flash",
    provider: "deepseek",
  });
  await store.initialize();

  // Draft store does not write to disk before user input
  assert.equal(store.is_persisted, false);

  await store.set_name("Refactor test");
  assert.equal(store.is_persisted, false);

  await store.persistUserInput("Hello Rind");
  assert.equal(store.is_persisted, true);
  assert.ok(store.sessionId);
  const st = await stat(path.join(sessionsDir, store.sessionId, "meta.json"));
  assert.ok(st.isFile());

  const now = store.nowIso();
  await store.persistMessage("assistant", "Running bash", {
    meta: {
      tool_calls: [{ id: "call_1", name: "bash", raw_args: '{"command":"echo hi"}' }],
    },
    reasoningContent: "Need to echo hi",
  });
  await store.persistToolCall(
    "call_1",
    "bash",
    { command: "echo hi" },
    '{"command":"echo hi"}',
    now,
    now,
    '{"ok":true,"tool":"bash","data":{"stdout":"hi\\n"}}',
    '{"ok":true,"tool":"bash","data":{"stdout":"hi\\n"}}',
  );
  await store.persistMessage("tool", '{"ok":true,"tool":"bash","data":{"stdout":"hi\\n"}}', "call_1", "bash");

  await store.persistUserInput("Second prompt");
  await store.persistMessage("assistant", "All done.");

  writePlan(
    [
      { step: "Step 1", status: "completed" },
      { step: "Step 2", status: "in_progress" },
    ],
    store.sessionBasePath,
  );
  const plan = loadPlanIfExists(store.sessionBasePath);
  assert.equal(plan.length, 2);

  const goal = await store.setGoal("Finish all tests");
  assert.equal(goal.status, "active");
  const paused = await store.setGoalStatus("paused");
  assert.equal(paused.status, "paused");

  // Fork before second user message
  const allMessages = await store.loadMessages();
  const secondUser = allMessages.find(m => m.role === "user" && m.content === "Second prompt");
  assert.ok(secondUser && secondUser.id);
  const forkedId = forkSession(sessionsDir, store.sessionId, { beforeMessageId: String(secondUser.id) });
  assert.notEqual(forkedId, store.sessionId);

  const forkedStore = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    sessionId: forkedId,
  });
  await forkedStore.initialize();
  const forkedMsgs = await forkedStore.loadMessages();
  assert.equal(forkedMsgs.some(m => m.content === "Second prompt"), false);
  assert.equal(forkedMsgs.some(m => m.content === "Hello Rind"), true);
});

test("ToolOutputStore and ToolResultNormalizer bound oversized tool outputs and spill to disk", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-tool-output-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const outputStore = new ToolOutputStore(tmp);
  const sessionId = "20261029_000001_aabbccdd";
  const savedPath = await outputStore.write(sessionId, "call_big", "x".repeat(50_000));
  assert.ok(savedPath.endsWith(".txt"));

  const normalizer = new ToolResultNormalizer(4000, 4000, 200);
  const bigOutput = JSON.stringify({
    ok: true,
    tool: "bash",
    data: { task_id: "t1", status: "completed", stdout: "line\n".repeat(5000), stderr: "" },
  });
  const normalized = await normalizer.normalize(bigOutput, {
    toolName: "bash",
    sessionId,
    callId: "call_norm",
    outputStore,
  });
  assert.ok(normalized.terminal_content.length <= 4500);
  assert.ok(normalized.model_content.length <= 5000);
});

test("usage ledger records and summarizes token usage across days and models", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-usage-ledger-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const ledgerPath = path.join(tmp, "usage.jsonl");

  appendUsageRecord(ledgerPath, {
    ts: new Date().toISOString(),
    session_id: "20261029_000001_aabbccdd",
    model: "deepseek-flash",
    sampling_kind: "assistant",
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    cached_input_tokens: 400,
  });

  const records = loadUsageRecords(ledgerPath);
  assert.equal(records.length, 1);
  const summary = summarizeUsage(records, 7);
  assert.equal(summary.totals.input, 1200);
  assert.equal(summary.totals.output, 300);
  assert.equal(summary.totals.total, 1500);
  assert.equal(summary.totals.cached, 400);
});

test("FileLockHandle cleans up 0-byte Python filelock files and supports re-entrant withLock", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-file-lock-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const targetPath = path.join(tmp, "session_index.json");
  const lockPath = `${targetPath}.lock`;

  // Simulate a 0-byte .lock file left by Python's filelock.UnixFileLock
  await writeFile(lockPath, "");
  const past = new Date(Date.now() - 1000);
  await utimes(lockPath, past, past);

  const lock = new FileLockHandle(lockPath);
  let nestedRan = false;
  lock.withLock(() => {
    const inner = new FileLockHandle(lockPath);
    inner.withLock(() => {
      nestedRan = true;
    });
  });
  assert.equal(nestedRan, true);
});

test("loadSettings infers deepseek provider from legacy settings.json with api.deepseek.com baseUrl", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-legacy-settings-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const settingsPath = path.join(tmp, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    }),
  );
  const settings = loadSettings(settingsPath);
  assert.equal(settings.provider, "deepseek");
  assert.equal(settings.model, "deepseek-flash");
});
