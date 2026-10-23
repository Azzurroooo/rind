import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";

// A fake model that asks one question per turn, then reports whether it got an answer or was skipped.
function questionModel() {
  const server = http.createServer((request, response) => {
    let raw = ""; request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      if (request.method !== "POST") { response.end(JSON.stringify({ data: [{ id: "fake" }] })); return; }
      const body = JSON.parse(raw);
      const last = body.messages.at(-1);
      const chunk = (delta, finish_reason = null) => "data: " + JSON.stringify({ id: "x", model: "fake", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (last?.role === "tool") {
        const skipped = String(last.content || "").includes("UserQuestionEmptyAnswer");
        const reply = skipped ? "CONTINUED_AFTER_SKIP" : "GOT_THE_ANSWER";
        response.end(chunk({ role: "assistant", content: reply }) + chunk({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      const secondTurn = body.messages.filter(message => message.role === "user").length > 1;
      const question = secondTurn ? "Deploy to staging?" : "Ship it now?";
      const callId = secondTurn ? "call_q2" : "call_q";
      const args = JSON.stringify({ question, options: [{ label: "Yes (Recommended)", description: "go" }, { label: "No", description: "wait" }] });
      response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "ask_user_question", arguments: args } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function window(windows, home, workspace, args) {
  const script = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    process.stdout.columns = 100; process.stdout.rows = 30;
    const { runFrontendCliApp } = await import(${JSON.stringify(new URL("../lib/frontend-cli-implementation.js", import.meta.url).href)});
    await runFrontendCliApp(${JSON.stringify(["--cwd", workspace, ...args])});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, env: { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const output = createVirtualOutput({ columns: 100, rows: 30 });
  child.stdout.on("data", value => output.output.write(value));
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  windows.push(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const screen = async () => (await output.flushAndGetViewport()).join("\n");
  return {
    key: value => child.stdin.write(value), screen,
    async visible(text) {
      for (let i = 0; i < 800; i++) { const s = await screen(); if (s.includes(text)) return s; if (child.exitCode !== null) break; await new Promise(r => setTimeout(r, 25)); }
      assert.fail("Expected " + text + "\n" + await screen() + "\n" + errors);
    },
  };
}

test("answering or skipping a question in one window updates another window and keeps the turn running on Esc", { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-two-windows-"));
  const workspace = path.join(home, "work"); await mkdir(workspace);
  const model = await questionModel();
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fake" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "test" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + model.address().port + "/v1" } } }));
  // One ordered teardown: windows first, then the model (its connections are kept
  // alive by the Runtime), then the home with its Runtime.
  const windows = [];
  t.after(async () => {
    for (const stop of windows) await stop();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await removeRindHome(home);
  });

  const first = window(windows, home, workspace, []);
  const banner = await first.visible("← agents");
  assert.match(banner, /session new/, "nothing exists before the first message");
  first.key("please ask me\r");
  await first.visible("Ship it now?");
  // The first message created and saved the conversation.
  const [sessionId] = (await readdir(path.join(home, "sessions"), { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d{8}_/.test(entry.name)).map(entry => entry.name);
  assert.ok(sessionId, "the first message saved a conversation");

  const second = window(windows, home, workspace, ["--session", sessionId]);
  const menu = await second.visible("Ship it now?");
  assert.match(menu, /esc skip/);
  second.key("\r");
  await second.visible("GOT_THE_ANSWER");
  const closed = await first.visible("answered in another window");
  assert.match(closed, /Yes/);
  await first.visible("GOT_THE_ANSWER");
  // Streaming the final text precedes turn completion. Start the next turn
  // only after both windows have processed completion, not as late steering.
  await first.visible("Worked for");
  await second.visible("Worked for");

  // Skipping with Esc sends an empty answer, does not interrupt the turn, and
  // lets the model continue after UserQuestionEmptyAnswer.
  second.key("ask again\r");
  await second.visible("Deploy to staging?");
  await first.visible("Deploy to staging?");
  second.key("\x1b");
  const secondAfterSkip = await second.visible("CONTINUED_AFTER_SKIP");
  assert.match(secondAfterSkip, /A: \(no answer\)/);
  assert.doesNotMatch(secondAfterSkip, /Interrupted/);
  const firstAfterSkip = await first.visible("(no answer) (answered in another window)");
  assert.doesNotMatch(firstAfterSkip, /Interrupted/);
  await first.visible("CONTINUED_AFTER_SKIP");
});
