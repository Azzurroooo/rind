import { createHash } from "node:crypto";
import type { FailureStatus, ToolEventStatus } from "./errors.js";
export type { FailureStatus, ToolEventStatus };

export type ProviderApi =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type AuthMethod = "oauth" | "api_key";

export interface ModelDefinition {
  readonly provider_id: string;
  readonly id: string;
  readonly api: ProviderApi;
  readonly reasoning_efforts: readonly string[];
  readonly context_window: number | null;
  readonly image_input: boolean | null;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly default_base_url: string;
  readonly auth_methods: readonly AuthMethod[];
  readonly environment_key: string | null;
  readonly fallback_models: readonly ModelDefinition[];
}

export interface Credential {
  readonly type: AuthMethod;
  readonly key?: string;
  readonly access?: string;
  readonly refresh?: string;
  readonly expires_at?: number | null;
  readonly client_id?: string;
  readonly account_id?: string;
}

export interface ProviderStatus {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly AuthMethod[];
  readonly configured: boolean;
  readonly source: "stored" | "environment" | "none";
}

export interface ModelSelection {
  readonly provider_id: string;
  readonly model_id: string;
  readonly reasoning_effort: string;
}

export interface ModelCatalog {
  readonly models: readonly ModelDefinition[];
  readonly warning: string | null;
}

export interface ImageAttachment {
  readonly path: string;
  readonly mime_type: string;
  readonly width: number;
  readonly height: number;
  readonly size_bytes: number;
}

export interface RequestImage {
  readonly mime_type: string;
  readonly data: Buffer;
}

export const PLAN_SCHEMA_VERSION = "2.0";
export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled";
export const PLAN_STEP_STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "completed", "cancelled"];
export const ALLOWED_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set(PLAN_STEP_STATUSES);

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

export function normalizePlan(plan: unknown): PlanItem[] {
  if (!Array.isArray(plan)) {
    throw new Error("plan must be an array.");
  }
  const normalized: PlanItem[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Plan item at index ${index} must be an object.`);
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length !== 2 || !keys.includes("step") || !keys.includes("status")) {
      throw new Error(`Plan item at index ${index} must contain only step and status.`);
    }
    const obj = item as Record<string, unknown>;
    const step = obj.step;
    const status = obj.status;
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`Plan item at index ${index} requires a non-empty step.`);
    }
    if (typeof status !== "string" || !ALLOWED_PLAN_STATUSES.has(status as PlanStatus)) {
      throw new Error(
        `Plan item at index ${index} has invalid status; expected one of ${PLAN_STEP_STATUSES.join(", ")}.`,
      );
    }
    normalized.push({ step: step.trim(), status: status as PlanStatus });
  }
  return normalized;
}

export const normalizePlanItems = normalizePlan;

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "blocked", "complete"];
export const GOAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["blocked", "complete"]);
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export interface GoalRecord {
  objective: string;
  status: GoalStatus;
  [key: string]: unknown;
}

export function goalContinuationReady(goal: unknown): boolean {
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    return false;
  }
  const obj = goal as Record<string, unknown>;
  return obj.status === "active" && typeof obj.objective === "string" && obj.objective.trim().length > 0;
}

export interface SessionIdentity {
  project_id: string | null;
  owner_agent_id: string | null;
  session_type: string | null;
  parent_session_id: string | null;
}

export function normalizeSessionIdentity(raw?: Record<string, unknown> | null): SessionIdentity {
  const source = raw && typeof raw === "object" ? raw : {};
  const cleanStr = (val: unknown): string | null => {
    if (typeof val !== "string") return null;
    const trimmed = val.trim();
    return trimmed ? trimmed : null;
  };
  return {
    project_id: cleanStr(source.project_id),
    owner_agent_id: cleanStr(source.owner_agent_id),
    session_type: cleanStr(source.session_type),
    parent_session_id: cleanStr(source.parent_session_id),
  };
}

export function normalizeGoalObjective(value: unknown): string {
  const objective = String(value ?? "").trim();
  if (!objective) {
    throw new Error("Goal objective must not be empty.");
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
  }
  return objective;
}

export function normalizeGoalStatus(value: unknown): GoalStatus {
  const status = String(value ?? "").trim().toLowerCase() as GoalStatus;
  if (!GOAL_STATUSES.includes(status)) {
    throw new Error(`Goal status must be one of ${GOAL_STATUSES.join(", ")}.`);
  }
  return status;
}

export function normalizeGoal(value: unknown): GoalRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Corrupted goal: expected objective and status.");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("objective") || !keys.includes("status")) {
    throw new Error("Corrupted goal: expected objective and status.");
  }
  const obj = value as Record<string, unknown>;
  return {
    objective: normalizeGoalObjective(obj.objective),
    status: normalizeGoalStatus(obj.status),
  };
}

export const COMPACT_BOUNDARY_KIND = "compact_boundary";
export const COMPACT_CONTINUATION_KIND = "compact_continuation";
export const COMPACT_HANDOFF_KIND = "compact_handoff";
export const COMPACT_POLICY_VERSION = "compact_boundary_v1";

export const COMPACT_CONTINUATION_USER_CONTENT =
  "Continue from the compacted conversation state. " +
  "Use the compact handoff below as the source of prior context.";

export const COMPACT_HANDOFF_REASONING_CONTENT =
  "Compacted context handoff: the summary in this message replaces prior history; " +
  "no separate reasoning trace exists for this boundary.";

export const MANUAL_COMPACT_INPUT_STATUS_PENDING = "pending";
export const MANUAL_COMPACT_INPUT_STATUS_CONSUMED = "consumed";
export const MANUAL_COMPACT_INPUT_STATUS_SUPERSEDED = "superseded";

export interface BoundaryValidationResult {
  ok: boolean;
  reason?: string | null;
  detail: Record<string, unknown>;
}

function invalidBoundary(reason: string, detail: Record<string, unknown> = {}): BoundaryValidationResult {
  return { ok: false, reason, detail };
}

function cleanId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function extractToolCallIds(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const ids: string[] = [];
  for (const item of toolCalls) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = cleanId((item as Record<string, unknown>).id);
      if (id) ids.push(id);
    }
  }
  return ids;
}

export function validateModelMessageBoundary(messages: unknown): BoundaryValidationResult {
  if (!Array.isArray(messages)) {
    return invalidBoundary("messages_not_list");
  }
  let seenNonSystem = false;
  let seenUser = false;
  const pendingToolCalls = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return invalidBoundary("message_not_dict", { index });
    }
    const msg = message as Record<string, unknown>;
    const role = msg.role;
    if (role === "system") {
      if (seenNonSystem) {
        return invalidBoundary("system_after_conversation", { index });
      }
      continue;
    }
    seenNonSystem = true;
    if (role === "user") {
      if (pendingToolCalls.size > 0) {
        return invalidBoundary("assistant_tool_calls_missing_results", { index });
      }
      seenUser = true;
      continue;
    }
    if (role === "assistant") {
      if (!seenUser) {
        return invalidBoundary("assistant_before_user", { index });
      }
      if (pendingToolCalls.size > 0) {
        return invalidBoundary("assistant_tool_calls_missing_results", { index });
      }
      const toolCallIds = extractToolCallIds(msg.tool_calls);
      for (const id of toolCallIds) {
        pendingToolCalls.add(id);
      }
      continue;
    }
    if (role === "tool") {
      if (!seenUser) {
        return invalidBoundary("tool_before_user", { index });
      }
      const toolCallId = cleanId(msg.tool_call_id);
      if (!toolCallId) {
        return invalidBoundary("tool_missing_tool_call_id", { index });
      }
      if (!pendingToolCalls.has(toolCallId)) {
        return invalidBoundary("tool_without_matching_assistant_call", { index, tool_call_id: toolCallId });
      }
      pendingToolCalls.delete(toolCallId);
      continue;
    }
    return invalidBoundary("unsupported_role", { index, role });
  }
  if (!seenUser) {
    return invalidBoundary("missing_user_message");
  }
  if (pendingToolCalls.size > 0) {
    return invalidBoundary("assistant_tool_calls_missing_results", {
      tool_call_ids: Array.from(pendingToolCalls).sort(),
    });
  }
  return { ok: true, detail: {} };
}

export function validateCompactHandoffBoundary(messages: unknown): BoundaryValidationResult {
  const result = validateModelMessageBoundary(messages);
  if (!result.ok) {
    return result;
  }
  const list = messages as Record<string, unknown>[];
  let first: number | null = null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].role !== "system") {
      first = i;
      break;
    }
  }
  if (first === null || first + 1 >= list.length) {
    return invalidBoundary("missing_compact_handoff_pair");
  }
  const user = list[first];
  const assistant = list[first + 1];
  if (user.role !== "user") {
    return invalidBoundary("compact_handoff_missing_user", { index: first });
  }
  if (assistant.role !== "assistant" || (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0)) {
    return invalidBoundary("compact_handoff_missing_assistant", { index: first + 1 });
  }
  if (typeof assistant.content !== "string") {
    return invalidBoundary("compact_handoff_assistant_content_invalid", { index: first + 1 });
  }
  return { ok: true, detail: {} };
}

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

export function validTransition(before: string | null | undefined, after: string): boolean {
  if (!before) return true;
  if (before === after) return true;
  if (TERMINAL_STATES.has(before as TaskStatus)) return false;
  if (before === "queued") return after !== "queued";
  if (before === "running") return after !== "queued";
  return false;
}

const PRIVATE_TASK_KEYS = new Set([
  "committed",
  "delivered",
  "consumed",
  "worker_instance_id",
  "pid",
  "event_id",
  "type",
]);

export function publicTask(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PRIVATE_TASK_KEYS.has(key)) {
      result[key] = value;
    }
  }
  result.handoff = Boolean(record.handoff);
  return result;
}

export type ToolOutputStream = "stdout" | "stderr" | "text" | "none";

export interface ToolResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly status: string;
  readonly data: Record<string, unknown>;
  readonly stdout: string;
  readonly stderr: string;
  readonly text: string;
  readonly error: string | null;
  readonly error_type: string | null;
  readonly meta: Record<string, unknown>;
  readonly attachments: readonly ImageAttachment[];
}

export function createToolResult(params: {
  tool: string;
  ok: boolean;
  status?: string;
  data?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  text?: string;
  error?: string | null;
  error_type?: string | null;
  meta?: Record<string, unknown>;
  attachments?: readonly ImageAttachment[];
}): ToolResult {
  const ok = Boolean(params.ok);
  const status = params.status ? String(params.status) : ok ? "completed" : "failed";
  let error = params.error !== undefined && params.error !== null ? String(params.error) : null;
  let errorType = params.error_type !== undefined && params.error_type !== null ? String(params.error_type) : null;
  if (ok) {
    error = null;
    errorType = null;
  } else {
    if (!error) error = "Tool execution failed.";
    if (!errorType) errorType = "ToolError";
  }
  return {
    tool: String(params.tool),
    ok,
    status,
    data: params.data ? { ...params.data } : {},
    stdout: String(params.stdout ?? ""),
    stderr: String(params.stderr ?? ""),
    text: String(params.text ?? ""),
    error,
    error_type: errorType,
    meta: params.meta ? { ...params.meta } : {},
    attachments: params.attachments ? [...params.attachments] : [],
  };
}

export function serializeToolResult(result: ToolResult): string {
  const payload: Record<string, unknown> = {
    tool: result.tool,
    ok: result.ok,
    status: result.status,
    data: result.data,
    stdout: result.stdout,
    stderr: result.stderr,
    text: result.text,
    error: result.error,
    error_type: result.error_type,
    meta: result.meta,
  };
  if (result.attachments.length > 0) {
    payload.attachments = result.attachments.map(a => ({ ...a }));
  }
  return JSON.stringify(payload);
}

export function parseToolResult(raw: unknown, toolName = "unknown"): ToolResult {
  if (raw && typeof raw === "object" && "tool" in raw && "ok" in raw && "data" in raw && "meta" in raw) {
    const r = raw as ToolResult;
    return createToolResult({
      tool: r.tool,
      ok: r.ok,
      status: r.status,
      data: r.data,
      stdout: r.stdout,
      stderr: r.stderr,
      text: r.text,
      error: r.error,
      error_type: r.error_type,
      meta: r.meta,
      attachments: r.attachments,
    });
  }
  let payload: Record<string, unknown>;
  if (typeof raw === "string") {
    const stripped = raw.trim();
    if (!stripped) {
      throw new Error(`Tool '${toolName}' returned an empty payload.`);
    }
    let loaded: unknown;
    try {
      loaded = JSON.parse(stripped);
    } catch {
      throw new Error(`Tool '${toolName}' did not return valid JSON ToolResult.`);
    }
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
      throw new Error(`Tool '${toolName}' JSON payload must be an object.`);
    }
    payload = loaded as Record<string, unknown>;
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    payload = { ...(raw as Record<string, unknown>) };
  } else {
    throw new Error(`Tool '${toolName}' returned unsupported result type.`);
  }
  if (!("tool" in payload) || !("ok" in payload)) {
    throw new Error(`Tool '${toolName}' result is missing required ToolResult fields.`);
  }
  const data = payload.data ?? {};
  const meta = payload.meta ?? {};
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Tool '${toolName}' field 'data' must be an object.`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`Tool '${toolName}' field 'meta' must be an object.`);
  }
  const rawAttachments = payload.attachments;
  const attachments: ImageAttachment[] = [];
  if (Array.isArray(rawAttachments)) {
    for (const item of rawAttachments) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const a = item as Record<string, unknown>;
        attachments.push({
          path: String(a.path || ""),
          mime_type: String(a.mime_type || ""),
          width: Number(a.width || 0),
          height: Number(a.height || 0),
          size_bytes: Number(a.size_bytes ?? a.byte_size ?? 0),
        });
      }
    }
  }
  const ok = Boolean(payload.ok);
  return createToolResult({
    tool: String(payload.tool || toolName),
    ok,
    status: String(payload.status || (ok ? "completed" : "failed")),
    data: data as Record<string, unknown>,
    stdout: String(payload.stdout ?? ""),
    stderr: String(payload.stderr ?? ""),
    text: String(payload.text ?? ""),
    error: payload.error !== undefined && payload.error !== null ? String(payload.error) : null,
    error_type: payload.error_type !== undefined && payload.error_type !== null ? String(payload.error_type) : null,
    meta: meta as Record<string, unknown>,
    attachments,
  });
}

export function buildToolSummaryText(params: {
  toolName: string;
  ok: boolean;
  status: string;
  data: Record<string, unknown>;
  error: string | null;
  errorType: string | null;
  meta: Record<string, unknown>;
  outputStream: ToolOutputStream;
  outputTotalChars: number;
  previewChars: number;
  truncated: boolean;
}): string {
  const { toolName, ok, status, data, error, errorType, meta, outputStream, outputTotalChars, previewChars, truncated } = params;
  const parts: string[] = [`tool=${toolName}`, `ok=${ok ? "true" : "false"}`, `status=${status}`];
  if (typeof data.path === "string" && data.path) {
    parts.push(`path=${data.path}`);
  }
  if (toolName === "read_file") {
    for (const key of ["offset", "limit", "lines_returned", "total_lines", "next_offset", "eof", "truncated"]) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        parts.push(`${key}=${data[key]}`);
      }
    }
  } else if (toolName === "write_file" || toolName === "edit_file") {
    for (const key of ["created", "bytes_written", "sha256", "previous_sha256", "replacements"]) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        parts.push(`${key}=${data[key]}`);
      }
    }
  } else if (toolName === "glob" || toolName === "grep") {
    for (const key of ["pattern", "glob", "returned", "truncated"]) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        parts.push(`${key}=${data[key]}`);
      }
    }
  } else if (toolName === "bash" || toolName === "task_control") {
    for (const key of ["action", "task_id", "exit_code", "timed_out", "cancelled", "yielded", "notify"]) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        parts.push(`${key}=${data[key]}`);
      }
    }
    if ("duration_ms" in meta && meta.duration_ms !== null && meta.duration_ms !== undefined) {
      parts.push(`duration_ms=${meta.duration_ms}`);
    }
  } else if (toolName === "update_plan") {
    for (const key of ["items_total", "in_progress_step"]) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        parts.push(`${key}=${data[key]}`);
      }
    }
  } else if (toolName === "ask_user_question") {
    if (typeof data.answer === "string" && data.answer) {
      parts.push(`answer_chars=${data.answer.length}`);
    }
  }
  if (outputStream !== "none") {
    parts.push(
      `stream=${outputStream}`,
      `output_chars=${outputTotalChars}`,
      `preview_chars=${previewChars}`,
      `truncated=${truncated ? "true" : "false"}`,
    );
  }
  if (!ok) {
    if (errorType) parts.push(`error_type=${errorType}`);
    if (error) parts.push(`error=${error}`);
  }
  return parts.join(" ");
}

export interface ToolExecutionResult {
  readonly status: "ok" | "error" | "cancelled";
  readonly result_str: string;
  readonly error_msg?: string | null;
  readonly error_type?: string | null;
  readonly failure_status?: FailureStatus | null;
}

export function toolOk(
  tool: string,
  data: unknown = null,
  meta?: Record<string, unknown> | null,
  options?: { attachments?: readonly ImageAttachment[] | null },
): string {
  const payload: Record<string, unknown> = {
    ok: true,
    tool,
    data,
    ts: new Date().toISOString(),
  };
  if (meta !== undefined && meta !== null) {
    payload.meta = meta;
  }
  if (options?.attachments && options.attachments.length > 0) {
    payload.attachments = options.attachments;
  }
  return JSON.stringify(payload);
}

export function toolError(
  tool: string,
  error: string,
  errorType?: string | null,
  meta?: Record<string, unknown> | null,
): string {
  const payload: Record<string, unknown> = {
    ok: false,
    tool,
    error,
    ts: new Date().toISOString(),
  };
  if (errorType) {
    payload.error_type = errorType;
  }
  if (meta !== undefined && meta !== null) {
    payload.meta = meta;
  }
  return JSON.stringify(payload);
}

export function toolCancelled(tool: string, reason?: string | null): string {
  const normalizedReason = reason || "cancelled";
  return toolError(tool, `Tool cancelled: ${normalizedReason}`, "Cancelled", {
    reason: normalizedReason,
  });
}

export interface ParsedToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly raw_args: string;
}

export function looksLikeToolPayload(value: unknown): boolean {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const text = value.trimStart();
  if (!text.startsWith("{")) {
    return false;
  }
  try {
    const obj = JSON.parse(text);
    return Boolean(obj && typeof obj === "object" && !Array.isArray(obj) && "ok" in obj && "tool" in obj);
  } catch {
    return false;
  }
}

export function parseToolArgs(rawArgs: string): [Record<string, unknown>, string | null] {
  if (!rawArgs) {
    return [{}, null];
  }
  let obj: unknown;
  try {
    obj = JSON.parse(rawArgs);
  } catch (err) {
    return [{}, (err as Error).message];
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return [{}, "Tool arguments must be a JSON object."];
  }
  return [obj as Record<string, unknown>, null];
}

export function parseToolResultPayload(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return "ok" in obj && "tool" in obj ? obj : null;
  }
  if (typeof value !== "string" || !value || !value.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const payload = JSON.parse(value);
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "ok" in payload && "tool" in payload) {
      return payload as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

export function classifyToolError(errorType: string): ToolEventStatus {
  const normalized = (errorType || "").toLowerCase();
  if (normalized === "cancelled") {
    return "cancelled";
  }
  if (normalized === "toolnotfound" || normalized === "notfound" || normalized === "userquestionunsupported") {
    return "unavailable";
  }
  if (normalized.includes("timeout") || normalized === "deadlineexceeded") {
    return "timed_out";
  }
  if (
    normalized === "toolargsjsonerror" ||
    normalized === "invalidarguments" ||
    normalized === "invaliduserquestion" ||
    normalized === "typeerror" ||
    normalized === "valueerror"
  ) {
    return "rejected";
  }
  return "failed";
}

export function classifyToolPayload(payload: Record<string, unknown>): [ToolEventStatus, string] | null {
  if (payload.ok === false) {
    const errorType =
      typeof payload.error_type === "string" && payload.error_type
        ? payload.error_type
        : "ToolExecutionError";
    return [classifyToolError(errorType), errorType];
  }
  const data = payload.data;
  const status = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).status
    : null;
  if (status === "cancelled") {
    return ["cancelled", "Cancelled"];
  }
  if (status === "timed_out") {
    return ["timed_out", "Timeout"];
  }
  if (status === "lost" || status === "failed") {
    return ["failed", status === "lost" ? "TaskLost" : "ToolExecutionError"];
  }
  return null;
}

const FENCED_SKILL_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const SLASH_SKILL_RE = /(?:^|(?<=\s))\/skill:([a-z0-9][a-z0-9_-]{0,63})(?=$|\s|[.,;:!?])/gi;
const DOLLAR_SKILL_RE = /(?:^|(?<=\s))\$([a-z0-9][a-z0-9_-]{0,63})(?=$|\s|[.,;:!?])/gi;
const FILE_RULE_BLOCK_RE = /<rind_file_tool_rules>[\s\S]*?<\/rind_file_tool_rules>/;
const ENV_CONTEXT_BLOCK_RE = /<environment_context>[\s\S]*?<\/environment_context>/;

export const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DESCRIPTION_MAX_CHARS = 1024;

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly source: string;
  readonly model_invocable: boolean;
}

export function skillToCatalogEntry(skill: SkillMetadata): { name: string; description: string; location: string } {
  return {
    name: skill.name,
    description: skill.description.slice(0, DESCRIPTION_MAX_CHARS),
    location: skill.location,
  };
}

export interface LoadedSkill {
  readonly metadata: SkillMetadata;
  readonly body: string;
}

export function extractExplicitSkillNames(
  text: string,
  knownSkills?: Iterable<string> | null,
): string[] {
  if (!text) return [];
  const known = knownSkills ? new Set(Array.from(knownSkills, item => item.toLowerCase())) : null;
  const stripped = text.replace(FENCED_SKILL_RE, " ");
  const ordered: string[] = [];
  const seen = new Set<string>();
  const record = (rawName: string, requireKnown: boolean) => {
    const name = rawName.toLowerCase();
    if (seen.has(name)) return;
    if (requireKnown && (!known || !known.has(name))) return;
    if (!requireKnown && known && !known.has(name)) return;
    seen.add(name);
    ordered.push(name);
  };
  for (const match of stripped.matchAll(SLASH_SKILL_RE)) {
    record(match[1], false);
  }
  for (const match of stripped.matchAll(DOLLAR_SKILL_RE)) {
    record(match[1], true);
  }
  return ordered;
}

export function extractUnresolvedSlashSkillNames(
  text: string,
  knownSkills: Iterable<string>,
): string[] {
  if (!text) return [];
  const known = new Set(Array.from(knownSkills, item => item.toLowerCase()));
  const stripped = text.replace(FENCED_SKILL_RE, " ");
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(SLASH_SKILL_RE)) {
    const name = match[1].toLowerCase();
    if (known.has(name) || seen.has(name)) continue;
    seen.add(name);
    unresolved.push(name);
  }
  return unresolved;
}

export const CURRENT_FILE_TOOL_RULES_BLOCK = `<rind_file_tool_rules>
   - All file tools use \`path\` for the absolute or workspace-relative file path.
   - \`read_file\`: Read local images (PNG/JPEG/WebP/GIF/BMP) as attachments, or consecutive complete UTF-8 lines. Omit offset/limit for images. Continue text reads at \`next_offset\`; a LineTooLong error requires a local character-slice read with bash/Python.
   - \`write_file\`: Atomically create or completely overwrite a UTF-8 text file. Use for new files or complete rewrites.
   - \`edit_file\`: Atomically replace one unique, exact text block. Read the target, then supply \`old_str\` and \`new_str\`. No hash parameter is required.
   - Edits and writes to the same file run in call order. Each edit sees earlier changes; a later write replaces the whole file.
</rind_file_tool_rules>`;

const LEGACY_FILE_TOOL_PATTERNS: readonly RegExp[] = [
  /-\s*`read_file`:\s*Read file contents[\s\S]*?(?=\n\s*\n\s*2\.\s*\*\*Code Search & Navigation\*\*)/,
  /-\s*All file tools use `path`[\s\S]*?`expected_sha256`[\s\S]*?(?=\n\s*\n\s*2\.\s*\*\*Code Search & Navigation\*\*)/,
];

export function upgradeSystemPromptText(
  content: string,
  options: {
    currentSystemPrompt?: string | null;
    recognizesBuiltinPrompt?: ((normalizedPrompt: string) => boolean) | null;
  } = {},
): [string, boolean] {
  if (!content) return [content, false];
  const { currentSystemPrompt, recognizesBuiltinPrompt } = options;
  if (currentSystemPrompt && recognizesBuiltinPrompt) {
    if (content === currentSystemPrompt) return [content, false];
    const normalized = normalizePromptEnvironment(content);
    if (recognizesBuiltinPrompt(normalized)) {
      return [currentSystemPrompt, true];
    }
  }
  if (FILE_RULE_BLOCK_RE.test(content)) {
    const updated = content.replace(FILE_RULE_BLOCK_RE, CURRENT_FILE_TOOL_RULES_BLOCK);
    return [updated, updated !== content];
  }
  for (const pattern of LEGACY_FILE_TOOL_PATTERNS) {
    if (pattern.test(content)) {
      const updated = content.replace(pattern, CURRENT_FILE_TOOL_RULES_BLOCK);
      return [updated, updated !== content];
    }
  }
  if (content.includes("expected_sha256")) {
    const updated = `${content.trimEnd()}\n\n${CURRENT_FILE_TOOL_RULES_BLOCK}\n`;
    return [updated, true];
  }
  return [content, false];
}

export function normalizePromptEnvironment(prompt: string): string {
  return prompt.replace(
    ENV_CONTEXT_BLOCK_RE,
    "<environment_context>\nCurrent Working Directory (Project Root): /fixture\nCurrent Date: 2026-01-01\n</environment_context>",
  );
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface ModelUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_tokens: number;
  readonly reasoning_tokens: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface ModelCompletion {
  readonly content: string;
  readonly tool_calls: readonly ParsedToolCall[];
  readonly reasoning_content: string | null;
  readonly usage: ModelUsage | null;
  readonly finish_reason: FinishReason | string | null;
}

export type ModelStreamEventKind =
  | "text_delta"
  | "reasoning_delta"
  | "tool_start"
  | "tool_arguments_delta"
  | "tool_end"
  | "usage"
  | "completed";

export interface ModelStreamEvent {
  readonly kind: ModelStreamEventKind;
  readonly text?: string;
  readonly reasoning?: string;
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly arguments?: string;
  readonly usage?: ModelUsage;
  readonly stop_reason?: string;
}

export interface ChatClient {
  setSessionIdProvider?(provider: (() => string | null) | null): void;
  create(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: import("./cancellation.js").CancellationToken | null,
    options?: {
      maxOutputTokens?: number | null;
      reasoningEffort?: string | null;
      promptCacheKey?: string | null;
    },
  ): Promise<ModelCompletion>;
  stream(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: import("./cancellation.js").CancellationToken | null,
    options?: {
      reasoningEffort?: string | null;
      promptCacheKey?: string | null;
    },
  ): AsyncIterable<ModelStreamEvent>;
  close(): Promise<void>;
}

