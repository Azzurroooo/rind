import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRindHome, resolveSessionBase, validateSessionId } from "../paths.js";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const CALL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

const PROCESS_LOCKS = new Map<string, FileLockHandle>();

export class FileLockHandle {
  readonly lockPath: string;
  private readonly timeoutMs: number;
  private fd: number | null = null;
  private depth = 0;

  constructor(lockPath: string, timeoutMs: number = 5000) {
    const resolved = path.resolve(lockPath);
    const existing = PROCESS_LOCKS.get(resolved);
    if (existing) {
      this.lockPath = existing.lockPath;
      this.timeoutMs = existing.timeoutMs;
      return existing;
    }
    this.lockPath = resolved;
    this.timeoutMs = timeoutMs;
    PROCESS_LOCKS.set(resolved, this);
  }

  acquire(timeoutMs: number = this.timeoutMs): void {
    if (this.fd !== null) {
      this.depth += 1;
      return;
    }
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        this.fd = fs.openSync(this.lockPath, "wx");
        fs.writeFileSync(this.fd, `${process.pid}\n`, "utf8");
        this.depth = 1;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EACCES") {
          throw err;
        }
        try {
          const content = fs.readFileSync(this.lockPath, "utf8").trim();
          const pid = Number.parseInt(content, 10);
          if (Number.isInteger(pid) && pid > 0) {
            if (pid === process.pid) {
              try {
                fs.unlinkSync(this.lockPath);
                continue;
              } catch {
                // ignore race
              }
            } else {
              try {
                process.kill(pid, 0);
              } catch (killErr) {
                if ((killErr as NodeJS.ErrnoException).code === "ESRCH") {
                  try {
                    fs.unlinkSync(this.lockPath);
                    continue;
                  } catch {
                    // ignore race
                  }
                }
              }
            }
          } else {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > 50) {
              try {
                fs.unlinkSync(this.lockPath);
                continue;
              } catch {
                // ignore race
              }
            }
          }
        } catch {
          // ignore
        }
        if (Date.now() >= deadline) {
          const timeoutError = new Error(`Lock timeout: ${this.lockPath}`);
          timeoutError.name = "TimeoutError";
          throw timeoutError;
        }
        sleepSync(15);
      }
    }
  }

  release(): void {
    if (this.depth > 1) {
      this.depth -= 1;
      return;
    }
    this.depth = 0;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
    }
  }

  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }
}

export class SessionFiles {
  private readonly locks = new Map<string, FileLockHandle>();

  lockFor(filePath: string): FileLockHandle {
    const lockPath = `${filePath}.lock`;
    let handle = this.locks.get(lockPath);
    if (!handle) {
      handle = new FileLockHandle(lockPath, 5000);
      this.locks.set(lockPath, handle);
    }
    return handle;
  }

  loadJson(filePath: string): Record<string, unknown> | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    let raw: string;
    try {
      raw = this.lockFor(filePath).withLock(() => fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new Error(`Session is currently in use by another process. Failed to acquire lock for: ${filePath}`);
      }
      throw new Error(`Failed to read JSON file: ${filePath}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Corrupted JSON file: ${filePath}: ${(err as Error).message}`);
    }
  }

  writeJson(filePath: string, data: unknown): void {
    const tmp = `${filePath}.${randomUUID().replace(/-/g, "")}.tmp`;
    try {
      this.lockFor(filePath).withLock(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(tmp, "w");
        try {
          fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.replaceWithRetry(tmp, filePath);
      });
    } catch (err) {
      this.removeTmp(tmp);
      if ((err as Error).name === "TimeoutError") {
        throw new Error(`Session is currently in use by another process. Failed to acquire lock for: ${filePath}`);
      }
      throw err;
    }
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
        throw new Error(`Session is currently in use by another process. Failed to acquire lock for: ${filePath}`);
      }
      throw err;
    }
  }

  readJsonl(filePath: string): Record<string, unknown>[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const items: Record<string, unknown>[] = [];
    this.lockFor(filePath).withLock(() => {
      const content = fs.readFileSync(filePath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          items.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          continue;
        }
      }
    });
    return items;
  }

  writeJsonl(filePath: string, records: readonly unknown[]): void {
    const payload = records.map(r => `${JSON.stringify(r)}\n`).join("");
    try {
      this.lockFor(filePath).withLock(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(filePath, "w");
        try {
          fs.writeFileSync(fd, payload, "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new Error(`Session is currently in use by another process. Failed to acquire lock for: ${filePath}`);
      }
      throw err;
    }
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
