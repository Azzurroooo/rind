import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startFixture() {
  const script = [];
  const models = ["fake-model-a", "fake-model-b"];
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
      port: server.address().port,
      async stop() {
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

function spawnCli(workspace, rindHome, env = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, "frontend-cli", "bin", "rind.js")], {
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
  const waitFor = (needle, timeout = 45000, fromIndex = 0) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = stdout.indexOf(needle, fromIndex);
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
  return { child, waitFor, send, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function makeWorkspace(parent, baseUrl) {
  const workspace = path.join(parent, "workspace");
  await mkdir(path.join(workspace, ".rind"), { recursive: true });
  await writeFile(
    path.join(workspace, ".rind", "settings.json"),
    JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model-a" }),
    "utf8",
  );
  return workspace;
}

test("interactive CLI journey: login, chat, logout", async () => {
  const fixture = await startFixture();
  fixture.script.push({ chunks: ["hi from fixture"] });
  const parent = await mkdtemp(path.join(tmpdir(), "rind-cli-journey-"));
  const rindHome = path.join(parent, "home");
  await mkdir(rindHome, { recursive: true });
  const workspace = await makeWorkspace(parent, `http://127.0.0.1:${fixture.port}/v1`);

  const cli = spawnCli(workspace, rindHome);
  try {
    await cli.waitFor("fake-model-a");
    cli.send("/login openai-compatible");
    await cli.waitFor("OpenAI compatible API key");
    cli.send("e2e-cli-secret");
    await cli.waitFor("Logged in to openai-compatible");

    cli.send("hello there");
    const replyAt = await cli.waitFor("hi from fixture");

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
    await fixture.stop().catch(() => {});
  }
});

test("one-shot run works against a configured endpoint", async () => {
  const fixture = await startFixture();
  fixture.script.push({ chunks: ["one-shot reply"] });
  const parent = await mkdtemp(path.join(tmpdir(), "rind-cli-oneshot-"));
  const rindHome = path.join(parent, "home");
  await mkdir(rindHome, { recursive: true });
  const workspace = path.join(parent, "workspace");
  await mkdir(path.join(workspace, ".rind"), { recursive: true });
  await writeFile(
    path.join(workspace, ".rind", "settings.json"),
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
    assert.ok(!stdout.includes("one-shot-key") && !stderr.includes("one-shot-key"), "secret must not leak into run output");
  } finally {
    child.kill();
    await fixture.stop().catch(() => {});
  }
});
