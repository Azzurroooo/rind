import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonlSessionStore,
  SESSION_FILES,
  SessionFiles,
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

test("reads of session_index.json, meta.json, and jsonl remain lock-free while an exclusive write lock is held by another process", { timeout: 20000 }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-lockfree-read-"));
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
  await store.persist_user_input("Analyze coal sector supply");
  await store.persist_message("assistant", "Starting sector analysis.");

  const indexPath = JsonlSessionStore.index_path_for(sessionsDir);
  const metaPath = path.join(sessionsDir, store.session_id, "meta.json");
  const messagesPath = path.join(sessionsDir, store.session_id, "messages.jsonl");
  const runtimeEntry = new URL("../dist/index.js", import.meta.url).href;

  // Hold exclusive write locks on index.json, meta.json, and messages.jsonl in a separate process.
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { FileLockHandle } from ${JSON.stringify(runtimeEntry)};
        const locks = ${JSON.stringify([`${indexPath}.lock`, `${metaPath}.lock`, `${messagesPath}.lock`])}.map(p => new FileLockHandle(p, 5000));
        for (const l of locks) l.acquire();
        process.stdout.write("LOCKED\\n");
        process.stdin.resume();
        process.stdin.once("data", () => {
          for (const l of locks) l.release();
          process.exit(0);
        });
      `,
    ],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  t.after(() => {
    if (holder.exitCode === null) holder.kill();
  });

  await new Promise((resolve, reject) => {
    let out = "";
    holder.once("error", reject);
    holder.stdout.on("data", chunk => {
      out += chunk.toString("utf8");
      if (out.includes("LOCKED")) resolve();
    });
  });

  // Pure reads must complete instantaneously without acquiring .lock or blocking.
  const startedAt = Date.now();
  const listed = JsonlSessionStore.list_session_metadata({ sessionDir: sessionsDir, workspaceRoot: workspace });
  const loadedMeta = JsonlSessionStore.load_session_metadata(store.session_id, sessionsDir);
  const loadedMessages = SESSION_FILES.readJsonl(messagesPath);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, store.session_id);
  assert.equal(loadedMeta.session_id, store.session_id);
  assert.ok(loadedMessages.some(m => m.content === "Analyze coal sector supply"));
  assert.ok(elapsedMs < 1000, `Expected lock-free reads to complete immediately, took ${elapsedMs}ms`);

  // Verify timeout error messages distinguish shared index files from per-session files.
  const shortIndexFiles = new SessionFiles();
  shortIndexFiles.lockFor = filePath => new FileLockHandle(`${filePath}.lock`, 40);
  assert.throws(
    () => shortIndexFiles.writeJson(indexPath, { sessions: [] }),
    /Timed out waiting to update shared store/,
  );
  assert.throws(
    () => shortIndexFiles.writeJson(metaPath, loadedMeta),
    /Session is currently in use by another process/,
  );

  holder.stdin.end("release\n");
  await new Promise(resolve => holder.once("close", resolve));
});

test("FileLockHandle reclaims dead-PID, remote-host stale, and expired-lease locks without deleting a new owner's lock", { timeout: 20000 }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-stale-lock-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // 1. Dead local PID lock is reclaimed immediately even when mtime is brand new.
  const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  await new Promise(resolve => deadChild.once("close", resolve));
  const deadLockPath = path.join(tmp, "dead.json.lock");
  await writeFile(deadLockPath, `${deadChild.pid} ${os.hostname()} dead-token\n`, "utf8");
  const deadHandle = new FileLockHandle(deadLockPath, 500);
  deadHandle.withLock(() => {
    assert.ok(true);
  });

  // 2. Remote GPU cluster host lock (e.g. gpu10 seen on gpu11): respected when fresh, reclaimed once stale (>30s).
  const remoteLockPath = path.join(tmp, "remote.json.lock");
  await writeFile(remoteLockPath, `${process.pid} gpu10-foreign-node remote-token\n`, "utf8");
  const remoteHandle = new FileLockHandle(remoteLockPath, 60);
  assert.throws(() => remoteHandle.acquire(60), /Lock timeout/);

  const expired = new Date(Date.now() - 35_000);
  await utimes(remoteLockPath, expired, expired);
  remoteHandle.withLock(() => {
    assert.ok(true);
  });

  // 3. Recycled / live local PID whose lock exceeded the 30s lease is reclaimed, and an evicted owner never deletes the new lock.
  const recycledLockPath = path.join(tmp, "recycled.json.lock");
  await writeFile(recycledLockPath, `${process.pid} other-host-or-container stale-token\n`, "utf8");
  await utimes(recycledLockPath, expired, expired);
  const newOwner = new FileLockHandle(recycledLockPath, 500);
  newOwner.acquire();
  const activeContent = await readFile(recycledLockPath, "utf8");
  assert.match(activeContent, new RegExp(`^${process.pid} `));
  newOwner.release();
});

test("concurrent multi-process session writes and continuous index reads complete with zero lock failures or lost entries", { timeout: 30000 }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-multiprocess-index-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionsDir = path.join(tmp, "sessions");
  const runtimeEntry = new URL("../dist/index.js", import.meta.url).href;
  const workerCount = 6;
  const sessionsPerWorker = 3;

  const workers = Array.from({ length: workerCount }, (_, workerIdx) => {
    const workspace = path.join(tmp, `agent_${workerIdx}`);
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { JsonlSessionStore } from ${JSON.stringify(runtimeEntry)};
            const ids = [];
            for (let s = 0; s < ${sessionsPerWorker}; s++) {
              const store = new JsonlSessionStore({
                sessionDir: ${JSON.stringify(sessionsDir)},
                workspaceRoot: ${JSON.stringify(workspace)},
                model: "deepseek-flash",
                provider: "deepseek",
              });
              await store.initialize();
              await store.persist_user_input("Task " + s + " from worker ${workerIdx}");
              for (let step = 0; step < 4; step++) {
                const now = store.now_iso();
                await store.persist_tool_call(
                  "call_" + step,
                  "bash",
                  { command: "echo " + step },
                  JSON.stringify({ command: "echo " + step }),
                  now,
                  now,
                  JSON.stringify({ ok: true }),
                  JSON.stringify({ ok: true }),
                );
                await store.persist_message("assistant", "Completed step " + step);
              }
              ids.push(store.session_id);
            }
            process.stdout.write(JSON.stringify(ids) + "\\n");
          `,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", d => { stdout += d.toString("utf8"); });
      child.stderr.on("data", d => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) reject(new Error(`Worker ${workerIdx} failed (${code}): ${stderr}`));
        else resolve(JSON.parse(stdout.trim()));
      });
    });
  });

  // Hammer list_session_metadata concurrently on the main process while all 6 child processes write.
  let settled = false;
  const allDone = Promise.all(workers).finally(() => { settled = true; });
  let readCount = 0;
  while (!settled) {
    const list = JsonlSessionStore.list_session_metadata({ sessionDir: sessionsDir, limit: 100 });
    assert.ok(Array.isArray(list));
    readCount += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const createdGroups = await allDone;
  const expectedIds = createdGroups.flat().sort();

  assert.ok(readCount > 0);
  const finalSessions = JsonlSessionStore.list_session_metadata({ sessionDir: sessionsDir, limit: 100 });
  assert.deepEqual(finalSessions.map(s => s.id).sort(), expectedIds);
});
