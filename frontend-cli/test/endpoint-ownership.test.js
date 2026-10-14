// The endpoint ownership protocol: one live server per name, stale entries
// replaced only after they are proven dead. Windows named pipes are exclusive
// by binding alone; the replacement dance is exercised on Unix, where socket
// files persist.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listenOwned } from "../../rind-runtime-client/endpoint.js";

test("a live owner refuses a second server", { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rind-endpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\rind-endpoint-" + path.basename(dir) : path.join(dir, "e.sock");
  const first = net.createServer();
  await listenOwned(first, endpoint);
  t.after(() => new Promise(resolve => first.close(resolve)));
  const second = net.createServer();
  await assert.rejects(listenOwned(second, endpoint), error => error.code === "ENDPOINT_OCCUPIED");
  second.close();
});

test("a dead entry is replaced without disturbing a live one", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rind-endpoint-dead-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const endpoint = path.join(dir, "e.sock");
  // A plain file proves dead: connecting is refused, so it may be replaced.
  await writeFile(endpoint, "");
  const server = net.createServer();
  await listenOwned(server, endpoint);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connected = await new Promise(resolve => {
    const socket = net.connect(endpoint);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  assert.equal(connected, true, "the replacement serves the canonical endpoint");
  const other = net.createServer();
  await assert.rejects(listenOwned(other, endpoint), error => error.code === "ENDPOINT_OCCUPIED");
  other.close();
});
