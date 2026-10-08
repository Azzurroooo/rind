import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, writeFile, utimes, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowLog, guardStartup } from "../lib/window-startup.js";

function terminal() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, paused: true,
    setRawMode(value) { this.isRaw = value; }, pause() { this.paused = true; }, resume() { this.paused = false; } });
  const written = [];
  const output = { isTTY: true, write: text => written.push(text) };
  return { input, output, written };
}

test("until the window reads keys, a lone Esc or Ctrl+C cancels; arrow keys do not", () => {
  const { input, output, written } = terminal();
  const cancelled = [];
  const guard = guardStartup({ input, output, onCancel: key => cancelled.push(key) });
  assert.equal(input.isRaw, true);
  assert.equal(input.paused, false);
  assert.match(written[0], /Opening conversation…  esc goes back/);
  input.emit("data", "\x1b[A");
  assert.deepEqual(cancelled, [], "an arrow key starts with Esc but is not one");
  input.emit("data", "\x1b");
  assert.deepEqual(cancelled, ["esc"]);
  assert.equal(input.isRaw, false, "the keyboard is handed back as it was");
  assert.equal(input.paused, true);
  assert.equal(written.at(-1), "\r\x1b[2K", "the line is cleared");
  input.emit("data", "\x03");
  assert.deepEqual(cancelled, ["esc"], "once stopped it no longer listens");
  guard.stop();
});

test("Ctrl+C cancels too, and stopping hands the keyboard to the window untouched", () => {
  const { input, output } = terminal();
  const cancelled = [];
  guardStartup({ input, output, onCancel: key => cancelled.push(key) });
  input.emit("data", "\x03");
  assert.deepEqual(cancelled, ["ctrl+c"]);
  const second = terminal();
  const guard = guardStartup({ input: second.input, output: second.output, onCancel: () => assert.fail("not cancelled") });
  guard.stop();
  assert.equal(second.input.listenerCount("data"), 0);
  assert.equal(second.input.isRaw, false);
  const piped = guardStartup({ input: { isTTY: false }, output: { isTTY: false }, onCancel() {} });
  piped.stop();
});

test("each step is logged with its time, a blocked event loop is noted, and old logs go", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rind-window-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) {
    const old = path.join(directory, "window-" + (100 + i) + ".log");
    await writeFile(old, "old\n");
    await utimes(old, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
  }
  const log = createWindowLog({ file: path.join(directory, "window-1.log"), keep: 2 });
  log.step("management ready");
  // The monitor measures from its first sample on.
  await new Promise(resolve => setTimeout(resolve, 60));
  const until = Date.now() + 700;
  while (Date.now() < until) { /* hold the event loop */ }
  await new Promise(resolve => setTimeout(resolve, 1100));
  log.close();
  const text = await readFile(log.file, "utf8");
  assert.match(text, /\+\d+ms management ready/);
  assert.match(text, /event loop blocked \d+ms/);
  assert.deepEqual((await readdir(directory)).sort(), ["window-1.log", "window-102.log"].sort(), "the newest logs are kept");
});
