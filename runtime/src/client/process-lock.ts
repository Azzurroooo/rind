import { mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ProcessLockHandle {
  release: () => Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

const sharingViolation = (error: NodeJS.ErrnoException): boolean =>
  process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code ?? "");
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

export async function acquireProcessLock(
  directory: string,
  timeoutMs = 30000,
): Promise<ProcessLockHandle> {
  const marker = path.join(directory, `${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(marker, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        await rmdir(directory).catch(() => {});
        throw error;
      }
      return { release: () => removeOwner(directory, marker) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const owner = entries.length === 1 ? entries[0].match(/^([1-9][0-9]*)-[0-9a-f-]{36}$/) : null;
    if (owner && !processAlive(Number(owner[1]))) {
      await removeOwner(directory, path.join(directory, entries[0]));
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process lock: " + directory);
    }
    await pause();
  }
}

async function removeOwner(directory: string, marker: string): Promise<void> {
  if (await removeEntry(unlink, marker)) await removeEntry(rmdir, directory);
}

async function removeEntry(
  remove: (target: string) => Promise<void>,
  target: string,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(target);
      return true;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") return false;
      if (!sharingViolation(errno) || attempt >= 19) throw error;
      await pause();
    }
  }
}
