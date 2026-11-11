import fs from "node:fs";
import path from "node:path";
import { atomicWriteTextSync } from "../infrastructure/persistence/atomic-files.js";
import type { InboundMessage } from "./types.js";

export const SESSION_NEW_METHOD = "session/new";
export const STATE_VERSION = 1;

export class SessionCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCreateError";
  }
}

export function sessionKey(message: InboundMessage): string {
  const base = `${message.channel}:${message.chat_type}:${message.chat_id}`;
  if (message.thread_id) {
    return `${base}:${message.thread_id}`;
  }
  return base;
}

export interface SessionRecord {
  session_id: string;
  cursor: number;
}

export interface WorkerRequestLike {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutSeconds?: number,
  ): Promise<Record<string, unknown>>;
}

export class SessionRouter {
  private readonly statePath: string;
  private readonly records = new Map<string, SessionRecord>();
  private readonly keysBySession = new Map<string, string>();

  constructor(statePath: string) {
    this.statePath = path.resolve(statePath);
    this.load();
  }

  lookup(key: string): SessionRecord | undefined {
    return this.records.get(key);
  }

  keyForSession(sessionId: string): string | undefined {
    return this.keysBySession.get(sessionId);
  }

  allSessions(): Record<string, SessionRecord> {
    const out: Record<string, SessionRecord> = {};
    for (const [key, record] of this.records.entries()) {
      out[key] = { session_id: record.session_id, cursor: record.cursor };
    }
    return out;
  }

  cursorFor(key: string): number {
    return this.records.get(key)?.cursor ?? 0;
  }

  async ensureSession(
    key: string,
    worker: WorkerRequestLike,
    workspaceRoot: string,
  ): Promise<SessionRecord> {
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }
    return await this.createSession(key, worker, workspaceRoot);
  }

  async createSession(
    key: string,
    worker: WorkerRequestLike,
    workspaceRoot: string,
  ): Promise<SessionRecord> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await worker.request(SESSION_NEW_METHOD, {
          workspace_root: workspaceRoot,
          owner_agent_id: `gateway:${key}`,
        });
        const sessionId = String(result?.session_id ?? "").trim();
        if (!sessionId) {
          throw new SessionCreateError("session/new returned no session_id");
        }
        return this.register(key, sessionId);
      } catch (exc) {
        lastError = exc;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new SessionCreateError(`session/new failed for ${key}: ${detail}`);
  }

  updateCursor(key: string, cursor: number): boolean {
    const record = this.records.get(key);
    if (!record || cursor <= record.cursor) {
      return false;
    }
    record.cursor = cursor;
    this.save();
    return true;
  }

  private register(key: string, sessionId: string): SessionRecord {
    const record: SessionRecord = { session_id: sessionId, cursor: 0 };
    this.records.set(key, record);
    this.keysBySession.set(sessionId, key);
    this.save();
    return record;
  }

  private load(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.statePath);
    } catch {
      return;
    }
    if (!stat.isFile()) {
      return;
    }

    let sessionsRaw: Record<string, unknown>;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("state must be an object");
      }
      const sessions = (data as Record<string, unknown>).sessions;
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
        throw new Error("sessions must be an object");
      }
      sessionsRaw = sessions as Record<string, unknown>;
    } catch {
      const corrupt = `${this.statePath}.corrupt`;
      try {
        fs.renameSync(this.statePath, corrupt);
      } catch {
        // best effort
      }
      return;
    }

    for (const [key, entry] of Object.entries(sessionsRaw)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const sessionId = String(rec.session_id ?? "").trim();
      if (!sessionId) {
        continue;
      }
      const cursor =
        typeof rec.cursor === "number" && Number.isInteger(rec.cursor) && rec.cursor >= 0
          ? rec.cursor
          : 0;
      this.records.set(key, { session_id: sessionId, cursor });
      this.keysBySession.set(sessionId, key);
    }
  }

  private save(): void {
    const sessionsObj: Record<string, { session_id: string; cursor: number }> = {};
    for (const [key, record] of this.records.entries()) {
      sessionsObj[key] = { session_id: record.session_id, cursor: record.cursor };
    }
    const payload = JSON.stringify(
      {
        version: STATE_VERSION,
        sessions: sessionsObj,
      },
      null,
      2,
    );
    atomicWriteTextSync(this.statePath, payload);
  }
}
