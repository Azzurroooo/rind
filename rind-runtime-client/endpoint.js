// Exactly one live server owns a local endpoint. A Unix server binds a private
// name first and publishes it over the canonical name with link/rename, so no
// actor ever removes a name it did not create: linking fails while any entry
// exists, a probe decides whether that entry still serves, and only an entry
// proven dead — and re-checked, since a replace may race — is replaced
// atomically. A server that loses ownership while starting stops serving.
// Windows named pipes are exclusive by name, so binding the canonical name is
// the whole protocol there.
// This follows orca's daemon endpoint ownership (src/main/daemon/daemon-endpoint-ownership.ts).
import net from "node:net";
import { chmod, link, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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
  try {
    await chmod(bound, 0o600).catch(() => {});
    const identity = await endpointIdentity(bound);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(bound, endpoint);
        return await confirm(endpoint, identity);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (await probe(endpoint)) throw new EndpointOccupiedError();
      const owner = await endpointIdentity(endpoint).catch(() => null);
      if (owner === null) continue;
      // Only replace the entry that was proven dead, and only while it is still
      // that entry and the second probe agrees: a concurrent publisher's entry
      // is never swapped out here.
      const before = await endpointIdentity(endpoint).catch(() => null);
      if (!sameIdentity(before, owner) || await probe(endpoint)) continue;
      await rename(bound, endpoint);
      return await confirm(endpoint, identity);
    }
    throw new Error("Could not take ownership of the endpoint " + endpoint + ".");
  } finally {
    await unlink(bound).catch(() => {});
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

// True while something accepts connections; anything else (refused, timed out)
// counts as dead. Identities are file identities, so a missing entry never
// matches a recorded one.
async function probe(endpoint) {
  return new Promise(resolve => {
    const socket = net.connect(endpoint);
    const done = alive => { socket.removeAllListeners(); socket.destroy(); resolve(alive); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function endpointIdentity(endpoint) {
  const value = await stat(endpoint);
  return `${value.dev}:${value.ino}`;
}

const sameIdentity = (identity, expected) => typeof identity === "string" && identity === expected;
