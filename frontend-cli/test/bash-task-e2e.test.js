import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";

const execFileAsync = promisify(execFile);
const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
const cliEntryUrl = new URL("../lib/frontend-cli-implementation.js", import.meta.url).href;

function sseText(content) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id: "chat_1", model: "fake-e2e", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return chunk({ role: "assistant", content }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

function sseToolCall(id, name, args) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id: "chat_1", model: "fake-e2e", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return (
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    }) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

async function writeProviderConfig(home, port) {
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fake-e2e" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "test-key" } }));
  await writeFile(
    path.join(home, "providers.json"),
    JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1` } } }),
  );
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function openTtyWindow(windows, home, workspace, args = []) {
  const script = `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    process.stdout.columns = 100;
    process.stdout.rows = 30;
    const { runFrontendCliApp } = await import(${JSON.stringify(cliEntryUrl)});
    await runFrontendCliApp(${JSON.stringify(["--cwd", workspace, ...args])});
  `;
  const env = { ...process.env, RIND_HOME: home, NO_COLOR: "1" };
  delete env.RIND_SHARED_HOST_PID;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = createVirtualOutput({ columns: 100, rows: 30 });
  child.stdout.on("data", (chunk) => output.output.write(chunk));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  windows.push(async () => {
    if (child.exitCode === null) {
      child.kill();
    }
    await exited;
  });
  const screen = async () => (await output.flushAndGetViewport()).join("\n");
  return {
    key: (value) => child.stdin.write(value),
    screen,
    async waitUntil(predicate, label = "condition") {
      for (let i = 0; i < 800; i += 1) {
        const current = await screen();
        if (await predicate(current)) return current;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`Timed out waiting for ${label}:\n${await screen()}\nSTDERR:\n${stderr}`);
    },
  };
}

test("rind run E2E: short bash leaves zero task artifacts and stderr spam; yielded on_exit bash auto-resumes cleanly", { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-bash-oneshot-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const slowReleaseFile = path.join(workspace, "slow-release.txt");
  await writeFile(path.join(workspace, "fast.mjs"), 'process.stdout.write("SHORT_RESULT_42\\n");\n', "utf8");
  await writeFile(
    path.join(workspace, "slow.mjs"),
    [
      'import { existsSync } from "node:fs";',
      `const releaseFile = ${JSON.stringify(slowReleaseFile)};`,
      "const deadline = Date.now() + 15000;",
      "const timer = setInterval(() => {",
      "  if (existsSync(releaseFile) || Date.now() >= deadline) {",
      "    clearInterval(timer);",
      '    process.stdout.write("LONG_JOB_COMPLETE\\n");',
      "    process.exit(0);",
      "  }",
      "}, 20);",
    ].join("\n"),
    "utf8",
  );

  let shortToolModelContent = "";
  let longNotificationContent = "";

  const provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-e2e" }] }));
        return;
      }
      const body = JSON.parse(raw);
      const messages = body.messages || [];
      const last = messages.at(-1);
      const firstUser = messages.find((m) => m.role === "user")?.content || "";
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (String(firstUser).includes("short-check")) {
        if (last?.role === "tool") {
          shortToolModelContent = String(last.content || "");
          res.end(sseText("SHORT_DONE"));
          return;
        }
        res.end(sseToolCall("call_short_1", "bash", { command: `${JSON.stringify(process.execPath)} fast.mjs`, yield_time_ms: 5000 }));
        return;
      }

      // Long yielded on_exit scenario
      const notificationMsg = messages.find(
        (m) => m.role === "user" && String(m.content || "").includes('"runtime_notification"'),
      );
      if (notificationMsg) {
        longNotificationContent = String(notificationMsg.content || "");
        res.end(sseText("AUTO_RESUMED_FINAL_ANSWER"));
        return;
      }
      if (last?.role === "tool") {
        res.end(sseText("Waiting on long job."));
        return;
      }
      res.end(sseToolCall("call_long_1", "bash", { command: `${JSON.stringify(process.execPath)} slow.mjs`, yield_time_ms: 50, notify: "on_exit" }));
    });
  });

  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await writeProviderConfig(home, provider.address().port);

  const env = { ...process.env, RIND_HOME: home, NO_COLOR: "1" };
  delete env.RIND_SHARED_HOST_PID;

  t.after(async () => {
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
    await removeRindHome(home).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  // 1) Short bash command in `rind run`
  const shortRun = await execFileAsync(
    process.execPath,
    [rindBin, "run", "--dir", workspace, "--prompt", "short-check"],
    { cwd: workspace, env, timeout: 45000 },
  );
  assert.equal(shortRun.stdout.trim(), "SHORT_DONE");
  assert.doesNotMatch(shortRun.stderr, /task task_/);
  assert.doesNotMatch(shortRun.stderr, /waiting for/);
  assert.match(shortToolModelContent, /SHORT_RESULT_42/);
  assert.doesNotMatch(shortToolModelContent, /task_id|task_control/);

  const sessionDirsAfterShort = (await readdir(path.join(home, "sessions"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}_/.test(entry.name))
    .map((entry) => entry.name);
  assert.equal(sessionDirsAfterShort.length, 1);
  const shortSessionDir = path.join(home, "sessions", sessionDirsAfterShort[0]);
  assert.equal(existsSync(path.join(shortSessionDir, "tasks.jsonl")), false);
  assert.equal(existsSync(path.join(home, "sessions", ".task-workers")), false);
  const shortToolOutputDir = path.join(shortSessionDir, "tool-output");
  if (existsSync(shortToolOutputDir)) {
    assert.deepEqual(await readdir(shortToolOutputDir), []);
  }

  // 2) Yielded on_exit bash command in `rind run`
  const longRun = await new Promise((resolve, reject) => {
    let released = false;
    let stderr = "";
    const child = execFile(
      process.execPath,
      [rindBin, "run", "--dir", workspace, "--prompt", "long-check"],
      { cwd: workspace, env, timeout: 45000 },
      (error, out, err) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: out, stderr: err });
      },
    );
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (!released && stderr.includes("waiting for 1 background task")) {
        released = true;
        void writeFile(slowReleaseFile, "1", "utf8");
      }
    });
  });
  assert.equal(longRun.stdout.trim(), "AUTO_RESUMED_FINAL_ANSWER");
  assert.doesNotMatch(longRun.stderr, /task task_.*:\s*(?:running|completed)/);
  assert.equal((longRun.stderr.match(/waiting for 1 background task\b/g) || []).length, 1);
  assert.match(longNotificationContent, /LONG_JOB_COMPLETE/);

  const allSessionDirs = (await readdir(path.join(home, "sessions"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}_/.test(entry.name))
    .map((entry) => entry.name);
  const longSessionId = allSessionDirs.find((id) => id !== sessionDirsAfterShort[0]);
  assert.ok(longSessionId);
  assert.equal(existsSync(path.join(home, "sessions", longSessionId, "tasks.jsonl")), true);
});

test("Interactive CLI E2E: strict Ctrl+B open/close, r foreground promotion with lossless resume, and manual service lifecycle", { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-bash-tui-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const holdStartedFile = path.join(workspace, "hold-started.txt");
  const holdReleaseFile = path.join(workspace, "hold-finish.txt");
  await writeFile(
    path.join(workspace, "hold.mjs"),
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      `const started = ${JSON.stringify(holdStartedFile)};`,
      `const finish = ${JSON.stringify(holdReleaseFile)};`,
      'process.stdout.write("PRE_RELEASE_OUTPUT\\n");',
      'writeFileSync(started, "1", "utf8");',
      "const timer = setInterval(() => {",
      "  if (existsSync(finish)) {",
      "    clearInterval(timer);",
      '    process.stdout.write("POST_RELEASE_OUTPUT\\n");',
      "    process.exit(0);",
      "  }",
      "}, 25);",
    ].join("\n"),
    "utf8",
  );

  const servicePidFile = path.join(workspace, "service.pid");
  await writeFile(
    path.join(workspace, "service.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(servicePidFile)}, String(process.pid), "utf8");`,
      'process.stdout.write("SERVICE_LISTENING_8080\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );

  let resumedTaskNotification = "";

  const provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-e2e" }] }));
        return;
      }
      const body = JSON.parse(raw);
      const messages = body.messages || [];
      const last = messages.at(-1);
      const userMessages = messages.filter((m) => m.role === "user");
      const latestHuman = [...userMessages]
        .reverse()
        .find((m) => !String(m.content || "").includes('"runtime_notification"'));
      const promptText = String(latestHuman?.content || "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (promptText.includes("start dev server")) {
        if (last?.role === "tool") {
          res.end(sseText("DEV_SERVER_READY"));
          return;
        }
        res.end(
          sseToolCall("call_svc_1", "bash", {
            command: "node service.mjs",
            yield_time_ms: 50,
            notify: "manual",
          }),
        );
        return;
      }

      // First turn: foreground hold -> released with `r` inside Ctrl+B -> auto-resumed on exit
      if (last?.role === "user" && String(last.content || "").includes('"runtime_notification"')) {
        resumedTaskNotification = String(last.content || "");
        res.end(sseText("RELEASE_AND_RESUME_OK"));
        return;
      }
      if (last?.role === "tool") {
        res.end(sseText("MOVED_TO_BACKGROUND"));
        return;
      }
      res.end(
        sseToolCall("call_hold_1", "bash", {
          command: "node hold.mjs",
          yield_time_ms: 20000,
          notify: "on_exit",
        }),
      );
    });
  });

  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await writeProviderConfig(home, provider.address().port);

  const windows = [];
  t.after(async () => {
    for (const stop of windows) await stop();
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
    await removeRindHome(home).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const win = openTtyWindow(windows, home, workspace);
  await win.waitUntil((s) => s.includes("← agents") && s.includes("session new"), "initial banner");

  // --- Scenario A: Foreground bash + strict Ctrl+B open/close + `r` release + auto-resume ---
  win.key("run foreground hold\r");
  await win.waitUntil(
    (s) => existsSync(holdStartedFile) && s.includes("ctrl+b tasks"),
    "foreground bash active with ctrl+b hint",
  );

  const [sessionId] = (await readdir(path.join(home, "sessions"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}_/.test(entry.name))
    .map((entry) => entry.name);
  assert.ok(sessionId);
  const tasksPath = path.join(home, "sessions", sessionId, "tasks.jsonl");
  assert.equal(existsSync(tasksPath), false, "foreground bash must not write tasks.jsonl before handoff");

  // Ctrl+B opens the monitor panel ONLY — does NOT release the foreground bash call!
  win.key("\x02");
  await win.waitUntil(
    (s) => s.includes("Background [") && s.includes("foreground · r background"),
    "Ctrl+B monitor opened showing foreground item",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(tasksPath), false, "Ctrl+B alone must not promote foreground bash to background");

  // Ctrl+B closes the panel cleanly without side effects, and Ctrl+B re-opens it
  win.key("\x02");
  await win.waitUntil((s) => !s.includes("Background ["), "Ctrl+B closed monitor");
  assert.equal(existsSync(tasksPath), false);
  win.key("\x02");
  await win.waitUntil(
    (s) => s.includes("Background [") && s.includes("foreground · r background"),
    "Ctrl+B re-opened monitor",
  );

  // Press `r` inside Ctrl+B to promote foreground wait to background
  win.key("r");
  await win.waitUntil(
    (s) => s.includes("MOVED_TO_BACKGROUND") && s.includes("auto-resume") && existsSync(tasksPath),
    "r promoted foreground bash to auto-resume background task",
  );

  // Trigger script exit and verify lossless pre+post handoff output, auto-resume, eviction, and monitor auto-close
  await writeFile(holdReleaseFile, "done", "utf8");
  const afterResumeScreen = await win.waitUntil(
    (s) => s.includes("RELEASE_AND_RESUME_OK") && !s.includes("Background [") && !s.includes("[bg:") && !s.includes("Waiting ·"),
    "auto-resumed turn completed and monitor auto-closed",
  );
  assert.doesNotMatch(afterResumeScreen, /ctrl\+b tasks/);
  assert.match(resumedTaskNotification, /PRE_RELEASE_OUTPUT/);
  assert.match(resumedTaskNotification, /POST_RELEASE_OUTPUT/);

  // --- Scenario B: Resident service (`notify: "manual"`) + quiet [bg:1] + `service` tag + `c` stop ---
  win.key("start dev server\r");
  const afterServiceReady = await win.waitUntil(
    (s) => s.includes("DEV_SERVER_READY") && s.includes("[bg:1]") && existsSync(servicePidFile),
    "manual service yielded with quiet [bg:1] badge",
  );
  assert.doesNotMatch(afterServiceReady, /Waiting ·/, "manual service must not show Waiting banner");
  assert.match(afterServiceReady, /ctrl\+b tasks/);

  const servicePid = Number.parseInt((await readFile(servicePidFile, "utf8")).trim(), 10);
  assert.equal(isPidAlive(servicePid), true);

  // Open Ctrl+B -> verify `service` role tag and `c stop` -> press `c` -> verify process stopped & monitor auto-closed
  win.key("\x02");
  const servicePanel = await win.waitUntil(
    (s) => s.includes("Background [") && s.includes("node service.mjs") && s.includes("service"),
    "Ctrl+B monitor shows resident service",
  );
  assert.doesNotMatch(servicePanel, /auto-resume/);
  assert.match(servicePanel, /c stop/);

  win.key("c");
  const afterServiceStopped = await win.waitUntil(
    (s) => !s.includes("Background [") && !s.includes("[bg:") && !isPidAlive(servicePid),
    "c stopped resident service and auto-closed monitor",
  );
  assert.doesNotMatch(afterServiceStopped, /ctrl\+b tasks/);
});
