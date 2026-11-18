import net from "node:net";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import { lstatSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireProcessLock, type ProcessLockHandle } from "./process-lock.js";

export class EndpointOccupiedError extends Error {
  readonly code = "ENDPOINT_OCCUPIED";

  constructor(message = "The endpoint is already served.") {
    super(message);
  }
}

export async function listenOwned(server: net.Server, endpoint: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await listen(server, endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        throw new EndpointOccupiedError();
      }
      throw error;
    }
    return;
  }
  const bound = endpoint + ".bind-" + process.pid + "-" + randomUUID().slice(0, 8);
  await listen(server, bound);
  let lock: ProcessLockHandle | undefined;
  try {
    lock = await acquireProcessLock(endpoint + ".publish-lock");
    await chmod(bound, 0o600).catch(() => {});
    const identity = await endpointIdentity(bound);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(bound, endpoint);
        return await confirm(endpoint, identity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
      const owner = await endpointIdentity(endpoint).catch(() => null);
      if (owner === null) continue;
      if (await probeEndpoint(endpoint)) throw new EndpointOccupiedError();
      let before: string;
      try {
        const value = lstatSync(endpoint);
        before = `${value.dev}:${value.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!sameIdentity(before, owner)) continue;
      renameSync(bound, endpoint);
      return await confirm(endpoint, identity);
    }
    throw new Error("Could not take ownership of the endpoint " + endpoint + ".");
  } catch (error) {
    server.close();
    throw error;
  } finally {
    await unlink(bound).catch(() => {});
    await lock?.release();
  }
}

async function confirm(endpoint: string, identity: string): Promise<void> {
  if (!sameIdentity(await endpointIdentity(endpoint).catch(() => null), identity)) {
    throw new Error("The endpoint " + endpoint + " was taken over while starting.");
  }
}

async function listen(server: net.Server, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    try {
      server.listen(target);
    } catch (error) {
      failed(error as Error);
    }
  });
}

export async function probeEndpoint(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(endpoint);
    const done = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(500, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(!["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")),
    );
  });
}

async function endpointIdentity(endpoint: string): Promise<string> {
  const value = await lstat(endpoint);
  return `${value.dev}:${value.ino}`;
}

const sameIdentity = (identity: string | null, expected: string): boolean =>
  typeof identity === "string" && identity === expected;
