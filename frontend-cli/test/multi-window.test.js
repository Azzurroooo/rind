import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";

// A fake model that asks one question, then answers with what it was told.
function questionModel() {
  const server = http.createServer((request, response) => {
    let raw = ""; request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      if (request.method !== "POST") { response.end(JSON.stringify({ data: [{ id: "fake" }] })); return; }
      const body = JSON.parse(raw);
      const answered = body.messages.some(message => message.role === "tool");
      const chunk = (delta, finish_reason = null) => "data: " + JSON.stringify({ id: "x", model: "fake", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (answered) { response.end(chunk({ role: "assistant", content: "GOT_THE_ANSWER" }) + chunk({}, "stop") + "data: [DONE]\n\n"); return; }
      const args = JSON.stringify({ question: "Ship it now?", options: [{ label: "Yes (Recommended)", description: "go" }, { label: "No", description: "wait" }] });
      response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_q", type: "function", function: { name: "ask_user_question", arguments: args } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
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

test("answering a question in one window closes it in another window on the same conversation", { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-two-windows-"));
  const workspace = path.join(home, "work"); await mkdir(workspace);
  const model = await questionModel();
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fake", apiKey: "test", baseUrl: "http://127.0.0.1:" + model.address().port + "/v1" }));
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
  const sessionId = banner.match(/session (\d{8}_\d{6}_[0-9a-f]+)/)?.[1];
  assert.ok(sessionId, "the banner names the session");
  first.key("please ask me\r");
  await first.visible("Ship it now?");

  const second = window(windows, home, workspace, ["--session", sessionId]);
  await second.visible("Ship it now?");
  second.key("\r");
  await second.visible("GOT_THE_ANSWER");
  const closed = await first.visible("answered in another window");
  assert.match(closed, /Yes/);
  await first.visible("GOT_THE_ANSWER");
});
