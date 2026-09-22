import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOneShotProgress } from "../lib/one-shot-progress.js";
import { paintRaw } from "../lib/theme.js";

import { parseOneShotArgs, promptSlug, runOneShot } from "../lib/one-shot.js";

test("one-shot parser requires run prompt and accepts explicit workspace/session", () => {
  assert.deepEqual(parseOneShotArgs(["run", "--dir", "C:/work", "--session", "s1", "--prompt", "hello"]), {
    dir: "C:/work",
    session: "s1",
    prompt: "hello",
    debug: false,
    traceLlm: false,
  });
  assert.throws(() => parseOneShotArgs(["run", "--prompt", ""]), /non-empty/);
  assert.throws(() => parseOneShotArgs(["run", "--dir", "relative", "--prompt", "hello"]), /absolute/);
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
      options.onMessage({ session_id: "s1", turn_id: "t1", event: { type: "context_built", decisions: { image_notice: "Image capability unconfirmed" } } });
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
  assert.match(errors.join(""), /  · System: Image capability unconfirmed/);
  const logs = (await import("node:fs/promises")).readdir(path.join(workspace, "logs"));
  const log = await readFile(path.join(workspace, "logs", (await logs)[0]), "utf8");
  assert.match(log, /session_id: "s1"/);
  assert.match(log, /# Assistant\n\nfinal/);
});

test("prompt slugs remove filesystem-invalid characters", () => {
  assert.equal(promptSlug("A:/bad? prompt"), "A bad prompt");
});

test("one-shot waits across turns and prints the request answer once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "rind-request-"));
  const output = [];
  const progress = [];
  let deliver;
  let finish;
  let shutdown = false;
  const running = runOneShot({
    args: ["run", "--prompt", "Build"], cwd: workspace,
    stdout: (text) => output.push(text), stderr: (text) => progress.push(text),
    clientFactory: ({ onMessage }) => {
      deliver = onMessage;
      return {
        start() {},
        async request(method, params) {
          if (method === "initialize") return { protocol_version: "2", capabilities: ["rind/tasks", "rind/request-completion"], methods: [], session_id: "s1" };
          assert.equal(params.completion_scope, "request");
          onMessage({ event: { type: "assistant_message_completed", content: "Waiting." } });
          onMessage({ event: { type: "turn_completed" } });
          return new Promise((resolve) => { finish = resolve; });
        },
        async shutdown() { shutdown = true; },
      };
    },
  });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output, []);
  assert.equal(shutdown, false);
  deliver({ event: { type: "assistant_message_completed", content: "Finished." } });
  finish({ answer: "Finished.", turn_id: "t2" });
  await running;
  assert.deepEqual(output, ["Finished."]);
  assert.equal(shutdown, true);
  assert.match(progress.join(""), /Waiting/);
  assert.doesNotMatch(output.join(""), /\x1b/);
  await (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true });
});


test("system notice colors follow stderr TTY and NO_COLOR", () => {
  const original = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const errors = [];
    const progress = createOneShotProgress({ stderr: (text) => errors.push(text), stream: { isTTY: true } });
    progress.systemNotice("unsupported", "warning");
    assert.equal(errors.pop(), `  ${paintRaw.warning("· System:")} ${paintRaw.dim("unsupported")}\n`);
    process.env.NO_COLOR = "";
    createOneShotProgress({ stderr: (text) => errors.push(text), stream: { isTTY: true } }).systemNotice("unknown", "info");
    assert.equal(errors.pop(), "  · System: unknown\n");
    delete process.env.NO_COLOR;
    createOneShotProgress({ stderr: (text) => errors.push(text), stream: { isTTY: false } }).systemNotice("unsupported", "warning");
    assert.equal(errors.pop(), "  · System: unsupported\n");
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});
