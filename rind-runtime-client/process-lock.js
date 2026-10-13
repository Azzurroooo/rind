import { mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Only ESRCH proves death; permission failures and PID reuse retain the lock.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

const sharingViolation = error => process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

// The owner marker has a unique name. Only the actor that successfully removes
// that marker may remove the directory. Another reclaimer cannot remove a new
// owner's directory, even if it read the dead owner's marker before a race.
// Empty/malformed locks are unknown ownership and time out with their path.
export async function acquireProcessLock(directory, timeoutMs = 30000) {
  const marker = path.join(directory, `${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try { await writeFile(marker, "", { flag: "wx", mode: 0o600 }); }
      catch (error) { await rmdir(directory).catch(() => {}); throw error; }
      return { release: () => removeOwner(directory, marker) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const entries = await readdir(directory).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const owner = entries.length === 1 && entries[0].match(/^([1-9][0-9]*)-[0-9a-f-]{36}$/);
    if (owner && !processAlive(Number(owner[1]))) {
      await removeOwner(directory, path.join(directory, entries[0]));
      continue;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process lock: " + directory);
    await pause();
  }
}

async function removeOwner(directory, marker) {
  // Only the actor that removed its unique marker can remove the directory.
  if (await removeEntry(unlink, marker)) await removeEntry(rmdir, directory);
}

async function removeEntry(remove, target) {
  // Concurrent unlink on Windows can transiently return EPERM while a prior
  // deletion releases its handles. Retry the same entry, never a new owner.
  for (let attempt = 0; ; attempt++) {
    try { await remove(target); return true; }
    catch (error) {
      if (error.code === "ENOENT") return false;
      if (!sharingViolation(error) || attempt >= 19) throw error;
      await pause();
    }
  }
}
