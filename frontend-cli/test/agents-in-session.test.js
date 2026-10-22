import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
import { removeRindHome } from "./helpers/rind-home.js";

const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url)).replaceAll("\\", "/");
const bash = (index, command) => ({ index, id: "call_" + index, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } });
const sse = (delta, finish) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n"
  + "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + "\n\ndata: [DONE]\n\n";

test("an agent cannot act as the user through `rind agents` in its shell, and its session keeps running", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-in-session-"));
  const work = path.join(home, "work");
  await mkdir(work);
  const requests = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(requests.length === 1
        ? sse({ tool_calls: [bash(0, `node "${rindBin}" agents task product reviewer "Review the change"`), bash(1, `node "${rindBin}" agents stop --all`)] }, "tool_calls")
        : sse({ content: "Nothing was assigned and the services were left running." }, "stop"));
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const host = await startSharedServer(options);
  const window = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", work] });
  t.after(async () => { await window.shutdown(); await host.close(); await new Promise(resolve => provider.close(resolve)); await removeRindHome(home); });

  await window.request("initialize");
  const { session_id: sessionId } = await window.request("session/create", {});
  await window.request("session/prompt", { session_id: sessionId, input: "Ask the reviewer for a review, then restart the background services." });

  assert.equal(requests.length, 2, "the model saw the commands' results");
  const toolResults = requests[1].messages.filter(message => message.role === "tool");
  assert.equal(toolResults.length, 2);
  for (const result of toolResults) assert.match(JSON.stringify(result), /acts as the user and cannot run inside a Rind session/);
  assert.equal(existsSync(path.join(home, "agents-management", "state", "user-token")), false, "the shell never reached the management service as the user");
  const replay = await window.request("session/replay", { session_id: sessionId });
  assert.match(JSON.stringify(replay), /Nothing was assigned and the services were left running\./);
});
