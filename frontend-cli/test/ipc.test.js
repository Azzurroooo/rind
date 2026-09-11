import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ipcEndpointName, listenIpc, sendIpc } from "../lib/ipc.js";
import { parseSendArgs } from "../lib/send.js";
import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";

const ipcHome = await mkdtemp(path.join(tmpdir(), "rind-ipc-home-"));
process.env.RIND_HOME = ipcHome;

function defer() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("ipcEndpointName is unique per session and rejects unsafe ids", () => {
  assert.notEqual(ipcEndpointName("20260910_101010_aaaabbbb"), ipcEndpointName("20260910_101010_ccccdddd"));
  assert.throws(() => ipcEndpointName("../escape"), /Invalid session id/);
  assert.throws(() => ipcEndpointName("a b"), /Invalid session id/);
});

test("listenIpc delivers input and acknowledges with the session id", async () => {
  const received = [];
  const server = await listenIpc({
    sessionId: "20260910_roundtrip",
    getSessionId: () => "20260910_roundtrip",
    dispatch: (text) => received.push(text),
  });
  const result = await sendIpc({ session: "20260910_roundtrip", input: "hello there" });
  assert.equal(result.ok, true);
  assert.equal(result.session_id, "20260910_roundtrip");
  assert.deepEqual(received, ["hello there"]);
  await server.close();
  const afterClose = await sendIpc({ session: "20260910_roundtrip", input: "anyone?" });
  assert.equal(afterClose.ok, false);
});

test("sendIpc reports a precise error when the session is not running", async () => {
  const result = await sendIpc({ session: "20990101_missing", input: "hi" });
  assert.equal(result.ok, false);
  assert.match(result.message, /20990101_missing is not running/);
});

test("second listener for the same session reports the endpoint as unavailable", async () => {
  const first = await listenIpc({
    sessionId: "20260910_owner",
    getSessionId: () => "20260910_owner",
    dispatch: () => {},
  });
  let unavailable = false;
  await listenIpc({
    sessionId: "20260910_owner",
    getSessionId: () => "second",
    dispatch: () => {},
    onUnavailable: () => {
      unavailable = true;
    },
  });
  assert.equal(unavailable, true);
  const stillOwner = await sendIpc({ session: "20260910_owner", input: "ping" });
  assert.equal(stillOwner.session_id, "20260910_owner");
  await first.close();
});

test("stale unix socket is removed before listening", { skip: process.platform === "win32" }, async () => {
  const endpoint = ipcEndpointName("20260910_revived");
  await mkdir(path.dirname(endpoint), { recursive: true });
  await writeFile(endpoint, "");
  let unavailable = false;
  const server = await listenIpc({
    sessionId: "20260910_revived",
    getSessionId: () => "20260910_revived",
    dispatch: () => {},
    onUnavailable: () => {
      unavailable = true;
    },
  });
  assert.equal(unavailable, false);
  const result = await sendIpc({ session: "20260910_revived", input: "back" });
  assert.equal(result.ok, true);
  assert.equal(result.session_id, "20260910_revived");
  await server.close();
});

test("dispatchExternal mirrors the typed submit order", async () => {
  const state = createCliState();
  const calls = [];
  const handledCommands = [];
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output: {
      writeUserInput: (text, source) => calls.push(["echo", text, source]),
      writeError: (text) => calls.push(["error", text]),
      redraw: () => {},
    },
    getTurnController: () => ({ submit: (text) => calls.push(["submit", text]) }),
    getCommandController: () => ({
      handle: async (text) => {
        calls.push(["command", text]);
        return handledCommands.includes(text);
      },
    }),
    getTaskMonitor: () => ({}),
    getLineInput: () => null,
    pausePrompt: () => {},
    resumePrompt: () => {},
    handleSigint: () => {},
  });

  actions.dispatchExternal("hello world");
  await defer();
  assert.deepEqual(calls, [["echo", "hello world", "send"], ["command", "hello world"], ["submit", "hello world"]]);

  calls.length = 0;
  handledCommands.push("/status");
  actions.dispatchExternal("/status");
  await defer();
  assert.deepEqual(calls, [["command", "/status"]]);

  calls.length = 0;
  state.turn.active = true;
  actions.dispatchExternal("steer this");
  await defer();
  assert.deepEqual(calls, [["command", "steer this"], ["submit", "steer this"]]);
});

test("parseSendArgs validates prompt and session", () => {
  assert.deepEqual(parseSendArgs(["send", "--session", "20260910_ab12cd34", "hi"]), {
    prompt: "hi",
    session: "20260910_ab12cd34",
  });
  assert.throws(() => parseSendArgs(["send", "hi"]), /requires --session/);
  assert.throws(() => parseSendArgs(["send"]), /requires --session/);
  assert.throws(() => parseSendArgs(["send", "--session"]), /--session requires a value/);
  assert.throws(() => parseSendArgs(["send", "--session", "../bad", "hi"]), /Invalid session id/);
  assert.throws(() => parseSendArgs(["send", "--session", "a", "b", "c"]), /exactly one prompt/);
  assert.throws(() => parseSendArgs(["send", "--session", "a", "--wat"]), /Unknown send option/);
  assert.throws(() => parseSendArgs(["send", "--session", "a", "  "]), /non-empty prompt/);
});
