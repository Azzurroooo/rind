import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AsyncSemaphore,
  buildFileToolSpecs,
  CancellationTokenSource,
  DefaultToolRegistry,
  FileMutationQueue,
  ProcessSupervisor,
  setRgSpawnerForTest,
  ShellSessionPool,
  ShellTools,
  buildShellToolSpecs,
  TaskJournal,
  ToolOutputStore,
  JsonlSessionStore,
  SkillRepository,
  SkillTurnCoordinator,
  installSystemSkills,
} from "../dist/index.js";

test("shell task contracts reject invalid ranges and combinations with actionable errors", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-task-contract-"));
  const shell = new ShellTools(new ToolOutputStore(tmp));
  t.after(async () => { await shell.close(); await rm(tmp, { recursive: true, force: true }); });
  const registry = new DefaultToolRegistry(buildShellToolSpecs(shell, tmp));
  for (const wait_ms of [0, 999, 60001, 1.5]) {
    const result = JSON.parse(await registry.callAsync("task_control", { action: "wait", task_id: "missing", wait_ms }));
    assert.equal(result.error_type, "InvalidArguments");
    assert.match(result.error, /1000\.\.60000/);
  }
  for (const yield_time_ms of [-1, 60001, 1.5]) {
    const result = JSON.parse(await registry.callAsync("bash", { command: "echo never", yield_time_ms }));
    assert.equal(result.error_type, "InvalidArguments");
    assert.match(result.error, /0\.\.60000/);
  }
  const read = JSON.parse(await registry.callAsync("task_control", { action: "read", task_id: "missing", wait_ms: 1000 }));
  assert.match(read.error, /Remove wait_ms/);
  const alias = JSON.parse(await registry.callAsync("task_control", { action: "read", task_id: "missing", start_cursor: "x" }));
  assert.equal(alias.ok, false);
  assert.match(alias.error, /Unknown arguments: start_cursor/);
  assert.equal(JSON.parse(await registry.callAsync("task_control", { action: "list" })).ok, true);
});

test("buildFileToolSpecs supports write_file, read_file, edit_file, glob, grep, and enforces workspace boundary", async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "rind-file-tools-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const registry = new DefaultToolRegistry(
    buildFileToolSpecs({
      workspaceRoot: workspace,
      allowedRoots: [workspace],
    }),
  );

  const writeRes = JSON.parse(
    await registry.callAsync("write_file", {
      path: "src/hello.ts",
      content: "export const a = 1;\nexport const b = 2;\n",
    }),
  );
  assert.equal(writeRes.ok, true);

  const readRes = JSON.parse(
    await registry.callAsync("read_file", {
      path: "src/hello.ts",
      offset: 1,
      limit: 10,
    }),
  );
  assert.equal(readRes.ok, true);
  assert.match(readRes.data, /export const a = 1;/);

  const editRes = JSON.parse(
    await registry.callAsync("edit_file", {
      path: "src/hello.ts",
      old_str: "export const a = 1;",
      new_str: "export const a = 42;",
    }),
  );
  assert.equal(editRes.ok, true);

  const globRes = JSON.parse(
    await registry.callAsync("glob", {
      pattern: "**/*.ts",
    }),
  );
  assert.equal(globRes.ok, true);
  assert.ok(globRes.data.some(m => m.path === "src/hello.ts"));

  const grepRes = JSON.parse(
    await registry.callAsync("grep", {
      pattern: "const a = 42",
    }),
  );
  assert.equal(grepRes.ok, true);
  assert.ok(grepRes.data.some(m => m.file === "src/hello.ts"));

  const outsideRes = JSON.parse(
    await registry.callAsync("read_file", {
      path: "../outside.txt",
    }),
  );
  assert.equal(outsideRes.ok, false);
  assert.equal(outsideRes.error_type, "WorkspaceBoundary");
});

test("ShellTools executes foreground and background bash commands, supports task_control, and blocks dangerous commands", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-shell-tools-"));
  const workspace = path.join(tmp, "work");
  await mkdir(workspace, { recursive: true });
  const shellTools = new ShellTools(new ToolOutputStore(tmp));
  t.after(async () => {
    await shellTools.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const sessionId = "20261029_000002_11223344";

  // 1. Foreground command
  const fg = JSON.parse(
    await shellTools.bash("echo hello-ts-runtime", null, 10000, null, "on_exit", {
      _workspace_root: workspace,
      _session_id: sessionId,
    }),
  );
  assert.equal(fg.ok, true);
  assert.equal(fg.data.status, "completed");
  assert.match(fg.data.stdout, /hello-ts-runtime/);

  // 2. Dangerous command blocked
  const blocked = JSON.parse(
    await shellTools.bash("mkfs.ext4 /dev/sda1", null, 10000, null, "on_exit", {
      _workspace_root: workspace,
      _session_id: sessionId,
    }),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error_type, "DangerousCommandBlocked");

  // 3. Background handoff via yield_time_ms
  const bg = JSON.parse(
    await shellTools.bash(
      `"${process.execPath}" -e "setTimeout(() => console.log('bg-finished'), 400)"`,
      null,
      50,
      null,
      "on_exit",
      {
        _workspace_root: workspace,
        _session_id: sessionId,
      },
    ),
  );
  assert.equal(bg.ok, true);
  assert.equal(bg.data.status, "running");
  assert.ok(bg.data.task_id);

  const waited = JSON.parse(
    await shellTools.taskControl("wait", bg.data.task_id, null, 3000, 10000, null, {
      _session_id: sessionId,
    }),
  );
  assert.equal(waited.ok, true);
  assert.equal(waited.data.status, "completed");
  assert.match(waited.data.stdout, /bg-finished/);
});

test("SkillRepository discovers project and system skills and SkillTurnCoordinator injects $skill activations", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-skills-"));
  const rindHome = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  const sessionsDir = path.join(rindHome, "sessions");
  await mkdir(path.join(workspace, ".agents", "skills", "demo-skill"), { recursive: true });
  await writeFile(
    path.join(workspace, ".agents", "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo test skill\n---\nFollow demo skill steps.\n",
  );
  t.after(() => rm(tmp, { recursive: true, force: true }));

  installSystemSkills(rindHome);
  const repo = new SkillRepository(workspace, { rindHome, home: tmp });
  const skills = repo.listSkills();
  assert.ok(skills.some(s => s.name === "demo-skill"));
  assert.ok(skills.some(s => s.name === "skill-creator"));

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "deepseek-flash",
    provider: "deepseek",
  });
  await store.initialize();
  const coordinator = new SkillTurnCoordinator(repo, { catalog: true });
  await coordinator.persistUserInput(store, "Please use $demo-skill to solve this");
  const msgs = await store.loadMessages();
  assert.ok(msgs.some(m => String(m.content).includes("Follow demo skill steps.")));
});

test("glob and grep pass bounded --threads 4 to rg and respect Worker toolSemaphore", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-rg-threads-"));
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "a.py"), "needle\n");

  const seenCommands = [];
  setRgSpawnerForTest((args, cwd) => {
    seenCommands.push([...args]);
    return spawn("rg", args, {
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });
  t.after(async () => {
    setRgSpawnerForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  const workerSemaphore = new AsyncSemaphore(1);
  const registry = new DefaultToolRegistry(
    buildFileToolSpecs({
      workspaceRoot: workspace,
      allowedRoots: [workspace],
      mutationQueue: new FileMutationQueue(workerSemaphore),
    }),
  );

  const globRes = JSON.parse(await registry.callAsync("glob", { pattern: "*.py", path: workspace }));
  assert.equal(globRes.ok, true);
  assert.deepEqual(globRes.data.map(item => item.path), ["a.py"]);

  const grepRes = JSON.parse(await registry.callAsync("grep", { pattern: "needle", path: workspace }));
  assert.equal(grepRes.ok, true);

  assert.equal(seenCommands.length, 2);
  for (const cmd of seenCommands) {
    const idx = cmd.indexOf("--threads");
    assert.notEqual(idx, -1, `Expected --threads in ${JSON.stringify(cmd)}`);
    assert.equal(cmd[idx + 1], "4");
  }

  // Exhaust worker semaphore and verify glob/grep wait on it and cancel cleanly
  assert.equal(await workerSemaphore.tryAcquire(), true);
  const cancelSource = new CancellationTokenSource();
  const pendingGlob = registry.callAsync("glob", {
    pattern: "*.py",
    path: workspace,
    _cancellation_token: cancelSource.token,
  });
  cancelSource.cancel("Worker slot cancelled");
  const cancelledGlob = JSON.parse(await pendingGlob);
  assert.equal(cancelledGlob.ok, false);
  assert.equal(cancelledGlob.error_type, "Cancelled");
  workerSemaphore.release();
});

test("ProcessSupervisor enforces per-session limit (default 64) without global cap", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-sup-limits-"));
  const workspace = path.join(tmp, "work");
  await mkdir(workspace, { recursive: true });

  assert.equal(new ProcessSupervisor().maxTasks, 64);

  const journal = new TaskJournal(path.join(tmp, "sessions"));
  const supervisor = new ProcessSupervisor({ maxTasks: 2, journal });
  const pool = new ShellSessionPool();
  const state = pool.getState("20261031_000001_aaaaaaaa", workspace);

  t.after(async () => {
    await supervisor.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const s1 = "20261031_000001_aaaaaaaa";
  const s2 = "20261031_000002_bbbbbbbb";
  const sleepCmd = `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`;

  const r1 = await supervisor.run(sleepCmd, state, s1, null, { yieldTimeMs: 20 });
  assert.equal(r1.status, "ok");
  const r2 = await supervisor.run(sleepCmd, state, s1, null, { yieldTimeMs: 20 });
  assert.equal(r2.status, "ok");

  const perSessionExceeded = await supervisor.run("echo hi", state, s1);
  assert.equal(perSessionExceeded.status, "error");
  assert.equal(perSessionExceeded.error_type, "TaskLimitExceeded");
  assert.match(perSessionExceeded.error_msg, /Running task limit reached \(2\)/);

  // Another session s2 is unaffected by s1 saturating its per-session limit
  const r3 = await supervisor.run(sleepCmd, state, s2, null, { yieldTimeMs: 20 });
  assert.equal(r3.status, "ok");
  const s2Ok = await supervisor.run("echo hi", state, s2);
  assert.equal(s2Ok.status, "ok");
  assert.equal(JSON.parse(s2Ok.result_str).data.status, "completed");
});
