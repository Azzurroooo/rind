import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CancellationToken } from "../../domain/cancellation.js";
import {
  TERMINAL_STATES,
  publicTask,
  toolError,
  toolOk,
  type ToolExecutionResult,
} from "../../domain/models.js";
import { detectDefaultShell, expandTilde } from "../paths.js";
import { ToolOutputStore } from "../persistence/atomic-files.js";
import {
  TaskJournal,
  TaskOutput,
  encodeCursor,
  readOutputPage,
} from "../persistence/task-journal.js";
import { ToolSpec } from "./registry.js";

export type BashPolicyStatus = "allow" | "deny";

const TOKEN_REGEX =
  /"(?:`.|\\.|[^"])*"|'(?:''|[^'])*'|`[^`]*`|\$\([^()]*\)|#[^\n]*|<<-?|[;&|(){}<>\n]+|[^\s;&|(){}<>"']+/g;
const FORBIDDEN_REGEX =
  /^(?:format(?:\.exe|\.com)?|mkfs(?:\.[a-z0-9]+)?|shutdown(?:\.exe)?|reboot(?:\.exe)?|format-volume)$/i;
const SHELL_NAMES = new Set(["bash", "sh", "cmd", "powershell", "pwsh"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeBash(command: string): string[] {
  const result: string[] = [];
  const pending: string[] = [];
  let delimiterNext = false;
  let skipUntil = 0;
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_REGEX.exec(command)) !== null) {
    if (match.index < skipUntil) continue;
    const token = match[0];
    if (token.startsWith("#")) continue;
    if (delimiterNext) {
      pending.push(token.replace(/^["']|["']$/g, ""));
      delimiterNext = false;
    }
    if (token === "<<" || token === "<<-") {
      delimiterNext = true;
    }
    if (token.includes("\n") && pending.length > 0) {
      let start = match.index + token.length;
      for (const delimiter of pending) {
        const endRe = new RegExp(`^\\t*${escapeRegex(delimiter)}\\r?$`, "m");
        const sub = command.slice(start);
        const endMatch = endRe.exec(sub);
        if (!endMatch) {
          skipUntil = command.length;
          break;
        }
        skipUntil = start + endMatch.index + endMatch[0].length;
        start = skipUntil;
      }
      pending.length = 0;
    }
    result.push(token);
  }
  return result;
}

export class BashPolicy {
  static classify(command: string, backend = "bash"): [BashPolicyStatus, string | null] {
    let position = true;
    let executable = "";
    let scriptNext = false;
    let redirectNext = false;
    let invocation = false;
    const tokens = tokenizeBash(command);
    for (const token of tokens) {
      if (!token.startsWith("'")) {
        const subMatches = [...token.matchAll(/\$\(([^()]*)\)/g)].map(m => m[1]!);
        if (backend !== "powershell") {
          subMatches.push(...[...token.matchAll(/`([^`]*)`/g)].map(m => m[1]!));
        }
        for (const script of subMatches) {
          const res = BashPolicy.classify(script, backend);
          if (res[0] === "deny") return res;
        }
      }
      if (scriptNext) {
        const stripped = token.replace(/^["']|["']$/g, "");
        const subBackend =
          executable === "powershell" || executable === "pwsh" ? "powershell" : "bash";
        const res = BashPolicy.classify(stripped, subBackend);
        if (res[0] === "deny") return res;
        scriptNext = false;
      }
      if (/^[;&|(){}\n]+$/.test(token)) {
        position = true;
        invocation = token === "&";
        executable = "";
        continue;
      }
      if (token === ">" || token === ">>" || token === "<" || token === "<<" || token === "<<-") {
        redirectNext = true;
        continue;
      }
      if (redirectNext) {
        redirectNext = false;
        continue;
      }
      if (position) {
        if (
          [
            "if",
            "then",
            "elif",
            "else",
            "do",
            "!",
            "sudo",
            "env",
            "command",
            "exec",
            "builtin",
            "call",
          ].includes(token) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
        ) {
          continue;
        }
        if (backend === "powershell" && token === ".") {
          invocation = true;
          continue;
        }
        if (backend === "powershell" && (token.startsWith('"') || token.startsWith("'")) && !invocation) {
          position = false;
          continue;
        }
        const stripped = token.replace(/^["']|["']$/g, "");
        const parts = stripped.split(/[/\\]/);
        const name = (parts[parts.length - 1] || "").toLowerCase();
        if (FORBIDDEN_REGEX.test(name)) {
          return ["deny", `Detected ${name} command.`];
        }
        executable = name.endsWith(".exe") ? name.slice(0, -4) : name;
        position = false;
      } else if (
        SHELL_NAMES.has(executable) &&
        ["-c", "-lc", "/c", "/k", "-command"].includes(token.toLowerCase())
      ) {
        scriptNext = true;
      }
    }
    const syntax = tokens
      .filter(t => !t.startsWith('"') && !t.startsWith("'"))
      .join(" ");
    if (/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(syntax)) {
      return ["deny", "Detected fork bomb pattern."];
    }
    return ["allow", null];
  }
}

const HEAD_LIMIT = 24 * 1024;
const TAIL_LIMIT = 24 * 1024;
const MAX_LINES = 2000;
const OUTPUT_TRUNCATED = "\n\n...[OUTPUT TRUNCATED]...\n\n";

export class StreamCapture {
  head: string[] = [];
  tail: string[] = [];
  charCount = 0;
  tailChars = 0;
  byteCount = 0;
  newlineCount = 0;
  lastByte: number | null = null;

  get lineCount(): number {
    return this.newlineCount + (this.byteCount > 0 && this.lastByte !== 10 ? 1 : 0);
  }

  get truncated(): boolean {
    return this.charCount > HEAD_LIMIT + TAIL_LIMIT || this.lineCount > MAX_LINES;
  }

  append(raw: Buffer, text: string): void {
    if (raw.length > 0) {
      this.byteCount += raw.length;
      for (let i = 0; i < raw.length; i += 1) {
        if (raw[i] === 10) this.newlineCount += 1;
      }
      this.lastByte = raw[raw.length - 1]!;
    }
    if (!text) return;

    const previousChars = this.charCount;
    this.charCount += text.length;
    const headSpace = Math.max(0, HEAD_LIMIT - previousChars);
    let remaining = text;
    if (headSpace > 0) {
      this.head.push(remaining.slice(0, headSpace));
      remaining = remaining.slice(headSpace);
    }
    if (!remaining) return;

    this.tail.push(remaining);
    this.tailChars += remaining.length;
    let overflow = this.tailChars - TAIL_LIMIT;
    while (overflow > 0 && this.tail.length > 0) {
      const first = this.tail[0]!;
      if (first.length <= overflow) {
        this.tail.shift();
        this.tailChars -= first.length;
        overflow -= first.length;
      } else {
        this.tail[0] = first.slice(overflow);
        this.tailChars -= overflow;
        overflow = 0;
      }
    }
  }

  render(): string {
    const headStr = this.head.join("");
    if (this.charCount <= HEAD_LIMIT) {
      return headStr;
    }
    const tailStr = this.tail.join("");
    if (!this.truncated) {
      return headStr + tailStr;
    }
    return headStr + OUTPUT_TRUNCATED + tailStr;
  }

  tailPreview(limit: number): string {
    if (limit <= 0) return "";
    const chunks: string[] = [];
    let remaining = limit;
    for (let i = this.tail.length - 1; i >= 0; i -= 1) {
      const chunk = this.tail[i]!;
      const piece = chunk.slice(-remaining);
      chunks.push(piece);
      remaining -= piece.length;
      if (remaining === 0) {
        return chunks.reverse().join("");
      }
    }
    if (this.charCount <= HEAD_LIMIT + TAIL_LIMIT) {
      for (let i = this.head.length - 1; i >= 0; i -= 1) {
        const chunk = this.head[i]!;
        const piece = chunk.slice(-remaining);
        chunks.push(piece);
        remaining -= piece.length;
        if (remaining === 0) break;
      }
    }
    return chunks.reverse().join("");
  }
}

export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  shell_executable: string | null;
  shell_error: string | null;
  shell_backend: string;
}

export class ShellSessionPool {
  private readonly states = new Map<string, ShellState>();
  private readonly defaultShell = detectDefaultShell();

  getState(sessionId: string, workspaceRoot?: string | null): ShellState {
    let state = this.states.get(sessionId);
    if (!state) {
      const envCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") envCopy[k] = v;
      }
      state = {
        cwd: path.resolve(expandTilde(workspaceRoot || process.cwd())),
        env: envCopy,
        shell_executable: this.defaultShell.executable,
        shell_error: this.defaultShell.error ?? null,
        shell_backend: this.defaultShell.backend,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  close(sessionId: string): void {
    this.states.delete(sessionId);
  }

  clear(): void {
    this.states.clear();
  }
}

class AsyncEvent {
  private flag = false;
  private resolvers = new Set<() => void>();

  isSet(): boolean {
    return this.flag;
  }

  set(): void {
    if (this.flag) return;
    this.flag = true;
    for (const resolve of this.resolvers) {
      resolve();
    }
    this.resolvers.clear();
  }

  wait(): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.resolvers.add(resolve);
    });
  }
}

interface ProcessRecord {
  task_id: string;
  session_id: string;
  command: string;
  cwd: string;
  shell_backend: string;
  shell_executable: string | null;
  call_id: string;
  origin_turn_id: string;
  request_id: string | null;
  notify: string;
  process: ChildProcess | null;
  spawned_at: number;
  persistence_error: string;
  status: string;
  reason: string;
  started_at: number;
  finished_at: number | null;
  stdout: StreamCapture;
  stderr: StreamCapture;
  exit_code: number | null;
  last_output_event_at: number;
  finished: AsyncEvent;
  started: AsyncEvent;
  waiters: Set<AsyncEvent>;
  saveChain: Promise<void>;
  handed_off: boolean;
  readersPromise: Promise<void> | null;
  monitorPromise: Promise<void> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  output: TaskOutput | null;
  termination_status: string | null;
}

function taskSnapshot(record: ProcessRecord): Record<string, unknown> {
  const nowSec = Date.now() / 1000;
  return {
    task_id: record.task_id,
    owner_session_id: record.session_id,
    origin_tool_call_id: record.call_id,
    origin_turn_id: record.origin_turn_id,
    request_id: record.request_id,
    command: record.command.slice(0, 2000),
    cwd: record.cwd,
    shell_backend: record.shell_backend,
    shell_executable: record.shell_executable,
    status: record.status,
    handoff: record.handed_off,
    exit_code: record.exit_code,
    notify: record.notify,
    started_at: record.started_at,
    finished_at: record.finished_at,
    elapsed_ms: Math.max(0, Math.trunc(((record.finished_at ?? nowSec) - record.started_at) * 1000)),
    reason: record.reason,
  };
}

export function outputPreview(stdout: string, stderr: string, limit: number): [string, string] {
  const stderrSize = Math.min(stderr.length, Math.max(1, Math.floor(limit / 2)));
  const stdoutSize = limit - stderrSize;
  return [
    stdoutSize > 0 ? stdout.slice(-stdoutSize) : "",
    stderrSize > 0 ? stderr.slice(-stderrSize) : "",
  ];
}

function taskPayload(
  record: ProcessRecord,
  returnReason: string,
  maxChars = 20000,
): [Record<string, unknown>, Record<string, unknown>] {
  let stdout = record.stdout.render();
  let stderr = record.stderr.render();
  const truncated =
    record.stdout.truncated ||
    record.stderr.truncated ||
    stdout.length + stderr.length > maxChars;
  [stdout, stderr] = outputPreview(stdout, stderr, maxChars);
  const meta: Record<string, unknown> = {
    truncated,
    total_bytes: record.stdout.byteCount + record.stderr.byteCount,
    total_lines: record.stdout.lineCount + record.stderr.lineCount,
  };
  if (record.output) {
    meta.output_path = record.output.path;
    meta.output_incomplete = Boolean(record.output.incomplete);
    if (record.output.incomplete) {
      meta.output_error = record.output.incomplete;
    }
  }
  if (record.persistence_error) {
    meta.persistence_error = record.persistence_error;
  }
  let recordsSize = 0;
  if (record.output) {
    try {
      recordsSize = statSync(record.output.recordsPath).size;
    } catch {
      recordsSize = 0;
    }
  }
  const data: Record<string, unknown> = {
    ...taskSnapshot(record),
    return_reason: returnReason,
    stdout,
    stderr,
    next_cursor: encodeCursor(record.task_id, recordsSize),
    start_cursor: encodeCursor(record.task_id, 0),
  };
  return [data, meta];
}

function notFoundResult(taskId: string): ToolExecutionResult {
  return {
    status: "error",
    result_str: "",
    error_type: "NotFound",
    error_msg: `Task ${taskId} is no longer managed by this Worker (or belongs to another session). The command will not be restarted.`,
  };
}

function errorResult(exc: unknown): ToolExecutionResult {
  const err = exc instanceof Error ? exc : new Error(String(exc));
  return {
    status: "error",
    result_str: "",
    error_msg: err.message,
    error_type: err.name || "Error",
  };
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function terminateProcessTree(proc: ChildProcess, graceMs: number): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null && !isProcessGroupAlive(pid)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

function killProcessTreeNow(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {}
  } else {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {}
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
}

export class ProcessSupervisor {
  static readonly TERMINATION_GRACE_SECONDS = 1.0;

  readonly maxTotalTasks: number;
  readonly maxTasks: number;
  readonly journal: TaskJournal | null;
  private readonly processes = new Map<string, ProcessRecord>();
  private readonly origins = new Map<string, string>();
  private closed = false;
  private readonly closedSessions = new Set<string>();
  private observer: ((event: Record<string, unknown>) => void) | null = null;

  constructor(options?: { maxTasks?: number; maxTotalTasks?: number; journal?: TaskJournal | null }) {
    this.maxTasks = options?.maxTasks ?? 8;
    this.maxTotalTasks = options?.maxTotalTasks ?? 32;
    this.journal = options?.journal ?? null;
  }

  setObserver(observer: ((event: Record<string, unknown>) => void) | null): void {
    this.observer = observer;
  }

  async run(
    command: string,
    state: ShellState,
    sessionId: string,
    cancellationToken?: CancellationToken | null,
    options?: {
      callId?: string;
      outputStore?: ToolOutputStore | null;
      yieldTimeMs?: number;
      timeoutMs?: number | null;
      notify?: string;
      originTurnId?: string;
      requestId?: string | null;
    },
  ): Promise<ToolExecutionResult> {
    const callId = options?.callId ?? "";
    const outputStore = options?.outputStore ?? null;
    const yieldTimeMs = options?.yieldTimeMs ?? 10000;
    const timeoutMs = options?.timeoutMs ?? null;
    const notify = options?.notify ?? "on_exit";
    const originTurnId = options?.originTurnId ?? "";
    const requestId = options?.requestId ?? null;

    for (const pending of Array.from(this.processes.values())) {
      if (pending.persistence_error && !(await this.save(pending))) {
        return {
          status: "error",
          result_str: "",
          error_type: "TaskPersistenceError",
          error_msg: pending.persistence_error,
        };
      }
    }
    this.retireFinished();
    const originKey = `${sessionId}\0${callId}`;
    const existingId = callId ? this.origins.get(originKey) : undefined;
    if (existingId) {
      const existing = this.processes.get(existingId);
      if (existing) {
        await existing.started.wait();
        return await this.buildResult(
          "bash",
          existing,
          existing.finished.isSet() ? "finished" : "yield_timeout",
        );
      }
    }
    if (this.closed || this.closedSessions.has(sessionId)) {
      return errorResult(new Error("Worker is shutting down."));
    }
    let sessionRunning = 0;
    let totalRunning = 0;
    for (const r of this.processes.values()) {
      if (!TERMINAL_STATES.has(r.status)) {
        totalRunning += 1;
        if (r.session_id === sessionId) sessionRunning += 1;
      }
    }
    if (sessionRunning >= this.maxTasks) {
      return {
        status: "error",
        result_str: "",
        error_type: "TaskLimitExceeded",
        error_msg: `Running task limit reached (${this.maxTasks}).`,
      };
    }
    if (totalRunning >= this.maxTotalTasks) {
      return {
        status: "error",
        result_str: "",
        error_type: "TaskLimitExceeded",
        error_msg: `Global running task limit reached (${this.maxTotalTasks}).`,
      };
    }

    const record: ProcessRecord = {
      task_id: `task_${randomUUID().replace(/-/g, "")}`,
      session_id: sessionId,
      command,
      cwd: state.cwd,
      shell_backend: state.shell_backend,
      shell_executable: state.shell_executable,
      call_id: callId,
      origin_turn_id: originTurnId,
      request_id: requestId,
      notify,
      process: null,
      spawned_at: 0,
      persistence_error: "",
      status: "starting",
      reason: "",
      started_at: Date.now() / 1000,
      finished_at: null,
      stdout: new StreamCapture(),
      stderr: new StreamCapture(),
      exit_code: null,
      last_output_event_at: 0,
      finished: new AsyncEvent(),
      started: new AsyncEvent(),
      waiters: new Set(),
      saveChain: Promise.resolve(),
      handed_off: false,
      readersPromise: null,
      monitorPromise: null,
      deadlineTimer: null,
      output: null,
      termination_status: null,
    };
    this.processes.set(record.task_id, record);
    if (callId) {
      this.origins.set(originKey, record.task_id);
    }
    let intentSaved = false;
    try {
      if (this.journal) {
        const intent = await this.journal.save(
          sessionId,
          {
            ...taskSnapshot(record),
            worker_instance_id: this.journal.worker_instance_id,
            committed: false,
            delivered: false,
          },
          { create: true },
        );
        intentSaved = true;
        if (intent.task_id !== record.task_id) {
          this.processes.delete(record.task_id);
          if (callId) this.origins.delete(originKey);
          record.started.set();
          return ProcessSupervisor.storedResult("bash", intent);
        }
      }
      if (outputStore !== null) {
        record.output = new TaskOutput(outputStore.pathFor(sessionId, record.task_id), record.task_id);
        await record.output.start();
      }
      await this.spawnProcess(record, command, state, timeoutMs);
      if (!(await this.save(record))) {
        throw new Error(record.persistence_error);
      }
      const elapsedMs = performance.now() - record.spawned_at;
      const remainingMs = Math.max(0, yieldTimeMs - elapsedMs);
      const reason = record.handed_off
        ? "released"
        : await this.waitRecord(record, remainingMs, cancellationToken);
      if (reason === "interrupted" && !record.handed_off) {
        await this.terminateRecord(
          record,
          "cancelled",
          cancellationToken?.reason || "User interrupted",
        );
      }
      record.handed_off = record.handed_off || !record.finished.isSet();
      const result = await this.buildResult("bash", record, reason);
      await this.save(record);
      return result;
    } catch (exc) {
      if (record.process !== null) {
        await this.terminateRecord(record, "failed", (exc as Error).message || String(exc));
        return await this.buildResult(
          "bash",
          record,
          record.finished.isSet() ? "finished" : "interrupted",
        );
      } else {
        record.status = "failed";
        record.reason = (exc as Error).message || String(exc);
        record.finished_at = Date.now() / 1000;
        record.finished.set();
        if (record.output) {
          await record.output.close();
        }
        if (intentSaved) {
          await this.save(record);
        }
      }
      if (!intentSaved) {
        this.processes.delete(record.task_id);
        if (callId) this.origins.delete(originKey);
      }
      return errorResult(exc);
    } finally {
      record.started.set();
    }
  }

  private async spawnProcess(
    record: ProcessRecord,
    command: string,
    state: ShellState,
    timeoutMs: number | null,
  ): Promise<void> {
    const cmdArgs = this.buildShellCmd(command, state);
    const proc = spawn(cmdArgs[0]!, cmdArgs.slice(1), {
      cwd: state.cwd,
      env: state.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        proc.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        proc.removeListener("spawn", onSpawn);
        reject(err);
      };
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    });

    record.process = proc;
    record.started_at = Date.now() / 1000;
    record.spawned_at = performance.now();
    record.status = "running";

    const stdoutReader = this.readStream(proc.stdout, record.stdout, record, "stdout");
    const stderrReader = this.readStream(proc.stderr, record.stderr, record, "stderr");
    record.readersPromise = Promise.allSettled([stdoutReader, stderrReader]).then(() => {});
    record.monitorPromise = this.monitorRecord(record);

    if (timeoutMs !== null) {
      const delayMs = Math.max(0, timeoutMs - (performance.now() - record.spawned_at));
      record.deadlineTimer = setTimeout(() => {
        void this.terminateRecord(
          record,
          "timed_out",
          `Runtime deadline exceeded (${timeoutMs} ms)`,
        );
      }, delayMs);
    }
    record.started.set();
  }

  async control(
    action: string,
    sessionId: string,
    taskId?: string | null,
    options?: {
      waitMs?: number;
      maxOutputChars?: number;
      cancellationToken?: CancellationToken | null;
      pageToken?: string | null;
      cursor?: string | null;
    },
  ): Promise<ToolExecutionResult> {
    const waitMs = options?.waitMs ?? 30000;
    const maxOutputChars = options?.maxOutputChars ?? 20000;
    const cancellationToken = options?.cancellationToken ?? null;
    const pageToken = options?.pageToken ?? null;
    const cursor = options?.cursor ?? null;

    this.retireFinished();
    if (action === "list") {
      const stored = this.journal ? await this.journal.records(sessionId) : {};
      const merged: Record<string, Record<string, unknown>> = { ...stored };
      for (const r of this.processes.values()) {
        if (r.session_id === sessionId) {
          merged[r.task_id] = taskSnapshot(r);
        }
      }
      const records = Object.values(merged).sort((a, b) => {
        const aTerm = TERMINAL_STATES.has(String(a.status ?? "")) ? 1 : 0;
        const bTerm = TERMINAL_STATES.has(String(b.status ?? "")) ? 1 : 0;
        if (aTerm !== bTerm) return aTerm - bTerm;
        const aStart = Number(a.started_at ?? 0);
        const bStart = Number(b.started_at ?? 0);
        if (bStart !== aStart) return bStart - aStart;
        return String(a.task_id ?? "").localeCompare(String(b.task_id ?? ""));
      });
      const offset = Number(pageToken || 0);
      const page: Record<string, unknown>[] = [];
      let pageBytes = 0;
      for (const rec of records.slice(offset, offset + 50)) {
        const item: Record<string, unknown> = {
          task_id: rec.task_id ?? null,
          status: rec.status ?? null,
          handoff: Boolean(rec.handoff),
          notify: rec.notify ?? null,
          command: String(rec.command || "").slice(0, 160),
          started_at: rec.started_at ?? null,
          finished_at: rec.finished_at ?? null,
          elapsed_ms: rec.elapsed_ms ?? null,
          origin_tool_call_id: rec.origin_tool_call_id ?? null,
        };
        const size = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (page.length > 0 && pageBytes + size > 20000) {
          break;
        }
        page.push(item);
        pageBytes += size;
      }
      return {
        status: "ok",
        result_str: toolOk("task_control", {
          tasks: page,
          next_page_token: offset + page.length < records.length ? String(offset + page.length) : null,
        }),
      };
    }

    const record = taskId ? this.processes.get(taskId) : undefined;
    if (!record || record.session_id !== sessionId) {
      const snapshot = this.journal && taskId ? await this.journal.get(sessionId, taskId) : null;
      if (snapshot !== null) {
        if (action === "cancel" && !TERMINAL_STATES.has(String(snapshot.status ?? ""))) {
          return {
            status: "error",
            result_str: "",
            error_type: "TaskNotOwned",
            error_msg: "Task belongs to another active Worker; no process was signalled.",
          };
        }
        return await this.readStored(snapshot, cursor, maxOutputChars);
      }
      return notFoundResult(taskId || "");
    }
    let reason = record.finished.isSet() ? "finished" : "yield_timeout";
    if (action === "cancel") {
      await record.started.wait();
      await this.terminateRecord(record, "cancelled", "Explicit task cancellation");
      reason = record.finished.isSet() ? "finished" : "yield_timeout";
    } else if (action === "wait") {
      reason = await this.waitRecord(record, waitMs, cancellationToken);
    }
    return await this.buildResult("task_control", record, reason, maxOutputChars, cursor);
  }

  async monitorTasks(sessionId: string, pageToken?: string | null): Promise<Record<string, unknown>> {
    this.retireFinished();
    const stored = this.journal ? await this.journal.relevant(sessionId) : {};
    const records: Record<string, Record<string, unknown>> = { ...stored };
    for (const record of this.processes.values()) {
      if (
        record.session_id === sessionId &&
        (record.task_id in stored ||
          Boolean(record.persistence_error) ||
          !this.journal ||
          !TERMINAL_STATES.has(record.status))
      ) {
        const extra: Record<string, unknown> = {};
        const prev = stored[record.task_id];
        if (prev) {
          for (const key of ["delivered", "consumed", "committed"]) {
            if (key in prev) extra[key] = prev[key];
          }
        }
        records[record.task_id] = { ...taskSnapshot(record), ...extra };
      }
    }
    const visible = Object.values(records).filter(
      r => !TERMINAL_STATES.has(String(r.status ?? "")) || (Boolean(r.handoff) && !r.delivered),
    );
    visible.sort((a, b) => {
      const aTerm = TERMINAL_STATES.has(String(a.status ?? "")) ? 1 : 0;
      const bTerm = TERMINAL_STATES.has(String(b.status ?? "")) ? 1 : 0;
      if (aTerm !== bTerm) return aTerm - bTerm;
      const aStart = Number(a.started_at ?? 0);
      const bStart = Number(b.started_at ?? 0);
      if (bStart !== aStart) return bStart - aStart;
      return String(a.task_id ?? "").localeCompare(String(b.task_id ?? ""));
    });
    const offset = Number(pageToken || 0);
    return {
      tasks: visible.slice(offset, offset + 50).map(r => publicTask(r)),
      next_page_token: offset + 50 < visible.length ? String(offset + 50) : null,
    };
  }

  private async buildResult(
    tool: string,
    record: ProcessRecord,
    reason: string,
    maxChars = 20000,
    cursor?: string | null,
  ): Promise<ToolExecutionResult> {
    if (record.output) {
      await record.output.flush();
    }
    const [data, meta] = taskPayload(record, reason, maxChars);
    if (cursor !== null && cursor !== undefined) {
      if (!record.output) {
        throw new Error("This task has no stored output.");
      }
      const page = await record.output.read(cursor, maxChars);
      for (const [k, v] of Object.entries(page)) {
        if (k === "truncated" || k === "output_incomplete" || k === "output_error") {
          meta[k] = v;
        } else {
          data[k] = v;
        }
      }
    }
    return {
      status: "ok",
      result_str: toolOk(tool, data, meta),
    };
  }

  private async save(record: ProcessRecord, changes?: Record<string, unknown>): Promise<boolean> {
    if (!this.journal) return true;
    let ok = true;
    const runSave = async (): Promise<void> => {
      if (!this.journal) return;
      if (record.output) {
        await record.output.flush();
      }
      const [data, meta] = taskPayload(
        record,
        TERMINAL_STATES.has(record.status) ? "finished" : "yield_timeout",
      );
      const snapshot: Record<string, unknown> = {
        ...data,
        meta,
        ...(changes || {}),
      };
      if (record.process?.pid) {
        snapshot.pid = record.process.pid;
      }
      if (TERMINAL_STATES.has(record.status)) {
        snapshot.event_id = `${record.task_id}:1`;
      }
      try {
        const saved = await this.journal.save(record.session_id, snapshot);
        record.persistence_error = "";
        if (this.observer) {
          this.observer(saved);
        }
      } catch (exc) {
        record.persistence_error = `Task journal write failed: ${(exc as Error).message || String(exc)}`;
        ok = false;
      }
    };
    record.saveChain = record.saveChain.then(runSave, runSave);
    await record.saveChain;
    return ok;
  }

  private static storedResult(tool: string, snapshot: Record<string, unknown>): ToolExecutionResult {
    const pub = publicTask(snapshot);
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pub)) {
      if (k !== "meta") data[k] = v;
    }
    const meta =
      snapshot.meta && typeof snapshot.meta === "object"
        ? (snapshot.meta as Record<string, unknown>)
        : {};
    return {
      status: "ok",
      result_str: toolOk(tool, data, meta),
    };
  }

  private retireFinished(): void {
    if (!this.journal) return;
    for (const [taskId, record] of Array.from(this.processes.entries())) {
      if (
        record.finished.isSet() &&
        !record.persistence_error &&
        !(record.process !== null && record.status === "lost")
      ) {
        this.processes.delete(taskId);
        if (record.call_id) {
          this.origins.delete(`${record.session_id}\0${record.call_id}`);
        }
      }
    }
  }

  private async readStored(
    rawSnapshot: Record<string, unknown>,
    cursor: string | null,
    maxChars: number,
  ): Promise<ToolExecutionResult> {
    const snapshot: Record<string, unknown> = { ...rawSnapshot };
    const existingMeta =
      snapshot.meta && typeof snapshot.meta === "object"
        ? { ...(snapshot.meta as Record<string, unknown>) }
        : {};
    if (cursor === null) {
      const rawStdout = String(snapshot.stdout ?? "");
      const rawStderr = String(snapshot.stderr ?? "");
      const [stdout, stderr] = outputPreview(rawStdout, rawStderr, maxChars);
      existingMeta.truncated =
        Boolean(existingMeta.truncated) || rawStdout.length + rawStderr.length > maxChars;
      snapshot.meta = existingMeta;
      snapshot.stdout = stdout;
      snapshot.stderr = stderr;
    } else {
      const outputPath = existingMeta.output_path;
      if (typeof outputPath !== "string" || !outputPath) {
        throw new Error("This task has no stored output.");
      }
      const jsonlPath = outputPath.replace(/\.[^.]+$/, ".jsonl");
      const page = readOutputPage(jsonlPath, String(snapshot.task_id ?? ""), cursor, maxChars);
      for (const [k, v] of Object.entries(page)) {
        if (k === "truncated" || k === "output_incomplete" || k === "output_error") {
          existingMeta[k] = v;
        } else {
          snapshot[k] = v;
        }
      }
      snapshot.meta = existingMeta;
    }
    return ProcessSupervisor.storedResult("task_control", snapshot);
  }

  releaseWait(sessionId: string, taskId?: string | null, callId?: string | null): boolean {
    let released = false;
    for (const record of this.processes.values()) {
      if (
        record.session_id !== sessionId ||
        (taskId && record.task_id !== taskId) ||
        (callId && record.call_id !== callId)
      ) {
        continue;
      }
      if (!record.handed_off && !TERMINAL_STATES.has(record.status)) {
        record.handed_off = true;
        released = true;
      }
      if (!TERMINAL_STATES.has(record.status)) {
        for (const waiter of record.waiters) {
          record.handed_off = true;
          waiter.set();
          released = true;
        }
      }
    }
    return released;
  }

  stopAccepting(): void {
    this.closed = true;
  }

  async closeRequest(sessionId: string, requestId: string, reason = "Request interrupted"): Promise<void> {
    const records = Array.from(this.processes.values()).filter(
      r => r.session_id === sessionId && r.request_id === requestId && !TERMINAL_STATES.has(r.status),
    );
    if (records.length > 0) {
      await this.closeRecords(records, reason);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.add(sessionId);
    const records = Array.from(this.processes.values()).filter(r => r.session_id === sessionId);
    await this.closeRecords(records, "Session closed");
    for (const record of records) {
      if (!record.persistence_error) {
        this.processes.delete(record.task_id);
        if (record.call_id) {
          this.origins.delete(`${sessionId}\0${record.call_id}`);
        }
      }
    }
    if (this.journal) {
      this.journal.forget_session(sessionId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeRecords(Array.from(this.processes.values()), "Worker shutting down");
    if (this.journal) {
      await this.journal.close();
    }
  }

  private async closeRecords(records: ProcessRecord[], reason: string): Promise<void> {
    const closeOne = async (record: ProcessRecord): Promise<void> => {
      await record.started.wait();
      await this.terminateRecord(record, "cancelled", reason);
      if (
        !record.finished.isSet() ||
        (record.process !== null &&
          (record.process.exitCode === null && record.process.signalCode === null ||
            record.status === "lost"))
      ) {
        throw new Error(`Termination of ${record.task_id} is not confirmed: ${record.reason}`);
      }
      if (record.monitorPromise) {
        await record.monitorPromise;
      }
    };
    const results = await Promise.allSettled(records.map(r => closeOne(r)));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map(r => r.reason);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Process cleanup failed: ${errors.map(e => (e as Error)?.message || String(e)).join("; ")}`,
      );
    }
  }

  closeNow(): void {
    this.closed = true;
    for (const record of this.processes.values()) {
      if (record.process && !record.finished.isSet()) {
        killProcessTreeNow(record.process);
      }
    }
    if (this.journal) {
      this.journal.close_now();
    }
  }

  private async monitorRecord(record: ProcessRecord): Promise<void> {
    let failureStatus: string | null = null;
    try {
      const proc = record.process!;
      const exitCode = await new Promise<number>(resolve => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        if (proc.signalCode !== null) {
          resolve(-1);
          return;
        }
        proc.once("exit", (code, signal) => {
          resolve(code ?? (signal ? -1 : 0));
        });
      });
      record.exit_code = exitCode;
      await terminateProcessTree(proc, ProcessSupervisor.TERMINATION_GRACE_SECONDS * 1000);
    } catch (exc) {
      failureStatus = "lost";
      record.reason = `Process cleanup failed: ${(exc as Error).message || String(exc)}`;
    } finally {
      await this.settleReaders(record);
      if (record.output) {
        await record.output.close();
      }
      record.status =
        failureStatus ||
        record.termination_status ||
        (record.exit_code === 0 ? "completed" : "failed");
      record.finished_at = Date.now() / 1000;
      await this.save(record);
      record.finished.set();
      if (record.deadlineTimer) {
        clearTimeout(record.deadlineTimer);
        record.deadlineTimer = null;
      }
    }
  }

  private async readStream(
    stream: NodeJS.ReadableStream | null,
    capture: StreamCapture,
    record: ProcessRecord,
    streamName: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    try {
      for await (const chunk of stream) {
        const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const text = decoder.write(raw);
        capture.append(raw, text);
        if (record.output) {
          await record.output.append(streamName, raw, text);
        }
        const now = performance.now();
        if (this.observer && now - record.last_output_event_at >= 100) {
          record.last_output_event_at = now;
          this.observer({
            ...taskSnapshot(record),
            type: "task_output",
            stdout: record.stdout.tailPreview(2000),
            stderr: record.stderr.tailPreview(2000),
          });
        }
      }
      const rem = decoder.end();
      capture.append(Buffer.alloc(0), rem);
      if (rem && record.output) {
        await record.output.append(streamName, Buffer.alloc(0), rem);
      }
    } catch {}
  }

  private async settleReaders(record: ProcessRecord): Promise<void> {
    if (!record.readersPromise) return;
    let timedOut = false;
    await Promise.race([
      record.readersPromise,
      new Promise<void>(resolve => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, ProcessSupervisor.TERMINATION_GRACE_SECONDS * 1000);
      }),
    ]);
    if (timedOut) {
      if (record.output) {
        record.output.incomplete =
          record.output.incomplete || "Output pipe could not be fully drained.";
      }
      record.process?.stdout?.destroy();
      record.process?.stderr?.destroy();
    }
  }

  private async waitRecord(
    record: ProcessRecord,
    waitMs: number,
    cancellationToken?: CancellationToken | null,
  ): Promise<string> {
    if (cancellationToken?.isCancelled) {
      return "interrupted";
    }
    if (record.finished.isSet()) {
      return "finished";
    }
    const release = new AsyncEvent();
    record.waiters.add(release);
    try {
      return await new Promise<string>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let onAbort: (() => void) | null = null;

        const finish = (outcome: string): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (onAbort && cancellationToken) {
            cancellationToken.signal.removeEventListener("abort", onAbort);
          }
          resolve(outcome);
        };

        if (cancellationToken) {
          if (cancellationToken.isCancelled) {
            finish("interrupted");
            return;
          }
          onAbort = () => finish("interrupted");
          cancellationToken.signal.addEventListener("abort", onAbort, { once: true });
        }
        void record.finished.wait().then(() => finish("finished"));
        void release.wait().then(() => finish("released"));
        timer = setTimeout(() => finish("yield_timeout"), Math.max(0, waitMs));
      });
    } finally {
      record.waiters.delete(release);
    }
  }

  private async terminateRecord(record: ProcessRecord, status: string, reason: string): Promise<void> {
    if (record.finished.isSet() || record.process === null) return;
    if (
      !TERMINAL_STATES.has(record.status) &&
      record.process.exitCode === null &&
      record.process.signalCode === null
    ) {
      if (record.termination_status === null) {
        record.status = "cancelling";
        record.reason = reason;
        record.termination_status = status;
        await this.save(record);
      }
      await terminateProcessTree(
        record.process,
        ProcessSupervisor.TERMINATION_GRACE_SECONDS * 1000,
      );
    }
    const confirmed = await Promise.race([
      record.finished.wait().then(() => true),
      new Promise<boolean>(resolve =>
        setTimeout(() => resolve(false), ProcessSupervisor.TERMINATION_GRACE_SECONDS * 2000),
      ),
    ]);
    if (!confirmed) {
      record.reason = `Termination not confirmed: ${reason}`;
      await this.save(record);
    }
  }

  private buildShellCmd(command: string, state: ShellState): string[] {
    if (!state.shell_executable) {
      throw new Error(state.shell_error || "Shell executable is not configured.");
    }
    if (state.shell_backend === "powershell") {
      return [
        state.shell_executable,
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ];
    }
    return [state.shell_executable, "-c", command];
  }
}

export function integer(value: unknown, name: string, minimum: number, maximum?: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      `${name} must be an integer in ${minimum}..${maximum !== undefined ? maximum : "unlimited"}.`,
    );
  }
  return value;
}

function unwrap(result: ToolExecutionResult, tool: string): string {
  return result.status === "ok"
    ? result.result_str
    : toolError(tool, result.error_msg || "Unknown error", result.error_type || "Error");
}

export class ShellTools {
  readonly pool: ShellSessionPool;
  readonly supervisor: ProcessSupervisor;
  readonly outputStore: ToolOutputStore;

  constructor(outputStore?: ToolOutputStore | null) {
    const resolvedOutputStore = outputStore ?? new ToolOutputStore();
    this.pool = new ShellSessionPool();
    this.supervisor = new ProcessSupervisor({
      journal: new TaskJournal(resolvedOutputStore.sessionRoot),
    });
    this.outputStore = resolvedOutputStore;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.supervisor.closeSession(sessionId);
    this.pool.close(sessionId);
  }

  async close(): Promise<void> {
    await this.supervisor.close();
    this.pool.clear();
  }

  closeNow(): void {
    this.supervisor.closeNow();
    this.pool.clear();
  }

  async bash(
    command: string,
    cwd: string | null = null,
    yieldTimeMs = 10000,
    timeoutMs: number | null = null,
    notify = "on_exit",
    options?: {
      _session_id?: string;
      _cancellation_token?: CancellationToken | null;
      _workspace_root?: string | null;
      _idempotency_key?: string;
      _output_store?: ToolOutputStore | null;
      _origin_turn_id?: string;
      _request_id?: string | null;
    },
  ): Promise<string> {
    const sessionId = options?._session_id ?? "default";
    let state: ShellState;
    try {
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("command must be a nonempty string.");
      }
      integer(yieldTimeMs, "yield_time_ms", 0, 60000);
      if (timeoutMs !== null && timeoutMs !== undefined) {
        integer(timeoutMs, "timeout_ms", 1);
      }
      if (notify !== "on_exit" && notify !== "manual") {
        throw new Error("notify must be on_exit or manual.");
      }
      state = this.pool.getState(sessionId, options?._workspace_root);
      if (cwd !== null && cwd !== undefined) {
        if (typeof cwd !== "string" || !cwd.trim()) {
          throw new Error("cwd must be a nonempty path.");
        }
        const target = path.resolve(state.cwd, cwd);
        let isDir = false;
        try {
          isDir = statSync(target).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          throw new Error("cwd must be an existing directory.");
        }
        state = { ...state, cwd: target };
      }
    } catch (exc) {
      return toolError("bash", (exc as Error).message, "InvalidArguments");
    }
    const [status, reason] = BashPolicy.classify(command, state.shell_backend);
    if (status === "deny") {
      return toolError("bash", `Blocked forbidden command. ${reason}`, "DangerousCommandBlocked");
    }
    const result = await this.supervisor.run(
      command,
      state,
      sessionId,
      options?._cancellation_token ?? null,
      {
        callId: options?._idempotency_key ?? "",
        outputStore: options?._output_store ?? this.outputStore,
        yieldTimeMs,
        timeoutMs: timeoutMs ?? null,
        notify,
        originTurnId: options?._origin_turn_id ?? "",
        requestId: options?._request_id ?? null,
      },
    );
    return unwrap(result, "bash");
  }

  async taskControl(
    action: string,
    taskId: string | null = null,
    cursor: string | null = null,
    waitMs: number | null = null,
    maxOutputChars = 20000,
    pageToken: string | null = null,
    options?: {
      _session_id?: string;
      _cancellation_token?: CancellationToken | null;
    },
  ): Promise<string> {
    const sessionId = options?._session_id ?? "default";
    try {
      if (!["list", "read", "wait", "cancel"].includes(action)) {
        throw new Error("action must be list, read, wait or cancel.");
      }
      integer(maxOutputChars, "max_output_chars", 1, 50000);
      if (action === "list") {
        if (taskId !== null || cursor !== null || waitMs !== null) {
          throw new Error("list does not accept task_id, cursor or wait_ms.");
        }
        if (pageToken !== null && (typeof pageToken !== "string" || !/^\d+$/.test(pageToken))) {
          throw new Error("Invalid page_token.");
        }
      } else {
        if (typeof taskId !== "string" || !taskId) {
          throw new Error("task_id is required.");
        }
        if (pageToken !== null) {
          throw new Error("page_token is only valid for list.");
        }
        if (action !== "wait" && waitMs !== null) {
          throw new Error("wait_ms is only valid for wait.");
        }
        if (action === "cancel" && cursor !== null) {
          throw new Error("cancel does not accept cursor.");
        }
      }
      if (waitMs !== null) {
        integer(waitMs, "wait_ms", 1000, 60000);
      }
      const result = await this.supervisor.control(action, sessionId, taskId, {
        waitMs: waitMs ?? 30000,
        maxOutputChars,
        cancellationToken: options?._cancellation_token ?? null,
        pageToken,
        cursor,
      });
      return unwrap(result, "task_control");
    } catch (exc) {
      return toolError("task_control", (exc as Error).message, "InvalidArguments");
    }
  }

  async bashOutput(
    bgId: string,
    kill = false,
    waitMs = 15000,
    maxOutputChars = 20000,
    options?: {
      _session_id?: string;
      _cancellation_token?: CancellationToken | null;
    },
  ): Promise<string> {
    if (typeof kill !== "boolean") {
      return toolError("bash_output", "kill must be boolean.", "InvalidArguments");
    }
    const raw = await this.taskControl(
      kill ? "cancel" : "wait",
      bgId,
      null,
      kill ? null : Math.max(1000, Math.min(integer(waitMs, "wait_ms", 0), 60000)),
      maxOutputChars,
      null,
      options,
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.tool = "bash_output";
    return JSON.stringify(parsed);
  }

  async listBackgrounds(sessionId = "default"): Promise<Record<string, unknown>[]> {
    const raw = await this.taskControl("list", null, null, null, 20000, null, {
      _session_id: sessionId,
    });
    const payload = JSON.parse(raw) as { data: { tasks: Record<string, unknown>[] } };
    return payload.data.tasks.map(task => ({ ...task, bg_id: task.task_id }));
  }

  async monitorTasks(sessionId: string, pageToken?: string | null): Promise<Record<string, unknown>> {
    return await this.supervisor.monitorTasks(sessionId, pageToken);
  }

  async maintainTasks(sessionId: string): Promise<void> {
    if (this.supervisor.journal) {
      await this.supervisor.journal.maintain(sessionId);
    }
  }

  async snapshotBackground(
    bgId: string,
    maxOutputChars = 20000,
    sessionId = "default",
  ): Promise<Record<string, unknown>> {
    const raw = await this.taskControl("read", bgId, null, null, maxOutputChars, null, {
      _session_id: sessionId,
    });
    const payload = JSON.parse(raw) as {
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    if (!payload.ok) {
      throw new Error(payload.error || `Task ${bgId} not found`);
    }
    return { ...(payload.data || {}), ...(payload.meta || {}), bg_id: bgId };
  }
}

export function normalizeBashArguments(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args = { ...rawArgs };
  if ("run_in_background" in args || "wait_ms" in args) {
    if (
      "yield_time_ms" in args ||
      "timeout_ms" in args ||
      "notify" in args ||
      "cwd" in args
    ) {
      throw new Error("Do not combine legacy run_in_background/wait_ms with new bash parameters.");
    }
    const background = "run_in_background" in args ? args.run_in_background : false;
    delete args.run_in_background;
    if (typeof background !== "boolean") {
      throw new Error("run_in_background must be boolean.");
    }
    const wait = "wait_ms" in args ? args.wait_ms : 10000;
    delete args.wait_ms;
    args.yield_time_ms = background
      ? Math.max(0, Math.min(integer(wait, "wait_ms", 0), 60000))
      : 10000;
  }
  return args;
}

export function buildShellToolSpecs(
  shellTools: ShellTools,
  workspaceRoot?: string | null,
): ToolSpec[] {
  return [
    new ToolSpec({
      name: "bash",
      description:
        "Run a managed non-interactive shell command. Wait up to yield_time_ms (default 10000); the same process then continues under its task_id. timeout_ms is an optional runtime deadline; null means no deadline. notify=on_exit automatically delivers completion and continues an idle session unless interrupted/paused: do not repeatedly poll. Use notify=manual for servers/watchers, and an explicit port/HTTP check to verify readiness. cwd applies only to this command. Use task_control for output or cancellation. No interactive stdin or independent daemons; Worker shutdown stops owned tasks.",
      normalizeArguments: normalizeBashArguments,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          yield_time_ms: { type: "integer", default: 10000, minimum: 0, maximum: 60000 },
          timeout_ms: { type: ["integer", "null"], default: null, minimum: 1 },
          notify: { type: "string", default: "on_exit", enum: ["on_exit", "manual"] },
        },
        required: ["command"],
      },
      handler: async args =>
        await shellTools.bash(
          args.command as string,
          (args.cwd as string | null) ?? null,
          (args.yield_time_ms as number | undefined) ?? 10000,
          (args.timeout_ms as number | null | undefined) ?? null,
          (args.notify as string | undefined) ?? "on_exit",
          {
            _session_id: (args._session_id as string | undefined) ?? "default",
            _cancellation_token:
              (args._cancellation_token as CancellationToken | null | undefined) ?? null,
            _workspace_root: workspaceRoot ?? null,
            _idempotency_key: (args._idempotency_key as string | undefined) ?? "",
            _output_store: (args._output_store as ToolOutputStore | null | undefined) ?? null,
            _origin_turn_id: (args._origin_turn_id as string | undefined) ?? "",
            _request_id: (args._request_id as string | null | undefined) ?? null,
          },
        ),
    }),
    new ToolSpec({
      name: "task_control",
      description:
        "Control a task owned by this session. list returns up to 50 tasks; read returns immediately; wait observes completion for a bounded interval without killing the task; cancel explicitly terminates its process tree. Reads are repeatable; use next_cursor for sequential output. No interactive stdin.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read", "wait", "cancel"] },
          task_id: { type: "string" },
          cursor: {
            type: "string",
            description:
              "read/wait only. Omit for a bounded latest preview; start_cursor begins full stored output, next_cursor continues independently.",
          },
          wait_ms: {
            type: "integer",
            minimum: 1000,
            maximum: 60000,
            description: "wait only; defaults to 30000 (1000..60000).",
          },
          max_output_chars: { type: "integer", default: 20000, minimum: 1, maximum: 50000 },
          page_token: {
            type: "string",
            description: "list only; use next_page_token from the previous page.",
          },
        },
        required: ["action"],
      },
      handler: async args =>
        await shellTools.taskControl(
          args.action as string,
          (args.task_id as string | null | undefined) ?? null,
          (args.cursor as string | null | undefined) ?? null,
          (args.wait_ms as number | null | undefined) ?? null,
          (args.max_output_chars as number | undefined) ?? 20000,
          (args.page_token as string | null | undefined) ?? null,
          {
            _session_id: (args._session_id as string | undefined) ?? "default",
            _cancellation_token:
              (args._cancellation_token as CancellationToken | null | undefined) ?? null,
          },
        ),
    }),
    new ToolSpec({
      name: "bash_output",
      advertised: false,
      description:
        "Legacy recovery only: kill maps to cancel, otherwise wait. Unknown old bg_id values cannot be restarted.",
      parameters: {
        type: "object",
        properties: {
          bg_id: { type: "string" },
          kill: { type: "boolean", default: false },
          wait_ms: { type: "integer", default: 15000 },
          max_output_chars: { type: "integer", default: 20000 },
        },
        required: ["bg_id"],
      },
      handler: async args =>
        await shellTools.bashOutput(
          args.bg_id as string,
          (args.kill as boolean | undefined) ?? false,
          (args.wait_ms as number | undefined) ?? 15000,
          (args.max_output_chars as number | undefined) ?? 20000,
          {
            _session_id: (args._session_id as string | undefined) ?? "default",
            _cancellation_token:
              (args._cancellation_token as CancellationToken | null | undefined) ?? null,
          },
        ),
    }),
  ];
}
