import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { removeRindHome } from "./helpers/rind-home.js";
import { connectManagement } from "../../agent-management/dist/client.js";

const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
const sse = text => "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + "\n\n"
  + "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n";

test("a second rind run in a busy member folder names the run that holds it, and stopping that run frees the folder", { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-busy-folder-"));
  const home = path.join(root, "home");
  const work = path.join(root, "member");
  await mkdir(home); await mkdir(work);
  const held = [];
  let requests = 0;
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume();
    request.on("end", () => {
      requests += 1;
      // The first run's model never answers, so that run keeps the folder.
      if (requests === 1) { held.push(response); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(sse("Done."));
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const env = { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" };
  delete env.RIND_SHARED_HOST_PID;
  const rind = async (...args) => {
    try { return { code: 0, ...await promisify(execFile)(process.execPath, [rindBin, ...args], { cwd: root, env, timeout: 60000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  t.after(async () => {
    for (const response of held) response.destroy();
    await rind("agents", "stop", "--all");
    await new Promise(resolve => provider.close(resolve));
    await removeRindHome(home);
    await removeRindHome(root);
  });

  // Registered as the Agents page does, through the management service.
  const management = await connectManagement({ home, python: env.RIND_PYTHON, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) });
  const team = await management.request("createTeam", { name: "desk" });
  await management.request("addMember", { teamId: team.id, workspace: work });
  management.close();

  const first = spawn(process.execPath, [rindBin, "run", "--dir", work, "--prompt", "first"], { cwd: root, env, windowsHide: true });
  const firstExit = new Promise(resolve => first.once("close", resolve));
  for (let i = 0; i < 300 && requests < 1; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 1, "the first run reached the model");

  const second = await rind("run", "--dir", work, "--prompt", "second");
  assert.notEqual(second.code, 0);
  const owner = second.stderr.match(/Run ([0-9a-f-]{36}) \(running\) owns this workspace\. Wait for it, or run `rind agents stop \1`\./);
  assert.ok(owner, second.stderr);

  const stopped = await rind("agents", "stop", owner[1]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.notEqual(await firstExit, 0, "the stopped run ends without an answer");

  const third = await rind("run", "--dir", work, "--prompt", "third");
  assert.equal(third.code, 0, third.stderr);
  assert.match(third.stdout, /Done\./);
});
