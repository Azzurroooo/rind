import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { acquireProcessLock } from "../../rind-runtime-client/process-lock.js";

function run(script) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true });
  let error = "";
  child.stderr.on("data", value => { error += value; });
  return { child, done: new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(error || "child exited " + code)));
  }) };
}

test("process locks serialize independent publishers and tolerate repeated release", { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-process-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "lock"), log = path.join(root, "events");
  const dead = run(""); await dead.done;
  await mkdir(directory);
  await writeFile(path.join(directory, `${dead.child.pid}-00000000-0000-0000-0000-000000000000`), "");
  const module = new URL("../../rind-runtime-client/process-lock.js", import.meta.url).href;
  const children = Array.from({ length: 8 }, () => run(`
    import { acquireProcessLock } from ${JSON.stringify(module)};
    import { appendFile } from 'node:fs/promises';
    const lock = await acquireProcessLock(${JSON.stringify(directory)});
    await appendFile(${JSON.stringify(log)}, process.pid + ':enter\\n');
    await new Promise(resolve => setTimeout(resolve, 25));
    await appendFile(${JSON.stringify(log)}, process.pid + ':exit\\n');
    await lock.release(); await lock.release();
  `));
  t.after(() => { for (const { child } of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(value => value.done));
  const events = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(events.length, 16);
  for (let i = 0; i < events.length; i += 2) {
    assert.match(events[i], /:enter$/);
    assert.equal(events[i + 1], events[i].replace(":enter", ":exit"));
  }
  assert.deepEqual(await readdir(root), ["events"]);
});

test("a dead owner's lock can be reclaimed but a live owner's cannot", { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-dead-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dead = run(""); await dead.done;
  const directory = path.join(root, "lock");
  await mkdir(directory);
  await writeFile(path.join(directory, `${dead.child.pid}-00000000-0000-0000-0000-000000000000`), "");
  const first = await acquireProcessLock(directory);
  await assert.rejects(acquireProcessLock(directory, 5), /Timed out/);
  await first.release();
  const second = await acquireProcessLock(directory); await second.release();
});

test("empty locks have unknown ownership and are never reclaimed by age", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-unknown-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "lock"); await mkdir(directory);
  await assert.rejects(acquireProcessLock(directory, 5), /Timed out waiting for process lock/);
  assert.deepEqual(await readdir(directory), []);
});
