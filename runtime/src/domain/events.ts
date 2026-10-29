import { randomUUID } from "node:crypto";
import type { FailureStatus, ToolEventStatus } from "./errors.js";

export function makeEventId(): string {
  return randomUUID().replace(/-/g, "");
}

export function nowUnixString(): string {
  return String(Date.now() / 1000);
}

export interface SessionEventContext {
  session_id?: string | null;
  sessionId?: string | null;
  now_iso?: () => string;
  nowIso?: () => string;
}

export function eventMeta(session?: SessionEventContext | null, turnId = ""): {
  ts: string;
  session_id: string;
  turn_id: string;
} {
  let ts = "";
  try {
    const fn = session?.now_iso || session?.nowIso;
    if (typeof fn === "function") ts = fn.call(session);
  } catch {}
  if (!ts) ts = nowUnixString();
  const sessionId = String(session?.session_id || session?.sessionId || "");
  return {
    ts,
    session_id: sessionId,
    turn_id: turnId || "",
  };
}

export interface RuntimeEventBase {
  type: string;
  ts: string;
  event_id: string;
  session_id: string;
  turn_id: string;
  [key: string]: unknown;
}

export type TypedRuntimeEvent<K extends string, T extends Record<string, unknown>> =
  RuntimeEventBase & { type: K } & T;

export function createEvent<K extends string, T extends Record<string, unknown>>(
  type: K,
  fields: T,
  meta?: { ts?: string; event_id?: string; session_id?: string | null; turn_id?: string | null },
): TypedRuntimeEvent<K, T> {
  return {
    type,
    ts: meta?.ts || (typeof fields.ts === "string" && fields.ts ? fields.ts : nowUnixString()),
    event_id: meta?.event_id || (typeof fields.event_id === "string" && fields.event_id ? fields.event_id : makeEventId()),
    session_id: meta?.session_id ?? (typeof fields.session_id === "string" ? fields.session_id : ""),
    turn_id: meta?.turn_id ?? (typeof fields.turn_id === "string" ? fields.turn_id : ""),
    ...fields,
  } as TypedRuntimeEvent<K, T>;
}

export function assistantDeltaEvent(params: {
  text: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"assistant_delta", { text: string }> {
  return createEvent("assistant_delta", { text: params.text }, params);
}

export function turnStartedEvent(params: {
  user_message_chars?: number;
  operation?: "prompt" | "compact";
  session_id?: string;
  turn_id?: string;
  ts?: string;
  delivery?: boolean;
  delivery_text?: string;
}): TypedRuntimeEvent<"turn_started", {
  user_message_chars: number;
  operation: "prompt" | "compact";
}> {
  return createEvent(
    "turn_started",
    {
      user_message_chars: params.user_message_chars ?? 0,
      operation: params.operation ?? "prompt",
      ...(params.delivery ? { delivery: true, delivery_text: params.delivery_text ?? "" } : {}),
    },
    params,
  );
}

export function contextCompactedEvent(params: {
  record: Record<string, unknown>;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"context_compacted", { record: Record<string, unknown> }> {
  return createEvent("context_compacted", { record: params.record }, params);
}

export function contextBuiltEvent(params: {
  message_count: number;
  stats?: Record<string, unknown>;
  decisions?: Record<string, unknown>;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"context_built", {
  message_count: number;
  stats: Record<string, unknown>;
  decisions: Record<string, unknown>;
}> {
  return createEvent(
    "context_built",
    {
      message_count: params.message_count,
      stats: params.stats ?? {},
      decisions: params.decisions ?? {},
    },
    params,
  );
}

export function turnStepRetryEvent(params: {
  attempt: number;
  reason: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"turn_step_retry", { attempt: number; reason: string }> {
  return createEvent("turn_step_retry", { attempt: params.attempt, reason: params.reason }, params);
}

export function assistantMessageCompletedEvent(params: {
  content: string;
  content_chars?: number;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"assistant_message_completed", { content: string; content_chars: number }> {
  return createEvent(
    "assistant_message_completed",
    {
      content: params.content,
      content_chars: params.content_chars ?? params.content.length,
    },
    params,
  );
}

export function queuedInputDeliveredEvent(params: {
  input_id: string;
  input: string;
  mode: "steering" | "follow_up";
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"queued_input_delivered", {
  input_id: string;
  input: string;
  mode: "steering" | "follow_up";
}> {
  return createEvent(
    "queued_input_delivered",
    {
      input_id: params.input_id,
      input: params.input,
      mode: params.mode,
    },
    params,
  );
}

export function toolRequestedEvent(params: {
  tool_call_id: string;
  tool_name: string;
  args_preview?: string;
  arguments?: Record<string, unknown> | null;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_requested", {
  tool_call_id: string;
  tool_name: string;
  args_preview: string;
  arguments: Record<string, unknown> | null;
}> {
  return createEvent(
    "tool_requested",
    {
      tool_call_id: params.tool_call_id,
      tool_name: params.tool_name,
      args_preview: params.args_preview ?? "",
      arguments: params.arguments ?? null,
    },
    params,
  );
}

export function planUpdatedEvent(params: {
  tool_call_id: string;
  plan: Array<{ step: string; status: string }>;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"plan_updated", {
  tool_call_id: string;
  plan: Array<{ step: string; status: string }>;
}> {
  return createEvent("plan_updated", { tool_call_id: params.tool_call_id, plan: params.plan }, params);
}

export function toolInputStartedEvent(params: {
  tool_call_id: string;
  tool_name: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_input_started", { tool_call_id: string; tool_name: string }> {
  return createEvent(
    "tool_input_started",
    { tool_call_id: params.tool_call_id, tool_name: params.tool_name },
    params,
  );
}

export function toolInputDeltaEvent(params: {
  tool_call_id: string;
  tool_name: string;
  delta: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_input_delta", {
  tool_call_id: string;
  tool_name: string;
  delta: string;
}> {
  return createEvent(
    "tool_input_delta",
    { tool_call_id: params.tool_call_id, tool_name: params.tool_name, delta: params.delta },
    params,
  );
}

export function toolInputEndedEvent(params: {
  tool_call_id: string;
  tool_name: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_input_ended", { tool_call_id: string; tool_name: string }> {
  return createEvent(
    "tool_input_ended",
    { tool_call_id: params.tool_call_id, tool_name: params.tool_name },
    params,
  );
}

export function toolCallStartedEvent(params: {
  tool_call_id: string;
  tool_name: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_call_started", { tool_call_id: string; tool_name: string }> {
  return createEvent(
    "tool_call_started",
    { tool_call_id: params.tool_call_id, tool_name: params.tool_name },
    params,
  );
}

export function userQuestionRequestedEvent(params: {
  tool_call_id: string;
  question: string;
  options?: Array<{ label: string; description?: string }> | null;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"user_question_requested", {
  tool_call_id: string;
  question: string;
  options: Array<{ label: string; description?: string }> | null;
}> {
  return createEvent(
    "user_question_requested",
    {
      tool_call_id: params.tool_call_id,
      question: params.question,
      options: params.options ?? null,
    },
    params,
  );
}

export function toolProgressEvent(params: {
  tool_call_id: string;
  tool_name: string;
  payload?: Record<string, unknown> | null;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_progress", {
  tool_call_id: string;
  tool_name: string;
  payload: Record<string, unknown> | null;
}> {
  return createEvent(
    "tool_progress",
    {
      tool_call_id: params.tool_call_id,
      tool_name: params.tool_name,
      payload: params.payload ?? null,
    },
    params,
  );
}

export function toolResultEvent(params: {
  tool_call_id: string;
  tool_name: string;
  status?: ToolEventStatus;
  result?: string;
  error_type?: string;
  error_source?: string;
  duration_ms?: number;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"tool_result", {
  tool_call_id: string;
  tool_name: string;
  status: ToolEventStatus;
  result: string;
  error_type: string;
  error_source: string;
  duration_ms: number;
}> {
  return createEvent(
    "tool_result",
    {
      tool_call_id: params.tool_call_id,
      tool_name: params.tool_name,
      status: params.status ?? "completed",
      result: params.result ?? "",
      error_type: params.error_type ?? "",
      error_source: params.error_source ?? "",
      duration_ms: params.duration_ms ?? 0,
    },
    params,
  );
}

export function fileChangeEvent(params: {
  tool_call_id: string;
  file_path: string;
  lines: Array<{ kind: string; text: string }>;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"file_change", {
  tool_call_id: string;
  file_path: string;
  lines: Array<{ kind: string; text: string }>;
}> {
  return createEvent(
    "file_change",
    {
      tool_call_id: params.tool_call_id,
      file_path: params.file_path,
      lines: params.lines,
    },
    params,
  );
}

export function tokenStatsUpdatedEvent(params: {
  stats: Record<string, unknown>;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"token_stats_updated", { stats: Record<string, unknown> }> {
  return createEvent("token_stats_updated", { stats: params.stats }, params);
}

export function turnCompletedEvent(params: {
  duration_ms?: number;
  background_wait?: Record<string, unknown> | null;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"turn_completed", { duration_ms: number }> {
  return createEvent(
    "turn_completed",
    {
      duration_ms: params.duration_ms ?? 0,
      ...(params.background_wait !== undefined ? { background_wait: params.background_wait } : {}),
    },
    params,
  );
}

export function turnFailedEvent(params: {
  error: string;
  error_type?: string;
  status?: FailureStatus;
  error_source?: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"turn_failed", {
  error: string;
  error_type: string;
  status: FailureStatus;
  error_source: string;
}> {
  return createEvent(
    "turn_failed",
    {
      error: params.error,
      error_type: params.error_type ?? "",
      status: params.status ?? "failed",
      error_source: params.error_source ?? "runtime",
    },
    params,
  );
}

export function turnCancelledEvent(params: {
  reason?: string;
  session_id?: string;
  turn_id?: string;
  ts?: string;
}): TypedRuntimeEvent<"turn_cancelled", { reason: string }> {
  return createEvent("turn_cancelled", { reason: params.reason ?? "" }, params);
}
