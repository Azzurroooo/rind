import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TERMINAL_STATES, type TaskStatus } from "../../domain/models.js";
import { resolveSessionBase } from "../paths.js";
import { FileLockHandle } from "./atomic-files.js";

export function encodeCursor(taskId: string, offset: number, character: number = 0): string {
  return Buffer.from(JSON.stringify([taskId, offset, character]), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function decodeCursor(taskId: string, cursor: string): [number, number] {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      throw new Error();
    }
    const [identity, offset, character] = parsed;
    if (
      identity !== taskId ||
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      typeof character !== "number" ||
      !Number.isInteger(character) ||
      Math.min(offset, character) < 0
    ) {
      throw new Error();
    }
    return [offset, character];
  } catch {
    throw new Error("Invalid cursor for this task.");
  }
}

export function readOutputPage(
  filePath: string,
  taskId: string,
  cursor: string,
  maxChars: number,
): Record<string, unknown> {
  let [offset, character] = decodeCursor(taskId, cursor);
  const output: {
    stdout: string;
    stderr: string;
    records: { stream: string; sequence: number; text: string }[];
  } = {
    stdout: "",
    stderr: "",
    records: [],
  };
  if (!fs.existsSync(filePath)) {
    return {
      ...output,
      next_cursor: encodeCursor(taskId, 0),
      truncated: true,
      output_incomplete: true,
      output_error: "Output log is no longer available.",
      available_cursor: encodeCursor(taskId, 0),
    };
  }
  const data = fs.readFileSync(filePath);
  if (offset > data.length) {
    throw new Error("Cursor exceeds available output.");
  }
  let pos = offset;
  let remaining = maxChars;
  while (remaining > 0 && pos < data.length) {
    const start = pos;
    let nl = data.indexOf(0x0a, pos);
    if (nl === -1) {
      nl = data.length;
    } else {
      nl += 1;
    }
    const lineBuf = data.subarray(start, nl);
    pos = nl;
    let record: { stream: "stdout" | "stderr"; sequence: number; text: string };
    try {
      record = JSON.parse(lineBuf.toString("utf8"));
    } catch {
      throw new Error("Cursor does not reference an output record.");
    }
    const text = String(record.text ?? "");
    if (character > text.length) {
      throw new Error("Cursor exceeds output record.");
    }
    const piece = text.slice(character, character + remaining);
    if (record.stream === "stderr") {
      output.stderr += piece;
    } else {
      output.stdout += piece;
    }
    output.records.push({
      stream: record.stream,
      sequence: record.sequence,
      text: piece,
    });
    remaining -= piece.length;
    character += piece.length;
    if (character < text.length) {
      pos = start;
      break;
    }
    character = 0;
  }
  const nextOffset = pos;
  const truncated = nextOffset < data.length;
  return {
    ...output,
    next_cursor: encodeCursor(taskId, nextOffset, character),
    truncated,
  };
}

export class TaskOutput {
  readonly path: string;
  readonly recordsPath: string;
  readonly taskId: string;
  readonly maxBytes: number;
  incomplete = "";
  private bytes = 0;
  private sequence = 0;

  constructor(filePath: string, taskId: string, maxBytes: number = 32 * 1024 * 1024) {
    this.path = filePath;
    this.recordsPath = filePath.replace(/\.[^/.]+$/, "") + ".jsonl";
    this.taskId = taskId;
    this.maxBytes = maxBytes;
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.closeSync(fs.openSync(this.path, "a"));
    fs.closeSync(fs.openSync(this.recordsPath, "a"));
  }

  async append(stream: string, raw: Buffer, text: string): Promise<void> {
    this.sequence += 1;
    if (this.incomplete) {
      return;
    }
    try {
      const lineBuf = Buffer.from(
        `${JSON.stringify({ stream, sequence: this.sequence, text })}\n`,
        "utf8",
      );
      if (this.bytes + raw.length + lineBuf.length > this.maxBytes) {
        this.incomplete = `Task output quota reached (${this.maxBytes} bytes including output index); further output drained and discarded.`;
        return;
      }
      fs.appendFileSync(this.path, raw);
      fs.appendFileSync(this.recordsPath, lineBuf);
      this.bytes += raw.length + lineBuf.length;
    } catch (err) {
      this.incomplete = `Output storage failed: ${(err as Error).message}`;
    }
  }

  async flush(): Promise<void> {
    // synchronous writes in append
  }

  async close(): Promise<void> {
    // no-op
  }

  async read(cursor: string, maxChars: number): Promise<Record<string, unknown>> {
    await this.flush();
    return readOutputPage(this.recordsPath, this.taskId, cursor, maxChars);
  }
}

interface SessionJournalState {
  maintainedAt: number | null;
}

export class TaskJournal {
  static readonly MAINTENANCE_INTERVAL = 3600;
  readonly root: string;
  readonly worker_instance_id: string;
  private leasePath: string | null = null;
  private leaseFd: number | null = null;
  private readonly fileLocks = new Map<string, FileLockHandle>();
  private readonly sessions = new Map<string, SessionJournalState>();

  constructor(sessionRoot: string) {
    this.root = path.resolve(sessionRoot);
    this.worker_instance_id = randomUUID().replace(/-/g, "");
  }

  private ensureLease(): void {
    if (this.leaseFd !== null) {
      return;
    }
    const dir = path.join(this.root, ".task-workers");
    fs.mkdirSync(dir, { recursive: true });
    const lpath = path.join(dir, `${this.worker_instance_id}.lock`);
    this.leaseFd = fs.openSync(lpath, "w");
    fs.writeFileSync(this.leaseFd, `${process.pid}\n`, "utf8");
    this.leasePath = lpath;
  }

  private ownerAlive(owner: string): boolean {
    if (!owner || !/^[A-Za-z0-9]+$/.test(owner)) {
      return false;
    }
    if (owner === this.worker_instance_id && this.leaseFd !== null) {
      return true;
    }
    const lockPath = path.join(this.root, ".task-workers", `${owner}.lock`);
    if (!fs.existsSync(lockPath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(lockPath, "utf8").trim();
      const pid = Number.parseInt(content, 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") {
            return true;
          }
          return false;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async records(sessionId: string): Promise<Record<string, Record<string, unknown>>> {
    return this.transaction(sessionId, "all") as Record<string, Record<string, unknown>>;
  }

  async relevant(sessionId: string): Promise<Record<string, Record<string, unknown>>> {
    return this.transaction(sessionId, "relevant") as Record<string, Record<string, unknown>>;
  }

  async get(sessionId: string, taskId: string): Promise<Record<string, unknown> | null> {
    return this.transaction(sessionId, "get", taskId) as Record<string, unknown> | null;
  }

  async save(
    sessionId: string,
    snapshot: Record<string, unknown>,
    options?: { create?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.transaction(
      sessionId,
      "save",
      String(snapshot.task_id || ""),
      snapshot,
      Boolean(options?.create),
    ) as Record<string, unknown>;
  }

  async update(
    sessionId: string,
    taskId: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.transaction(sessionId, "save", taskId, changes, false) as Record<string, unknown>;
  }

  async maintain(sessionId: string): Promise<void> {
    this.transaction(sessionId, "maintain");
  }

  private static isRelevant(record: Record<string, unknown>): boolean {
    const status = String(record.status || "") as TaskStatus;
    return (
      !TERMINAL_STATES.has(status) ||
      Boolean(record.handoff && (!record.delivered || !record.consumed))
    );
  }

  private static summary(record: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k !== "stdout" && k !== "stderr" && k !== "records") {
        out[k] = v;
      }
    }
    return out;
  }

  private readAllAndRepair(filePath: string): Record<string, Record<string, unknown>> {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const buf = fs.readFileSync(filePath);
    const records: Record<string, Record<string, unknown>> = {};
    let pos = 0;
    while (pos < buf.length) {
      const start = pos;
      let nl = buf.indexOf(0x0a, pos);
      let hadNewline = true;
      if (nl === -1) {
        nl = buf.length;
        hadNewline = false;
      } else {
        nl += 1;
      }
      const lineBuf = buf.subarray(start, nl);
      pos = nl;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(lineBuf.toString("utf8")) as Record<string, unknown>;
      } catch {
        if (pos !== buf.length) {
          throw new Error("Corrupt task journal; refusing to execute commands.");
        }
        fs.truncateSync(filePath, start);
        break;
      }
      if (record && typeof record.task_id === "string") {
        records[record.task_id] = record;
      }
      if (!hadNewline) {
        const fd = fs.openSync(filePath, "a");
        try {
          fs.writeFileSync(fd, "\n", "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    return records;
  }

  private appendRecord(filePath: string, record: Record<string, unknown>): void {
    const fd = fs.openSync(filePath, "a");
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private recover(
    filePath: string,
    records: Record<string, Record<string, unknown>>,
  ): Record<string, Record<string, unknown>> {
    const owners = new Map<string, boolean>();
    for (const [taskId, record] of Object.entries(records)) {
      const status = String(record.status || "") as TaskStatus;
      if (TERMINAL_STATES.has(status)) {
        continue;
      }
      const owner = String(record.worker_instance_id || "");
      let alive = owners.get(owner);
      if (alive === undefined) {
        alive = this.ownerAlive(owner);
        owners.set(owner, alive);
      }
      if (!alive) {
        const lostRecord: Record<string, unknown> = {
          ...record,
          status: "lost",
          finished_at: Date.now() / 1000,
          exit_code: null,
          reason: "Previous Worker ownership was lost; process state is unknown. Command was not restarted.",
          event_id: `${taskId}:1`,
        };
        this.appendRecord(filePath, lostRecord);
        records[taskId] = lostRecord;
      }
    }
    return records;
  }

  private transaction(
    sessionId: string,
    action: "all" | "relevant" | "get" | "save" | "maintain",
    taskId?: string,
    changes?: Record<string, unknown>,
    create: boolean = false,
  ): unknown {
    const directory = resolveSessionBase(this.root, sessionId);
    const filePath = path.join(directory, "tasks.jsonl");
    if ((action === "all" || action === "relevant" || action === "get" || action === "maintain") && !fs.existsSync(filePath)) {
      return action === "all" || action === "relevant" ? {} : null;
    }
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const lockKey = `${filePath}.lock`;
    let lock = this.fileLocks.get(lockKey);
    if (!lock) {
      lock = new FileLockHandle(lockKey, 5000);
      this.fileLocks.set(lockKey, lock);
    }
    return lock.withLock(() => {
      this.ensureLease();
      let state = this.sessions.get(sessionId);
      if (!state) {
        state = { maintainedAt: null };
        this.sessions.set(sessionId, state);
      }
      const allRecords = this.readAllAndRepair(filePath);
      if (action === "all") {
        return this.recover(filePath, allRecords);
      }
      if (action === "get") {
        if (!taskId || !(taskId in allRecords)) {
          return null;
        }
        const rec = this.recover(filePath, { [taskId]: allRecords[taskId] })[taskId];
        return rec ?? null;
      }
      if (action === "relevant") {
        const rel: Record<string, Record<string, unknown>> = {};
        for (const [k, r] of Object.entries(allRecords)) {
          if (TaskJournal.isRelevant(r)) {
            rel[k] = r;
          }
        }
        const recovered = this.recover(filePath, rel);
        const out: Record<string, Record<string, unknown>> = {};
        for (const [k, r] of Object.entries(recovered)) {
          out[k] = TaskJournal.summary(r);
        }
        return out;
      }
      if (action === "maintain") {
        this.maintainSync(filePath, directory, state, allRecords);
        return null;
      }
      // action === "save"
      const chg = changes ?? {};
      if (create && chg.origin_tool_call_id) {
        const origin = chg.origin_tool_call_id;
        const existing = Object.values(allRecords).find(r => r.origin_tool_call_id === origin);
        if (existing) {
          const eid = String(existing.task_id);
          return this.recover(filePath, { [eid]: existing })[eid];
        }
      }
      const previous = !create && taskId ? allRecords[taskId] : undefined;
      if (!previous && !chg.task_id) {
        const err = new Error(`Unknown task: ${taskId}`);
        err.name = "LookupError";
        throw err;
      }
      const record: Record<string, unknown> = {
        ...(previous ?? {}),
        ...chg,
      };
      record.handoff = Boolean(record.handoff || previous?.handoff);
      this.appendRecord(filePath, record);
      return { ...record };
    });
  }

  private maintainSync(
    filePath: string,
    directory: string,
    state: SessionJournalState,
    records: Record<string, Record<string, unknown>>,
  ): void {
    const nowSec = Date.now() / 1000;
    if (state.maintainedAt !== null && nowSec - state.maintainedAt < TaskJournal.MAINTENANCE_INTERVAL) {
      return;
    }
    const expired = Object.values(records).filter(
      r =>
        typeof r.finished_at === "number" &&
        r.finished_at < nowSec - 86400 &&
        (r.consumed || r.notify === "manual" || r.status === "cancelled") &&
        "stdout" in r,
    );
    if (expired.length > 0) {
      const toolOutputDir = path.resolve(directory, "tool-output");
      for (const record of expired) {
        const meta = record.meta && typeof record.meta === "object"
          ? (record.meta as Record<string, unknown>)
          : null;
        const outputPath = meta && typeof meta.output_path === "string" ? meta.output_path : null;
        if (outputPath) {
          const target = path.resolve(outputPath);
          if (
            path.dirname(target) === toolOutputDir &&
            path.basename(target, path.extname(target)) === String(record.task_id || "")
          ) {
            try {
              if (fs.existsSync(target)) fs.unlinkSync(target);
            } catch {
              // ignore
            }
            const jsonlTarget = target.replace(/\.[^/.]+$/, "") + ".jsonl";
            try {
              if (fs.existsSync(jsonlTarget)) fs.unlinkSync(jsonlTarget);
            } catch {
              // ignore
            }
          }
        }
        delete record.stdout;
        delete record.stderr;
        record.meta = {
          output_incomplete: true,
          output_error: "Output retention expired; task facts and deduplication identity remain available.",
        };
      }
      const temporary = `${filePath}.tmp`;
      try {
        const fd = fs.openSync(temporary, "w");
        try {
          for (const rec of Object.values(records)) {
            fs.writeFileSync(fd, `${JSON.stringify(rec)}\n`, "utf8");
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, filePath);
      } finally {
        try {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        } catch {
          // ignore
        }
      }
    }
    state.maintainedAt = nowSec;
  }

  async close(): Promise<void> {
    this.close_now();
  }

  close_now(): void {
    if (this.leaseFd !== null) {
      try {
        fs.closeSync(this.leaseFd);
      } catch {
        // ignore
      }
      this.leaseFd = null;
    }
    if (this.leasePath) {
      try {
        if (fs.existsSync(this.leasePath)) fs.unlinkSync(this.leasePath);
      } catch {
        // ignore
      }
      this.leasePath = null;
    }
    this.sessions.clear();
  }

  forget_session(sessionId: string): void {
    this.sessions.delete(sessionId);
    const lockKey = `${path.join(resolveSessionBase(this.root, sessionId), "tasks.jsonl")}.lock`;
    this.fileLocks.delete(lockKey);
  }
}
