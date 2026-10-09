import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startFixture() {
  const script = [];
  const models = ["fake-model-a", "fake-model-b"];
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
      const body = JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(body);
      return;
    }
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(raw || "{}"));
      const entry = script.shift() || { chunks: ["(no script)"] };
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: "assistant" }));
      for (const piece of entry.chunks || []) {
        response.write(chunk({ content: piece }));
      }
      response.write(chunk({}, "stop"));
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      script,
      requests,
      port: server.address().port,
      async stop() {
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

function spawnCli(workspace, rindHome, env = {}, args = []) {
  const child = spawn(process.execPath, [path.join(repoRoot, "frontend-cli", "bin", "rind.js"), ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      RIND_HOME: rindHome,
      RIND_PYTHON: process.env.RIND_PYTHON || "python",
      NO_COLOR: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const waitFor = (needle, timeout = 45000, fromIndex = 0, stream = "stdout") => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = (stream === "stderr" ? stderr : stdout).indexOf(needle, fromIndex);
      if (found >= 0) {
        resolve(found);
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`CLI exited (${child.exitCode}) before ${JSON.stringify(needle)}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
  const send = (line) => child.stdin.write(`${line}\n`);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, waitFor, send, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// The user's settings live in RIND_HOME (parent/home); the folder holds none.
async function makeWorkspace(parent, baseUrl) {
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(parent, "home"), { recursive: true });
  await writeFile(
    path.join(parent, "home", "settings.json"),
    JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model-a" }),
    "utf8",
  );
  return workspace;
}

test("interactive CLI journey: empty startup, login, send, chat, logout", async () => {
  const fixture = await startFixture();
  fixture.script.push({ chunks: ["hi from fixture"] });
  const parent = await mkdtemp(path.join(tmpdir(), "rind-cli-journey-"));
  const rindHome = path.join(parent, "home");
  await mkdir(rindHome, { recursive: true });
  const workspace = await makeWorkspace(parent, `http://127.0.0.1:${fixture.port}/v1`);

  const cli = spawnCli(workspace, rindHome);
  try {
    await cli.waitFor("fake-model-a");
    assert.match(cli.stdout, /session\s+new/, "nothing exists before the first message");
    await assert.rejects(stat(path.join(rindHome, "sessions")), { code: "ENOENT" });
    // OpenAI offers two ways in; choosing the API key asks for it as before.
    cli.send("/login openai");
    await cli.waitFor("Sign in [API key, Sign in with ChatGPT]");
    cli.send("API key");
    await cli.waitFor("OpenAI API key");
    cli.send("");
    await cli.waitFor("Login canceled.");
    cli.send("/login openai-compatible");
    await cli.waitFor("OpenAI compatible (chat completions) API key");
    cli.send("e2e-cli-secret");
    await cli.waitFor("Logged in to openai-compatible");
    await assert.rejects(stat(path.join(rindHome, "sessions")), { code: "ENOENT" });

    // The first message, typed in the window, creates and saves the conversation.
    cli.send("hello there");
    const replyAt = await cli.waitFor("hi from fixture");
    const [sessionId] = await readdir(path.join(rindHome, "sessions"));
    assert.match(sessionId, /^\d{8}_\d{6}_[a-f0-9]+$/);
    const meta = JSON.parse(await readFile(path.join(rindHome, "sessions", sessionId, "meta.json"), "utf8"));
    assert.equal(meta.session_id, sessionId);
    assert.equal(fixture.requests.at(-1).reasoning_effort, undefined);

    // Refreshed /models entries carry no effort metadata, so the dialect default
    // applies and /effort max is accepted and sent with the next request.
    cli.send("/effort max");
    await cli.waitFor("session effort: max");
    // Turn state settles asynchronously after the completion event; input sent
    // inside that window is misrouted as steering, so pace like a real user.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    fixture.script.push({ chunks: ["second reply from fixture"] });
    cli.send("one more");
    let secondAt = -1;
    for (let attempt = 0; attempt < 6 && secondAt < 0; attempt += 1) {
      try {
        secondAt = await cli.waitFor("second reply from fixture", 5000);
      } catch {
        cli.send("one more");
      }
    }
    assert.ok(secondAt >= 0, `second turn never acknowledged:\n${cli.stdout}`);
    assert.equal(fixture.requests.at(-1).reasoning_effort, "max");

    // The serial non-TTY prompt loop asks for the next line only after the
    // turn settles, so retype /logout like a user until the CLI accepts it.
    let loggedOutAt = -1;
    for (let attempt = 0; attempt < 12 && loggedOutAt < 0; attempt += 1) {
      cli.send("/logout");
      try {
        loggedOutAt = await cli.waitFor("Logged out of openai-compatible", 4000, replyAt);
      } catch {
        // line dropped while the prompt loop was busy; retry
      }
    }
    assert.ok(loggedOutAt >= 0, `logout never acknowledged:\n${cli.stdout}`);

    assert.ok(!cli.stdout.includes("e2e-cli-secret"), "secret must not echo into CLI output");

    cli.send("/exit");
    const code = await new Promise((resolve) => cli.child.on("exit", resolve));
    assert.equal(code, 0);
  } finally {
    cli.child.kill();
    await cli.exited;
    await fixture.stop().catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("one-shot run works against a configured endpoint", async () => {
  const fixture = await startFixture();
  fixture.script.push({ chunks: ["one-shot reply"] });
  const parent = await mkdtemp(path.join(tmpdir(), "rind-cli-oneshot-"));
  const rindHome = path.join(parent, "home");
  await mkdir(rindHome, { recursive: true });
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(rindHome, "settings.json"),
    JSON.stringify({ provider: "openai-compatible", baseUrl: `http://127.0.0.1:${fixture.port}/v1`, apiKey: "one-shot-key", model: "fake-model-a" }),
    "utf8",
  );

  const child = spawn(process.execPath, [path.join(repoRoot, "frontend-cli", "bin", "rind.js"), "run", "--prompt", "say hi"], {
    cwd: workspace,
    env: { ...process.env, RIND_HOME: rindHome, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  try {
    assert.equal(code, 0, `stderr:\n${stderr}\nstdout:\n${stdout}`);
    assert.ok(stdout.includes("one-shot reply"), `stdout:\n${stdout}`);
    const sessions = await readdir(path.join(rindHome, "sessions"));
    assert.equal(sessions.length, 1);
    const history = await readFile(path.join(rindHome, "sessions", sessions[0], "messages.jsonl"), "utf8");
    assert.ok(history.includes("say hi") && history.includes("one-shot reply"));
    assert.ok(!stdout.includes("one-shot-key") && !stderr.includes("one-shot-key"), "secret must not leak into run output");
  } finally {
    child.kill();
    await fixture.stop().catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("session lifecycle: run, send, empty sessions, compact and resume", { timeout: 120000 }, async (t) => {
  const fixture = await startFixture();
  const parent = await mkdtemp(path.join(tmpdir(), "rind-session-matrix-"));
  const home = path.join(parent, "home");
  const workspace = await makeWorkspace(parent, `http://127.0.0.1:${fixture.port}/v1`);
  // A provider-specific environment key would also enable that remote provider's
  // startup catalog refresh. Scope this fake credential to the local endpoint.
  await writeFile(path.join(home, "settings.json"), JSON.stringify({
    provider: "openai-compatible", baseUrl: `http://127.0.0.1:${fixture.port}/v1`,
    model: "fake-model-a", apiKey: "matrix-key",
  }));
  const env = { ...process.env, RIND_HOME: home, NO_COLOR: "1" };
  const clients = [];
  const base = (id) => path.join(home, "sessions", id);
  const absent = (id) => assert.rejects(stat(base(id)), { code: "ENOENT" });
  async function command(...args) {
    try {
      return { code: 0, ...await promisify(execFile)(process.execPath,
        [path.join(repoRoot, "frontend-cli", "bin", "rind.js"), ...args],
        { cwd: workspace, env, timeout: 30000 }) };
    } catch (error) {
      assert.equal(typeof error.code, "number", String(error));
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  // A window opened on a conversation reports its id; a new one has none until its first message.
  async function open(...args) {
    const cli = spawnCli(workspace, home, {}, args);
    clients.push(cli);
    await cli.waitFor("fake-model-a");
    const id = cli.stdout.match(/session\s+(\d{8}_\d{6}_[a-f0-9]+)/)?.[1] || "";
    if (!id) { await cli.waitFor("session new"); return { cli, id }; }
    // A successful status reply also establishes that the IPC listener is ready.
    for (let attempt = 0; ; attempt += 1) {
      const reply = await command("send", "--session", id, "/status");
      if (reply.code === 0) break;
      assert.ok(attempt < 10, reply.stderr);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { cli, id };
  }
  async function close({ cli, id }) {
    if (id) assert.equal((await command("send", "--session", id, "/exit")).code, 0);
    else cli.send("/exit");
    assert.equal(await cli.exited, 0);
  }
  const saved = async () => (await readdir(path.join(home, "sessions")).catch(() => [])).sort();
  async function rejectsRun(id) {
    const before = fixture.requests.length;
    const result = await command("run", "--session", id, "--prompt", "must not run");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Session not found/i);
    assert.equal(fixture.requests.length, before);
    await absent(id);
  }
  let historyId;
  let empty;
  try {
    await t.test("1. run without session creates exactly one durable session", async () => {
      fixture.script.push({ chunks: ["matrix first reply"] });
      const result = await command("run", "--prompt", "matrix first task");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matrix first reply/);
      const ids = await readdir(path.join(home, "sessions"));
      assert.equal(ids.length, 1);
      historyId = ids[0];
    });
    await t.test("2. run resumes a closed session with history", async () => {
      fixture.script.push({ chunks: ["matrix resumed reply"] });
      const result = await command("run", "--session", historyId, "--prompt", "matrix second task");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matrix resumed reply/);
      assert.ok(fixture.requests.at(-1).messages.some((m) => m.content === "matrix first task"));
      assert.deepEqual(await readdir(path.join(home, "sessions")), [historyId]);
    });
    await t.test("3. a window closed before its first message leaves nothing behind", async () => {
      const before = await saved();
      const window = await open();
      assert.equal(window.id, "");
      await close(window);
      assert.deepEqual(await saved(), before);
    });
    await t.test("7a. send rejects a conversation that does not exist", async () => {
      const result = await command("send", "--session", "20261007_000000_deadbeef", "must not run");
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not running/);
      await absent("20261007_000000_deadbeef");
    });
    empty = await open();
    await t.test("8. compact before the first message needs a conversation, without model calls or files", async () => {
      const before = { requests: fixture.requests.length, saved: await saved() };
      empty.cli.send("/compact");
      await empty.cli.waitFor("/compact needs a conversation. Send your first message to start one.");
      assert.equal(fixture.requests.length, before.requests);
      assert.deepEqual(await saved(), before.saved);
    });
    await t.test("5. the first message typed in a window creates its conversation", async () => {
      const before = await saved();
      fixture.script.push({ chunks: ["matrix sent first reply"] });
      empty.cli.send("matrix sent first task");
      await empty.cli.waitFor("matrix sent first reply");
      const [id] = (await saved()).filter((entry) => !before.includes(entry));
      assert.ok(id, "exactly one conversation was created");
      empty = { ...empty, id };
      assert.equal(JSON.parse(await readFile(path.join(base(id), "meta.json"), "utf8")).session_id, id);
    });
    await close(empty);
    empty = await open("--session", empty.id);
    await t.test("6. send continues a live session with history", async () => {
      fixture.script.push({ chunks: ["matrix sent second reply"] });
      assert.equal((await command("send", "--session", empty.id, "matrix sent second task")).code, 0);
      await empty.cli.waitFor("matrix sent second reply");
      assert.ok(fixture.requests.at(-1).messages.some((m) => m.content === "matrix sent first task"));
    });
    await close(empty);
    await t.test("7b. send rejects a closed session with history without modifying it", async () => {
      const file = path.join(base(empty.id), "messages.jsonl");
      const before = await readFile(file, "utf8");
      const result = await command("send", "--session", empty.id, "must not run");
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not running/);
      assert.equal(await readFile(file, "utf8"), before);
    });
    await t.test("resume-latest skips an empty session opened and closed later", async () => {
      const discarded = await open();
      await close(discarded);
      const resumed = await open("-c");
      assert.equal(resumed.id, empty.id);
      await close(resumed);
    });
    await t.test("run rejects unknown ids and workspace conflicts without touching history", async () => {
      await rejectsRun("missing-session");
      const before = await readFile(path.join(base(historyId), "messages.jsonl"), "utf8");
      const result = await command("run", "--session", historyId, "--dir", parent, "--prompt", "must not run");
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /conflicts with --cwd/);
      assert.equal(await readFile(path.join(base(historyId), "messages.jsonl"), "utf8"), before);
    });
    await t.test("run opens a closed empty session already persisted by an older version", async () => {
      const id = "persisted-empty";
      const { workspace_root: storedWorkspace } = JSON.parse(await readFile(path.join(base(historyId), "meta.json"), "utf8"));
      await mkdir(base(id));
      await writeFile(path.join(base(id), "meta.json"), JSON.stringify({
        schema_version: "2.0", session_id: id, workspace_root: storedWorkspace,
        provider: "openai-compatible", model: "fake-model-a", message_count: 1, tool_call_count: 0,
      }));
      await writeFile(path.join(base(id), "messages.jsonl"), JSON.stringify({ role: "system", content: "legacy system" }) + "\n");
      await writeFile(path.join(base(id), "tool_calls.jsonl"), "");
      fixture.script.push({ chunks: ["legacy first reply"] });
      const result = await command("run", "--session", id, "--prompt", "legacy first task");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /legacy first reply/);
      const history = (await readFile(path.join(base(id), "messages.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(history.filter((m) => m.role === "system").length, 1);
      assert.ok(history.some((m) => m.role === "user" && m.content === "legacy first task"));
    });
    await t.test("invalid input and unsafe ids do not create sessions or call the model", async () => {
      const ids = await readdir(path.join(home, "sessions"));
      const before = fixture.requests.length;
      for (const args of [["--prompt", "  "], ["--session", "../escape", "--prompt", "must not run"]]) {
        const result = await command("run", ...args);
        assert.notEqual(result.code, 0);
      }
      assert.deepEqual(await readdir(path.join(home, "sessions")), ids);
      assert.equal(fixture.requests.length, before);
    });
    await t.test("corrupt and incomplete sessions are rejected without being recreated", async () => {
      const before = fixture.requests.length;
      for (const [id, meta] of [
        ["corrupt-session", "{invalid"],
        ["incomplete-session", JSON.stringify({ schema_version: "2.0", session_id: "incomplete-session", workspace_root: workspace })],
      ]) {
        await mkdir(base(id));
        await writeFile(path.join(base(id), "meta.json"), meta);
        const result = await command("run", "--session", id, "--prompt", "must not run");
        assert.notEqual(result.code, 0);
        // filelock leaves its .lock file on POSIX (Windows removes it); it is not session content.
        assert.deepEqual((await readdir(base(id))).filter((entry) => !entry.endsWith(".lock")), ["meta.json"]);
        assert.equal(await readFile(path.join(base(id), "meta.json"), "utf8"), meta);
      }
      assert.equal(fixture.requests.length, before);
    });
  } finally {
    for (const cli of clients) if (cli.child.exitCode === null) cli.child.kill();
    await Promise.all(clients.map((cli) => cli.exited));
    await fixture.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
