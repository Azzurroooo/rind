import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repo, "frontend-cli/bin/rind.js");

test("CLI compact accepts rind send, resumes work and accepts the next turn", {timeout: 40000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-compact-journey-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  const requests = [];
  let finishCompact;
  let startedCompact;
  const compactStarted = new Promise((resolve) => { startedCompact = resolve; });
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({data: [{id: "fake-model"}]}));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      if (!body.stream) {
        finishCompact = () => {
          if (response.writableEnded || response.destroyed) return;
          response.writeHead(200, {"Content-Type": "application/json"});
          response.end(JSON.stringify({id: "summary", model: "fake-model", choices: [
            {index: 0, message: {role: "assistant", content: "Keep the original task contract."}, finish_reason: "stop"},
          ], usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110}}));
        };
        startedCompact();
        return;
      }
      const lastUser = body.messages.filter((message) => message.role === "user").at(-1)?.content;
      const text = lastUser === "redirect during compact" ? "STEER_DELIVERED" : lastUser === "next ordinary turn" ? "NEXT_TURN_OK" : "INITIAL_REPLY";
      response.writeHead(200, {"Content-Type": "text/event-stream"});
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({id: "sample", model: "fake-model", choices: [{index: 0, delta, finish_reason}]})}\n\n`;
      response.end(chunk({role: "assistant", content: text}) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({
    provider: "openai-compatible", model: "fake-model", apiKey: "local-test-only",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  }));
  const env = {...process.env, RIND_HOME: home, NO_COLOR: "1", PYTHONIOENCODING: "utf-8"};
  const child = spawn(process.execPath, [cliPath], {cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  async function waitFor(predicate) {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, `${stdout}\n${stderr}`);
      if (Date.now() > deadline) assert.fail(`CLI stalled:\n${stdout}\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const send = (text) => child.stdin.write(`${text}\n`);
  try {
    await waitFor(() => /session\s+(\d{8}_\d{6}_[a-f0-9]+)/.test(stdout));
    const session = stdout.match(/session\s+(\d{8}_\d{6}_[a-f0-9]+)/)[1];
    send("original task");
    await waitFor(() => stdout.includes("INITIAL_REPLY"));
    await waitFor(() => /INITIAL_REPLY[\s\S]*Worked for/.test(stdout));
    await new Promise((resolve) => setTimeout(resolve, 100));
    send("/compact");
    await Promise.race([compactStarted, new Promise((_, reject) => setTimeout(() => reject(new Error(`compact never started: ${stdout}\n${stderr}`)), 12000).unref())]);
    await promisify(execFile)(process.execPath, [cliPath, "send", "--session", session, "redirect during compact"], {cwd: workspace, env, timeout: 10000});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.filter((item) => item.stream).length, 1);
    finishCompact();
    await waitFor(() => /STEER_DELIVERED[\s\S]*Worked for/.test(stdout));
    assert.ok(stdout.includes("Compact complete."), stdout);
    assert.equal(requests.filter((item) => item.stream).length, 2);
    send("next ordinary turn");
    await waitFor(() => stdout.includes("NEXT_TURN_OK"));
    assert.equal(requests.filter((item) => item.stream).length, 3);
    assert.doesNotMatch(stderr, /timed out|not active|failed/i);
    send("/exit");
    await exited;
  } finally {
    finishCompact?.();
    if (child.exitCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) { child.kill(); await exited; }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, {recursive: true, force: true});
  }
});
