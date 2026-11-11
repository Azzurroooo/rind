import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BashPolicy,
  ProcessSupervisor,
  ShellSessionPool,
  ShellTools,
  StreamCapture,
  TaskJournal,
  ToolOutputStore,
  ToolResultNormalizer,
} from "../dist/index.js";

const OUTPUT_TRUNCATED_MARKER = "\n\n...[OUTPUT TRUNCATED]...\n\n";

function nodeScriptCommand(shellBackend, scriptPath) {
  if (shellBackend === "powershell") {
    return `& "${process.execPath}" "${scriptPath}"`;
  }
  return `"${process.execPath.replace(/\\/g, "/")}" "${scriptPath.replace(/\\/g, "/")}"`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

test("BashPolicy.classify blocks dangerous commands, fork bombs, and nested subshells while allowing safe commands and literals", () => {
  // Direct dangerous commands, path-prefixed binaries, sudo/env wrappers, and fork bombs
  const deniedCases = [
    ["mkfs /dev/sda1", "bash"],
    ["mkfs.ext4 /dev/nvme0n1p2", "bash"],
    ["shutdown -h now", "bash"],
    ["/sbin/reboot", "bash"],
    ["sudo ENV_FLAG=1 shutdown -r now", "bash"],
    ["format.exe D: /Q", "powershell"],
    ["C:\\Windows\\System32\\format.com E:", "powershell"],
    ["Format-Volume -DriveLetter D -FileSystem NTFS", "powershell"],
    [":(){ :|:& };:", "bash"],
    [": () { : | : & } ; :", "bash"],
    // Subshell & nested shell invocations
    ["echo $(shutdown -h now)", "bash"],
    ['echo "checking $(mkfs.ext4 /dev/sdb)"', "bash"],
    ["echo `reboot`", "bash"],
    ['bash -c "echo start && shutdown -h now"', "bash"],
    ['sh -lc "mkfs /dev/sdc"', "bash"],
    ['cmd /c "format.exe D:"', "powershell"],
    ['pwsh -Command "Write-Host hi; Format-Volume -DriveLetter E"', "powershell"],
    ["Write-Output $(reboot.exe)", "powershell"],
  ];

  for (const [cmd, backend] of deniedCases) {
    const [decision, reason] = BashPolicy.classify(cmd, backend);
    assert.equal(decision, "deny", `Expected deny for [${backend}] ${cmd}`);
    assert.ok(reason && reason.length > 0, `Expected non-empty deny reason for ${cmd}`);
  }

  // Safe commands, arguments containing dangerous words in non-command position, and quoted literals
  const allowedCases = [
    ["git status --short", "bash"],
    ["echo mkfs shutdown reboot format.exe", "bash"],
    ['grep -rn "shutdown" src/', "bash"],
    ["echo '$(reboot)'", "bash"],
    ["echo ':(){ :|:& };:'", "bash"],
    ['echo ":(){ :|:& };:"', "bash"],
    ['Write-Host "format.exe is just text"', "powershell"],
    // In PowerShell, backtick is an escape character rather than command substitution
    ['Write-Host "line1`nreboot"', "powershell"],
  ];

  for (const [cmd, backend] of allowedCases) {
    const [decision, reason] = BashPolicy.classify(cmd, backend);
    assert.equal(decision, "allow", `Expected allow for [${backend}] ${cmd}, got reason=${reason}`);
    assert.equal(reason, null);
  }
});

test("StreamCapture enforces 24KiB head + 24KiB tail truncation, accurate line counting, and tailPreview", () => {
  const empty = new StreamCapture();
  assert.equal(empty.lineCount, 0);
  assert.equal(empty.truncated, false);
  assert.equal(empty.render(), "");
  assert.equal(empty.tailPreview(100), "");
  assert.equal(empty.tailPreview(0), "");

  // Line counting with and without trailing newline
  const withNewline = new StreamCapture();
  const bufNl = Buffer.from("alpha\nbeta\n", "utf8");
  withNewline.append(bufNl, bufNl.toString("utf8"));
  assert.equal(withNewline.lineCount, 2);

  const withoutNewline = new StreamCapture();
  const bufNoNl = Buffer.from("alpha\nbeta\ngamma", "utf8");
  withoutNewline.append(bufNoNl, bufNoNl.toString("utf8"));
  assert.equal(withoutNewline.lineCount, 3);
  assert.equal(withoutNewline.tailPreview(5), "gamma");
  assert.equal(withoutNewline.tailPreview(10), "beta\ngamma");

  // Line-count truncation (> 2000 lines even when total bytes < 48 KiB)
  const manyLines = new StreamCapture();
  const linesText = "x\n".repeat(2005);
  manyLines.append(Buffer.from(linesText, "utf8"), linesText);
  assert.equal(manyLines.lineCount, 2005);
  assert.equal(manyLines.truncated, true);

  // Character-budget head + tail truncation (> 48 KiB)
  const large = new StreamCapture();
  const headExpected = "H".repeat(24 * 1024);
  const middleDropped = "M".repeat(16 * 1024);
  const tailExpected = "T".repeat(24 * 1024 - 8) + "END_MARK";
  for (const segment of [headExpected, middleDropped, tailExpected]) {
    large.append(Buffer.from(segment, "utf8"), segment);
  }
  assert.equal(large.truncated, true);
  const rendered = large.render();
  assert.ok(rendered.includes(OUTPUT_TRUNCATED_MARKER));
  assert.equal(rendered, headExpected + OUTPUT_TRUNCATED_MARKER + tailExpected);
  assert.equal(large.tailPreview(8), "END_MARK");
  assert.equal(large.tailPreview(12), "TTTTEND_MARK");
});

test("ShellTools, ProcessSupervisor, and TaskJournal: sync execution, yield_timeout handoff, cursor pagination, wait, and process-tree cancel", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-shell-tasks-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const outputStore = new ToolOutputStore(sessionsDir);
  const shellTools = new ShellTools(outputStore);
  t.after(async () => {
    await shellTools.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const sessionId = "sess_main";
  const state = shellTools.pool.getState(sessionId, workspace);
  assert.ok(state.shell_executable, "Expected a detected shell executable on host");

  // 1) Fast synchronous command finishes inline (handoff: false, return_reason: "finished")
  //    Must leave ZERO tasks.jsonl, ZERO .task-workers lease, ZERO tool-output/task_* files, and ZERO task_id
  const observedEvents = [];
  shellTools.supervisor.setObserver(event => observedEvents.push(event));
  const fastScript = path.join(tmp, "fast.mjs");
  await writeFile(
    fastScript,
    'process.stdout.write("sync-stdout-ok\\n"); process.stderr.write("sync-stderr-ok\\n");\n',
    "utf8",
  );
  const syncRaw = await shellTools.bash(
    nodeScriptCommand(state.shell_backend, fastScript),
    workspace,
    10000,
    null,
    "on_exit",
    { _session_id: sessionId, _workspace_root: workspace, _idempotency_key: "call_fast" },
  );
  const syncRes = JSON.parse(syncRaw);
  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.data.status, "completed");
  assert.equal(syncRes.data.return_reason, "finished");
  assert.equal(syncRes.data.handoff, false);
  assert.equal(syncRes.data.exit_code, 0);
  assert.equal("task_id" in syncRes.data, false);
  assert.equal("start_cursor" in syncRes.data, false);
  assert.equal("next_cursor" in syncRes.data, false);
  assert.match(syncRes.data.stdout, /sync-stdout-ok/);
  assert.match(syncRes.data.stderr, /sync-stderr-ok/);
  assert.equal(observedEvents.length, 0, "Foreground bash completion must emit zero task events");
  assert.equal(
    existsSync(path.join(sessionsDir, sessionId, "tasks.jsonl")),
    false,
    "Foreground bash completion must not create tasks.jsonl",
  );
  assert.equal(
    existsSync(path.join(sessionsDir, ".task-workers")),
    false,
    "Foreground bash completion must not create .task-workers lease",
  );
  assert.equal(
    existsSync(path.join(sessionsDir, sessionId, "tool-output")),
    false,
    "Short foreground bash completion must not create tool-output files",
  );

  // 2) Long-running command yields to background (return_reason: "yield_timeout"), streams paged output, and completes via task_wait
  const pagedScript = path.join(tmp, "paged.mjs");
  await writeFile(
    pagedScript,
    [
      'for (let i = 0; i < 6; i++) {',
      '  process.stdout.write(`OUT_CHUNK_${i}_` + "A".repeat(30) + "\\n");',
      '}',
      'process.stderr.write("ERR_MARKER_1\\n");',
      'setTimeout(() => {',
      '  process.stdout.write("FINAL_TAIL_LINE\\n");',
      '  process.exit(0);',
      '}, 280);',
    ].join("\n"),
    "utf8",
  );

  const bgRaw = await shellTools.bash(
    nodeScriptCommand(state.shell_backend, pagedScript),
    workspace,
    30,
    null,
    "on_exit",
    { _session_id: sessionId, _workspace_root: workspace, _idempotency_key: "call_paged" },
  );
  const bgRes = JSON.parse(bgRaw);
  assert.equal(bgRes.ok, true);
  assert.equal(bgRes.data.status, "running");
  assert.equal(bgRes.data.return_reason, "yield_timeout");
  assert.equal(bgRes.data.handoff, true);
  const pagedTaskId = bgRes.data.task_id;
  assert.ok(pagedTaskId);
  assert.ok(bgRes.data.start_cursor);
  assert.ok(bgRes.data.next_cursor);

  // Wait for completion via taskControl("wait", ...)
  const waitRaw = await shellTools.taskControl("wait", pagedTaskId, null, 5000, 20000, null, {
    _session_id: sessionId,
  });
  const waitRes = JSON.parse(waitRaw);
  assert.equal(waitRes.ok, true);
  assert.equal(waitRes.data.status, "completed");
  assert.equal(waitRes.data.return_reason, "finished");

  // Verify TaskJournal persisted completed record
  const journalEntry = await shellTools.supervisor.journal.get(sessionId, pagedTaskId);
  assert.ok(journalEntry);
  assert.equal(journalEntry.status, "completed");
  assert.equal(journalEntry.handoff, true);

  // Read full stored output sequentially from start_cursor -> next_cursor in small 70-char pages
  let cursor = bgRes.data.start_cursor;
  let combinedStdout = "";
  let combinedStderr = "";
  let pages = 0;
  while (true) {
    pages += 1;
    assert.ok(pages <= 20, "Pagination must converge in bounded steps");
    const pageRaw = await shellTools.taskControl("read", pagedTaskId, cursor, null, 70, null, {
      _session_id: sessionId,
    });
    const pageRes = JSON.parse(pageRaw);
    assert.equal(pageRes.ok, true);
    combinedStdout += pageRes.data.stdout;
    combinedStderr += pageRes.data.stderr;
    assert.notEqual(pageRes.data.next_cursor, cursor, "Cursor must advance while reading chunks");
    cursor = pageRes.data.next_cursor;
    if (!pageRes.meta.truncated) {
      break;
    }
  }
  assert.ok(pages >= 3, `Expected multi-page cursor traversal, got ${pages} page(s)`);
  for (let i = 0; i < 6; i++) {
    assert.ok(combinedStdout.includes(`OUT_CHUNK_${i}_`), `Missing OUT_CHUNK_${i}_ in paged stdout`);
  }
  assert.ok(combinedStdout.includes("FINAL_TAIL_LINE"));
  assert.ok(combinedStderr.includes("ERR_MARKER_1"));

  // 3) task_cancel terminates the entire child + grandchild process tree
  const grandchildPidFile = path.join(tmp, "grandchild.pid");
  const childTreeScript = path.join(tmp, "tree-parent.mjs");
  await writeFile(
    childTreeScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const pidFile = ${JSON.stringify(grandchildPidFile)};`,
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(pidFile, String(child.pid), "utf8");',
      'setInterval(() => {}, 1000);',
    ].join("\n"),
    "utf8",
  );

  const treeStartRaw = await shellTools.bash(
    nodeScriptCommand(state.shell_backend, childTreeScript),
    workspace,
    40,
    null,
    "manual",
    { _session_id: sessionId, _workspace_root: workspace, _idempotency_key: "call_tree" },
  );
  const treeStart = JSON.parse(treeStartRaw);
  assert.equal(treeStart.ok, true);
  const treeTaskId = treeStart.data.task_id;

  // Poll briefly until grandchild PID file is written
  let grandchildPid = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const txt = (await readFile(grandchildPidFile, "utf8")).trim();
      grandchildPid = Number.parseInt(txt, 10);
      if (grandchildPid > 0) break;
    } catch {
      // wait for spawn
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(grandchildPid > 0, "Expected grandchild process to record its PID");
  assert.equal(isPidAlive(grandchildPid), true);

  const cancelRaw = await shellTools.taskControl("cancel", treeTaskId, null, null, 20000, null, {
    _session_id: sessionId,
  });
  const cancelRes = JSON.parse(cancelRaw);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.data.status, "cancelled");

  // Wait briefly for OS process table cleanup on Windows/Unix and verify grandchild is dead
  for (let i = 0; i < 30 && isPidAlive(grandchildPid); i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(
    isPidAlive(grandchildPid),
    false,
    `Expected grandchild PID ${grandchildPid} to be terminated with process tree`,
  );
});

test("ProcessSupervisor enforces per-session maxTasks limit and strict cross-session NotFound isolation", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-task-isolation-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const outputStore = new ToolOutputStore(sessionsDir);
  const journal = new TaskJournal(outputStore.sessionRoot);
  const supervisor = new ProcessSupervisor({ maxTasks: 2, journal });
  const pool = new ShellSessionPool();

  t.after(async () => {
    await supervisor.close();
    pool.clear();
    await rm(tmp, { recursive: true, force: true });
  });

  const sleepScript = path.join(tmp, "sleeper.mjs");
  await writeFile(sleepScript, "setInterval(() => {}, 1000);\n", "utf8");

  const stateA = pool.getState("session_A", workspace);
  const stateB = pool.getState("session_B", workspace);
  const cmdA = nodeScriptCommand(stateA.shell_backend, sleepScript);
  const cmdB = nodeScriptCommand(stateB.shell_backend, sleepScript);

  // Start 2 background tasks in session_A (reaches maxTasks: 2)
  const r1 = await supervisor.run(cmdA, stateA, "session_A", null, {
    callId: "a1",
    outputStore,
    yieldTimeMs: 25,
  });
  const r2 = await supervisor.run(cmdA, stateA, "session_A", null, {
    callId: "a2",
    outputStore,
    yieldTimeMs: 25,
  });
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  const taskA1 = JSON.parse(r1.result_str).data.task_id;

  // 3rd concurrent task in session_A is rejected with TaskLimitExceeded
  const r3 = await supervisor.run(cmdA, stateA, "session_A", null, {
    callId: "a3",
    outputStore,
    yieldTimeMs: 25,
  });
  assert.equal(r3.status, "error");
  assert.equal(r3.error_type, "TaskLimitExceeded");
  assert.match(r3.error_msg, /Running task limit reached \(2\)/);

  // Meanwhile, session_B has its own independent task quota and succeeds
  const rB = await supervisor.run(cmdB, stateB, "session_B", null, {
    callId: "b1",
    outputStore,
    yieldTimeMs: 25,
  });
  assert.equal(rB.status, "ok");

  // Cross-session isolation: session_B cannot read, wait, or cancel session_A's task
  for (const action of ["read", "wait", "cancel"]) {
    const cross = await supervisor.control(action, "session_B", taskA1, { waitMs: 50 });
    assert.equal(cross.status, "error", `Expected cross-session ${action} to fail`);
    assert.equal(cross.error_type, "NotFound");
  }

  // session_B's list only includes session_B's task, never session_A's tasks
  const listB = JSON.parse((await supervisor.control("list", "session_B")).result_str);
  assert.equal(listB.data.tasks.length, 1);
  assert.notEqual(listB.data.tasks[0].task_id, taskA1);
});

test("Lazy promotion via releaseWait, active-only monitorTasks, and oversized foreground ToolResultNormalizer projection", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-lazy-promotion-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const outputStore = new ToolOutputStore(sessionsDir);
  const shellTools = new ShellTools(outputStore);
  const normalizer = new ToolResultNormalizer();
  t.after(async () => {
    await shellTools.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const sessionId = "sess_lazy";
  const state = shellTools.pool.getState(sessionId, workspace);

  // 1) Oversized foreground output (>30 KiB) finishes inline without tasks.jsonl, spills raw text via ToolResultNormalizer, and preserves JSON terminal_content
  const bigScript = path.join(tmp, "big.mjs");
  await writeFile(
    bigScript,
    'process.stdout.write(("LINE_" + "X".repeat(80) + "\\n").repeat(400));\n',
    "utf8",
  );
  const bigRaw = await shellTools.bash(
    nodeScriptCommand(state.shell_backend, bigScript),
    workspace,
    10000,
    null,
    "on_exit",
    { _session_id: sessionId, _workspace_root: workspace, _idempotency_key: "call_big" },
  );
  assert.equal(existsSync(path.join(sessionsDir, sessionId, "tasks.jsonl")), false);
  const normalizedBig = await normalizer.normalize(bigRaw, {
    toolName: "bash",
    status: "completed",
    outputStore,
    sessionId,
    callId: "call_big",
  });
  const terminalParsed = JSON.parse(normalizedBig.terminal_content);
  assert.equal(terminalParsed.ok, true);
  assert.equal(terminalParsed.meta.truncated, true);
  assert.ok(terminalParsed.meta.output_path);
  assert.doesNotMatch(normalizedBig.model_content, /task_control/);
  const spilledRaw = await readFile(terminalParsed.meta.output_path, "utf8");
  assert.ok(spilledRaw.startsWith("LINE_XXXX"), "Spilled foreground output must be clean shell text, not JSON wrapper");

  // 2) Active foreground command is discoverable via monitorTasks, promotes losslessly on releaseWait, and disappears from monitorTasks once finished
  const holdSignalFile = path.join(tmp, "release-done.txt");
  const holdScript = path.join(tmp, "hold.mjs");
  await writeFile(
    holdScript,
    [
      'import { existsSync } from "node:fs";',
      `const doneFile = ${JSON.stringify(holdSignalFile)};`,
      'process.stdout.write("EARLY_PRE_HANDOFF_LINE\\n");',
      'const timer = setInterval(() => {',
      '  if (existsSync(doneFile)) {',
      '    clearInterval(timer);',
      '    process.stdout.write("POST_HANDOFF_LINE\\n");',
      '    process.exit(0);',
      '  }',
      '}, 25);',
    ].join("\n"),
    "utf8",
  );

  const pendingBash = shellTools.bash(
    nodeScriptCommand(state.shell_backend, holdScript),
    workspace,
    15000,
    null,
    "on_exit",
    { _session_id: sessionId, _workspace_root: workspace, _idempotency_key: "call_hold" },
  );

  // Wait until monitorTasks exposes the active running foreground command
  let activeTask = null;
  for (let i = 0; i < 80; i += 1) {
    const listed = await shellTools.monitorTasks(sessionId);
    if (listed.tasks.length === 1 && listed.tasks[0].status === "running") {
      activeTask = listed.tasks[0];
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(activeTask, "Expected running foreground bash to appear in monitorTasks");
  assert.equal(activeTask.handoff, false);
  assert.equal(activeTask.status, "running");
  assert.equal(
    existsSync(path.join(sessionsDir, sessionId, "tasks.jsonl")),
    false,
    "Still-foreground command must not have written tasks.jsonl before handoff",
  );

  // Wait briefly for EARLY_PRE_HANDOFF_LINE to buffer in memory before releasing
  await new Promise(resolve => setTimeout(resolve, 80));
  const released = shellTools.supervisor.releaseWait(sessionId, activeTask.task_id);
  assert.equal(released, true);

  const releasedRes = JSON.parse(await pendingBash);
  assert.equal(releasedRes.ok, true);
  assert.equal(releasedRes.data.handoff, true);
  assert.equal(releasedRes.data.return_reason, "released");
  assert.equal(releasedRes.data.task_id, activeTask.task_id);
  assert.equal(existsSync(path.join(sessionsDir, sessionId, "tasks.jsonl")), true);

  // While still running in background, monitorTasks includes it with handoff: true
  const bgListed = await shellTools.monitorTasks(sessionId);
  assert.equal(bgListed.tasks.length, 1);
  assert.equal(bgListed.tasks[0].handoff, true);

  // Let background task finish and verify byte-0 cursor output + eviction from monitorTasks
  await writeFile(holdSignalFile, "done\n", "utf8");
  const finishedRes = JSON.parse(
    await shellTools.taskControl("wait", activeTask.task_id, null, 5000, 20000, null, {
      _session_id: sessionId,
    }),
  );
  assert.equal(finishedRes.data.status, "completed");

  const fromStart = JSON.parse(
    await shellTools.taskControl("read", activeTask.task_id, releasedRes.data.start_cursor, null, 20000, null, {
      _session_id: sessionId,
    }),
  );
  assert.match(fromStart.data.stdout, /EARLY_PRE_HANDOFF_LINE/);
  assert.match(fromStart.data.stdout, /POST_HANDOFF_LINE/);

  const afterFinish = await shellTools.monitorTasks(sessionId);
  assert.equal(afterFinish.tasks.length, 0, "Completed task must be immediately evicted from monitorTasks");
});
