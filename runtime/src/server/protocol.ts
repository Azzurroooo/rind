import fs from "node:fs";
import path from "node:path";
import type { ModelSelection } from "../domain/models.js";
import { LEGACY_IMAGE_NOTICE, hasLegacyImages } from "../infrastructure/images.js";
import { validateWorkspaceRoot } from "../infrastructure/paths.js";
import {
  INTERNAL_MESSAGE_KINDS,
  isCompactBoundaryMessage,
  projectToolReplayFields,
} from "../infrastructure/persistence/session-store.js";
import {
  type FolderSelection,
  loadSettings,
  normalizeReasoningEffort,
  saveSettings,
} from "../infrastructure/settings.js";

export const PROTOCOL_VERSION = "2";
export type RequestId = string | number;

export interface ErrorObject {
  type: string;
  message: string;
}

export interface ResponseEnvelope {
  kind: "response";
  request_id: RequestId | null;
  result?: unknown;
  error?: ErrorObject;
}

export interface EventEnvelope {
  kind: "event";
  method: "session/update";
  sequence: number;
  durability: "durable" | "incremental";
  session_id: string;
  turn_id: string;
  event: Record<string, unknown>;
}

export const RuntimeMethod = {
  INITIALIZE: "initialize",
  SHUTDOWN: "shutdown",
  SESSION_NEW: "session/new",
  SESSION_OPEN: "session/open",
  SESSION_LIST: "session/list",
  SESSION_SWITCH: "session/switch",
  SESSION_FORK: "session/fork",
  SESSION_REPLAY: "session/replay",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_SUBSCRIBE: "session/subscribe",
  SESSION_UNSUBSCRIBE: "session/unsubscribe",
  SESSION_DELETE: "session/delete",
  PING: "ping",
  FILE_LIST: "file/list",
  FILE_READ: "file/read",
  FILE_WRITE: "file/write",
  MODEL_LIST: "model/list",
  MODEL_SET: "model/set",
  MODEL_EFFORT: "model/effort",
  RIND_AUTH_LIST: "rind/auth/list",
  RIND_AUTH_LOGIN: "rind/auth/login",
  RIND_AUTH_LOGOUT: "rind/auth/logout",
  RIND_AUTH_PROMPT: "rind/auth/prompt",
  RIND_AUTH_UPDATE: "rind/auth/update",
  RIND_SESSION_STEER: "rind/session/steer",
  RIND_SESSION_FOLLOW_UP: "rind/session/follow_up",
  RIND_SESSION_DELIVER: "rind/session/deliver",
  RIND_SESSION_PROMOTE_FOLLOW_UP: "rind/session/promote_follow_up",
  RIND_SESSION_UNSTEER: "rind/session/unsteer",
  RIND_SESSION_DEQUEUE_FOLLOW_UP: "rind/session/dequeue_follow_up",
  RIND_SESSION_COMPACT: "rind/session/compact",
  SESSION_CREATE: "session/create",
  RIND_COMMAND_EXECUTE: "rind/command/execute",
  RIND_USER_QUESTION_RESPOND: "rind/user-question/respond",
  RIND_BACKGROUND_LIST: "rind/background/list",
  RIND_BACKGROUND_OUTPUT: "rind/background/output",
  RIND_TASK_LIST: "rind/task/list",
  RIND_TASK_READ: "rind/task/read",
  RIND_TASK_WAIT: "rind/task/wait",
  RIND_TASK_CANCEL: "rind/task/cancel",
  RIND_TASK_RELEASE_WAIT: "rind/task/release_wait",
  RIND_GOAL_GET: "rind/goal/get",
  RIND_GOAL_SET: "rind/goal/set",
  RIND_GOAL_STATUS: "rind/goal/status",
  RIND_GOAL_CLEAR: "rind/goal/clear",
  RIND_CONTEXT_INSPECT: "rind/context/inspect",
  RIND_USAGE_SUMMARY: "rind/usage/summary",
  RIND_FOLDER_DEFAULTS_GET: "rind/folder_defaults/get",
  RIND_FOLDER_DEFAULTS_SET: "rind/folder_defaults/set",
  RIND_FOLDER_DEFAULTS_UNSET: "rind/folder_defaults/unset",
  RIND_FOLDER_DEFAULTS_APPLY: "rind/folder_defaults/apply",
  RIND_FOLDER_DEFAULTS_RESOLVE: "rind/folder_defaults/resolve",
  SESSION_UPDATE: "session/update",
} as const;

export type RuntimeMethodName = (typeof RuntimeMethod)[keyof typeof RuntimeMethod];

export const SESSION_SCOPED_METHODS: ReadonlySet<string> = new Set([
  RuntimeMethod.SESSION_PROMPT,
  RuntimeMethod.SESSION_REPLAY,
  RuntimeMethod.SESSION_SWITCH,
  RuntimeMethod.SESSION_FORK,
  RuntimeMethod.SESSION_CANCEL,
  RuntimeMethod.SESSION_SUBSCRIBE,
  RuntimeMethod.SESSION_UNSUBSCRIBE,
  RuntimeMethod.SESSION_DELETE,
  RuntimeMethod.MODEL_SET,
  RuntimeMethod.RIND_AUTH_LIST,
  RuntimeMethod.RIND_AUTH_LOGIN,
  RuntimeMethod.RIND_AUTH_LOGOUT,
  RuntimeMethod.RIND_SESSION_STEER,
  RuntimeMethod.RIND_SESSION_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_PROMOTE_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_UNSTEER,
  RuntimeMethod.RIND_SESSION_DEQUEUE_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_COMPACT,
  RuntimeMethod.RIND_COMMAND_EXECUTE,
  RuntimeMethod.RIND_USER_QUESTION_RESPOND,
  RuntimeMethod.RIND_BACKGROUND_LIST,
  RuntimeMethod.RIND_BACKGROUND_OUTPUT,
  RuntimeMethod.RIND_TASK_LIST,
  RuntimeMethod.RIND_TASK_READ,
  RuntimeMethod.RIND_TASK_WAIT,
  RuntimeMethod.RIND_TASK_CANCEL,
  RuntimeMethod.RIND_TASK_RELEASE_WAIT,
  RuntimeMethod.RIND_GOAL_GET,
  RuntimeMethod.RIND_GOAL_SET,
  RuntimeMethod.RIND_GOAL_STATUS,
  RuntimeMethod.RIND_GOAL_CLEAR,
  RuntimeMethod.RIND_CONTEXT_INSPECT,
]);

export const TURN_SCOPED_METHODS: ReadonlySet<string> = new Set([
  RuntimeMethod.SESSION_CANCEL,
  RuntimeMethod.RIND_SESSION_STEER,
]);

export const FOLDER_DEFAULT_METHODS: ReadonlySet<string> = new Set([
  RuntimeMethod.RIND_FOLDER_DEFAULTS_GET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_SET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_UNSET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_RESOLVE,
]);

export const CORE_METHODS: readonly string[] = [
  RuntimeMethod.INITIALIZE,
  RuntimeMethod.SHUTDOWN,
  RuntimeMethod.SESSION_NEW,
  RuntimeMethod.SESSION_LIST,
  RuntimeMethod.SESSION_SWITCH,
  RuntimeMethod.SESSION_FORK,
  RuntimeMethod.SESSION_REPLAY,
  RuntimeMethod.SESSION_PROMPT,
  RuntimeMethod.SESSION_CANCEL,
  RuntimeMethod.SESSION_SUBSCRIBE,
  RuntimeMethod.SESSION_UNSUBSCRIBE,
  RuntimeMethod.SESSION_DELETE,
  RuntimeMethod.PING,
  RuntimeMethod.FILE_LIST,
  RuntimeMethod.FILE_READ,
  RuntimeMethod.FILE_WRITE,
  RuntimeMethod.MODEL_LIST,
  RuntimeMethod.MODEL_SET,
  RuntimeMethod.MODEL_EFFORT,
  RuntimeMethod.RIND_AUTH_LIST,
  RuntimeMethod.RIND_AUTH_LOGIN,
  RuntimeMethod.RIND_AUTH_LOGOUT,
  RuntimeMethod.RIND_SESSION_STEER,
  RuntimeMethod.RIND_SESSION_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_PROMOTE_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_UNSTEER,
  RuntimeMethod.RIND_SESSION_DEQUEUE_FOLLOW_UP,
  RuntimeMethod.RIND_SESSION_COMPACT,
  RuntimeMethod.SESSION_CREATE,
  RuntimeMethod.RIND_COMMAND_EXECUTE,
  RuntimeMethod.RIND_USER_QUESTION_RESPOND,
  RuntimeMethod.RIND_CONTEXT_INSPECT,
  RuntimeMethod.RIND_USAGE_SUMMARY,
  RuntimeMethod.RIND_TASK_LIST,
  RuntimeMethod.RIND_TASK_READ,
  RuntimeMethod.RIND_TASK_WAIT,
  RuntimeMethod.RIND_TASK_CANCEL,
  RuntimeMethod.RIND_TASK_RELEASE_WAIT,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_GET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_SET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_UNSET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_APPLY,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_RESOLVE,
  RuntimeMethod.RIND_SESSION_DELIVER,
];

export const CAPABILITIES: readonly string[] = [
  "sessions",
  "models",
  "rind/commands",
  "rind/compaction",
  "rind/context",
  "rind/user-questions",
  "rind/steering",
  "rind/follow-up",
  "rind/input-retrieval",
  "rind/session-subscriptions",
  "rind/auth",
  "rind/files",
  "rind/tasks",
  "rind/request-completion",
];

export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_started",
  "context_compacted",
  "assistant_message_completed",
  "tool_requested",
  "tool_result",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "task_updated",
]);

export function eventDurability(event: Record<string, unknown>): "durable" | "incremental" {
  return DURABLE_EVENT_TYPES.has(String(event.type || "")) ? "durable" : "incremental";
}

export function eventEnvelope(event: Record<string, unknown>, sequence: number): EventEnvelope {
  return {
    kind: "event",
    method: RuntimeMethod.SESSION_UPDATE,
    sequence,
    durability: eventDurability(event),
    session_id: String(event.session_id || ""),
    turn_id: String(event.turn_id || ""),
    event,
  };
}

export function validateRequest(request: Record<string, unknown>): string | null {
  if (request.kind !== "request") {
    return 'kind must be "request".';
  }
  const requestId = request.request_id;
  if (typeof requestId === "boolean" || requestId === null || requestId === undefined) {
    return "request_id is required.";
  }
  if (typeof requestId === "string" && !requestId.trim()) {
    return "request_id must not be empty.";
  }
  if (typeof requestId !== "string" && typeof requestId !== "number") {
    return "request_id must be a string or number.";
  }
  const method = request.method;
  if (typeof method !== "string" || !method.trim()) {
    return "method is required.";
  }
  const params = request.params;
  if (params !== null && params !== undefined && (typeof params !== "object" || Array.isArray(params))) {
    return "params must be an object.";
  }
  return null;
}

export function responseMessage(request: Record<string, unknown>, result: unknown): ResponseEnvelope {
  const reqId = request.request_id;
  return {
    kind: "response",
    request_id: typeof reqId === "string" || typeof reqId === "number" ? reqId : null,
    result,
  };
}

export function errorMessage(
  request: Record<string, unknown>,
  message: string,
  errorType: string,
): ResponseEnvelope {
  const reqId = request.request_id;
  return {
    kind: "response",
    request_id: typeof reqId === "string" || typeof reqId === "number" ? reqId : null,
    error: { type: errorType, message },
  };
}

// --- Workspace Files (from agent/runtime/server/workspace_files.py) ---

export const FILE_LIMIT_BYTES = 8 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

export class FileMethodError extends Error {
  readonly error_type: string;
  readonly errorType: string;

  constructor(message: string, errorType: string) {
    super(message);
    this.name = "FileMethodError";
    this.error_type = errorType;
    this.errorType = errorType;
  }
}

export function mimeForSuffix(suffix: string): string {
  let key = suffix.toLowerCase();
  if (!key.startsWith(".")) {
    key = path.extname(key).toLowerCase();
  }
  return MIME_TYPES[key] || "application/octet-stream";
}

function isRelativeTo(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realpathSafe(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    const baseReal = fs.realpathSync(cur);
    return tail.length > 0 ? path.join(baseReal, ...tail) : baseReal;
  } catch {
    return path.resolve(p);
  }
}

export function resolveWorkspacePath(workspaceRoot: string, relPath: unknown): string {
  if (typeof relPath !== "string") {
    throw new FileMethodError("path must be a string.", "InvalidRequest");
  }
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new FileMethodError("path must be relative to the workspace.", "InvalidRequest");
  }
  const segments = relPath.split(/[/\\]+/).filter(Boolean);
  if (segments.includes("..")) {
    throw new FileMethodError("path must not contain '..' segments.", "InvalidRequest");
  }
  const root = path.resolve(workspaceRoot);
  const resolved = relPath ? path.resolve(root, relPath) : root;
  if (!isRelativeTo(resolved, root)) {
    throw new FileMethodError("path escapes the workspace.", "InvalidRequest");
  }
  const realRoot = realpathSafe(root);
  const realResolved = realpathSafe(resolved);
  if (!isRelativeTo(realResolved, realRoot)) {
    throw new FileMethodError("path escapes the workspace.", "InvalidRequest");
  }
  return resolved;
}

export function fileList(workspaceRoot: string, relPath: string): Record<string, unknown> {
  const resolved = resolveWorkspacePath(workspaceRoot, relPath);
  if (!fs.existsSync(resolved)) {
    throw new FileMethodError(`Directory not found: ${relPath}`, "NotFound");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new FileMethodError(`Directory not found: ${relPath}`, "NotFound");
  }
  if (!stat.isDirectory()) {
    throw new FileMethodError(`Not a directory: ${relPath}`, "InvalidRequest");
  }
  const names = fs.readdirSync(resolved).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: Array<{ name: string; type: "dir" | "file"; size: number }> = [];
  for (const name of names) {
    const child = path.join(resolved, name);
    let isDir = false;
    try {
      isDir = fs.statSync(child).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      entries.push({ name, type: "dir", size: 0 });
    } else {
      let size = 0;
      try {
        size = fs.statSync(child).size;
      } catch {
        size = 0;
      }
      entries.push({ name, type: "file", size });
    }
  }
  return { entries };
}

export function fileRead(workspaceRoot: string, relPath: string): Record<string, unknown> {
  const resolved = resolveWorkspacePath(workspaceRoot, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new FileMethodError(`File not found: ${relPath}`, "NotFound");
    }
    throw new FileMethodError(`Cannot read file: ${err.message}`, "InvalidRequest");
  }
  if (stat.isDirectory()) {
    throw new FileMethodError(`Not a file: ${relPath}`, "InvalidRequest");
  }
  if (stat.size > FILE_LIMIT_BYTES) {
    throw new FileMethodError(`File exceeds the ${FILE_LIMIT_BYTES} byte limit.`, "PayloadTooLarge");
  }
  const data = fs.readFileSync(resolved);
  return {
    content_base64: data.toString("base64"),
    mime: mimeForSuffix(path.extname(resolved)),
    size: stat.size,
  };
}

export function fileWrite(
  workspaceRoot: string,
  relPath: string,
  contentBase64: unknown,
): Record<string, unknown> {
  const resolved = resolveWorkspacePath(workspaceRoot, relPath);
  const uploadsRoot = path.join(path.resolve(workspaceRoot), "uploads");
  if (!isRelativeTo(resolved, uploadsRoot) || resolved === uploadsRoot) {
    throw new FileMethodError("file/write is restricted to the uploads/ directory.", "InvalidRequest");
  }
  const realUploads = realpathSafe(uploadsRoot);
  const realResolved = realpathSafe(resolved);
  if (!isRelativeTo(realResolved, realUploads) || realResolved === realUploads) {
    throw new FileMethodError("file/write is restricted to the uploads/ directory.", "InvalidRequest");
  }
  if (typeof contentBase64 !== "string") {
    throw new FileMethodError("content_base64 must be a string.", "InvalidRequest");
  }
  const cleanB64 = contentBase64.trim();
  if (cleanB64.length > 0 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanB64) || cleanB64.length % 4 !== 0)) {
    throw new FileMethodError("content_base64 is not valid base64.", "DecodeError");
  }
  const data = Buffer.from(cleanB64, "base64");
  if (data.length > FILE_LIMIT_BYTES) {
    throw new FileMethodError(`File exceeds the ${FILE_LIMIT_BYTES} byte limit.`, "PayloadTooLarge");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, data);
  return { path: relPath, size: data.length };
}

// --- Resume Preview (from agent/runtime/server/resume_preview.py) ---

export const DEFAULT_RESUME_PREVIEW_LIMIT = 6;
export const DEFAULT_RESUME_PREVIEW_CHARS = 180;
export const RESUME_VISIBLE_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

function previewText(content: string, limit: number): string {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function shortId(value?: string | null): string {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-4)}`;
}

export function resumeVisibleMessages(
  messages: readonly Record<string, unknown>[],
): Array<{ role: string; content: string }> {
  const visible: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "");
    const content = String(message.content || "");
    const metadata = message._rind_meta;
    if (
      metadata &&
      typeof metadata === "object" &&
      (metadata as Record<string, unknown>).kind === "skill_snapshot"
    ) {
      continue;
    }
    if (!RESUME_VISIBLE_ROLES.has(role) || !content.trim()) {
      continue;
    }
    visible.push({ role, content });
  }
  return visible;
}

export function renderResumePreview(
  messages: readonly Record<string, unknown>[],
  options: {
    sessionId?: string | null;
    limit?: number;
    previewChars?: number;
  } = {},
): string {
  const limit = options.limit ?? DEFAULT_RESUME_PREVIEW_LIMIT;
  const previewChars = options.previewChars ?? DEFAULT_RESUME_PREVIEW_CHARS;
  const visible = resumeVisibleMessages(messages);
  if (visible.length === 0) return "";
  const shown = visible.slice(-Math.max(1, limit));
  const hidden = Math.max(0, visible.length - shown.length);
  const lines = [
    `Resumed session ${shortId(options.sessionId)}: ${visible.length} visible message(s), showing last ${shown.length}.`,
  ];
  if (hidden > 0) {
    lines.push(`Full context is still loaded; ${hidden} older message(s) are hidden from the terminal.`);
  }
  if (hasLegacyImages(messages)) {
    lines.push(LEGACY_IMAGE_NOTICE);
  }
  for (const message of shown) {
    lines.push(`- ${message.role}: ${previewText(message.content, previewChars)}`);
  }
  lines.push("Use /status for details, /sessions to switch, or continue typing below.");
  return lines.join("\n");
}

// --- Replay Events (from agent/runtime/server/replay_events.py) ---

const TERMINAL_EVENT_TYPES: Readonly<Record<string, string>> = {
  failed: "turn_failed",
  cancelled: "turn_cancelled",
  completed: "turn_completed",
};

function assistantToolCalls(message: Record<string, unknown>): unknown[] {
  const meta =
    message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? (message.meta as Record<string, unknown>)
      : {};
  const calls = Array.isArray(meta.tool_calls) ? meta.tool_calls : message.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function toolCallField(call: Record<string, unknown>, name: string): unknown {
  const fn =
    call.function && typeof call.function === "object" && !Array.isArray(call.function)
      ? (call.function as Record<string, unknown>)
      : {};
  return call[name] ?? fn[name];
}

function toolCallArguments(call: Record<string, unknown>): Record<string, unknown> {
  let rawArgs: unknown = call.raw_args;
  if (rawArgs === undefined || rawArgs === null) {
    rawArgs = toolCallField(call, "arguments");
  }
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toolResultEvent(
  message: Record<string, unknown>,
  record: Record<string, unknown> | undefined,
  turnId: string,
  sessionId: string,
): Record<string, unknown> {
  const replay = projectToolReplayFields(record ?? null, message);
  const event: Record<string, unknown> = {
    type: "tool_result",
    session_id: sessionId,
    turn_id: turnId,
    tool_call_id: String(message.tool_call_id || ""),
    tool_name: replay.tool_name,
    result: replay.result,
    status: replay.status,
    error_type: replay.error_type,
    error_source: "tool",
  };
  if ("duration_ms" in replay) {
    event.duration_ms = replay.duration_ms;
  }
  return event;
}

function projectMessageForReplay(
  message: Record<string, unknown>,
  meta: Record<string, unknown>,
  record: Record<string, unknown> | undefined,
  sessionId: string,
): Record<string, unknown>[] {
  const role = message.role;
  const turnId = String(meta.turn_id || "");
  if (role === "user") {
    const event: Record<string, unknown> = {
      type: "turn_started",
      session_id: sessionId,
      turn_id: turnId,
      user_message_chars: String(message.content || "").length,
    };
    const marker =
      message._rind_meta && typeof message._rind_meta === "object" && !Array.isArray(message._rind_meta)
        ? (message._rind_meta as Record<string, unknown>)
        : meta;
    if (marker.kind === "team_delivery") {
      event.delivery = true;
      event.delivery_text = String(message.content || "");
    }
    return [event];
  }
  if (role === "assistant") {
    const events: Record<string, unknown>[] = [];
    for (const rawCall of assistantToolCalls(message)) {
      if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
      const call = rawCall as Record<string, unknown>;
      if (!call.id) continue;
      events.push({
        type: "tool_requested",
        session_id: sessionId,
        turn_id: turnId,
        tool_call_id: String(call.id || ""),
        tool_name: String(toolCallField(call, "name") || ""),
        arguments: toolCallArguments(call),
      });
    }
    if (message.content) {
      const content = String(message.content || "");
      events.push({
        type: "assistant_message_completed",
        session_id: sessionId,
        turn_id: turnId,
        content,
        content_chars: content.length,
        text: content,
      });
    }
    return events;
  }
  if (role === "tool") {
    return [toolResultEvent(message, record, turnId, sessionId)];
  }
  return [];
}

function terminalReplayEvent(
  turnState: Record<string, unknown> | null | undefined,
  sessionId: string,
): Record<string, unknown> | null {
  const state = turnState && typeof turnState === "object" ? turnState : {};
  const eventType = TERMINAL_EVENT_TYPES[String(state.status || "").trim().toLowerCase()];
  if (!eventType) return null;
  const event: Record<string, unknown> = {
    type: eventType,
    session_id: sessionId,
    turn_id: String(state.turn_id || ""),
  };
  const reason = String(state.reason || state.error || "");
  if (eventType === "turn_failed" && reason) {
    event.reason = reason;
  }
  return event;
}

export function iterDurableEvents(
  messages: readonly Record<string, unknown>[],
  toolRecords: readonly Record<string, unknown>[],
  turnState: Record<string, unknown> | null | undefined,
  sessionId: string,
): Record<string, unknown>[] {
  const records = new Map<string, Record<string, unknown>>();
  for (const record of toolRecords) {
    if (record && typeof record === "object" && record.id) {
      records.set(String(record.id), record);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || isCompactBoundaryMessage(message)) {
      continue;
    }
    const meta =
      message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
        ? (message.meta as Record<string, unknown>)
        : {};
    if (INTERNAL_MESSAGE_KINDS.has(String(meta.kind || ""))) {
      continue;
    }
    const record = records.get(String(message.tool_call_id || ""));
    out.push(...projectMessageForReplay(message, meta, record, sessionId));
  }
  const terminal = terminalReplayEvent(turnState, sessionId);
  if (terminal !== null) {
    out.push(terminal);
  }
  return out;
}

// --- Folder Defaults (from agent/runtime/server/folder_defaults.py) ---

export const FOLDER_DEFAULT_GROUPS = ["model", "reasoning_effort"] as const;

export interface FolderDefaultsWorkerLike {
  readonly workspaceRoot: string;
  readonly repository: {
    readonly workspaceDefaults: {
      get(workspaceRoot: string): Record<string, string>;
      setModel(workspaceRoot: string, provider: string, model: string): void;
      setReasoningEffort(workspaceRoot: string, effort: string): void;
      unset(workspaceRoot: string, group: string): boolean;
    };
    folderSelection(workspaceRoot: string, options?: { own?: boolean }): FolderSelection;
    chooseSelection(
      workspaceRoot: string,
      provider?: string,
      model?: string,
      effort?: string | null,
    ): [ModelSelection, Record<string, string>];
  };
   readonly providerService: {
    describeConnection(providerId: string, modelId?: string): Record<string, string | null> | null;
  };
  listProviders(): Array<Record<string, unknown>>;
  listModels(options?: { refresh?: boolean }): Promise<Record<string, unknown>>;
}

function serializeFolderSelection(folder: FolderSelection): Record<string, string> {
  return {
    provider: folder.selection.provider_id,
    model: folder.selection.model_id,
    reasoning_effort: folder.selection.reasoning_effort,
    model_source: folder.model_source,
    effort_source: folder.effort_source,
  };
}

export async function describeFolderDefaults(
  worker: FolderDefaultsWorkerLike,
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const repository = worker.repository;
  const own = repository.workspaceDefaults.get(root);
  const resolved = repository.folderSelection(root);
  const inherited = repository.folderSelection(root, { own: false });
  return {
    workspace_root: root,
    folder: own,
    resolved: serializeFolderSelection(resolved),
    inherited: serializeFolderSelection(inherited),
  };
}

export async function resolveManyFolderDefaults(
  worker: FolderDefaultsWorkerLike,
  workspaceRoots: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const ready = new Set(
    worker
      .listProviders()
      .filter(p => Boolean(p.configured))
      .map(p => String(p.id || "")),
  );
  const result: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const root of workspaceRoots) {
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      const resolved = serializeFolderSelection(
        worker.repository.folderSelection(validateWorkspaceRoot(root)),
      );
      result[root] = {
        ...resolved,
        connection_ready: ready.has(resolved.provider),
      };
    } catch {
      continue;
    }
  }
  return result;
}

export async function setFolderDefaults(
  worker: FolderDefaultsWorkerLike,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = validateWorkspaceRoot(String(params.workspace_root || worker.workspaceRoot));
  const scope = String(params.scope || "folder").trim();
  if (scope !== "folder" && scope !== "global") {
    throw new Error("scope must be folder or global.");
  }
  const provider = String(params.provider_id || "").trim();
  const model = String(params.model_id || "").trim();
  const effort = normalizeReasoningEffort(params.reasoning_effort);
  if (Boolean(provider) !== Boolean(model)) {
    throw new Error(`A ${scope} default model needs both provider_id and model_id.`);
  }
  if (!model && !effort) {
    throw new Error("Set a model (provider_id and model_id), a reasoning_effort, or both.");
  }
  const modelsCatalog = await worker.listModels();
  const models = Array.isArray(modelsCatalog.models)
    ? (modelsCatalog.models as Array<Record<string, unknown>>)
    : [];
  let chosen: [string, string];
  if (model) {
    chosen = [provider, model];
  } else if (scope === "global") {
    const current = loadSettings();
    chosen = [current.provider, current.model];
  } else {
    const described = await describeFolderDefaults(worker, root);
    const resolved = described.resolved as Record<string, string>;
    chosen = [resolved.provider, resolved.model];
  }
  const listed = models.find(item => item.provider_id === chosen[0] && item.id === chosen[1]);
  if (model && !listed) {
    throw new Error(
      `${provider} / ${model} is not available. Log in to ${provider} with /login, or choose a listed model.`,
    );
  }
  const supported = Array.isArray(listed?.reasoning_efforts)
    ? (listed.reasoning_efforts as string[])
    : null;
  if (effort && supported && supported.length > 0 && !supported.includes(effort)) {
    throw new Error(
      `${chosen[1]} supports reasoning effort ${supported.join(", ")}, not ${effort}.`,
    );
  }
  if (scope === "global") {
    const saved = saveSettings({
      provider: provider || null,
      model: model || null,
      reasoning_effort: effort || null,
    });
    return {
      ...(await describeFolderDefaults(worker, root)),
      scope: "global",
      settings: {
        provider: saved.provider,
        model: saved.model,
        reasoning_effort: saved.reasoning_effort,
      },
    };
  }
  const defaults = worker.repository.workspaceDefaults;
  if (model) {
    defaults.setModel(root, provider, model);
  }
  if (effort) {
    defaults.setReasoningEffort(root, effort);
  }
  return {
    ...(await describeFolderDefaults(worker, root)),
    scope: "folder",
  };
}

export async function unsetFolderDefaults(
  worker: FolderDefaultsWorkerLike,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = validateWorkspaceRoot(String(params.workspace_root || worker.workspaceRoot));
  const group = String(params.group || "");
  if (!FOLDER_DEFAULT_GROUPS.includes(group as (typeof FOLDER_DEFAULT_GROUPS)[number])) {
    throw new Error("group must be model or reasoning_effort.");
  }
  worker.repository.workspaceDefaults.unset(root, group);
  return await describeFolderDefaults(worker, root);
}

export async function explainSelection(
  worker: FolderDefaultsWorkerLike,
  workspaceRoot: string,
  selection: Record<string, string>,
  source: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  let chosen: ModelSelection = {
    provider_id: selection.provider || "",
    model_id: selection.model || "",
    reasoning_effort: selection.reasoning_effort || "",
  };
  let resolvedSource = source;
  if (resolvedSource === null) {
    [chosen, resolvedSource] = worker.repository.chooseSelection(
      workspaceRoot,
      chosen.provider_id,
      chosen.model_id,
      selection.reasoning_effort,
    );
  }
  const connection = worker.providerService.describeConnection(chosen.provider_id, chosen.model_id);
  return {
    provider: chosen.provider_id,
    model: chosen.model_id,
    reasoning_effort: chosen.reasoning_effort,
    connection,
    model_source: resolvedSource.model || "",
    effort_source: resolvedSource.effort || "",
  };
}
