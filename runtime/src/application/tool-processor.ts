import { CancellationTokenSource, type CancellationToken } from "../domain/cancellation.js";
import {
  CancelledError,
  PersistenceError,
  type FailureStatus,
  type ToolEventStatus,
} from "../domain/errors.js";
import {
  eventMeta,
  fileChangeEvent,
  toolCallStartedEvent,
  toolProgressEvent,
  toolResultEvent,
  userQuestionRequestedEvent,
  type RuntimeEventBase,
} from "../domain/events.js";
import {
  classifyToolError,
  classifyToolPayload,
  parseToolArgs,
  parseToolResultPayload,
  toolCancelled,
  toolError,
  toolOk,
  type ParsedToolCall,
  type ToolExecutionResult,
} from "../domain/models.js";
import type { ToolOutputStore } from "../infrastructure/persistence/atomic-files.js";
import {
  ToolResultNormalizer,
  type NormalizedToolResult,
} from "../infrastructure/persistence/result-normalizer.js";
import type { JsonlSessionStore } from "../infrastructure/persistence/session-store.js";
import type { DefaultToolRegistry } from "../infrastructure/tools/registry.js";
import type { TaskNotifications } from "./context-manager.js";

export class ToolExecutor {
  private readonly registry: DefaultToolRegistry;

  constructor(registry: DefaultToolRegistry) {
    this.registry = registry;
  }

  isAsyncTool(name: string): boolean {
    return this.registry.isAsync(name);
  }

  isParallelTool(name: string): boolean {
    return this.registry.isParallel(name);
  }

  executeSync(name: string, args: Record<string, unknown>): ToolExecutionResult {
    if (!this.registry.has(name)) {
      return unavailableResult(name);
    }
    try {
      const res = this.registry.call(name, args);
      return completedResult(res);
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      const err = exc as Error;
      if (err.name === "TimeoutError") return failedResult(err, "timed_out");
      if (err instanceof TypeError) return failedResult(err, "rejected");
      return failedResult(err, "failed");
    }
  }

  async executeAsync(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.registry.has(name)) {
      return unavailableResult(name);
    }
    try {
      const res = await this.registry.callAsync(name, args);
      return completedResult(res);
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      const err = exc as Error;
      if (err.name === "TimeoutError") return failedResult(err, "timed_out");
      if (err instanceof TypeError) return failedResult(err, "rejected");
      return failedResult(err, "failed");
    }
  }
}

function completedResult(result: unknown): ToolExecutionResult {
  return {
    status: "ok",
    result_str: typeof result === "string" ? result : String(result ?? ""),
  };
}

function unavailableResult(name: string): ToolExecutionResult {
  return {
    status: "error",
    result_str: "",
    error_msg: `Unknown tool: ${name}`,
    error_type: "ToolNotFound",
    failure_status: "unavailable",
  };
}

function failedResult(exc: Error, failureStatus: FailureStatus): ToolExecutionResult {
  return {
    status: "error",
    result_str: "",
    error_msg: exc.message || String(exc),
    error_type: exc.name || "Error",
    failure_status: failureStatus,
  };
}

export type UserQuestionResponder = (
  event: RuntimeEventBase & {
    type: "user_question_requested";
    tool_call_id: string;
    question: string;
    options: Array<{ label: string; description?: string }> | null;
  },
) => string | Promise<string>;

function cleanUserQuestionOptions(
  value: unknown,
): Array<{ label: string; description: string }> | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ask_user_question options must be a non-empty array of option objects.");
  }
  const cleaned: Array<{ label: string; description: string }> = [];
  const labels = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each ask_user_question option must be an object.");
    }
    const obj = item as Record<string, unknown>;
    const unknown = Object.keys(obj).filter(k => k !== "label" && k !== "description");
    if (unknown.length > 0) {
      throw new Error(
        `ask_user_question options contain unsupported fields: ${JSON.stringify(unknown.sort())}.`,
      );
    }
    const rawLabel = obj.label;
    const rawDesc = obj.description;
    if (typeof rawLabel !== "string" || !rawLabel.trim()) {
      throw new Error("Each ask_user_question option requires a non-empty label.");
    }
    if (typeof rawDesc !== "string" || !rawDesc.trim()) {
      throw new Error("Each ask_user_question option requires a non-empty description.");
    }
    const label = rawLabel.trim();
    if (labels.has(label)) {
      throw new Error(`ask_user_question option labels must be unique: ${JSON.stringify(label)}.`);
    }
    labels.add(label);
    const hasRec = label.endsWith(" (Recommended)");
    if (index === 0 && !hasRec) {
      throw new Error('The first ask_user_question option label must end with " (Recommended)".');
    }
    if (index > 0 && hasRec) {
      throw new Error('Only the first ask_user_question option may end with " (Recommended)".');
    }
    cleaned.push({ label, description: rawDesc.trim() });
  }
  return cleaned;
}

export function buildUserQuestionEvent(options: {
  session: JsonlSessionStore;
  turnId: string;
  call: ParsedToolCall;
  parsedArgs: Record<string, unknown>;
}): RuntimeEventBase & {
  type: "user_question_requested";
  tool_call_id: string;
  question: string;
  options: Array<{ label: string; description?: string }> | null;
} {
  const rawQuestion = options.parsedArgs.question;
  const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
  if (!question) {
    throw new Error("ask_user_question requires a non-empty question string.");
  }
  if ("recommended" in options.parsedArgs) {
    throw new Error("ask_user_question no longer accepts a top-level recommended field.");
  }
  const cleanOptions = cleanUserQuestionOptions(options.parsedArgs.options);
  return userQuestionRequestedEvent({
    ...eventMeta(options.session, options.turnId),
    tool_call_id: options.call.call_id,
    question,
    options: cleanOptions,
  });
}

export async function runUserQuestion(
  responder: UserQuestionResponder | null,
  event: RuntimeEventBase & {
    type: "user_question_requested";
    tool_call_id: string;
    question: string;
    options: Array<{ label: string; description?: string }> | null;
  },
  cancellationToken?: CancellationToken | null,
): Promise<[ToolEventStatus, string, string]> {
  if (!responder) {
    return [
      "unavailable",
      toolError(
        "ask_user_question",
        "No user-question responder is available in this execution environment.",
        "UserQuestionUnsupported",
      ),
      "UserQuestionUnsupported",
    ];
  }
  let answerValue: string;
  try {
    answerValue = await responder(event);
  } catch (exc) {
    if (exc instanceof CancelledError) throw exc;
    const err = exc as Error;
    const errType = err.name || "Error";
    if (errType === "KeyboardInterrupt" || errType === "EOFError") {
      return [
        "cancelled",
        toolError("ask_user_question", "User question input was interrupted.", errType),
        errType,
      ];
    }
    return ["failed", toolError("ask_user_question", err.message || String(exc), errType), errType];
  }

  if (cancellationToken?.isCancelled) {
    return [
      "cancelled",
      toolCancelled("ask_user_question", cancellationToken.reason),
      "Cancelled",
    ];
  }
  const answer = String(answerValue || "").trim();
  if (!answer) {
    return [
      "failed",
      toolError(
        "ask_user_question",
        "User provided an empty answer.",
        "UserQuestionEmptyAnswer",
      ),
      "UserQuestionEmptyAnswer",
    ];
  }
  return ["completed", toolOk("ask_user_question", { answer }), ""];
}

function splitLines(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((_, idx, arr) => {
    // Match Python str.splitlines() which drops a trailing empty element after a trailing newline
    if (idx === arr.length - 1 && value.endsWith("\n") && arr[idx] === "") return false;
    return true;
  });
}

export function buildFileChangeEvent(options: {
  session: JsonlSessionStore;
  turnId: string;
  call: ParsedToolCall;
  parsedArgs: Record<string, unknown>;
  status: string;
  result: string;
}): (RuntimeEventBase & { type: "file_change" }) | null {
  if (
    options.status !== "completed" ||
    (options.call.name !== "write_file" && options.call.name !== "edit_file")
  ) {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(options.result) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || payload.ok !== true) {
    return null;
  }
  const lines: Array<{ kind: string; text: string }> = [];
  if (options.call.name === "write_file") {
    for (const line of splitLines(options.parsedArgs.content)) {
      lines.push({ kind: "added", text: line });
    }
  } else if (options.call.name === "edit_file") {
    for (const line of splitLines(options.parsedArgs.old_str)) {
      lines.push({ kind: "removed", text: line });
    }
    for (const line of splitLines(options.parsedArgs.new_str)) {
      lines.push({ kind: "added", text: line });
    }
  }
  if (lines.length === 0) return null;
  return fileChangeEvent({
    ...eventMeta(options.session, options.turnId),
    tool_call_id: options.call.call_id,
    file_path: String(options.parsedArgs.path || options.parsedArgs.file_path || ""),
    lines,
  });
}

const HEARTBEAT_TOOLS = new Set(["bash", "task_control", "bash_output"]);

interface ToolCallOutcome {
  status: ToolEventStatus;
  result: string;
  error_type: string;
}

export class ToolCallProcessor {
  static readonly HEARTBEAT_INTERVAL = 10.0;

  private readonly toolExecutor: ToolExecutor;
  private readonly toolResultNormalizer: ToolResultNormalizer;
  private readonly toolOutputStore: ToolOutputStore | null;
  private userQuestionResponder: UserQuestionResponder | null;
  private readonly taskNotifications: TaskNotifications | null;

  constructor(options: {
    toolExecutor: ToolExecutor;
    toolResultNormalizer?: ToolResultNormalizer | null;
    toolOutputStore?: ToolOutputStore | null;
    userQuestionResponder?: UserQuestionResponder | null;
    taskNotifications?: TaskNotifications | null;
  }) {
    this.toolExecutor = options.toolExecutor;
    this.toolResultNormalizer = options.toolResultNormalizer ?? new ToolResultNormalizer();
    this.toolOutputStore = options.toolOutputStore ?? null;
    this.userQuestionResponder = options.userQuestionResponder ?? null;
    this.taskNotifications = options.taskNotifications ?? null;
  }

  setUserQuestionResponder(responder: UserQuestionResponder | null): void {
    this.userQuestionResponder = responder;
  }

  private isParallelCall(
    call: ParsedToolCall,
    parsedArgs: Record<string, unknown>,
    parseError: string | null,
  ): boolean {
    if (parseError || call.name === "ask_user_question" || HEARTBEAT_TOOLS.has(call.name)) {
      return false;
    }
    if (Boolean(parsedArgs.wait)) {
      return false;
    }
    return this.toolExecutor.isParallelTool(call.name);
  }

  async *execute(
    session: JsonlSessionStore,
    toolCalls: readonly ParsedToolCall[],
    cancellationToken?: CancellationToken | null,
    turnId = "",
  ): AsyncGenerator<RuntimeEventBase, void, void> {
    let index = 0;
    const total = toolCalls.length;
    while (index < total) {
      const call = toolCalls[index]!;
      const startedAt = performance.now();
      const [parsedArgs, parseError] = parseToolArgs(call.raw_args);
      const tsStart = session.nowIso();
      const existing = await this.loadToolRecord(session, call);

      if (
        existing !== null ||
        cancellationToken?.isCancelled ||
        parseError ||
        !this.isParallelCall(call, parsedArgs ?? {}, parseError)
      ) {
        index += 1;
        for await (const event of this.executeSerialCall({
          session,
          turnId,
          call,
          parsedArgs: parsedArgs ?? {},
          parseError,
          existing,
          tsStart,
          startedAt,
          cancellationToken: cancellationToken ?? null,
        })) {
          yield event;
        }
        continue;
      }

      const batch: Array<[ParsedToolCall, Record<string, unknown>, string, number]> = [
        [call, parsedArgs ?? {}, tsStart, startedAt],
      ];
      index += 1;
      while (index < total) {
        const nextCall = toolCalls[index]!;
        const [nextArgs, nextError] = parseToolArgs(nextCall.raw_args);
        if (!this.isParallelCall(nextCall, nextArgs ?? {}, nextError)) {
          break;
        }
        if ((await this.loadToolRecord(session, nextCall)) !== null) {
          break;
        }
        batch.push([nextCall, nextArgs ?? {}, session.nowIso(), performance.now()]);
        index += 1;
      }

      for (const [bCall] of batch) {
        yield toolCallStartedEvent({
          ...eventMeta(session, turnId),
          tool_call_id: bCall.call_id,
          tool_name: bCall.name,
        });
      }

      const sessionId = session.sessionId || "default";
      const outcomes = await Promise.all(
        batch.map(([bCall, bArgs]) =>
          this.runToolCall({
            call: bCall,
            parsedArgs: bArgs,
            sessionId,
            cancellationToken: cancellationToken ?? null,
            turnId,
          }),
        ),
      );

      for (let i = 0; i < batch.length; i += 1) {
        const [bCall, bArgs, bTsStart, bStartedAt] = batch[i]!;
        const outcome = outcomes[i]!;
        for await (const event of this.finishToolCall({
          session,
          turnId,
          call: bCall,
          parsedArgs: bArgs,
          outcome,
          reused: false,
          tsStart: bTsStart,
          startedAt: bStartedAt,
        })) {
          yield event;
        }
      }
    }
  }

  private async *executeSerialCall(options: {
    session: JsonlSessionStore;
    turnId: string;
    call: ParsedToolCall;
    parsedArgs: Record<string, unknown>;
    parseError: string | null;
    existing: Record<string, unknown> | null;
    tsStart: string;
    startedAt: number;
    cancellationToken: CancellationToken | null;
  }): AsyncGenerator<RuntimeEventBase, void, void> {
    const { session, turnId, call, parseError, existing, tsStart, startedAt, cancellationToken } =
      options;
    let parsedArgs = options.parsedArgs;
    let reused = false;
    let outcome: ToolCallOutcome;

    if (existing !== null) {
      if (existing.args && typeof existing.args === "object") {
        parsedArgs = existing.args as Record<string, unknown>;
      }
      outcome = this.outcomeFromRecord(existing);
      reused = true;
    } else if (cancellationToken?.isCancelled) {
      outcome = {
        status: "cancelled",
        error_type: "Cancelled",
        result: toolCancelled(call.name, cancellationToken.reason),
      };
    } else if (parseError) {
      outcome = {
        status: "rejected",
        error_type: "ToolArgsJSONError",
        result: toolError(
          call.name,
          `Invalid tool arguments JSON: ${parseError}`,
          "ToolArgsJSONError",
          { raw_args: call.raw_args.slice(0, 2000) },
        ),
      };
    } else {
      yield toolCallStartedEvent({
        ...eventMeta(session, turnId),
        tool_call_id: call.call_id,
        tool_name: call.name,
      });

      if (call.name === "ask_user_question") {
        let questionEvent: ReturnType<typeof buildUserQuestionEvent> | null = null;
        try {
          questionEvent = buildUserQuestionEvent({
            session,
            turnId,
            call,
            parsedArgs,
          });
        } catch (exc) {
          outcome = {
            status: "rejected",
            error_type: "InvalidUserQuestion",
            result: toolError(
              "ask_user_question",
              (exc as Error).message || String(exc),
              "InvalidUserQuestion",
            ),
          };
        }
        if (questionEvent !== null) {
          yield questionEvent;
          const [status, result, errorType] = await runUserQuestion(
            this.userQuestionResponder,
            questionEvent,
            cancellationToken,
          );
          outcome = { status, result, error_type: errorType };
        } else {
          outcome = outcome!;
        }
      } else {
        const execPromise = this.runToolCall({
          call,
          parsedArgs,
          sessionId: session.sessionId || "default",
          cancellationToken,
          turnId,
        });
        if (!HEARTBEAT_TOOLS.has(call.name)) {
          outcome = await execPromise;
        } else {
          let done = false;
          execPromise.then(
            () => {
              done = true;
            },
            () => {
              done = true;
            },
          );
          while (!done) {
            let timer: ReturnType<typeof setTimeout> | null = null;
            let raceRes: { kind: "done"; value: Awaited<typeof execPromise> } | { kind: "tick" };
            try {
              raceRes = await Promise.race([
                execPromise.then(r => ({ kind: "done" as const, value: r })),
                new Promise<{ kind: "tick" }>(resolve => {
                  timer = setTimeout(
                    () => resolve({ kind: "tick" }),
                    ToolCallProcessor.HEARTBEAT_INTERVAL * 1000,
                  );
                }),
              ]);
            } finally {
              if (timer !== null) {
                clearTimeout(timer);
              }
            }
            if (raceRes.kind === "done") {
              outcome = raceRes.value;
              break;
            }
            const elapsedSeconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
            yield toolProgressEvent({
              ...eventMeta(session, turnId),
              tool_call_id: call.call_id,
              tool_name: call.name,
              payload: {
                message: `still running (${elapsedSeconds}s)`,
              },
            });
          }
          outcome = await execPromise;
        }
      }
    }

    for await (const event of this.finishToolCall({
      session,
      turnId,
      call,
      parsedArgs,
      outcome,
      reused,
      tsStart,
      startedAt,
    })) {
      yield event;
    }
  }

  private async *finishToolCall(options: {
    session: JsonlSessionStore;
    turnId: string;
    call: ParsedToolCall;
    parsedArgs: Record<string, unknown>;
    outcome: ToolCallOutcome;
    reused: boolean;
    tsStart: string;
    startedAt: number;
  }): AsyncGenerator<RuntimeEventBase, void, void> {
    const { session, turnId, call, parsedArgs, reused, tsStart, startedAt } = options;
    let outcome = options.outcome;
    const tsEnd = session.nowIso();

    let normalizedResult = await this.toolResultNormalizer.normalize(outcome.result, {
      toolName: call.name,
      status: outcome.status,
      errorType: outcome.error_type,
      outputStore: this.toolOutputStore,
      sessionId: session.sessionId || "",
      callId: call.call_id,
    });

    const projected = parseToolResultPayload(normalizedResult.model_content);
    const projectedStatus = projected ? classifyToolPayload(projected) : null;
    if (outcome.status === "completed" && projectedStatus) {
      outcome = {
        ...outcome,
        status: projectedStatus[0],
        error_type: projectedStatus[1],
      };
    }

    let persistError: Error | null = null;
    try {
      if (!reused) {
        await this.persistToolResult({
          session,
          call,
          parsedArgs,
          tsStart,
          tsEnd,
          normalizedResult,
          resultContent: outcome.result,
        });
      }
      if (this.taskNotifications && session.sessionId) {
        await this.taskNotifications.resultCommitted(
          session.sessionId,
          call.name,
          call.call_id,
          outcome.result,
        );
      }
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      persistError = exc instanceof Error ? exc : new Error(String(exc));
      outcome = {
        status: "failed",
        error_type: "PersistenceError",
        result: toolError(
          call.name,
          `Failed to persist tool result: ${persistError.message}`,
          "PersistenceError",
        ),
      };
      normalizedResult = await this.toolResultNormalizer.normalize(outcome.result, {
        toolName: call.name,
        status: outcome.status,
        errorType: outcome.error_type,
      });
    }

    const durationMs = Math.trunc(performance.now() - startedAt);
    const changeEvent = reused
      ? null
      : buildFileChangeEvent({
          session,
          turnId,
          call,
          parsedArgs,
          status: outcome.status,
          result: outcome.result,
        });
    if (changeEvent !== null) {
      yield changeEvent;
    }

    yield toolResultEvent({
      ...eventMeta(session, turnId),
      tool_call_id: call.call_id,
      tool_name: call.name,
      status: outcome.status,
      result: normalizedResult.terminal_content,
      error_type: outcome.error_type,
      error_source: persistError !== null ? "persistence" : "tool",
      duration_ms: durationMs,
    });

    if (persistError !== null) {
      throw new PersistenceError(
        `Failed to persist tool result for ${call.call_id}: ${persistError.message}`,
        { code: persistError.name || "Error", cause: persistError },
      );
    }
  }

  private async runToolCall(options: {
    call: ParsedToolCall;
    parsedArgs: Record<string, unknown>;
    sessionId: string;
    cancellationToken: CancellationToken | null;
    turnId: string;
  }): Promise<ToolCallOutcome> {
    const { call, parsedArgs, sessionId, cancellationToken, turnId } = options;
    try {
      const executionArgs: Record<string, unknown> = {
        ...parsedArgs,
        _session_id: sessionId,
        _cancellation_token: cancellationToken,
        _idempotency_key: call.call_id,
        _output_store: this.toolOutputStore,
        _origin_turn_id: turnId,
        _request_id:
          this.taskNotifications && this.taskNotifications.requestId
            ? this.taskNotifications.requestId(sessionId)
            : null,
      };
      let result: ToolExecutionResult;
      if (this.toolExecutor.isAsyncTool(call.name)) {
        result = await this.toolExecutor.executeAsync(call.name, executionArgs);
      } else {
        const cancellation = new CancellationTokenSource(cancellationToken);
        executionArgs._cancellation_token = cancellation.token;
        try {
          result = this.toolExecutor.executeSync(call.name, executionArgs);
        } finally {
          cancellation.dispose();
        }
      }

      if (result.status === "ok") {
        let toolResultStr = result.result_str;
        const payload = parseToolResultPayload(toolResultStr);
        if (payload === null) {
          toolResultStr = toolOk(call.name, toolResultStr);
        }
        const payloadStatus = payload ? classifyToolPayload(payload) : null;
        if (payloadStatus) {
          return {
            status: payloadStatus[0],
            error_type: payloadStatus[1],
            result: toolResultStr,
          };
        }
        return { status: "completed", error_type: "", result: toolResultStr };
      }

      const errorType = result.error_type || "ToolExecutionError";
      if (result.status === "cancelled") {
        return {
          status: "cancelled",
          error_type: errorType,
          result: result.result_str || toolCancelled(call.name, result.error_msg),
        };
      }
      return {
        status: (result.failure_status || classifyToolError(errorType)) as ToolEventStatus,
        error_type: errorType,
        result: toolError(call.name, result.error_msg || "Tool error", errorType),
      };
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      const err = exc as Error;
      const errorType = err.name || "Error";
      return {
        status: "failed",
        error_type: errorType,
        result: toolError(call.name, err.message || String(exc), errorType),
      };
    }
  }

  private async loadToolRecord(
    session: JsonlSessionStore,
    call: ParsedToolCall,
  ): Promise<Record<string, unknown> | null> {
    const records = await session.getToolRecords([call.call_id]);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (
        record &&
        typeof record === "object" &&
        String(record.id || "") === call.call_id &&
        String(record.name || "") === call.name &&
        String(record.raw_args || "") === call.raw_args
      ) {
        return record;
      }
    }
    return null;
  }

  private outcomeFromRecord(record: Record<string, unknown>): ToolCallOutcome {
    let result = record.result;
    if (result && typeof result === "object" && Array.isArray(record.attachments)) {
      result = { ...(result as Record<string, unknown>), attachments: record.attachments };
    }
    const resultContent = typeof result === "string" ? result : JSON.stringify(result);
    const payload = parseToolResultPayload(resultContent);
    const payloadStatus = payload ? classifyToolPayload(payload) : null;
    const errorType = String(record.error_type || "");
    const status: ToolEventStatus =
      record.ok === true
        ? "completed"
        : classifyToolError(errorType || "ToolExecutionError");
    return {
      status: payloadStatus ? payloadStatus[0] : status,
      error_type: payloadStatus ? payloadStatus[1] : errorType,
      result: resultContent,
    };
  }

  private async persistToolResult(options: {
    session: JsonlSessionStore;
    call: ParsedToolCall;
    parsedArgs: Record<string, unknown>;
    tsStart: string;
    tsEnd: string;
    normalizedResult: NormalizedToolResult;
    resultContent: string;
  }): Promise<void> {
    const { session, call, parsedArgs, tsStart, tsEnd, normalizedResult, resultContent } = options;
    await session.persistToolCall(
      call.call_id,
      call.name,
      { ...parsedArgs },
      call.raw_args,
      tsStart,
      tsEnd,
      resultContent,
      normalizedResult.model_content,
      normalizedResult.model_content_format,
      normalizedResult.model_content_policy,
      normalizedResult.attachments && normalizedResult.attachments.length > 0
        ? [...normalizedResult.attachments]
        : null,
    );
    await session.persistMessage("tool", "", {
      toolCallId: call.call_id,
      toolName: call.name,
    });
  }
}
