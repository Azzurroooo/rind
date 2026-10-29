import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CancellationToken } from "../../domain/cancellation.js";
import {
  classifyToolError,
  classifyToolPayload,
  COMPACT_CONTINUATION_USER_CONTENT,
  COMPACT_HANDOFF_REASONING_CONTENT,
  looksLikeToolPayload,
  normalizeGoal,
  normalizeGoalObjective,
  normalizeGoalStatus,
  normalizePlan,
  parseToolResultPayload,
  PLAN_SCHEMA_VERSION,
  PLAN_STEP_STATUSES,
  SKILL_NAME_PATTERN,
  validateCompactHandoffBoundary,
  type GoalRecord,
  type ImageAttachment,
  type PlanItem,
} from "../../domain/models.js";
import { refreshSystemPrompt } from "../../prompts.js";
import {
  attachmentPath,
  captureImage,
  checkCancelled,
  checkImageBudget,
  loadImage,
  processImage,
  saveImage,
  uploadPaths,
} from "../images.js";
import { resolveProjectRoot, resolveRindHome, resolveSessionBase, validateSessionId } from "../paths.js";
import { DEFAULT_PROVIDER, normalizeReasoningEffort } from "../settings.js";
import { IMPORT_DEFAULTS } from "../skills.js";
import { SessionFiles } from "./atomic-files.js";
import { ToolResultNormalizer } from "./result-normalizer.js";

export const NAME_LIMIT = 80;
export const TITLE_LIMIT = 80;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const INTERNAL_MESSAGE_KINDS = new Set(["goal_checkpoint", "task_notification"]);
export const CONTEXT_RECORD_KINDS = new Set([
  "skill_snapshot",
  "skill_catalog",
  "team_delivery",
  "goal_checkpoint",
  "task_notification",
]);

export const MISSING_TOOL_RESULT_CONTENT =
  "[tool result unavailable] rind was interrupted before this call's " +
  "result was saved; the call may or may not have run.";

const FORK_TITLE_SUFFIX = " (fork)";

export function normalizeName(value: string): string {
  const collapsed = String(value || "")
    .replace(CONTROL_RE, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  let clean = "";
  for (const ch of collapsed) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      clean += ch;
    }
  }
  clean = clean.trim();
  if (!clean) {
    throw new Error("A name cannot be empty.");
  }
  return clean.slice(0, NAME_LIMIT).trimEnd();
}

export function automaticTitle(firstMessage: string): string {
  return String(firstMessage || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .slice(0, TITLE_LIMIT)
    .trimEnd();
}

export function displayTitle(meta: Record<string, unknown>): string {
  const name = meta.name;
  if (typeof name === "string" && name.trim()) {
    return name;
  }
  const title = meta.title;
  return typeof title === "string" && title !== "" && title !== "Untitled" ? title : "";
}

export function newSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function sessionIndexEntry(
  sessionId: string,
  meta: Record<string, unknown>,
  options: {
    messageCount: number;
    toolCallCount: number;
    preview: string;
  },
): Record<string, unknown> {
  return {
    id: sessionId,
    title: displayTitle(meta),
    name: (meta.name as string) || null,
    updated_at: String(meta.updated_at || ""),
    size: { messages: options.messageCount, tool_calls: options.toolCallCount },
    preview: options.preview,
    workspace_root: meta.workspace_root ?? null,
    project_id: meta.project_id ?? null,
    owner_agent_id: meta.owner_agent_id ?? null,
    session_type: meta.session_type ?? null,
    parent_session_id: meta.parent_session_id ?? null,
    provider: (meta.provider as string) || null,
    model: (meta.model as string) || null,
    reasoning_effort: (meta.reasoning_effort as string) || null,
    selection_source:
      meta.selection_source && typeof meta.selection_source === "object" && !Array.isArray(meta.selection_source)
        ? meta.selection_source
        : null,
    has_user_message: true,
  };
}

export function sessionIndexSummary(entry: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...entry };
  delete copy.updated_at;
  return copy;
}

export function defaultAutoCompactWindow(): { ordinal: number } {
  return { ordinal: 1 };
}

export function normalizeAutoCompactWindow(windowValue: unknown): { ordinal: number } {
  if (windowValue && typeof windowValue === "object" && !Array.isArray(windowValue)) {
    const raw = (windowValue as Record<string, unknown>).ordinal;
    const parsed = Number.parseInt(String(raw ?? 1), 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return { ordinal: parsed };
    }
  }
  return { ordinal: 1 };
}

export function normalizeSkillCatalog(
  value: unknown,
): { name: string; description: string; location: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = new Map<string, { name: string; description: string; location: string }>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = obj.name;
    const description = obj.description;
    const location = obj.location;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof location !== "string" ||
      !location.trim()
    ) {
      continue;
    }
    if (!SKILL_NAME_PATTERN.test(name) || description.includes("\n") || description.includes("\r")) {
      continue;
    }
    const key = name.toLowerCase();
    if (!entries.has(key)) {
      entries.set(key, { name, description, location });
    }
  }
  return Array.from(entries.values()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function normalizeSkillSources(value: unknown): Record<string, boolean> {
  const chosen = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const result: Record<string, boolean> = {};
  for (const [source, defaultVal] of Object.entries(IMPORT_DEFAULTS)) {
    result[source] = typeof chosen[source] === "boolean" ? (chosen[source] as boolean) : defaultVal;
  }
  return result;
}

export function newSessionMeta(options: {
  sessionId: string;
  now: string;
  model: string | null;
  cwd: string;
  workspaceRoot: string;
  projectId?: string | null;
  ownerAgentId?: string | null;
  sessionType?: string | null;
  parentSessionId?: string | null;
  reasoningEffort?: string;
  provider?: string;
  selectionSource?: Record<string, string> | null;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    schema_version: "2.0",
    session_id: options.sessionId,
    title: "",
    created_at: options.now,
    updated_at: options.now,
    model: options.model,
    provider: options.provider || "openai",
    cwd: options.cwd,
    workspace_root: options.workspaceRoot,
    message_count: 0,
    tool_call_count: 0,
    auto_compact_window: defaultAutoCompactWindow(),
  };
  if (options.reasoningEffort) {
    meta.reasoning_effort = options.reasoningEffort;
  }
  if (options.selectionSource && Object.keys(options.selectionSource).length > 0) {
    meta.selection_source = { ...options.selectionSource };
  }
  const optionalBindings: Record<string, unknown> = {
    project_id: options.projectId,
    owner_agent_id: options.ownerAgentId,
    session_type: options.sessionType || "standalone_project",
    parent_session_id: options.parentSessionId,
  };
  for (const [k, v] of Object.entries(optionalBindings)) {
    if (v !== null && v !== undefined) {
      meta[k] = v;
    }
  }
  return meta;
}

export function syncSessionCounts(
  meta: Record<string, unknown>,
  counts: { messageCount: number; toolCallCount: number },
): boolean {
  let changed = false;
  if (typeof meta.message_count !== "number" || meta.message_count !== counts.messageCount) {
    meta.message_count = counts.messageCount;
    changed = true;
  }
  if (typeof meta.tool_call_count !== "number" || meta.tool_call_count !== counts.toolCallCount) {
    meta.tool_call_count = counts.toolCallCount;
    changed = true;
  }
  return changed;
}

const INDEX_CACHE = new Map<string, [string, Record<string, unknown>]>();

export class SessionIndexRepository {
  private readonly files: SessionFiles;
  private readonly indexPath: string;

  constructor(files: SessionFiles, indexPath: string) {
    this.files = files;
    this.indexPath = indexPath;
  }

  loadIndex(): { sessions: Record<string, unknown>[] } {
    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      return { sessions: [] };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.indexPath);
    } catch {
      return { sessions: [] };
    }
    const key = path.resolve(this.indexPath);
    const sig = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
    const cached = INDEX_CACHE.get(key);
    if (cached && cached[0] === sig) {
      return cached[1] as { sessions: Record<string, unknown>[] };
    }
    const data = this.readIndex();
    try {
      const after = fs.statSync(this.indexPath);
      const afterSig = `${after.dev}:${after.ino}:${after.ctimeMs}:${after.mtimeMs}:${after.size}`;
      if (sig === afterSig) {
        if (INDEX_CACHE.size >= 8) {
          INDEX_CACHE.clear();
        }
        INDEX_CACHE.set(key, [sig, data]);
      }
    } catch {
      // ignore
    }
    return data;
  }

  private readIndex(): { sessions: Record<string, unknown>[] } {
    const data = this.files.loadJson(this.indexPath);
    if (!data || !Array.isArray(data.sessions)) {
      return { sessions: [] };
    }
    return data as { sessions: Record<string, unknown>[] };
  }

  updateIndex(entry: Record<string, unknown>): boolean {
    if (!this.indexPath) {
      return false;
    }
    try {
      this.files.lockFor(this.indexPath).withLock(() => {
        const indexData = this.readIndex();
        const sessions = [...indexData.sessions];
        const idx = sessions.findIndex(s => s && s.id === entry.id);
        if (idx >= 0) {
          sessions[idx] = entry;
        } else {
          sessions.push(entry);
        }
        this.files.writeJson(this.indexPath, { ...indexData, sessions });
        this.invalidate();
      });
      return true;
    } catch {
      return false;
    }
  }

  removeSession(sessionId: string): void {
    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      return;
    }
    try {
      this.files.lockFor(this.indexPath).withLock(() => {
        const indexData = this.readIndex();
        const remaining = indexData.sessions.filter(s => !s || s.id !== sessionId);
        if (remaining.length === indexData.sessions.length) {
          return;
        }
        this.files.writeJson(this.indexPath, { ...indexData, sessions: remaining });
        this.invalidate();
      });
    } catch {
      // ignore
    }
  }

  private invalidate(): void {
    if (this.indexPath) {
      INDEX_CACHE.delete(path.resolve(this.indexPath));
    }
  }
}

export class MessageRepository {
  private readonly files: SessionFiles;
  private readonly filePath: string;

  constructor(files: SessionFiles, filePath: string) {
    this.files = files;
    this.filePath = filePath;
  }

  persistMessage(
    ts: string,
    role: string,
    content: string,
    toolCallId?: string | null,
    toolName?: string | null,
    meta?: Record<string, unknown> | null,
    reasoningContent?: string | null,
    attachments?: unknown[] | null,
  ): void {
    const msg: Record<string, unknown> = {
      id: randomUUID().replace(/-/g, ""),
      ts,
      role,
      content: content || "",
    };
    if (toolCallId) msg.tool_call_id = toolCallId;
    if (toolName) msg.tool_name = toolName;
    if (meta && Object.keys(meta).length > 0) msg.meta = meta;
    if (reasoningContent !== undefined && reasoningContent !== null) {
      msg.reasoning_content = reasoningContent;
    }
    if (attachments !== undefined && attachments !== null) {
      msg.attachments = attachments;
    }
    this.files.appendJsonl(this.filePath, msg);
  }

  loadMessages(): Record<string, unknown>[] {
    return this.files.readJsonl(this.filePath);
  }
}

export class ToolCallRepository {
  private readonly files: SessionFiles;
  private readonly filePath: string;

  constructor(files: SessionFiles, filePath: string) {
    this.files = files;
    this.filePath = filePath;
  }

  persistToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    rawArgs: string,
    tsStart: string,
    tsEnd: string,
    result: string,
    modelContent: string,
    modelContentFormat?: string | null,
    modelContentPolicy?: Record<string, unknown> | null,
    attachments?: unknown[] | null,
  ): Record<string, unknown> {
    if (typeof modelContent !== "string" || !modelContent) {
      throw new Error("tool record schema v2 requires non-empty model_content");
    }
    let parsed: unknown = result;
    if (typeof result === "string" && looksLikeToolPayload(result)) {
      try {
        parsed = JSON.parse(result);
      } catch {
        parsed = result;
      }
    }
    if (attachments && attachments.length > 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const copy = { ...(parsed as Record<string, unknown>) };
      delete copy.attachments;
      parsed = copy;
    }
    let ok: boolean | null = null;
    let errorType: unknown = null;
    let errorMessage: unknown = null;
    let meta: Record<string, unknown> | null = null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if ("ok" in obj && "tool" in obj) {
        ok = Boolean(obj.ok);
        errorType = obj.error_type ?? null;
        errorMessage = obj.error ?? null;
        if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
          const dataObj = obj.data as Record<string, unknown>;
          const m: Record<string, unknown> = {};
          if (typeof dataObj.stdout === "string") m.stdout_size = dataObj.stdout.length;
          if (typeof dataObj.stderr === "string") m.stderr_size = dataObj.stderr.length;
          if ("exit_code" in dataObj) m.exit_code = dataObj.exit_code;
          if (Object.keys(m).length > 0) meta = m;
        }
      }
    }
    const record: Record<string, unknown> = {
      id: callId,
      ts_start: tsStart,
      ts_end: tsEnd,
      name,
      args,
      raw_args: rawArgs,
      result: parsed,
      ok,
      error_type: errorType,
      error_message: errorMessage,
      meta,
      model_content: modelContent,
      model_content_format: modelContentFormat || "tool_result_v2",
      model_content_policy: modelContentPolicy ? { ...modelContentPolicy } : {},
    };
    if (attachments && attachments.length > 0) {
      record.attachments = attachments;
    }
    this.files.appendJsonl(this.filePath, record);
    return record;
  }

  loadToolCalls(): Record<string, unknown>[] {
    return this.files.readJsonl(this.filePath);
  }
}

export class CompactionRepository {
  private readonly files: SessionFiles;
  private readonly filePath: string;

  constructor(files: SessionFiles, filePath: string) {
    this.files = files;
    this.filePath = filePath;
  }

  persistCompaction(record: Record<string, unknown>): Record<string, unknown> {
    const stored = { ...record };
    this.files.appendJsonl(this.filePath, stored);
    return stored;
  }

  loadCompactions(): Record<string, unknown>[] {
    return this.files.readJsonl(this.filePath);
  }
}

const TOOL_RESULT_NORMALIZER = new ToolResultNormalizer();

export function isInternalMessage(message: Record<string, unknown>): boolean {
  const metadata = message.meta;
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      INTERNAL_MESSAGE_KINDS.has(String((metadata as Record<string, unknown>).kind || "")),
  );
}

export function isCompactBoundaryMessage(message: Record<string, unknown>): boolean {
  const meta = message.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      (meta as Record<string, unknown>).kind === "compact_boundary",
  );
}

function hasValidHandoff(record: Record<string, unknown>): boolean {
  const handoff = record.handoff_message;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    return false;
  }
  const h = handoff as Record<string, unknown>;
  return h.role === "assistant" && typeof h.content === "string";
}

export function latestCompactPair(
  messages: readonly Record<string, unknown>[],
  compactions: readonly Record<string, unknown>[],
): [number, Record<string, unknown>] | null {
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of compactions) {
    if (record && typeof record === "object" && record.id && hasValidHandoff(record)) {
      byId.set(String(record.id), record);
    }
  }
  if (byId.size === 0) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (!msg || !isCompactBoundaryMessage(msg)) continue;
    const meta = msg.meta as Record<string, unknown>;
    const compactId = meta.compact_id ? String(meta.compact_id) : "";
    const record = compactId ? byId.get(compactId) : undefined;
    if (record) {
      return [index, { ...record }];
    }
  }
  return null;
}

export function latestCompaction(
  messages: readonly Record<string, unknown>[],
  compactions: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  const matched = latestCompactPair(messages, compactions);
  return matched ? matched[1] : null;
}

function retainedCutIndex(
  boundaryIndex: number,
  compaction: Record<string, unknown>,
): number {
  const source = compaction.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const end = (source as Record<string, unknown>).message_end_index_exclusive;
    if (typeof end === "number" && Number.isInteger(end) && end >= 0 && end <= boundaryIndex) {
      return end;
    }
  }
  return boundaryIndex;
}

function compactReplacementBoundary(compaction: Record<string, unknown>): Record<string, unknown>[] {
  const handoff = compaction.handoff_message as Record<string, unknown>;
  const content = String(handoff.content ?? "");
  const rawUser = compaction.continuation_user_message;
  let userContent = COMPACT_CONTINUATION_USER_CONTENT;
  if (
    rawUser &&
    typeof rawUser === "object" &&
    !Array.isArray(rawUser) &&
    (rawUser as Record<string, unknown>).role === "user" &&
    typeof (rawUser as Record<string, unknown>).content === "string"
  ) {
    userContent = (rawUser as Record<string, unknown>).content as string;
  }
  return [
    { role: "user", content: userContent },
    { role: "assistant", content, reasoning_content: COMPACT_HANDOFF_REASONING_CONTENT },
  ];
}

export function applyLatestCompactBoundary(
  messages: readonly Record<string, unknown>[],
  compactions: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const matched = latestCompactPair(messages, compactions);
  if (!matched) {
    return messages.map(m => ({ ...m }));
  }
  const [boundaryIndex, compaction] = matched;
  const cut = retainedCutIndex(boundaryIndex, compaction);
  const projected: Record<string, unknown>[] = [];
  for (const m of messages.slice(0, cut)) {
    if (m.role === "system") projected.push({ ...m });
  }
  projected.push(...compactReplacementBoundary(compaction));
  for (const m of messages.slice(cut, boundaryIndex)) {
    if (m.role !== "system") projected.push({ ...m });
  }
  for (const m of messages.slice(boundaryIndex + 1)) {
    if (!isCompactBoundaryMessage(m)) projected.push({ ...m });
  }
  return projected;
}

function toolResultPayload(record: Record<string, unknown>, message: Record<string, unknown>): unknown {
  const payload = record.result;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  for (const fallback of [record.model_content, message.content]) {
    if (typeof fallback === "string" && fallback) {
      return fallback;
    }
  }
  return "";
}

export function projectToolReplayFields(
  record?: Record<string, unknown> | null,
  message?: Record<string, unknown> | null,
): Record<string, unknown> {
  const rec = record && typeof record === "object" ? record : {};
  const msg = message && typeof message === "object" ? message : {};
  const payload = toolResultPayload(rec, msg);
  const toolName = String(rec.name || msg.tool_name || "");
  let errorType = String(rec.error_type || "");
  let status = errorType || rec.ok === false
    ? classifyToolError(errorType || "ToolExecutionError")
    : "completed";
  const content = TOOL_RESULT_NORMALIZER.projectForTerminal(payload, {
    toolName,
    status,
    errorType,
  });
  for (const candidate of [payload, content]) {
    const parsed = parseToolResultPayload(candidate);
    if (!parsed) continue;
    const classified = classifyToolPayload(parsed);
    if (classified) {
      [status, errorType] = classified;
      break;
    }
    if (candidate === payload && !content.startsWith('{"ok": false') && !content.startsWith('{"ok":false')) {
      break;
    }
  }
  const fields: Record<string, unknown> = {
    tool_name: toolName,
    result: content,
    status,
    error_type: errorType,
  };
  const startMs = Date.parse(String(rec.ts_start || ""));
  const endMs = Date.parse(String(rec.ts_end || ""));
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    fields.duration_ms = Math.trunc(endMs - startMs);
  }
  return fields;
}

function buildToolContent(toolRecord?: Record<string, unknown> | null): string {
  if (!toolRecord) {
    throw new Error("Unsupported legacy tool record: missing tool call record.");
  }
  const modelContent = toolRecord.model_content;
  if (typeof modelContent === "string" && modelContent) {
    return modelContent;
  }
  throw new Error("Unsupported legacy tool record: missing model_content.");
}

function projectToolMessage(
  message: Record<string, unknown>,
  toolRecord: Record<string, unknown> | undefined,
  includeIds: boolean,
): Record<string, unknown> {
  const toolCallId = message.tool_call_id;
  let projected: Record<string, unknown>;
  if (includeIds) {
    const replay = projectToolReplayFields(toolRecord, message);
    projected = {
      role: "tool",
      tool_call_id: toolCallId,
      content: replay.result,
      status: replay.status,
    };
    if (replay.error_type) {
      projected.error_type = replay.error_type;
    }
    if ("duration_ms" in replay) {
      projected.duration_ms = replay.duration_ms;
    }
  } else {
    projected = {
      role: "tool",
      tool_call_id: toolCallId,
      content: buildToolContent(toolRecord),
    };
  }
  if ("attachments" in message) {
    projected.attachments = message.attachments;
  }
  if (includeIds && message.id) {
    projected.id = String(message.id);
  }
  if (toolRecord && Array.isArray(toolRecord.attachments) && toolRecord.attachments.length > 0) {
    projected.attachments = toolRecord.attachments;
  }
  return projected;
}

function buildAssistantToolCalls(
  toolCallsMeta: readonly Record<string, unknown>[],
  toolMap: Map<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  const toolCalls: Record<string, unknown>[] = [];
  for (const tcMeta of toolCallsMeta) {
    const tcId = String(tcMeta.id || "");
    const tcName = String(tcMeta.name || "");
    if (!tcId) {
      throw new Error("Invalid tool call message: missing tool call id.");
    }
    const tcRecord = toolMap.get(tcId);
    const rawArgs = tcRecord ? tcRecord.raw_args : tcMeta.raw_args;
    if (rawArgs === undefined || rawArgs === null) {
      continue;
    }
    toolCalls.push({
      id: tcId,
      type: "function",
      function: { name: tcName, arguments: rawArgs },
    });
  }
  return toolCalls;
}

function missingToolMessages(
  toolCalls: readonly Record<string, unknown>[],
  toolMap: Map<string, Record<string, unknown>>,
  emittedToolCallIds: Set<string>,
  includeIds: boolean,
): Record<string, unknown>[] {
  const missing: Record<string, unknown>[] = [];
  for (const toolCall of toolCalls) {
    const toolCallId = String(toolCall.id || "");
    if (!toolCallId || emittedToolCallIds.has(toolCallId)) {
      continue;
    }
    const toolRecord = toolMap.get(toolCallId);
    if (!toolRecord) {
      missing.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: MISSING_TOOL_RESULT_CONTENT,
      });
      emittedToolCallIds.add(toolCallId);
      continue;
    }
    missing.push(
      projectToolMessage(
        { role: "tool", tool_call_id: toolCallId, id: toolRecord.id },
        toolRecord,
        includeIds,
      ),
    );
    emittedToolCallIds.add(toolCallId);
  }
  return missing;
}

export function projectMessages(
  messages: readonly Record<string, unknown>[],
  toolRecords: readonly Record<string, unknown>[],
  compactions: readonly Record<string, unknown>[],
  systemPrompt: string,
  options: {
    includeIds?: boolean;
    compacted?: boolean;
    includeInternal?: boolean;
  } = {},
): Record<string, unknown>[] {
  const includeIds = options.includeIds ?? false;
  const compacted = options.compacted ?? true;
  const includeInternal = options.includeInternal ?? false;

  const compactApplied = compacted && latestCompactPair(messages, compactions) !== null;
  const projectedMessages = compactApplied
    ? applyLatestCompactBoundary(messages, compactions)
    : messages.map(m => ({ ...m }));

  const toolMap = new Map<string, Record<string, unknown>>();
  for (const item of toolRecords) {
    if (item && typeof item === "object" && item.id) {
      toolMap.set(String(item.id), item);
    }
  }

  const builtMessages: Record<string, unknown>[] = [];
  const emittedToolCallIds = new Set<string>();

  for (const message of projectedMessages) {
    if (!message || typeof message !== "object" || isCompactBoundaryMessage(message)) {
      continue;
    }
    if (!includeInternal && isInternalMessage(message)) {
      continue;
    }
    const role = message.role;
    if (role === "tool") {
      const toolCallId = message.tool_call_id;
      if (toolCallId && emittedToolCallIds.has(String(toolCallId))) {
        continue;
      }
      const record = toolCallId ? toolMap.get(String(toolCallId)) : undefined;
      builtMessages.push(projectToolMessage(message, record, includeIds));
      if (toolCallId) {
        emittedToolCallIds.add(String(toolCallId));
      }
      continue;
    }
    const meta = message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? (message.meta as Record<string, unknown>)
      : null;
    if (role === "assistant" && meta && Array.isArray(meta.tool_calls) && meta.tool_calls.length > 0) {
      const toolCalls = buildAssistantToolCalls(
        meta.tool_calls as Record<string, unknown>[],
        toolMap,
      );
      if (toolCalls.length > 0) {
        const assistant: Record<string, unknown> = { role: "assistant", tool_calls: toolCalls };
        if (includeIds && message.id) assistant.id = String(message.id);
        if (message.content) assistant.content = message.content;
        if (typeof message.reasoning_content === "string") {
          assistant.reasoning_content = message.reasoning_content;
        }
        builtMessages.push(assistant);
        builtMessages.push(...missingToolMessages(toolCalls, toolMap, emittedToolCallIds, includeIds));
      } else if (message.content || typeof message.reasoning_content === "string") {
        const assistant: Record<string, unknown> = {
          role: "assistant",
          content: message.content ?? "",
        };
        if (includeIds && message.id) assistant.id = String(message.id);
        if (typeof message.reasoning_content === "string") {
          assistant.reasoning_content = message.reasoning_content;
        }
        builtMessages.push(assistant);
      }
      continue;
    }
    if (role === "system" || role === "user" || role === "assistant") {
      const projected: Record<string, unknown> = {
        role,
        content: message.content ?? "",
      };
      if (role === "system") {
        projected.content = refreshSystemPrompt(String(projected.content ?? ""));
      }
      if ("attachments" in message) {
        projected.attachments = message.attachments;
      }
      if (includeIds && message.id) {
        projected.id = String(message.id);
      }
      if (role === "assistant" && typeof message.reasoning_content === "string") {
        projected.reasoning_content = message.reasoning_content;
      }
      const metaKind = meta ? meta.kind : null;
      if (metaKind === "skill_snapshot" || metaKind === "team_delivery") {
        projected._rind_meta = { kind: metaKind };
      }
      builtMessages.push(projected);
    }
  }

  if (includeIds) {
    const timestamps = new Map<string, unknown>();
    for (const m of projectedMessages) {
      if (m && m.id && m.ts) {
        timestamps.set(String(m.id), m.ts);
      }
    }
    for (const m of builtMessages) {
      if (typeof m.id === "string" && timestamps.has(m.id)) {
        m.ts = timestamps.get(m.id);
      }
    }
  }

  if (builtMessages.length === 0) {
    return [{ role: "system", content: systemPrompt }];
  }
  if (compactApplied) {
    const result = validateCompactHandoffBoundary(builtMessages);
    if (!result.ok) {
      throw new Error(`Invalid compact continuation boundary: ${result.reason}`);
    }
  }
  return builtMessages;
}

function validSessionIdValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateSessionId(value);
    return true;
  } catch {
    return false;
  }
}

function validateSessionMeta(meta: unknown, sessionId: string): asserts meta is Record<string, unknown> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`Session data corrupted or missing meta.json for id: ${sessionId}`);
  }
  const obj = meta as Record<string, unknown>;
  if (String(obj.schema_version || "") !== "2.0") {
    throw new Error("Unsupported legacy session schema; start a new session.");
  }
  if (String(obj.session_id || sessionId) !== sessionId) {
    throw new Error(`Session data corrupted: meta.json id does not match ${sessionId}`);
  }
}

function isRealUserMessage(message: Record<string, unknown>): boolean {
  return message.role === "user" && Boolean(String(message.content || "").trim());
}

function requireSessionFiles(paths: Record<string, string>, sessionId: string): void {
  for (const key of ["messages", "tool_calls"]) {
    if (!fs.existsSync(paths[key]) || !fs.statSync(paths[key]).isFile()) {
      throw new Error(`Session data corrupted or missing ${key}.jsonl for id: ${sessionId}`);
    }
  }
}

function isNonConversationMessage(message: Record<string, unknown>): boolean {
  const metadata = message.meta;
  if (isInternalMessage(message)) return true;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const kind = String((metadata as Record<string, unknown>).kind || "");
    return kind === "skill_snapshot" || kind === "skill_catalog" || kind === "team_delivery";
  }
  return false;
}

function normalizePathCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface JsonlSessionStoreOptions {
  sessionDir?: string | null;
  sessionId?: string | null;
  resumeLatest?: boolean;
  model?: string | null;
  systemPrompt?: string;
  workspaceRoot?: string | null;
  projectId?: string | null;
  ownerAgentId?: string | null;
  sessionType?: string | null;
  parentSessionId?: string | null;
  reasoningEffort?: string;
  provider?: string;
  selectionSource?: Record<string, string> | null;
  createMissing?: boolean;
}

export class JsonlSessionStore {
  private readonly _sessionDir: string | null;
  private _sessionId: string | null;
  private readonly _resumeLatest: boolean;
  private _createMissing: boolean;
  private _model: string | null;
  private _provider: string;
  private _reasoningEffort: string;
  private _selectionSource: Record<string, string>;
  private readonly _systemPrompt: string;
  private readonly _workspaceRoot: string | null;
  private readonly _projectId: string | null;
  private readonly _ownerAgentId: string | null;
  private readonly _sessionType: string | null;
  private readonly _parentSessionId: string | null;

  private _sessionRoot: string | null = null;
  private _indexPath: string | null = null;
  private _sessionPaths: Record<string, string> = {};
  private _sessionMeta: Record<string, unknown> | null = null;
  private _hasUserMessage = false;
  private _indexEntry: Record<string, unknown> | null = null;
  private _lastPreview = "";
  private _projectedCaches = new Map<string, [string, Record<string, unknown>[]]>();
  private _messagesCache: [string, Record<string, unknown>[]] | null = null;
  private _toolRecordsCache: [string, Record<string, unknown>[]] | null = null;
  private readonly _files = new SessionFiles();
  private _msgRepo: MessageRepository | null = null;
  private _toolRepo: ToolCallRepository | null = null;
  private _compactionRepo: CompactionRepository | null = null;
  private _indexRepo: SessionIndexRepository | null = null;
  private readonly _writeLock = new AsyncMutex();

  constructor(options: JsonlSessionStoreOptions = {}) {
    this._sessionDir = options.sessionDir ?? null;
    this._sessionId = options.sessionId ?? null;
    this._resumeLatest = Boolean(options.resumeLatest);
    this._createMissing = options.createMissing ?? true;
    this._model = options.model ?? null;
    this._provider = String(options.provider || DEFAULT_PROVIDER).trim();
    this._reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    this._selectionSource = options.selectionSource ? { ...options.selectionSource } : {};
    this._systemPrompt = options.systemPrompt ?? "";
    this._workspaceRoot = options.workspaceRoot ?? null;
    this._projectId = options.projectId ?? null;
    this._ownerAgentId = options.ownerAgentId ?? null;
    this._sessionType = options.sessionType ?? null;
    this._parentSessionId = options.parentSessionId ?? null;
  }

  get session_id(): string | null {
    return this._sessionId;
  }

  get is_persisted(): boolean {
    return this._msgRepo !== null;
  }

  mark_deleted(): void {
    this._createMissing = false;
  }

  async get_metadata(): Promise<Record<string, unknown>> {
    return this._writeLock.run(() => structuredClone(this._sessionMeta ?? {}));
  }

  get model(): string | null {
    return this._model;
  }

  get provider(): string {
    return this._provider;
  }

  get reasoning_effort(): string {
    return this._reasoningEffort;
  }

  get selection_source(): Record<string, string> {
    return { ...this._selectionSource };
  }

  get system_prompt(): string {
    return this._systemPrompt;
  }

  get session_root(): string {
    return this._sessionRoot || JsonlSessionStore.resolve_session_root(this._sessionDir);
  }

  get session_base_path(): string | null {
    if (!this._sessionId) return null;
    return this._sessionPaths.base || resolveSessionBase(this.session_root, this._sessionId);
  }

  get workspace_root(): string | null {
    if (this._sessionMeta && typeof this._sessionMeta.workspace_root === "string" && this._sessionMeta.workspace_root.trim()) {
      return this._sessionMeta.workspace_root;
    }
    return this._workspaceRoot;
  }

  now_iso(): string {
    return new Date().toISOString();
  }

  static default_rind_home(): string {
    return resolveRindHome();
  }

  static resolve_session_root(sessionDir?: string | null): string {
    if (sessionDir) {
      const expanded = sessionDir.startsWith("~")
        ? path.join(os.homedir(), sessionDir.slice(1))
        : sessionDir;
      return path.resolve(expanded);
    }
    return path.join(JsonlSessionStore.default_rind_home(), "sessions");
  }

  static index_path_for(sessionDir?: string | null): string {
    if (sessionDir) {
      return path.join(JsonlSessionStore.resolve_session_root(sessionDir), "index.json");
    }
    return path.join(JsonlSessionStore.default_rind_home(), "session_index.json");
  }

  static load_session_metadata(sessionId: string, sessionDir?: string | null): Record<string, unknown> {
    const clean = validateSessionId(sessionId);
    const root = JsonlSessionStore.resolve_session_root(sessionDir);
    const base = resolveSessionBase(root, clean);
    const metaPath = path.join(base, "meta.json");
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      const err = new Error(`Session not found: ${clean}`);
      err.name = "LookupError";
      throw err;
    }
    const files = new SessionFiles();
    const meta = files.loadJson(metaPath);
    validateSessionMeta(meta, clean);
    return meta;
  }

  static list_session_metadata(options: {
    sessionDir?: string | null;
    limit?: number;
    workspaceRoot?: string | null;
    excludeWorkspaceRoots?: readonly string[] | null;
    excludeSessionIds?: readonly string[] | null;
  } = {}): Record<string, unknown>[] {
    const [sessions] = JsonlSessionStore._scan_session_metadata(options);
    return sessions;
  }

  static list_session_metadata_by_workspace(options: {
    sessionDir?: string | null;
    limit?: number;
    perWorkspaceLimit?: number;
    excludeWorkspaceRoots?: readonly string[] | null;
    excludeSessionIds?: readonly string[] | null;
  } = {}): [Record<string, unknown>[], { workspace_root: string; count: number }[]] {
    return JsonlSessionStore._scan_session_metadata({
      ...options,
      limit: options.limit ?? 500,
      perWorkspaceLimit: options.perWorkspaceLimit ?? 3,
    });
  }

  private static _scan_session_metadata(options: {
    sessionDir?: string | null;
    limit?: number;
    workspaceRoot?: string | null;
    excludeWorkspaceRoots?: readonly string[] | null;
    excludeSessionIds?: readonly string[] | null;
    perWorkspaceLimit?: number | null;
  }): [Record<string, unknown>[], { workspace_root: string; count: number }[]] {
    const limit = options.limit ?? 20;
    const indexPath = JsonlSessionStore.index_path_for(options.sessionDir);
    const files = new SessionFiles();
    const index = new SessionIndexRepository(files, indexPath).loadIndex();
    const roots = new Map<string, string>();

    const normalizedWorkspace = (value: string): string => {
      const expanded = value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
      const key = path.resolve(expanded);
      let cached = roots.get(key);
      if (cached === undefined) {
        try {
          cached = normalizePathCase(fs.realpathSync(key));
        } catch {
          cached = normalizePathCase(key);
        }
        roots.set(key, cached);
      }
      return cached;
    };

    const entries = Array.isArray(index.sessions) ? index.sessions : [];
    const expectedRoot = options.workspaceRoot ? normalizedWorkspace(options.workspaceRoot) : null;
    const excluded = new Set(
      (options.excludeWorkspaceRoots ?? [])
        .filter((v): v is string => typeof v === "string" && Boolean(v))
        .map(normalizedWorkspace),
    );
    const skipped = new Set(
      (options.excludeSessionIds ?? []).filter((v): v is string => typeof v === "string" && Boolean(v)),
    );

    const result: Record<string, unknown>[] = [];
    const totals = new Map<string, [string, number]>();

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !validSessionIdValue(entry.id)) {
        continue;
      }
      if (skipped.has(entry.id)) continue;
      if (entry.has_user_message === false) continue;
      const entryRoot = entry.workspace_root;
      if (excluded.size > 0 && typeof entryRoot === "string" && excluded.has(normalizedWorkspace(entryRoot))) {
        continue;
      }
      if (expectedRoot !== null) {
        if (typeof entryRoot !== "string" || normalizedWorkspace(entryRoot) !== expectedRoot) {
          continue;
        }
      }
      result.push(structuredClone(entry));
      if (options.perWorkspaceLimit !== undefined && options.perWorkspaceLimit !== null && typeof entryRoot === "string" && entryRoot) {
        const k = normalizedWorkspace(entryRoot);
        const bucket = totals.get(k) ?? [entryRoot, 0];
        bucket[1] += 1;
        totals.set(k, bucket);
      }
    }

    result.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    if (options.perWorkspaceLimit === undefined || options.perWorkspaceLimit === null) {
      return [result.slice(0, Math.max(0, Math.trunc(limit))), []];
    }

    const kept: Record<string, unknown>[] = [];
    const representatives = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const entry of result) {
      const rawRoot = String(entry.workspace_root || "");
      const key = normalizedWorkspace(rawRoot);
      const curCount = counts.get(key) ?? 0;
      if (curCount >= options.perWorkspaceLimit) continue;
      counts.set(key, curCount + 1);
      if (!representatives.has(key)) {
        representatives.set(key, rawRoot);
      }
      kept.push(entry);
    }

    const workspaceTotals: { workspace_root: string; count: number }[] = [];
    for (const key of counts.keys()) {
      const totalEntry = totals.get(key);
      const rep = representatives.get(key);
      if (totalEntry && rep) {
        workspaceTotals.push({ workspace_root: rep, count: totalEntry[1] });
      }
    }
    return [kept.slice(0, Math.max(0, Math.trunc(limit))), workspaceTotals];
  }

  private _resolveWorkspaceRoot(): string {
    const raw = this._workspaceRoot
      ? (this._workspaceRoot.startsWith("~")
          ? path.join(os.homedir(), this._workspaceRoot.slice(1))
          : this._workspaceRoot)
      : resolveProjectRoot();
    const resolved = path.resolve(raw);
    try {
      return normalizePathCase(fs.realpathSync(resolved));
    } catch {
      return normalizePathCase(resolved);
    }
  }

  private _expectedBinding(): Record<string, string | null> {
    return {
      project_id: this._projectId,
      owner_agent_id: this._ownerAgentId,
      session_type: this._sessionType,
      workspace_root: this._workspaceRoot ? this._resolveWorkspaceRoot() : null,
    };
  }

  private _validateSessionBinding(meta: Record<string, unknown>): void {
    for (const [key, expected] of Object.entries(this._expectedBinding())) {
      if (expected === null || expected === undefined) continue;
      if (meta[key] !== expected) {
        throw new Error(`Session ${key} is immutable and does not match the requested agent context.`);
      }
    }
  }

  private _setupPaths(): void {
    this._sessionRoot = JsonlSessionStore.resolve_session_root(this._sessionDir);
    this._indexPath = JsonlSessionStore.index_path_for(this._sessionDir);
    this._indexRepo = new SessionIndexRepository(this._files, this._indexPath);
  }

  private _getSessionPaths(sessionId: string, sessionRoot?: string | null): Record<string, string> {
    const base = resolveSessionBase(sessionRoot || this._sessionRoot || this.session_root, sessionId);
    return {
      base,
      meta: path.join(base, "meta.json"),
      messages: path.join(base, "messages.jsonl"),
      tool_calls: path.join(base, "tool_calls.jsonl"),
      compactions: path.join(base, "compactions.jsonl"),
    };
  }

  private _setupRepos(): void {
    this._msgRepo = new MessageRepository(this._files, this._sessionPaths.messages);
    this._toolRepo = new ToolCallRepository(this._files, this._sessionPaths.tool_calls);
    this._compactionRepo = new CompactionRepository(this._files, this._sessionPaths.compactions);
  }

  private _createSession(sessionId: string): void {
    this._bindDraftSync(sessionId);
    this._createSessionFilesSync();
  }

  private _createSessionFilesSync(): void {
    fs.mkdirSync(this._sessionPaths.base, { recursive: true });
    fs.closeSync(fs.openSync(this._sessionPaths.messages, "a"));
    fs.closeSync(fs.openSync(this._sessionPaths.tool_calls, "a"));
    this._files.writeJson(this._sessionPaths.meta, this._sessionMeta);
    this._setupRepos();
  }

  private _bindDraftSync(sessionId?: string | null): void {
    this._sessionId = sessionId ?? null;
    this._sessionPaths = sessionId ? this._getSessionPaths(sessionId) : {};
    this._hasUserMessage = false;
    this._lastPreview = "";
    this._msgRepo = null;
    this._toolRepo = null;
    this._compactionRepo = null;
    this._invalidateProjectionCache();
    const ws = this._resolveWorkspaceRoot();
    this._sessionMeta = sessionId
      ? newSessionMeta({
          sessionId,
          now: this.now_iso(),
          model: this._model,
          cwd: ws,
          workspaceRoot: ws,
          projectId: this._projectId,
          ownerAgentId: this._ownerAgentId,
          sessionType: this._sessionType,
          parentSessionId: this._parentSessionId,
          reasoningEffort: this._reasoningEffort,
          provider: this._provider,
          selectionSource: this._selectionSource,
        })
      : null;
  }

  private _loadSession(sessionId: string): Record<string, unknown>[] {
    this._sessionId = sessionId;
    this._sessionPaths = this._getSessionPaths(sessionId);
    const meta = this._files.loadJson(this._sessionPaths.meta);
    validateSessionMeta(meta, sessionId);
    this._validateSessionBinding(meta);
    requireSessionFiles(this._sessionPaths, sessionId);

    this._setupRepos();
    this._invalidateProjectionCache();

    this._sessionMeta = meta;
    if ("goal" in this._sessionMeta) {
      this._sessionMeta.goal = normalizeGoal(this._sessionMeta.goal);
    }
    const configuredModel = String(meta.model || "").trim();
    this._model = configuredModel || this._model;
    this._provider = String(meta.provider || DEFAULT_PROVIDER).trim();
    if (!meta.provider) {
      this._sessionMeta.provider = this._provider;
    }
    let configuredEffort = "";
    try {
      configuredEffort = normalizeReasoningEffort(meta.reasoning_effort);
    } catch {
      configuredEffort = "";
    }
    this._reasoningEffort = configuredEffort || this._reasoningEffort;
    const source = meta.selection_source;
    this._selectionSource =
      source && typeof source === "object" && !Array.isArray(source)
        ? Object.fromEntries(Object.entries(source as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {};
    const originalWindow = this._sessionMeta.auto_compact_window;
    const normalizedWindow = normalizeAutoCompactWindow(originalWindow);
    this._sessionMeta.auto_compact_window = normalizedWindow;

    const messages = this._loadMessagesSync();
    const messageCount = messages.filter(m => m && !isNonConversationMessage(m)).length;
    const toolCallCount = this._loadToolRecordsSync().length;
    this._hasUserMessage = messages.some(m => m && !isNonConversationMessage(m) && isRealUserMessage(m));
    const countsChanged = syncSessionCounts(this._sessionMeta, {
      messageCount,
      toolCallCount,
    });
    this._lastPreview = JsonlSessionStore._latestAssistantPreview(messages);
    this._indexEntry = null;
    const windowChanged =
      !originalWindow ||
      typeof originalWindow !== "object" ||
      (originalWindow as Record<string, unknown>).ordinal !== normalizedWindow.ordinal;
    if (countsChanged || windowChanged) {
      this._persistMetaSync(typeof meta.updated_at === "string" ? meta.updated_at : undefined);
    } else if (this._hasUserMessage) {
      this._indexEntry = sessionIndexEntry(this._sessionId, this._sessionMeta, {
        messageCount: Number(this._sessionMeta.message_count || 0),
        toolCallCount: Number(this._sessionMeta.tool_call_count || 0),
        preview: this._lastPreview,
      });
    }
    return messages;
  }

  private static _latestAssistantPreview(messages: readonly Record<string, unknown>[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      if (typeof m.content === "string" && m.content) {
        return m.content.slice(0, 200);
      }
    }
    return "";
  }

  private _validateExistingSessionSync(sessionId: string): string {
    const clean = validateSessionId(sessionId);
    const paths = this._getSessionPaths(clean);
    if (!fs.existsSync(paths.base) || !fs.statSync(paths.base).isDirectory()) {
      throw new Error(`Session not found: ${clean}`);
    }
    const meta = this._files.loadJson(paths.meta);
    validateSessionMeta(meta, clean);
    requireSessionFiles(paths, clean);
    return clean;
  }

  private _switchSessionSync(sessionId: string): Record<string, unknown>[] {
    this._setupPaths();
    const clean = this._validateExistingSessionSync(sessionId);
    const previous = {
      sessionId: this._sessionId,
      sessionPaths: this._sessionPaths,
      sessionMeta: this._sessionMeta,
      lastPreview: this._lastPreview,
      indexEntry: this._indexEntry,
      projectedCaches: new Map(this._projectedCaches),
      messagesCache: this._messagesCache,
      toolRecordsCache: this._toolRecordsCache,
      model: this._model,
      provider: this._provider,
      reasoningEffort: this._reasoningEffort,
      selectionSource: this._selectionSource,
      msgRepo: this._msgRepo,
      toolRepo: this._toolRepo,
      compactionRepo: this._compactionRepo,
      hasUserMessage: this._hasUserMessage,
    };
    try {
      return this._loadSession(clean);
    } catch (err) {
      this._sessionId = previous.sessionId;
      this._sessionPaths = previous.sessionPaths;
      this._sessionMeta = previous.sessionMeta;
      this._lastPreview = previous.lastPreview;
      this._indexEntry = previous.indexEntry;
      this._projectedCaches = previous.projectedCaches;
      this._messagesCache = previous.messagesCache;
      this._toolRecordsCache = previous.toolRecordsCache;
      this._model = previous.model;
      this._provider = previous.provider;
      this._reasoningEffort = previous.reasoningEffort;
      this._selectionSource = previous.selectionSource;
      this._msgRepo = previous.msgRepo;
      this._toolRepo = previous.toolRepo;
      this._compactionRepo = previous.compactionRepo;
      this._hasUserMessage = previous.hasUserMessage;
      throw err;
    }
  }

  private _sessionInfoSync(): Record<string, unknown> {
    const meta = this._sessionMeta ?? {};
    const latest = meta.latest_sampling_usage;
    const assistant = meta.latest_assistant_sampling_usage;
    return {
      session_id: this._sessionId,
      model: this._model,
      usage: latest && typeof latest === "object" ? structuredClone(latest) : null,
      assistant_usage: assistant && typeof assistant === "object" ? structuredClone(assistant) : null,
      goal: meta.goal && typeof meta.goal === "object" ? structuredClone(meta.goal) : null,
      project_id: meta.project_id ?? null,
      owner_agent_id: meta.owner_agent_id ?? null,
      workspace_root: meta.workspace_root ?? null,
      session_type: meta.session_type ?? null,
      parent_session_id: meta.parent_session_id ?? null,
      draft: !this.is_persisted,
    };
  }

  private _findLatestSessionId(): string | null {
    const indexData = this._indexRepo ? this._indexRepo.loadIndex() : { sessions: [] };
    const sessions = indexData.sessions.filter(
      s => s && typeof s === "object" && s.updated_at && this._indexEntryHasUserMessageSync(s),
    );
    if (sessions.length === 0) return null;
    const scoped = sessions.filter(s => {
      if (!this._matchesCurrentWorkspace(s)) return false;
      return typeof s.id === "string" && this._isSupportedSessionId(s.id);
    });
    if (scoped.length === 0) return null;
    scoped.sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
    return String(scoped[scoped.length - 1].id);
  }

  private _indexEntryHasUserMessageSync(entry: Record<string, unknown>): boolean {
    if (typeof entry.has_user_message === "boolean") {
      return entry.has_user_message;
    }
    const sessionId = entry.id;
    if (typeof sessionId !== "string" || !this._isSupportedSessionId(sessionId)) {
      return false;
    }
    const messages = this._files.readJsonl(this._getSessionPaths(sessionId).messages);
    const hasUserMessage = messages.some(m => m && !isNonConversationMessage(m) && isRealUserMessage(m));
    entry.has_user_message = hasUserMessage;
    this._indexRepo?.updateIndex(entry);
    return hasUserMessage;
  }

  private _matchesCurrentWorkspace(entry: Record<string, unknown>): boolean {
    const entryRoot = entry.workspace_root;
    if (typeof entryRoot !== "string" || !entryRoot.trim()) {
      return false;
    }
    let sessionRoot: string;
    try {
      sessionRoot = normalizePathCase(fs.realpathSync(path.resolve(entryRoot)));
    } catch {
      sessionRoot = normalizePathCase(path.resolve(entryRoot));
    }
    const currentRoot = this._resolveWorkspaceRoot();
    return sessionRoot === currentRoot;
  }

  private _isSupportedSessionId(sessionId: string): boolean {
    let metaPath: string;
    try {
      metaPath = this._getSessionPaths(validateSessionId(sessionId)).meta;
    } catch {
      return false;
    }
    try {
      const meta = this._files.loadJson(metaPath);
      return Boolean(meta && String(meta.schema_version || "") === "2.0");
    } catch {
      return false;
    }
  }

  private _updateIndex(): void {
    if (!this._indexRepo || !this._sessionMeta || !this._sessionId) {
      return;
    }
    if (!this._hasUserMessage) {
      this._indexRepo.removeSession(this._sessionId);
      this._indexEntry = null;
      return;
    }
    const entry = sessionIndexEntry(this._sessionId, this._sessionMeta, {
      messageCount: Number(this._sessionMeta.message_count || 0),
      toolCallCount: Number(this._sessionMeta.tool_call_count || 0),
      preview: this._lastPreview,
    });
    if (
      this._indexEntry !== null &&
      JSON.stringify(sessionIndexSummary(this._indexEntry)) === JSON.stringify(sessionIndexSummary(entry))
    ) {
      return;
    }
    if (this._indexRepo.updateIndex(entry)) {
      this._indexEntry = entry;
    }
  }

  private _persistMetaSync(updatedAt?: string | null): void {
    if (!this._sessionMeta) return;
    this._sessionMeta.updated_at = updatedAt || this.now_iso();
    if (!this.is_persisted) return;
    this._files.writeJson(this._sessionPaths.meta, this._sessionMeta);
    this._updateIndex();
  }

  private _invalidateProjectionCache(): void {
    this._projectedCaches.clear();
    this._messagesCache = null;
    this._toolRecordsCache = null;
  }

  private _loadMessagesSync(): Record<string, unknown>[] {
    if (!this._msgRepo) return [];
    const filePath = this._sessionPaths.messages;
    const sig = this._projectionFileSignature(filePath);
    if (this._messagesCache && this._messagesCache[0] === sig) {
      return this._messagesCache[1];
    }
    const messages = this._msgRepo.loadMessages();
    this._messagesCache = [sig, messages];
    return messages;
  }

  private _loadToolRecordsSync(): Record<string, unknown>[] {
    if (!this._toolRepo) return [];
    const filePath = this._sessionPaths.tool_calls;
    const sig = this._projectionFileSignature(filePath);
    if (this._toolRecordsCache && this._toolRecordsCache[0] === sig) {
      return this._toolRecordsCache[1];
    }
    const records = this._toolRepo.loadToolCalls();
    this._toolRecordsCache = [sig, records];
    return records;
  }

  private _projectionFileSignature(filePath?: string | null): string {
    if (!filePath) return "0:0";
    try {
      const stat = fs.statSync(filePath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "0:0";
    }
  }

  private _projectionCacheKeySync(): string {
    return [
      this._systemPrompt,
      this._projectionFileSignature(this._sessionPaths.messages),
      this._projectionFileSignature(this._sessionPaths.tool_calls),
      this._projectionFileSignature(this._sessionPaths.compactions),
    ].join("|");
  }

  private _projectedMessagesSync(options: {
    includeIds?: boolean;
    compacted?: boolean;
    includeInternal?: boolean;
  } = {}): Record<string, unknown>[] {
    const includeIds = options.includeIds ?? false;
    const compacted = options.compacted ?? true;
    const includeInternal = options.includeInternal ?? false;
    const key = `${includeIds}:${compacted}:${includeInternal}`;
    const sig = this._projectionCacheKeySync();
    const cached = this._projectedCaches.get(key);
    if (cached && cached[0] === sig) {
      return cached[1];
    }
    const messages = this._loadMessagesSync();
    const toolRecords = this._loadToolRecordsSync();
    const compactions = this._compactionRepo ? this._compactionRepo.loadCompactions() : [];
    const built = projectMessages(messages, toolRecords, compactions, this._systemPrompt, {
      includeIds,
      compacted,
      includeInternal,
    });
    this._projectedCaches.set(key, [sig, built]);
    return built;
  }

  private _autoCompactWindowSync(): { ordinal: number } {
    if (!this._sessionMeta) return defaultAutoCompactWindow();
    const normalized = normalizeAutoCompactWindow(this._sessionMeta.auto_compact_window);
    this._sessionMeta.auto_compact_window = normalized;
    return { ...normalized };
  }

  private _ensureSessionSync(): Record<string, unknown>[] {
    this._setupPaths();
    if (this._sessionMeta !== null && !this.is_persisted) {
      return [];
    }
    if (this._sessionId !== null) {
      const sessionId = validateSessionId(this._sessionId);
      const sessionPaths = this._getSessionPaths(sessionId);
      if (fs.existsSync(sessionPaths.base) && fs.statSync(sessionPaths.base).isDirectory()) {
        return this._loadSession(sessionId);
      }
      if (!this._createMissing) {
        const err = new Error(`Session not found: ${sessionId}`);
        err.name = "LookupError";
        throw err;
      }
      this._createSession(sessionId);
      return [];
    }
    if (this._resumeLatest) {
      const latestId = this._findLatestSessionId();
      if (latestId) {
        const base = this._getSessionPaths(latestId).base;
        if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
          return this._loadSession(latestId);
        }
      }
      throw new Error("No existing session found to resume.");
    }
    this._bindDraftSync();
    return [];
  }

  private _initializeHistorySync(messages: readonly Record<string, unknown>[]): void {
    if (!this._msgRepo || !this._sessionMeta) return;
    const hasSystem = messages.some(m => m && m.role === "system");
    if (!hasSystem && this._systemPrompt) {
      this._msgRepo.persistMessage(this.now_iso(), "system", this._systemPrompt);
      this._invalidateProjectionCache();
      this._sessionMeta.message_count = Number(this._sessionMeta.message_count || 0) + 1;
      this._persistMetaSync();
    }
  }

  private _materializeDraftSync(): void {
    if (this.is_persisted) return;
    if (!this._createMissing) {
      const err = new Error(`Session not found: ${this._sessionId || "unknown"}`);
      err.name = "LookupError";
      throw err;
    }
    if (this._sessionId === null) {
      this._bindDraftSync(newSessionId());
    }
    this._createSessionFilesSync();
    this._initializeHistorySync([]);
  }

  async initialize(options: { persistSystemPrompt?: boolean } = {}): Promise<void> {
    const persistSystemPrompt = options.persistSystemPrompt ?? true;
    await this._writeLock.run(() => {
      const messages = this._ensureSessionSync();
      if (persistSystemPrompt) {
        this._initializeHistorySync(messages);
      }
    });
  }

  async discard_if_empty(): Promise<void> {
    await this._writeLock.run(() => {
      this._discardIfEmptySync();
    });
  }

  private _discardIfEmptySync(): void {
    if (!this._sessionId || !this._sessionPaths.base) return;
    const messages = this._loadMessagesSync();
    if (messages.some(m => m && !isNonConversationMessage(m) && isRealUserMessage(m))) {
      return;
    }
    const base = this._sessionPaths.base;
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return;
    this._indexRepo?.removeSession(this._sessionId);
    fs.rmSync(base, { recursive: true, force: true });
  }

  async switch_session(sessionId: string): Promise<Record<string, unknown>> {
    return this._writeLock.run(() => {
      const messages = this._switchSessionSync(sessionId);
      this._initializeHistorySync(messages);
      return this._sessionInfoSync();
    });
  }

  async create_session(options: { sessionId?: string | null } = {}): Promise<Record<string, unknown>> {
    const clean = options.sessionId !== undefined && options.sessionId !== null
      ? validateSessionId(options.sessionId)
      : null;
    return this._writeLock.run(() => {
      this._setupPaths();
      if (clean !== null && fs.existsSync(this._getSessionPaths(clean).base)) {
        throw new Error(`Session already exists: ${clean}`);
      }
      this._bindDraftSync(clean);
      return this._sessionInfoSync();
    });
  }

  async update_model(model: string): Promise<void> {
    const clean = String(model || "").trim();
    if (!clean) {
      throw new Error("Model name is required.");
    }
    await this._writeLock.run(() => {
      this._model = clean;
      if (!this._sessionMeta || !this._sessionPaths.meta) return;
      this._sessionMeta.model = clean;
      this._persistMetaSync();
    });
  }

  async set_name(name: string | null): Promise<{ name: string | null; title: string }> {
    const clean = name !== null && name !== undefined ? normalizeName(name) : null;
    return this._writeLock.run(() => {
      const meta = this._sessionMeta ?? {};
      if (clean === null) {
        delete meta.name;
      } else {
        meta.name = clean;
      }
      this._sessionMeta = meta;
      this._persistMetaSync();
      return {
        name: (meta.name as string | undefined) ?? null,
        title: displayTitle(meta),
      };
    });
  }

  async update_selection(provider: string, model: string, options: { source?: string } = {}): Promise<void> {
    const cleanProvider = String(provider || "").trim();
    const cleanModel = String(model || "").trim();
    if (!cleanProvider || !cleanModel) {
      throw new Error("Provider and model are required.");
    }
    const source = options.source ?? "session";
    await this._writeLock.run(() => {
      this._provider = cleanProvider;
      this._model = cleanModel;
      this._selectionSource = { ...this._selectionSource, model: source };
      if (this._sessionMeta && this._sessionPaths.meta) {
        this._sessionMeta.provider = cleanProvider;
        this._sessionMeta.model = cleanModel;
        this._sessionMeta.selection_source = this._selectionSource;
        this._persistMetaSync();
      }
    });
  }

  async update_reasoning_effort(effort: string, options: { source?: string } = {}): Promise<void> {
    const clean = normalizeReasoningEffort(effort);
    if (!clean) {
      throw new Error("Reasoning effort is required.");
    }
    const source = options.source ?? "session";
    await this._writeLock.run(() => {
      this._reasoningEffort = clean;
      this._selectionSource = { ...this._selectionSource, effort: source };
      if (!this._sessionMeta || !this._sessionPaths.meta) return;
      this._sessionMeta.reasoning_effort = clean;
      this._sessionMeta.selection_source = this._selectionSource;
      this._persistMetaSync();
    });
  }

  async get_skill_catalog(): Promise<{ name: string; description: string; location: string }[]> {
    return this._writeLock.run(() =>
      normalizeSkillCatalog(this._sessionMeta ? this._sessionMeta.skill_catalog : []),
    );
  }

  async set_skill_catalog(entries: { name: string; description: string; location: string }[]): Promise<void> {
    const normalized = normalizeSkillCatalog(entries);
    await this._writeLock.run(() => {
      if (!this._sessionMeta || !this._sessionPaths.meta) return;
      const current = normalizeSkillCatalog(this._sessionMeta.skill_catalog);
      if ("skill_catalog" in this._sessionMeta && JSON.stringify(current) === JSON.stringify(normalized)) {
        return;
      }
      this._sessionMeta.skill_catalog = normalized;
      this._persistMetaSync(typeof this._sessionMeta.updated_at === "string" ? this._sessionMeta.updated_at : undefined);
    });
  }

  async get_skill_sources(): Promise<Record<string, boolean>> {
    return this._writeLock.run(() =>
      normalizeSkillSources(this._sessionMeta ? this._sessionMeta.skill_sources : null),
    );
  }

  async set_skill_sources(sources: Record<string, boolean>): Promise<void> {
    const normalized = normalizeSkillSources(sources);
    await this._writeLock.run(() => {
      const meta = this._sessionMeta ?? {};
      meta.skill_sources = normalized;
      this._sessionMeta = meta;
      this._persistMetaSync(typeof meta.updated_at === "string" ? meta.updated_at : undefined);
    });
  }

  capture_image(filePath: string, cancellationToken?: CancellationToken | null): [ImageAttachment, string] {
    if (!this.session_base_path || !this.is_persisted) {
      throw new Error("Image reading requires an active persisted session.");
    }
    return captureImage(this.session_base_path, filePath, cancellationToken);
  }

  async load_image(attachment: ImageAttachment): Promise<Buffer> {
    const base = this.session_base_path;
    if (!base) {
      throw new Error("No active session for image loading.");
    }
    return loadImage(base, attachment);
  }

  async persist_user_input(content: string, options: { meta?: Record<string, unknown> } = {}): Promise<void> {
    await this._writeLock.run(() => {
      const paths = uploadPaths(content, this.workspace_root);
      checkImageBudget(paths.map(() => ({ path: "", mime_type: "", width: 0, height: 0, size_bytes: 0 })));
      const processed = paths.map(p => processImage(p));
      checkImageBudget(
        processed.map(item => ({ path: "", mime_type: item.mime, width: item.width, height: item.height, size_bytes: item.data.length })),
      );
      const attachments: ImageAttachment[] = [];
      const created: string[] = [];
      const wasDraft = !this.is_persisted;
      const draftMetadata = wasDraft && this._sessionMeta ? structuredClone(this._sessionMeta) : null;
      try {
        if (processed.length > 0) {
          this._materializeDraftSync();
          const base = this.session_base_path!;
          const attDir = path.join(base, "attachments");
          const existing = new Set<string>(
            fs.existsSync(attDir) ? fs.readdirSync(attDir).map(n => path.join(attDir, n)) : [],
          );
          for (const item of processed) {
            const reference = saveImage(base, item);
            const fullPath = path.join(base, reference.path);
            if (!existing.has(fullPath)) {
              created.push(fullPath);
            }
            attachments.push(reference);
          }
        }
      } catch (err) {
        for (const p of created) {
          try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch {
            // ignore
          }
        }
        if (wasDraft) {
          this._discardIfEmptySync();
          this._bindDraftSync(this._sessionId);
          if (draftMetadata && this._sessionMeta) {
            Object.assign(this._sessionMeta, draftMetadata);
          }
        }
        throw err;
      }
      const notes: string[] = [];
      for (let i = 0; i < paths.length; i += 1) {
        if (processed[i].hint) {
          notes.push(`${path.basename(paths[i])}: ${processed[i].hint}`);
        }
      }
      const text = content + (notes.length > 0 ? `\n[Image processing: ${notes.join(" ")}]` : "");
      this._persistMessageSync(
        "user",
        text,
        null,
        null,
        options.meta ?? null,
        null,
        attachments.length > 0 ? attachments : null,
      );
    });
  }

  async persist_message(
    role: string,
    content: string,
    toolCallId?: string | null,
    toolName?: string | null,
    meta?: Record<string, unknown> | null,
    reasoningContent?: string | null,
    attachments?: unknown[] | null,
  ): Promise<void> {
    await this._writeLock.run(() => {
      this._persistMessageSync(role, content, toolCallId, toolName, meta, reasoningContent, attachments);
    });
  }

  private _persistMessageSync(
    role: string,
    content: string,
    toolCallId?: string | null,
    toolName?: string | null,
    meta?: Record<string, unknown> | null,
    reasoningContent?: string | null,
    attachments?: unknown[] | null,
  ): void {
    const isContextRecord = Boolean(
      meta &&
        typeof meta === "object" &&
        !Array.isArray(meta) &&
        CONTEXT_RECORD_KINDS.has(String(meta.kind || "")),
    );
    if (!this.is_persisted) {
      if (role !== "user" || !String(content || "").trim() || isContextRecord) {
        return;
      }
      this._materializeDraftSync();
    }
    this._msgRepo!.persistMessage(
      this.now_iso(),
      role,
      content,
      toolCallId,
      toolName,
      meta,
      reasoningContent,
      attachments,
    );
    this._invalidateProjectionCache();
    if (!isContextRecord && this._sessionMeta) {
      this._sessionMeta.message_count = Number(this._sessionMeta.message_count || 0) + 1;
    }
    if (role === "user" && !isContextRecord && String(content || "").trim()) {
      this._hasUserMessage = true;
    }
    if (role === "assistant" && content) {
      this._lastPreview = content.slice(0, 200);
    }
    if (
      role === "user" &&
      !isContextRecord &&
      this._sessionMeta &&
      (this._sessionMeta.title === null || this._sessionMeta.title === undefined || this._sessionMeta.title === "" || this._sessionMeta.title === "Untitled")
    ) {
      this._sessionMeta.title = automaticTitle(content);
    }
    this._persistMetaSync();
  }

  async persist_tool_call(
    callId: string,
    name: string,
    parsedArgs: Record<string, unknown>,
    rawArgs: string,
    tsStart: string,
    tsEnd: string,
    resultPayload: string,
    modelContent: string,
    modelContentFormat?: string | null,
    modelContentPolicy?: Record<string, unknown> | null,
    attachments?: unknown[] | null,
  ): Promise<void> {
    await this._writeLock.run(() => {
      if (!this._toolRepo || !this._sessionMeta) return;
      const toolPath = this._sessionPaths.tool_calls;
      const priorCache = this._toolRecordsCache;
      const priorRecords =
        priorCache && priorCache[0] === this._projectionFileSignature(toolPath)
          ? priorCache[1]
          : null;
      const record = this._toolRepo.persistToolCall(
        callId,
        name,
        parsedArgs,
        rawArgs,
        tsStart,
        tsEnd,
        resultPayload,
        modelContent,
        modelContentFormat,
        modelContentPolicy,
        attachments,
      );
      this._invalidateProjectionCache();
      if (priorRecords !== null) {
        this._toolRecordsCache = [this._projectionFileSignature(toolPath), [...priorRecords, record]];
      }
      this._sessionMeta.tool_call_count = Number(this._sessionMeta.tool_call_count || 0) + 1;
      this._persistMetaSync();
    });
  }

  async load_messages(): Promise<Record<string, unknown>[]> {
    return this._loadMessagesSync().map(m => ({ ...m }));
  }

  private _latestCompactionSync(): Record<string, unknown> | null {
    if (!this._compactionRepo || !this._msgRepo) return null;
    return latestCompaction(this._loadMessagesSync(), this._compactionRepo.loadCompactions());
  }

  async get_messages_slice(options: {
    start?: number | null;
    end?: number | null;
    roles?: readonly string[] | null;
    includeIds?: boolean;
    compacted?: boolean;
    includeInternal?: boolean;
  } = {}): Promise<Record<string, unknown>[]> {
    let builtMessages = this._projectedMessagesSync({
      includeIds: options.includeIds ?? false,
      compacted: options.compacted ?? true,
      includeInternal: options.includeInternal ?? false,
    });
    if (options.roles && options.roles.length > 0) {
      const allowedRoles = new Set(options.roles);
      builtMessages = builtMessages.filter(m => allowedRoles.has(String(m.role || "")));
    }
    const start = options.start ?? undefined;
    const end = options.end ?? undefined;
    return builtMessages.slice(start, end).map(m => ({ ...m }));
  }

  async list_recent_sessions(limit: number = 10): Promise<Record<string, unknown>[]> {
    this._setupPaths();
    const indexData = this._indexRepo ? this._indexRepo.loadIndex() : { sessions: [] };
    const sessions = indexData.sessions.filter(
      s =>
        s &&
        typeof s === "object" &&
        s.updated_at &&
        validSessionIdValue(s.id) &&
        this._indexEntryHasUserMessageSync(s) &&
        this._matchesCurrentWorkspace(s),
    );
    sessions.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return sessions.slice(0, limit);
  }

  async get_tool_records(options: {
    limit?: number | null;
    callIds?: readonly string[] | null;
  } = {}): Promise<Record<string, unknown>[]> {
    if (!this._toolRepo) return [];
    let records = this._loadToolRecordsSync();
    if (options.callIds && options.callIds.length > 0) {
      const allowed = new Set(options.callIds);
      records = records.filter(r => allowed.has(String(r.id || "")));
    }
    if (options.limit !== undefined && options.limit !== null && options.limit > 0) {
      records = records.slice(-options.limit);
    }
    return records.map(r => ({ ...r }));
  }

  async persist_sampling_usage(usage: Record<string, unknown>): Promise<void> {
    await this._writeLock.run(() => {
      if (!this._sessionMeta || !this._sessionPaths.meta) return;
      const latest: Record<string, unknown> = { ...(usage || {}), updated_at: this.now_iso() };
      this._sessionMeta.latest_sampling_usage = latest;
      if (latest.sampling_kind === "assistant") {
        this._sessionMeta.latest_assistant_sampling_usage = { ...latest };
      }
      this._persistMetaSync(String(latest.updated_at));
    });
  }

  async get_latest_sampling_usage(): Promise<Record<string, unknown> | null> {
    return this._latestMetaUsage("latest_sampling_usage");
  }

  async persist_context_breakdown(snapshot: Record<string, unknown>): Promise<void> {
    await this._writeLock.run(() => {
      if (!this._sessionMeta || !this._sessionPaths.meta) return;
      this._sessionMeta.latest_context_breakdown = { ...(snapshot || {}) };
      this._persistMetaSync();
    });
  }

  async get_latest_assistant_sampling_usage(): Promise<Record<string, unknown> | null> {
    return this._latestMetaUsage("latest_assistant_sampling_usage");
  }

  private _latestMetaUsage(key: string): Record<string, unknown> | null {
    if (!this._sessionMeta) return null;
    const usage = this._sessionMeta[key];
    return usage && typeof usage === "object" && !Array.isArray(usage)
      ? { ...(usage as Record<string, unknown>) }
      : null;
  }

  async persist_turn_state(
    turnId: string,
    status: string,
    ts: string,
    recoveryAttempt?: number | null,
  ): Promise<void> {
    const cleanTurnId = String(turnId || "").trim();
    const cleanStatus = String(status || "").trim();
    if (!cleanTurnId || !cleanStatus) {
      throw new Error("Turn state requires turn_id and status.");
    }
    await this._writeLock.run(() => {
      if (!this._sessionMeta) return;
      const state: Record<string, unknown> = {
        turn_id: cleanTurnId,
        status: cleanStatus,
        ts: String(ts || this.now_iso()),
      };
      if (recoveryAttempt !== undefined && recoveryAttempt !== null) {
        if (typeof recoveryAttempt !== "number" || !Number.isInteger(recoveryAttempt) || recoveryAttempt < 1) {
          throw new Error("Recovery attempt must be a positive integer.");
        }
        state.recovery_attempt = recoveryAttempt;
      }
      this._sessionMeta.turn_state = state;
      this._persistMetaSync();
    });
  }

  async get_turn_state(): Promise<Record<string, unknown> | null> {
    if (!this._sessionMeta) return null;
    const state = this._sessionMeta.turn_state;
    return state && typeof state === "object" && !Array.isArray(state)
      ? { ...(state as Record<string, unknown>) }
      : null;
  }

  async get_goal(): Promise<GoalRecord | null> {
    if (!this._sessionMeta) return null;
    const goal = this._sessionMeta.goal;
    return goal && typeof goal === "object" && !Array.isArray(goal)
      ? ({ ...(goal as Record<string, unknown>) } as unknown as GoalRecord)
      : null;
  }

  async set_goal(objective: string): Promise<GoalRecord> {
    const normalized = normalizeGoalObjective(objective);
    return this._writeLock.run(() => {
      if (!this._sessionMeta) {
        throw new Error("Send a message before setting a goal for this draft session.");
      }
      this._materializeDraftSync();
      const goal: GoalRecord = { objective: normalized, status: "active" };
      this._sessionMeta.goal = goal;
      this._persistMetaSync();
      return { ...goal };
    });
  }

  async set_goal_status(status: string): Promise<GoalRecord> {
    const normalizedStatus = normalizeGoalStatus(status);
    return this._writeLock.run(() => {
      if (!this._sessionMeta) {
        throw new Error("Session is not initialized.");
      }
      const goal = normalizeGoal(this._sessionMeta.goal);
      if (!goal) {
        throw new Error("No active goal exists.");
      }
      goal.status = normalizedStatus;
      this._sessionMeta.goal = goal;
      this._persistMetaSync();
      return { ...goal };
    });
  }

  async clear_goal(): Promise<void> {
    await this._writeLock.run(() => {
      if (this._sessionMeta) {
        delete this._sessionMeta.goal;
        this._persistMetaSync();
      }
    });
  }

  async get_compact_generation(): Promise<number> {
    return this._writeLock.run(() => Number(this._autoCompactWindowSync().ordinal || 1));
  }

  async persist_compaction(compaction: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._writeLock.run(() => {
      if (!this._compactionRepo || !this._msgRepo || !this._sessionMeta) {
        throw new Error("Send a message before compacting this draft session.");
      }
      const candidate: Record<string, unknown> = { ...compaction };
      if (!candidate.id) candidate.id = randomUUID().replace(/-/g, "");
      if (!candidate.created_at) candidate.created_at = this.now_iso();
      if (!candidate.policy_version) candidate.policy_version = "compact_boundary_v1";
      const record = this._compactionRepo.persistCompaction(candidate);
      const compactId = record.id;
      this._msgRepo.persistMessage(this.now_iso(), "assistant", "", null, null, {
        kind: "compact_boundary",
        compact_id: compactId,
      });
      this._invalidateProjectionCache();
      this._sessionMeta.message_count = Number(this._sessionMeta.message_count || 0) + 1;
      this._sessionMeta.latest_compaction = {
        id: compactId,
        created_at: record.created_at,
        policy_version: record.policy_version,
        source: record.source,
      };
      this._sessionMeta.auto_compact_window = {
        ordinal: Number(this._autoCompactWindowSync().ordinal || 1) + 1,
      };
      delete this._sessionMeta.latest_assistant_sampling_usage;
      this._persistMetaSync();
      return record;
    });
  }

  async get_latest_compaction(): Promise<Record<string, unknown> | null> {
    return this._latestCompactionSync();
  }

  // --- camelCase aliases for unified TypeScript ergonomics ---

  get sessionId(): string | null {
    return this.session_id;
  }

  get persisted(): boolean {
    return this.is_persisted;
  }

  get directory(): string {
    return this.session_base_path || "";
  }

  get sessionBasePath(): string | null {
    return this.session_base_path;
  }

  get reasoningEffort(): string {
    return this.reasoning_effort;
  }

  get selectionSource(): Record<string, string> {
    return this.selection_source;
  }

  get workspaceRoot(): string | null {
    return this.workspace_root;
  }

  nowIso(): string {
    return this.now_iso();
  }

  static resolveSessionRoot(sessionDir?: string | null): string {
    return JsonlSessionStore.resolve_session_root(sessionDir);
  }

  getMetadata(): Promise<Record<string, unknown>> {
    return this.get_metadata();
  }

  loadMessages(): Promise<Record<string, unknown>[]> {
    return this.load_messages();
  }

  loadToolRecords(options?: { limit?: number | null; callIds?: readonly string[] | null }): Promise<Record<string, unknown>[]> {
    return this.get_tool_records(options);
  }

  getToolRecords(
    optionsOrCallIds?: { limit?: number | null; callIds?: readonly string[] | null } | readonly string[],
  ): Promise<Record<string, unknown>[]> {
    if (Array.isArray(optionsOrCallIds)) {
      return this.get_tool_records({ callIds: optionsOrCallIds as readonly string[] });
    }
    return this.get_tool_records(optionsOrCallIds as { limit?: number | null; callIds?: readonly string[] | null } | undefined);
  }

  getMessagesSlice(options?: {
    start?: number | null;
    end?: number | null;
    roles?: readonly string[] | null;
    includeIds?: boolean;
    compacted?: boolean;
    includeInternal?: boolean;
  }): Promise<Record<string, unknown>[]> {
    return this.get_messages_slice(options);
  }

  persistCompaction(compaction: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.persist_compaction(compaction);
  }

  getLatestCompaction(): Promise<Record<string, unknown> | null> {
    return this.get_latest_compaction();
  }

  getCompactGeneration(): Promise<number> {
    return this.get_compact_generation();
  }

  persistSamplingUsage(usage: Record<string, unknown>): Promise<void> {
    return this.persist_sampling_usage(usage);
  }

  getLatestAssistantSamplingUsage(): Promise<Record<string, unknown> | null> {
    return this.get_latest_assistant_sampling_usage();
  }

  persistContextBreakdown(snapshot: Record<string, unknown>): Promise<void> {
    return this.persist_context_breakdown(snapshot);
  }

  persistTurnState(
    turnId: string,
    status: string,
    ts?: string | null,
    recoveryAttempt?: number | null,
  ): Promise<void> {
    return this.persist_turn_state(turnId, status, ts || this.now_iso(), recoveryAttempt);
  }

  getTurnState(): Promise<Record<string, unknown> | null> {
    return this.get_turn_state();
  }

  getGoal(): Promise<GoalRecord | null> {
    return this.get_goal();
  }

  setGoal(objective: string): Promise<GoalRecord> {
    return this.set_goal(objective);
  }

  setGoalStatus(status: string): Promise<GoalRecord> {
    return this.set_goal_status(status);
  }

  clearGoal(): Promise<void> {
    return this.clear_goal();
  }

  async saveGoal(goal: Record<string, unknown> | null): Promise<void> {
    if (goal === null) {
      await this.clear_goal();
      return;
    }
    const normalized = normalizeGoal(goal);
    if (!normalized) {
      await this.clear_goal();
      return;
    }
    await this._writeLock.run(() => {
      this._materializeDraftSync();
      if (this._sessionMeta) {
        this._sessionMeta.goal = normalized;
        this._persistMetaSync();
      }
    });
  }

  getSkillCatalog(): Promise<{ name: string; description: string; location: string }[]> {
    return this.get_skill_catalog();
  }

  setSkillCatalog(entries: { name: string; description: string; location: string }[]): Promise<void> {
    return this.set_skill_catalog(entries);
  }

  getSkillSources(): Promise<Record<string, boolean>> {
    return this.get_skill_sources();
  }

  setSkillSources(sources: Record<string, boolean>): Promise<void> {
    return this.set_skill_sources(sources);
  }

  captureImage(filePath: string, cancellationToken?: CancellationToken | null): [ImageAttachment, string] {
    return this.capture_image(filePath, cancellationToken);
  }

  loadImage(attachment: ImageAttachment): Promise<Buffer> {
    return this.load_image(attachment);
  }

  persistUserInput(
    content: string,
    optionsOrMeta?: { meta?: Record<string, unknown> | null } | Record<string, unknown> | null,
  ): Promise<void> {
    if (!optionsOrMeta) {
      return this.persist_user_input(content);
    }
    if ("meta" in optionsOrMeta && (optionsOrMeta.meta === null || typeof optionsOrMeta.meta === "object")) {
      return this.persist_user_input(content, { meta: (optionsOrMeta.meta as Record<string, unknown>) ?? undefined });
    }
    return this.persist_user_input(content, { meta: optionsOrMeta as Record<string, unknown> });
  }

  persistMessage(
    role: string,
    content: string,
    optionsOrToolCallId?:
      | {
          toolCallId?: string | null;
          toolName?: string | null;
          meta?: Record<string, unknown> | null;
          reasoningContent?: string | null;
          attachments?: unknown[] | null;
        }
      | string
      | null,
    toolName?: string | null,
    meta?: Record<string, unknown> | null,
    reasoningContent?: string | null,
    attachments?: unknown[] | null,
  ): Promise<void> {
    if (optionsOrToolCallId && typeof optionsOrToolCallId === "object" && !Array.isArray(optionsOrToolCallId)) {
      return this.persist_message(
        role,
        content,
        optionsOrToolCallId.toolCallId ?? null,
        optionsOrToolCallId.toolName ?? null,
        optionsOrToolCallId.meta ?? null,
        optionsOrToolCallId.reasoningContent ?? null,
        optionsOrToolCallId.attachments ?? null,
      );
    }
    return this.persist_message(
      role,
      content,
      (optionsOrToolCallId as string | null) ?? null,
      toolName ?? null,
      meta ?? null,
      reasoningContent ?? null,
      attachments ?? null,
    );
  }

  persistToolCall(
    callId: string,
    name: string,
    parsedArgs: Record<string, unknown>,
    rawArgs: string,
    tsStart: string,
    tsEnd: string,
    resultPayload: string,
    modelContent: string,
    modelContentFormat?: string | null,
    modelContentPolicy?: Record<string, unknown> | null,
    attachments?: unknown[] | null,
  ): Promise<void> {
    return this.persist_tool_call(
      callId,
      name,
      parsedArgs,
      rawArgs,
      tsStart,
      tsEnd,
      resultPayload,
      modelContent,
      modelContentFormat,
      modelContentPolicy,
      attachments,
    );
  }

  switchSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.switch_session(sessionId);
  }

  createSession(options?: { sessionId?: string | null }): Promise<Record<string, unknown>> {
    return this.create_session(options);
  }

  updateSelection(provider: string, model: string, optionsOrSource?: { source?: string } | string): Promise<void> {
    const opts = typeof optionsOrSource === "string" ? { source: optionsOrSource } : optionsOrSource;
    return this.update_selection(provider, model, opts);
  }

  updateReasoningEffort(effort: string, optionsOrSource?: { source?: string } | string): Promise<void> {
    const opts = typeof optionsOrSource === "string" ? { source: optionsOrSource } : optionsOrSource;
    return this.update_reasoning_effort(effort, opts);
  }

  rename(name: string | null): Promise<{ name: string | null; title: string }> {
    return this.set_name(name);
  }

  listSessions(limit = 20): Promise<Record<string, unknown>[]> {
    return this.list_recent_sessions(limit);
  }

  async getStats(): Promise<Record<string, any>> {
    const meta = await this.get_metadata();
    const messages = await this.load_messages();
    const toolRecords = await this.get_tool_records();
    const compactions = this._compactionRepo ? this._compactionRepo.loadCompactions() : [];
    let messagesBytes = 0;
    try {
      if (this._sessionPaths.messages && fs.existsSync(this._sessionPaths.messages)) {
        messagesBytes = fs.statSync(this._sessionPaths.messages).size;
      }
    } catch {
      messagesBytes = 0;
    }
    return {
      session_id: this._sessionId || "draft",
      session_dir: this.session_base_path || this.session_root,
      message_count: messages.length,
      user_messages: messages.filter((m) => m.role === "user").length,
      assistant_messages: messages.filter((m) => m.role === "assistant").length,
      tool_messages: messages.filter((m) => m.role === "tool").length,
      tool_call_records: toolRecords.length,
      compaction_count: compactions.length,
      messages_bytes: messagesBytes,
      latest_context_breakdown: meta.latest_context_breakdown ?? null,
      latest_sampling_usage: meta.latest_sampling_usage ?? null,
      latest_assistant_sampling_usage: meta.latest_assistant_sampling_usage ?? null,
    };
  }
}

function isContextRecord(message: Record<string, unknown>): boolean {
  const meta = message.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      CONTEXT_RECORD_KINDS.has(String((meta as Record<string, unknown>).kind || "")),
  );
}

function isPromptMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "user" || isContextRecord(message)) {
    return false;
  }
  return Boolean(String(message.content || "").trim());
}

function forkCut(messages: readonly Record<string, unknown>[], beforeMessageId?: string | null): number {
  if (beforeMessageId === undefined || beforeMessageId === null) {
    return messages.length;
  }
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].id === beforeMessageId) {
      if (!isPromptMessage(messages[i])) {
        throw new Error("Fork point must be a user message.");
      }
      return i;
    }
  }
  throw new Error("Fork message not found.");
}

function compactionEnd(record: Record<string, unknown>): number {
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return 0;
  const end = Number((source as Record<string, unknown>).message_end_index_exclusive ?? 0);
  return Number.isFinite(end) ? Math.trunc(end) : 0;
}

export function forkSession(
  sessionDir: string | null | undefined,
  sourceId: string,
  options: { beforeMessageId?: string | null } = {},
): string {
  const clean = validateSessionId(sourceId);
  const root = JsonlSessionStore.resolve_session_root(sessionDir);
  const sourceBase = resolveSessionBase(root, clean);
  const files = new SessionFiles();

  const meta = files.loadJson(path.join(sourceBase, "meta.json"));
  if (!meta) {
    const err = new Error(`Session not found: ${clean}`);
    err.name = "LookupError";
    throw err;
  }

  const messages = files.readJsonl(path.join(sourceBase, "messages.jsonl"));
  const cut = forkCut(messages, options.beforeMessageId);
  const retained = messages.slice(0, cut);
  if (!retained.some(isPromptMessage)) {
    throw new Error("Nothing to fork: the session has no user messages.");
  }

  const allToolCalls = files.readJsonl(path.join(sourceBase, "tool_calls.jsonl"));
  const compactions = files
    .readJsonl(path.join(sourceBase, "compactions.jsonl"))
    .filter(record => compactionEnd(record) < cut);

  const retainedCalls = new Set<string>();
  for (const message of retained) {
    if (typeof message.tool_call_id === "string" && message.tool_call_id) {
      retainedCalls.add(message.tool_call_id);
    }
    const metaObj = message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? (message.meta as Record<string, unknown>)
      : null;
    if (metaObj && Array.isArray(metaObj.tool_calls)) {
      for (const call of metaObj.tool_calls) {
        if (call && typeof call === "object" && (call as Record<string, unknown>).id) {
          retainedCalls.add(String((call as Record<string, unknown>).id));
        }
      }
    }
  }
  const toolCalls = allToolCalls.filter(record => retainedCalls.has(String(record.id || "")));
  const attachmentsMap = new Map<string, ImageAttachment>();
  for (const record of [...retained, ...toolCalls]) {
    if (Array.isArray(record.attachments)) {
      for (const item of record.attachments as ImageAttachment[]) {
        if (item && item.path) {
          attachmentsMap.set(item.path, item);
        }
      }
    }
  }

  const newId = newSessionId();
  const targetBase = resolveSessionBase(root, newId);
  fs.mkdirSync(targetBase, { recursive: true });
  try {
    for (const attachment of attachmentsMap.values()) {
      const payload = loadImage(sourceBase, attachment);
      const target = attachmentPath(targetBase, attachment.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, payload);
    }
    const sourceAttachmentsPrefix = `${path.resolve(sourceBase).replace(/\\/g, "/")}/attachments/`;
    const targetAttachmentsPrefix = `${path.resolve(targetBase).replace(/\\/g, "/")}/attachments/`;
    for (const record of compactions) {
      const handoff = record.handoff_message;
      if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
        const h = handoff as Record<string, unknown>;
        if (typeof h.content === "string") {
          h.content = h.content.split(sourceAttachmentsPrefix).join(targetAttachmentsPrefix);
        }
      }
    }
    files.writeJsonl(path.join(targetBase, "messages.jsonl"), retained);
    files.writeJsonl(path.join(targetBase, "tool_calls.jsonl"), toolCalls);
    if (compactions.length > 0) {
      files.writeJsonl(path.join(targetBase, "compactions.jsonl"), compactions);
    }

    const messageCount = retained.filter(m => !isContextRecord(m)).length;
    const now = new Date().toISOString();
    let title = displayTitle(meta) || "Untitled";
    while (title.endsWith(FORK_TITLE_SUFFIX)) {
      title = title.slice(0, -FORK_TITLE_SUFFIX.length);
    }
    const forkedMeta: Record<string, unknown> = { ...meta };
    delete forkedMeta.name;
    Object.assign(forkedMeta, {
      session_id: newId,
      title: `${title}${FORK_TITLE_SUFFIX}`,
      created_at: now,
      updated_at: now,
      parent_session_id: clean,
      message_count: messageCount,
      tool_call_count: toolCalls.length,
    });
    if (compactions.length > 0) {
      const latest = compactions[compactions.length - 1];
      forkedMeta.latest_compaction = {
        id: latest.id,
        created_at: latest.created_at,
        policy_version: latest.policy_version,
        source: latest.source,
      };
      forkedMeta.auto_compact_window = { ordinal: compactions.length + 1 };
    } else {
      delete forkedMeta.latest_compaction;
      forkedMeta.auto_compact_window = { ordinal: 1 };
    }
    files.writeJson(path.join(targetBase, "meta.json"), forkedMeta);

    let preview = "";
    for (let i = retained.length - 1; i >= 0; i -= 1) {
      const m = retained[i];
      if (m.role === "assistant" && String(m.content || "").trim()) {
        preview = String(m.content).slice(0, 200);
        break;
      }
    }
    new SessionIndexRepository(files, JsonlSessionStore.index_path_for(sessionDir)).updateIndex(
      sessionIndexEntry(newId, forkedMeta, {
        messageCount,
        toolCallCount: toolCalls.length,
        preview,
      }),
    );
  } catch (err) {
    fs.rmSync(targetBase, { recursive: true, force: true });
    throw err;
  }
  return newId;
}


const DEFAULT_SUMMARY_CHAR_LIMIT = 2200;
const TRUNCATION_HINT = "\n...(plan summary truncated due to context budget)...";

export function planPath(sessionBase: string | null | undefined): string {
  if (!sessionBase || !fs.existsSync(sessionBase) || !fs.statSync(sessionBase).isDirectory()) {
    throw new Error("No persisted session. Initialize the session before using plan tools.");
  }
  return path.join(sessionBase, "plan.json");
}

export function loadPlanIfExists(sessionBase: string | null | undefined): PlanItem[] | null {
  const filePath = planPath(sessionBase);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Corrupted plan file for session ${path.basename(path.dirname(filePath))}: ${(err as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Corrupted plan file: expected an object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== PLAN_SCHEMA_VERSION) {
    return null;
  }
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("plan")) {
    throw new Error("Corrupted v2 plan file: unexpected fields.");
  }
  try {
    return normalizePlan(obj.plan);
  } catch (err) {
    throw new Error(`Corrupted v2 plan file: ${(err as Error).message}`);
  }
}

export function writePlan(plan: readonly PlanItem[], sessionBase: string | null | undefined): void {
  const filePath = planPath(sessionBase);
  const payload = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan,
  };
  const temporary = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${randomUUID().replace(/-/g, "")}.tmp`,
  );
  try {
    const fd = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
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

function truncatePlanText(text: string, charLimit: number): string {
  const limit = Math.max(0, Math.trunc(charLimit));
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_HINT.length) return TRUNCATION_HINT.slice(0, limit);
  return text.slice(0, limit - TRUNCATION_HINT.length).trimEnd() + TRUNCATION_HINT;
}

export function renderPlanSummary(
  plan: readonly PlanItem[],
  charLimit: number = DEFAULT_SUMMARY_CHAR_LIMIT,
): string {
  if (!plan || plan.length === 0) {
    return "";
  }
  const counts: Record<string, number> = {};
  for (const status of PLAN_STEP_STATUSES) {
    counts[status] = 0;
  }
  const lines = ["Active plan:"];
  for (const item of plan) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    lines.push(`- [${item.status}] ${item.step}`);
  }
  lines.push(
    `- Progress: ${(["completed", "in_progress", "pending", "cancelled"] as const)
      .map(s => `${s}=${counts[s] ?? 0}`)
      .join(", ")}`,
  );
  return truncatePlanText(lines.join("\n"), charLimit);
}

export function buildPlanSnapshot(
  sessionBase: string | null | undefined,
  charLimit: number = 1800,
): string {
  try {
    const plan = loadPlanIfExists(sessionBase);
    return renderPlanSummary(plan ?? [], Math.max(0, Math.trunc(charLimit)));
  } catch {
    return "";
  }
}
