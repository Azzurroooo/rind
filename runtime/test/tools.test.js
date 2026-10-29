import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFileToolSpecs,
  DefaultToolRegistry,
  ShellTools,
  ToolOutputStore,
  JsonlSessionStore,
  SkillRepository,
  SkillTurnCoordinator,
  installSystemSkills,
} from "../dist/index.js";

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
