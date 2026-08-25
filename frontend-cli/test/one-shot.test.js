import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseOneShotArgs, promptSlug, runOneShot } from "../lib/one-shot.js";

test("one-shot parser requires run prompt and accepts explicit workspace/session", () => {
  assert.deepEqual(parseOneShotArgs(["run", "--cwd", "C:/work", "--session", "s1", "--prompt", "hello"]), {
    cwd: "C:/work",
    session: "s1",
    prompt: "hello",
    debug: false,
    traceLlm: false,
  });
  assert.throws(() => parseOneShotArgs(["run", "--prompt", ""]), /non-empty/);
  assert.throws(() => parseOneShotArgs(["run", "--cwd", "relative", "--prompt", "hello"]), /absolute/);
  assert.equal(parseOneShotArgs(["hello"]), null);
});

test("one-shot execution keeps stdout to the assistant and writes a compact log", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "rind-one-shot-"));
  const output = [];
  const errors = [];
  let options;
  let promptParams;
  const client = {
    start() {},
    request(method) {
      if (method === "initialize") {
        return Promise.resolve({ protocol_version: "2", capabilities: [], methods: [], session_id: "s1", workspace_root: workspace, model: "m1" });
      }
      if (method === "session/prompt") promptParams = arguments[1];
      options.onMessage({ session_id: "s1", turn_id: "t1", event: { type: "tool_requested", tool_name: "bash" } });
      options.onMessage({ session_id: "s1", turn_id: "t1", event: { type: "assistant_delta", text: "final" } });
      return Promise.resolve({ session_id: "s1", turn_id: "t1" });
    },
    shutdown() { return Promise.resolve(); },
    forceShutdown() {},
  };
  const result = await runOneShot({
    args: ["run", "--prompt", "hello"],
    python: "python",
    repoRoot: workspace,
    runtimePath: "runtime",
    cwd: workspace,
    stderr: (text) => errors.push(text),
    stdout: (text) => output.push(text),
    clientFactory: (value) => {
      options = value;
      return client;
    },
  });

  assert.equal(result, true);
  assert.deepEqual(output, ["final"]);
  assert.equal(options.cliArgs.includes("--no-user-question"), true);
  assert.deepEqual(promptParams, { session_id: "s1", input: "hello" });
  assert.equal(errors.join("").includes("bash"), true);
  const logs = (await import("node:fs/promises")).readdir(path.join(workspace, "logs"));
  const log = await readFile(path.join(workspace, "logs", (await logs)[0]), "utf8");
  assert.match(log, /session_id: "s1"/);
  assert.match(log, /# Assistant\n\nfinal/);
});

test("prompt slugs remove filesystem-invalid characters", () => {
  assert.equal(promptSlug("A:/bad? prompt"), "A bad prompt");
});
