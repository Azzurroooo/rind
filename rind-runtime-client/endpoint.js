// Unix publishers serialize stale-entry replacement under a process lock.
// Link/rename publishes a private listener; identity checks detect interference
// from software outside this protocol. A failed publisher stops its listener.
// Windows named pipes are exclusive by name, so binding the canonical name is
// the whole protocol there.
// This follows orca's daemon endpoint ownership (src/main/daemon/daemon-endpoint-ownership.ts).
import net from "node:net";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import { lstatSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "./process-lock.js";

export class EndpointOccupiedError extends Error {
  constructor(message = "The endpoint is already served.") {
    super(message);
    this.code = "ENDPOINT_OCCUPIED";
  }
}

// Publishes the already-created server on its canonical endpoint. Resolves when
// this server owns the endpoint; throws EndpointOccupiedError when a live one
// owns it, or a plain Error when ownership could not be established.
export async function listenOwned(server, endpoint) {
  if (process.platform === "win32") {
    try {
      await listen(server, endpoint);
    } catch (error) {
      if (error?.code === "EADDRINUSE") throw new EndpointOccupiedError();
      throw error;
    }
    return;
  }
  const bound = endpoint + ".bind-" + process.pid + "-" + randomUUID().slice(0, 8);
  await listen(server, bound);
  let lock;
  try {
    lock = await acquireProcessLock(endpoint + ".publish-lock");
    await chmod(bound, 0o600).catch(() => {});
    const identity = await endpointIdentity(bound);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(bound, endpoint);
        return await confirm(endpoint, identity);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const owner = await endpointIdentity(endpoint).catch(() => null);
      if (owner === null) continue;
      if (await probeEndpoint(endpoint)) throw new EndpointOccupiedError();
      // Other Rind publishers hold this same lock. Recheck before replacing
      // to detect changes made by software that does not use the protocol.
      let before;
      try { const value = lstatSync(endpoint); before = `${value.dev}:${value.ino}`; }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!sameIdentity(before, owner)) continue;
      renameSync(bound, endpoint);
      return await confirm(endpoint, identity);
    }
    throw new Error("Could not take ownership of the endpoint " + endpoint + ".");
  } catch (error) {
    // Publishing can fail after the private listener has already been bound.
    server.close();
    throw error;
  } finally {
    await unlink(bound).catch(() => {});
    await lock?.release();
  }
}

// A concurrent publisher may have replaced the entry we published; whoever no
// longer owns the canonical entry must not serve.
async function confirm(endpoint, identity) {
  if (!sameIdentity(await endpointIdentity(endpoint).catch(() => null), identity)) {
    throw new Error("The endpoint " + endpoint + " was taken over while starting.");
  }
}

async function listen(server, target) {
  await new Promise((resolve, reject) => {
    const failed = error => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    try { server.listen(target); } catch (error) { failed(error); }
  });
}

// Only missing/refused proves the endpoint is free. Timeouts and permission
// errors are unknown ownership, conservatively treated as occupied.
export async function probeEndpoint(endpoint) {
  return new Promise(resolve => {
    const socket = net.connect(endpoint);
    const done = alive => { socket.removeAllListeners(); socket.destroy(); resolve(alive); };
    socket.setTimeout(500, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", error => done(!["ENOENT", "ECONNREFUSED"].includes(error.code)));
  });
}

async function endpointIdentity(endpoint) {
  const value = await lstat(endpoint);
  return `${value.dev}:${value.ino}`;
}

const sameIdentity = (identity, expected) => typeof identity === "string" && identity === expected;
