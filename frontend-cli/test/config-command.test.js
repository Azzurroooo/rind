import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { describeFolderDefaults, parseConfigArgs, runConfig } from "../lib/config-command.js";

const cwd = path.resolve("/work/app");

test("config needs an explicit folder; there is no global scope", () => {
  assert.deepEqual(parseConfigArgs(["set", "model", "deepseek-flash", "--folder"], cwd),
    { action: "set", group: "model", value: "deepseek-flash", folder: cwd, connection: "" });
  assert.equal(parseConfigArgs(["set", "effort", "high", "--folder", "../lib"], cwd).folder, path.resolve(cwd, "../lib"));
  assert.deepEqual(parseConfigArgs(["unset", "effort", "--folder"], cwd).group, "reasoning_effort");
  assert.throws(() => parseConfigArgs(["set", "model", "x"], cwd), /--folder/);
  assert.throws(() => parseConfigArgs(["set", "model", "x", "--global"], cwd), /Unknown config option: --global/);
  assert.throws(() => parseConfigArgs(["set", "theme", "x", "--folder"], cwd), /Usage/);
  assert.throws(() => parseConfigArgs(["unset", "model", "x", "--folder"], cwd), /Usage/);
  assert.throws(() => parseConfigArgs(["set", "effort", "high", "--connection", "a", "--folder"], cwd), /Usage/);
});

function fakeClient(models, calls) {
  return () => ({
    start() {},
    async shutdown() { calls.push(["shutdown"]); },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "initialize") return { session_id: "", capabilities: [], methods: [], protocol_version: "2" };
      if (method === "model/list") return { models };
      return { workspace_root: params.workspace_root, folder: {}, resolved: { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "high", model_source: "folder", effort_source: "settings" } };
    },
  });
}

test("a model id is matched to its connection, and an ambiguous one asks for --connection", async () => {
  const models = [{ provider_id: "deepseek", id: "deepseek-flash" }, { provider_id: "openrouter", id: "shared" }, { provider_id: "client-a", id: "shared" }];
  const calls = [];
  const lines = [];
  await runConfig({ args: ["set", "model", "deepseek-flash", "--folder"], cwd, launch: {}, write: text => lines.push(text), clientFactory: fakeClient(models, calls) });
  assert.deepEqual(calls.find(([method]) => method === "rind/folder_defaults/set")[1], { workspace_root: cwd, provider_id: "deepseek", model_id: "deepseek-flash" });
  assert.match(lines.join(""), /deepseek \/ deepseek-flash  \(this folder\)/);
  assert.equal(calls.at(-1)[0], "shutdown");

  await assert.rejects(runConfig({ args: ["set", "model", "shared", "--folder"], cwd, launch: {}, write() {}, clientFactory: fakeClient(models, []) }), /openrouter, client-a\. Add --connection/);
  const chosen = [];
  await runConfig({ args: ["set", "model", "shared", "--connection", "client-a", "--folder"], cwd, launch: {}, write() {}, clientFactory: fakeClient(models, chosen) });
  assert.equal(chosen.find(([method]) => method === "rind/folder_defaults/set")[1].provider_id, "client-a");
  await assert.rejects(runConfig({ args: ["set", "model", "missing", "--folder"], cwd, launch: {}, write() {}, clientFactory: fakeClient(models, []) }), /not listed\. Log in with \/login/);
});

test("the answer says what new conversations start with and where each part comes from", () => {
  const text = describeFolderDefaults({ workspace_root: "/w", resolved: { provider: "openai", model: "gpt-5.5", reasoning_effort: "", model_source: "main_repository", effort_source: "settings" } });
  assert.match(text, /model   openai \/ gpt-5\.5  \(the main repository\)/);
  assert.match(text, /effort  unset  \(settings\.json\)/);
});
