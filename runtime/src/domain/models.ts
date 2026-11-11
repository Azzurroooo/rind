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
type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled";
export const PLAN_STEP_STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "completed", "cancelled"];
const ALLOWED_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set(PLAN_STEP_STATUSES);

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

type GoalStatus = "active" | "paused" | "blocked" | "complete";

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "blocked", "complete"];
export const GOAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["blocked", "complete"]);
const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export interface GoalRecord {
  objective: string;
  status: GoalStatus;
  [key: string]: unknown;
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

export const COMPACT_CONTINUATION_USER_CONTENT =
  "Continue from the compacted conversation state. " +
  "Use the compact handoff below as the source of prior context.";

export const COMPACT_HANDOFF_REASONING_CONTENT =
  "Compacted context handoff: the summary in this message replaces prior history; " +
  "no separate reasoning trace exists for this boundary.";

export function isCompactBoundaryMessage(
  message: Record<string, unknown> | null | undefined,
): boolean {
  if (!message || typeof message !== "object") return false;
  const meta = message.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      (meta as Record<string, unknown>).kind === COMPACT_BOUNDARY_KIND,
  );
}

interface BoundaryValidationResult {
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

export function extractToolCallIds(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const ids: string[] = [];
  for (const item of toolCalls) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const id = cleanId(rec.id ?? rec.call_id);
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

export interface ToolExecutionResult {
  readonly status: "ok" | "error" | "cancelled";
  readonly result_str: string;
  readonly error_msg?: string | null;
  readonly error_type?: string | null;
  readonly failure_status?: FailureStatus | null;
  readonly parsed_payload?: Record<string, unknown> | null;
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
  parsed_args?: [Record<string, unknown>, string | null];
}

export function looksLikeToolPayload(value: unknown): boolean {
  return parseToolResultPayload(value) !== null;
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

type ModelStreamEventKind =
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

