import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRindHome, resolveSessionBase, validateSessionId } from "../paths.js";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const CALL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const EMPTY_LOCK_STALE_MS = 500;
const LOCK_STALE_MS = 30_000;
const LOCAL_HOST = os.hostname();

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface ActiveLockState {
  fd: number;
  ownerRecord: string;
  depth: number;
}

const ACTIVE_LOCKS = new Map<string, ActiveLockState>();

export class FileLockHandle {
  readonly lockPath: string;
  private readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number = 5000) {
    this.lockPath = path.resolve(lockPath);
    this.timeoutMs = timeoutMs;
  }

  acquire(timeoutMs: number = this.timeoutMs): void {
    const active = ACTIVE_LOCKS.get(this.lockPath);
    if (active) {
      active.depth += 1;
      return;
    }
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, "wx");
        const ownerRecord = `${process.pid} ${LOCAL_HOST} ${randomUUID()}\n`;
        try {
          fs.writeFileSync(fd, ownerRecord, "utf8");
        } catch (writeErr) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
          throw writeErr;
        }
        ACTIVE_LOCKS.set(this.lockPath, { fd, ownerRecord, depth: 1 });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const winSharing = process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
        if (code !== "EEXIST" && code !== "EACCES" && !winSharing) {
          throw err;
        }
        if (this.tryReclaimStale()) {
          continue;
        }
        if (Date.now() >= deadline) {
          const timeoutError = new Error(`Lock timeout: ${this.lockPath}`);
          timeoutError.name = "TimeoutError";
          throw timeoutError;
        }
        sleepSync(10 + Math.floor(Math.random() * 15));
      }
    }
  }

  private tryReclaimStale(): boolean {
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(this.lockPath);
      raw = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return false;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const content = raw.trim();
    let stale = false;
    if (!content) {
      stale = ageMs >= EMPTY_LOCK_STALE_MS;
    } else {
      const [pidPart, hostPart] = content.split(/\s+/);
      const pid = Number.parseInt(pidPart, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = ageMs >= EMPTY_LOCK_STALE_MS;
      } else if (!hostPart || hostPart === LOCAL_HOST) {
        stale = pid === process.pid || !processAlive(pid) || ageMs >= LOCK_STALE_MS;
      } else {
        stale = ageMs >= LOCK_STALE_MS;
      }
    }
    if (!stale) {
      return false;
    }
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== raw) {
        return false;
      }
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    const active = ACTIVE_LOCKS.get(this.lockPath);
    if (!active) {
      return;
    }
    if (active.depth > 1) {
      active.depth -= 1;
      return;
    }
    ACTIVE_LOCKS.delete(this.lockPath);
    const { fd, ownerRecord } = active;
    let sameInode = true;
    if (process.platform !== "win32") {
      try {
        sameInode = fs.fstatSync(fd).ino === fs.statSync(this.lockPath).ino;
      } catch {
        sameInode = false;
      }
    }
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    if (sameInode) {
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === ownerRecord) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {
        // ignore
      }
    }
  }

  withLock<T>(fn: () => T, timeoutMs: number = this.timeoutMs): T {
    this.acquire(timeoutMs);
    try {
      return fn();
    } finally {
      this.release();
    }
  }
}

export class SessionFiles {
  lockFor(filePath: string): FileLockHandle {
    return new FileLockHandle(`${filePath}.lock`, 5000);
  }

  loadJson(filePath: string): Record<string, unknown> | null {
    let raw: string | null;
    try {
      raw = this.readText(filePath);
    } catch (err) {
      throw new Error(`Failed to read JSON file: ${filePath}: ${(err as Error).message}`);
    }
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Corrupted JSON file: ${filePath}: ${(err as Error).message}`);
    }
  }

  writeJson(filePath: string, data: unknown): void {
    this.writeAtomic(filePath, JSON.stringify(data, null, 2));
  }

  appendJsonl(filePath: string, data: unknown): void {
    const line = `${JSON.stringify(data)}\n`;
    try {
      this.lockFor(filePath).withLock(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(filePath, "a");
        try {
          fs.writeFileSync(fd, line, "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw this.lockTimeoutError(filePath);
      }
      throw err;
    }
  }

  readJsonl(filePath: string): Record<string, unknown>[] {
    let content: string | null;
    try {
      content = this.readText(filePath);
    } catch (err) {
      throw new Error(`Failed to read JSONL file: ${filePath}: ${(err as Error).message}`);
    }
    if (content === null) {
      return [];
    }
    const items: Record<string, unknown>[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        items.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    return items;
  }

  writeJsonl(filePath: string, records: readonly unknown[]): void {
    this.writeAtomic(filePath, records.map(r => `${JSON.stringify(r)}\n`).join(""));
  }

  private readText(filePath: string): string | null {
    for (const delay of [10, 25, 50, null] as const) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return null;
        }
        const winSharing =
          process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
        if (!winSharing || delay === null) {
          throw err;
        }
        sleepSync(delay);
      }
    }
    return null;
  }

  private writeAtomic(filePath: string, payload: string): void {
    const tmp = `${filePath}.${randomUUID().replace(/-/g, "")}.tmp`;
    try {
      this.lockFor(filePath).withLock(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(tmp, "w");
        try {
          fs.writeFileSync(fd, payload, "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.replaceWithRetry(tmp, filePath);
      });
    } catch (err) {
      this.removeTmp(tmp);
      if ((err as Error).name === "TimeoutError") {
        throw this.lockTimeoutError(filePath);
      }
      throw err;
    }
  }

  private lockTimeoutError(filePath: string): Error {
    const name = path.basename(filePath);
    if (name === "session_index.json" || name === "index.json" || name === "usage.jsonl") {
      return new Error(`Timed out waiting to update shared store: ${filePath}`);
    }
    return new Error(`Session is currently in use by another process. Failed to acquire lock for: ${filePath}`);
  }

  private replaceWithRetry(source: string, destination: string): void {
    for (const delay of [50, 100, 200, 400, null] as const) {
      try {
        fs.renameSync(source, destination);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || delay === null) {
          throw err;
        }
        sleepSync(delay);
      }
    }
  }

  private removeTmp(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}

export const SESSION_FILES = new SessionFiles();

export class ToolOutputStore {
  readonly sessionRoot: string;
  private readonly retentionSeconds: number;

  constructor(sessionDir?: string | null, retentionSeconds: number = RETENTION_SECONDS) {
    this.sessionRoot = sessionDir
      ? path.resolve(sessionDir)
      : path.resolve(resolveRindHome(), "sessions");
    this.retentionSeconds = Math.max(1, Math.trunc(retentionSeconds));
  }

  sessionOutputRoot(sessionId: string): string {
    return path.join(resolveSessionBase(this.sessionRoot, validateSessionId(sessionId)), "tool-output");
  }

  pathFor(sessionId: string, callId: string): string {
    if (!CALL_ID_PATTERN.test(String(callId || ""))) {
      throw new Error("Invalid tool call id for output path.");
    }
    return path.resolve(this.sessionOutputRoot(sessionId), `${callId}.txt`);
  }

  async write(sessionId: string, callId: string, content: string): Promise<string> {
    const target = this.pathFor(sessionId, callId);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID().replace(/-/g, "")}.tmp`);
    try {
      fs.writeFileSync(temporary, String(content), "utf8");
      fs.renameSync(temporary, target);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // ignore
      }
    }
    return target;
  }

  async cleanup(): Promise<void> {
    const cutoffMs = Date.now() - this.retentionSeconds * 1000;
    if (!fs.existsSync(this.sessionRoot)) {
      return;
    }
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(this.sessionRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const outputDir = path.join(this.sessionRoot, sessionEntry.name, "tool-output");
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(outputDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || file.name.startsWith(".") || file.name.startsWith("task_")) {
          continue;
        }
        const fullPath = path.join(outputDir, file.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoffMs) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  }
}
