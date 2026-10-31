import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CompactionService,
  ContextBudget,
  ContextEstimator,
  ContextManager,
   DEFAULT_CONTEXT_WINDOW_TOKENS,
  TaskNotifications,
  attachContextAnchor,
  buildContextSnapshot,
  buildUsageRecord,
  normalizeSamplingUsage,
  positiveInt,
  type ContextBuildResult,
} from "../application/context-manager.js";
import {
  ToolCallProcessor,
  ToolExecutor,
  type UserQuestionResponder,
} from "../application/tool-processor.js";
import { AsyncSemaphore, type CancellationToken } from "../domain/cancellation.js";
import {
  BoundaryError,
  CancelledError,
  InputQueueError,
  PersistenceError,
  ProviderError,
} from "../domain/errors.js";
import {
  assistantDeltaEvent,
  assistantMessageCompletedEvent,
  contextBuiltEvent,
  contextCompactedEvent,
  eventMeta,
  planUpdatedEvent,
  queuedInputDeliveredEvent,
  tokenStatsUpdatedEvent,
  toolInputDeltaEvent,
  toolInputEndedEvent,
  toolInputStartedEvent,
  toolRequestedEvent,
  turnCancelledEvent,
  turnCompletedEvent,
  turnFailedEvent,
  turnStartedEvent,
  turnStepRetryEvent,
  type RuntimeEventBase,
} from "../domain/events.js";
import {
  parseToolArgs,
  validateCompactHandoffBoundary,
  validateModelMessageBoundary,
  type ChatClient,
  type ImageAttachment,
  type ModelStreamEvent,
  type ModelUsage,
  type ParsedToolCall,
} from "../domain/models.js";
import {
  checkImageBudget,
  imageBudgetExceeded,
  prepareImageMessages,
} from "../infrastructure/images.js";
import { expandTilde, getSystemInfo } from "../infrastructure/paths.js";
import { ToolOutputStore } from "../infrastructure/persistence/atomic-files.js";
import { ToolResultNormalizer } from "../infrastructure/persistence/result-normalizer.js";
import {
  JsonlSessionStore,
  buildPlanSnapshot,
} from "../infrastructure/persistence/session-store.js";
import {
  appendUsageRecord,
  defaultUsageLedgerPath,
} from "../infrastructure/persistence/usage-ledger.js";
import { buildRindDocContext } from "../infrastructure/rind-docs.js";
import { loadSettings, type AppSettings } from "../infrastructure/settings.js";
import { SkillRepository, SkillTurnCoordinator } from "../infrastructure/skills.js";
import {
  buildBuiltinToolSpecs,
  type ExternalTool,
} from "../infrastructure/tools/control-tools.js";
import { FileMutationQueue } from "../infrastructure/tools/file-tools.js";
import { DefaultToolRegistry, type ToolFunctionSchema } from "../infrastructure/tools/registry.js";
import { ShellTools } from "../infrastructure/tools/shell-tools.js";
import { WebSessions } from "../infrastructure/tools/web-tools.js";
import { buildGoalPolicyPrompt, buildSystemPrompt } from "../prompts.js";

export class MessageStreamParser {
  async consumeAsyncStream(
    response: AsyncIterable<ModelStreamEvent>,
    onContentAsync: (text: string) => unknown | Promise<unknown>,
    cancellationToken?: CancellationToken | null,
    onToolInputStartedAsync?: ((callId: string, name: string) => unknown | Promise<unknown>) | null,
    onToolInputDeltaAsync?:
      | ((callId: string, name: string, delta: string) => unknown | Promise<unknown>)
      | null,
    onToolInputEndedAsync?: ((callId: string, name: string) => unknown | Promise<unknown>) | null,
  ): Promise<[string, ParsedToolCall[], ModelUsage | null, string | null, string | null]> {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls = new Map<
      string,
      { name: string; arguments: string; started: boolean; ended: boolean }
    >();
    let usage: ModelUsage | null = null;
    let finishReason: string | null = null;

    const getSlot = (
      callId: string,
      started = false,
    ): { name: string; arguments: string; started: boolean; ended: boolean } => {
      let slot = toolCalls.get(callId);
      if (!slot) {
        slot = { name: "", arguments: "", started, ended: false };
        toolCalls.set(callId, slot);
      }
      return slot;
    };

    for await (const event of response) {
      if (cancellationToken?.isCancelled) {
        throw new CancelledError(cancellationToken.reason);
      }
      if (event.kind === "text_delta") {
        if (event.text) {
          await onContentAsync(event.text);
          textParts.push(event.text);
        }
      } else if (event.kind === "reasoning_delta") {
        if (event.reasoning !== undefined && event.reasoning !== null) {
          reasoningParts.push(event.reasoning);
        }
      } else if (event.kind === "tool_start") {
        const callId = event.tool_call_id || "";
        const call = getSlot(callId);
        call.name = event.tool_name || call.name;
        if (!call.started) {
          call.started = true;
          if (onToolInputStartedAsync) {
            await onToolInputStartedAsync(callId, call.name);
          }
        }
      } else if (event.kind === "tool_arguments_delta") {
        const callId = event.tool_call_id || "";
        const call = getSlot(callId, true);
        call.name = event.tool_name || call.name;
        const delta = event.arguments || "";
        call.arguments += delta;
        if (onToolInputDeltaAsync && delta) {
          await onToolInputDeltaAsync(callId, call.name, delta);
        }
      } else if (event.kind === "tool_end") {
        const callId = event.tool_call_id || "";
        const call = toolCalls.get(callId);
        if (call && !call.ended) {
          call.ended = true;
          if (onToolInputEndedAsync) {
            await onToolInputEndedAsync(callId, call.name);
          }
        }
      } else if (event.kind === "usage") {
        if (event.usage) {
          usage = event.usage;
        }
      } else if (event.kind === "completed") {
        finishReason = event.stop_reason ?? null;
      }
    }

    if (onToolInputEndedAsync) {
      for (const [callId, call] of toolCalls.entries()) {
        if (call.started && !call.ended) {
          await onToolInputEndedAsync(callId, call.name);
        }
      }
    }

    const calls: ParsedToolCall[] = [];
    for (const [callId, call] of toolCalls.entries()) {
      if (callId && call.name) {
        calls.push({
          call_id: callId,
          name: call.name,
          raw_args: call.arguments,
        });
      }
    }
    const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join("") : null;
    return [textParts.join(""), calls, usage, reasoningContent, finishReason];
  }
}

export class ModelStreamResult {
  content = "";
  tool_calls: ParsedToolCall[] = [];
  reasoning_content: string | null = null;
  finish_reason: string | null = null;
}

export async function* pumpModelStreamEvents(options: {
  streamResponse: AsyncIterable<ModelStreamEvent>;
  streamParser: MessageStreamParser;
  session: JsonlSessionStore;
  turnId: string;
  cancellationToken: CancellationToken | null;
  contextStats: Record<string, unknown>;
  persistSamplingUsage: (session: JsonlSessionStore, usage: Record<string, unknown>) => Promise<void>;
  result: ModelStreamResult;
}): AsyncGenerator<RuntimeEventBase, void, void> {
  const {
    streamResponse,
    streamParser,
    session,
    turnId,
    cancellationToken,
    contextStats,
    persistSamplingUsage,
    result,
  } = options;

  const eventQueue: RuntimeEventBase[] = [];
  let notifyConsumer = null as (() => void) | null;
  let done = false;
  let error: unknown = null;

  const wakeConsumer = (): void => {
    if (notifyConsumer) {
      const fn = notifyConsumer;
      notifyConsumer = null;
      fn();
    }
  };

  const pushEvent = (ev: RuntimeEventBase): void => {
    eventQueue.push(ev);
    wakeConsumer();
  };

  const unsubscribeCancel = cancellationToken
    ? cancellationToken.registerCallback(() => {
        if (!done) {
          error = new CancelledError(cancellationToken.reason || "User interrupted");
          done = true;
          wakeConsumer();
        }
      })
    : () => {};

  const consumePromise = (async (): Promise<void> => {
    try {
      const onContentAsync = async (text: string): Promise<void> => {
        for (let start = 0; start < text.length; start += 2048) {
          pushEvent(
            assistantDeltaEvent({
              ...eventMeta(session, turnId),
              text: text.slice(start, start + 2048),
            }),
          );
        }
      };
      const onToolInputStartedAsync = async (callId: string, name: string): Promise<void> => {
        pushEvent(
          toolInputStartedEvent({
            ...eventMeta(session, turnId),
            tool_call_id: callId,
            tool_name: name,
          }),
        );
      };
      const onToolInputDeltaAsync = async (
        callId: string,
        name: string,
        delta: string,
      ): Promise<void> => {
        for (let start = 0; start < delta.length; start += 2048) {
          pushEvent(
            toolInputDeltaEvent({
              ...eventMeta(session, turnId),
              tool_call_id: callId,
              tool_name: name,
              delta: delta.slice(start, start + 2048),
            }),
          );
        }
      };
      const onToolInputEndedAsync = async (callId: string, name: string): Promise<void> => {
        pushEvent(
          toolInputEndedEvent({
            ...eventMeta(session, turnId),
            tool_call_id: callId,
            tool_name: name,
          }),
        );
      };

      const [content, calls, usage, reasoningContent, finishReason] =
        await streamParser.consumeAsyncStream(
          streamResponse,
          onContentAsync,
          cancellationToken,
          onToolInputStartedAsync,
          onToolInputDeltaAsync,
          onToolInputEndedAsync,
        );

      result.content = String(content || "");
      result.tool_calls = [...calls];
      result.reasoning_content = typeof reasoningContent === "string" ? reasoningContent : null;
      result.finish_reason = finishReason !== null ? String(finishReason) : null;

      if (usage) {
        const normalized = normalizeSamplingUsage(usage, {
          samplingKind: "assistant",
          contextWindowTokens: positiveInt(
            contextStats.context_window_tokens,
            DEFAULT_CONTEXT_WINDOW_TOKENS,
          ),
        });
        if (normalized) {
          const anchored = attachContextAnchor(normalized, {
            contextStats,
            model: session.model,
            compactGeneration: positiveInt(contextStats.auto_compact_compact_generation, 1),
          });
          await persistSamplingUsage(session, anchored);
          pushEvent(
            tokenStatsUpdatedEvent({
              ...eventMeta(session, turnId),
              stats: anchored,
            }),
          );
        }
      }
    } catch (exc) {
      if (!error) {
        error = exc;
      }
    } finally {
      done = true;
      wakeConsumer();
    }
  })();

  try {
    while (true) {
      if (eventQueue.length === 0) {
        if (done) {
          if (error) throw error;
          break;
        }
        await new Promise<void>(resolve => {
          notifyConsumer = resolve;
        });
        continue;
      }
      if (cancellationToken?.isCancelled) {
        throw new CancelledError(cancellationToken.reason || "User interrupted");
      }
      const event = eventQueue.shift()!;
      if (event.type === "assistant_delta") {
        const parts = [String(event.text || "")];
        let textBytes = Buffer.byteLength(parts[0]!, "utf8");
        while (textBytes < 8192 && eventQueue.length > 0) {
          const next = eventQueue[0]!;
          if (next.type !== "assistant_delta") break;
          const nextText = String(next.text || "");
          const size = Buffer.byteLength(nextText, "utf8");
          if (textBytes + size > 8192) break;
          eventQueue.shift();
          parts.push(nextText);
          textBytes += size;
        }
        event.text = parts.join("");
      }
      yield event;
    }

    await consumePromise;
  } finally {
    unsubscribeCancel();
    void consumePromise.catch(() => {});
  }
}

const MAX_STEP_RECOVERY_ATTEMPTS = 3;

function compactDiagnostics(phaseDetail?: string | null): Record<string, unknown> | null {
  if (!phaseDetail) return null;
  return { auto_compact_phase_detail: phaseDetail };
}

function buildContextBuiltEvent(
  context: ContextBuildResult,
  session: JsonlSessionStore,
  turnId: string,
): RuntimeEventBase & { type: "context_built" } {
  return contextBuiltEvent({
    ...eventMeta(session, turnId),
    message_count: context.messages.length,
    stats: { ...context.stats },
    decisions: { ...context.decisions },
  });
}

export class TurnRunner {
  private chatClient: ChatClient;
  private readonly toolProcessor: ToolCallProcessor;
  private readonly streamParser: MessageStreamParser;
  private readonly toolSchemas: ToolFunctionSchema[];
  private readonly contextManager: ContextManager;
  private readonly compactionService: CompactionService;
  private readonly skills: SkillTurnCoordinator | null;
  private readonly usageRecorder: ((record: Record<string, unknown>) => unknown) | null;
  private readonly prepareMessages:
    | ((
        messages: Record<string, unknown>[],
        options: { imageInput: boolean | null; compact?: boolean },
      ) => Promise<Record<string, unknown>[]>)
    | null;
  private _imageInput: boolean | null;
  private readonly taskNotifications: TaskNotifications | null;

  constructor(options: {
    chatClient: ChatClient;
    toolProcessor: ToolCallProcessor;
    streamParser: MessageStreamParser;
    toolSchemas: ToolFunctionSchema[];
    contextManager: ContextManager;
    compactionService?: CompactionService | null;
    skills?: SkillTurnCoordinator | null;
    usageRecorder?: ((record: Record<string, unknown>) => unknown) | null;
    prepareMessages?:
      | ((
          messages: Record<string, unknown>[],
          options: { imageInput: boolean | null; compact?: boolean },
        ) => Promise<Record<string, unknown>[]>)
      | null;
    imageInput?: boolean | null;
    taskNotifications?: TaskNotifications | null;
  }) {
    this.chatClient = options.chatClient;
    this.toolProcessor = options.toolProcessor;
    this.streamParser = options.streamParser;
    this.toolSchemas = options.toolSchemas;
    this.contextManager = options.contextManager;
    this.compactionService = options.compactionService ?? new CompactionService();
    this.skills = options.skills ?? null;
    this.usageRecorder = options.usageRecorder ?? null;
    this.prepareMessages = options.prepareMessages ?? null;
    this._imageInput = options.imageInput ?? null;
    this.taskNotifications = options.taskNotifications ?? null;
  }

  get imageInput(): boolean | null {
    return this._imageInput;
  }

  replaceChatClient(chatClient: ChatClient, options: { imageInput: boolean | null }): void {
    this.chatClient = chatClient;
    this._imageInput = options.imageInput;
  }

  setUserQuestionResponder(responder: UserQuestionResponder | null): void {
    this.toolProcessor.setUserQuestionResponder(responder);
  }

  private bindSession(session: JsonlSessionStore): void {
    if (typeof this.chatClient.setSessionIdProvider === "function") {
      this.chatClient.setSessionIdProvider(() => session.sessionId);
    }
  }

  private async toolsForSession(
    session: JsonlSessionStore,
  ): Promise<Array<Record<string, unknown>>> {
    const rawSchemas = this.toolSchemas as unknown as Array<Record<string, unknown>>;
    const hasUpdateGoal = this.toolSchemas.some(t => t.function.name === "update_goal");
    if (!hasUpdateGoal) {
      return rawSchemas;
    }
    const goal = await session.getGoal();
    if (goal && goal.status === "active") {
      return rawSchemas;
    }
    return this.toolSchemas
      .filter(t => t.function.name !== "update_goal")
      .map(t => t as unknown as Record<string, unknown>);
  }

  private async prepareForModel(
    messages: Record<string, unknown>[],
    options?: { compact?: boolean },
  ): Promise<Record<string, unknown>[]> {
    if (!this.prepareMessages) return messages;
    return await this.prepareMessages(messages, {
      imageInput: this._imageInput,
      compact: options?.compact,
    });
  }

  async *runTurn(options: {
    session: JsonlSessionStore;
    cancellationToken?: CancellationToken | null;
    turnId?: string;
    transientSystemMessages?: Record<string, unknown>[] | null;
    takeSteering?: (() => [string, string] | null) | null;
    resume?: boolean;
  }): AsyncGenerator<RuntimeEventBase, void, void> {
    const {
      session,
      cancellationToken = null,
      turnId = "",
      transientSystemMessages = null,
      takeSteering = null,
    } = options;
    let resume = options.resume ?? false;
    const turnStartedAt = performance.now();
    this.bindSession(session);
    const originalHardLimit = this.contextManager.snapshotHardLimit();

    try {
      let samplingIndex = 0;
      let steeringForSampling = false;
      let forceRescueNextBuild = false;
      let contextLengthRecoveryCount = 0;
      let imageNoticeSent = false;
      let initialRecoveryAttempt = await this.currentRecoveryAttempt(session);

      if (resume) {
        const pendingToolCalls = await this.pendingToolCalls(session);
        if (pendingToolCalls.length > 0) {
          for await (const event of this.toolProcessor.execute(
            session,
            pendingToolCalls,
            cancellationToken,
            turnId,
          )) {
            yield event;
          }
        }
        resume = false;
      }

      while (true) {
        if (cancellationToken?.isCancelled) {
          yield this.cancelledEvent(session, turnId, cancellationToken);
          return;
        }

        if (this.taskNotifications) {
          await this.taskNotifications.deliver(session);
        }
        const taskContext =
          this.taskNotifications && session.sessionId
            ? await this.taskNotifications.references(session.sessionId)
            : [];
        let context = await this.buildContext(session, {
          transientSystemMessages,
          allowRescue: forceRescueNextBuild,
          turnId,
        });
        forceRescueNextBuild = false;
        yield buildContextBuiltEvent(context, session, turnId);

        if (
          Boolean(context.decisions.auto_compact_token_limit_reached) ||
          (this._imageInput !== false && imageBudgetExceeded(context.messages))
        ) {
          if (this._imageInput !== false) {
            let latestGroup = 0;
            for (let i = 0; i < context.messages.length; i += 1) {
              const m = context.messages[i]!;
              if (m.role === "user" || Boolean(m.tool_calls)) {
                latestGroup = i;
              }
            }
            const groupAttachments = context.messages
              .slice(latestGroup)
              .flatMap(m =>
                Array.isArray(m.attachments) ? (m.attachments as ImageAttachment[]) : [],
              );
            checkImageBudget(groupAttachments);
          }
          const [compactedContext, record] = await this.runCompact({
            session,
            context,
            reason: "auto",
            phase: "mid_turn",
            phaseDetail: samplingIndex === 0 ? "before_first_sampling" : null,
            transientSystemMessages,
            cancellationToken,
            turnId,
          });
          context = compactedContext;
          yield contextCompactedEvent({
            ...eventMeta(session, turnId),
            record,
          });
          yield buildContextBuiltEvent(context, session, turnId);
        }

        if (!steeringForSampling) {
          const steeringItem = takeSteering ? takeSteering() : null;
          if (steeringItem !== null) {
            yield await this.deliverSteering(session, turnId, steeringItem);
            steeringForSampling = true;
            context = await this.buildContext(session, {
              transientSystemMessages,
              turnId,
            });
            yield buildContextBuiltEvent(context, session, turnId);
          }
        }
        if (cancellationToken?.isCancelled) {
          continue;
        }

        const boundary =
          context.messages.length > 0 ? validateModelMessageBoundary(context.messages) : null;
        if (boundary && !boundary.ok) {
          throw new Error(`Invalid model message boundary: ${boundary.reason}`);
        }

        if (
          !imageNoticeSent &&
          this._imageInput !== true &&
          context.messages.some(m => Array.isArray(m.attachments) && m.attachments.length > 0)
        ) {
          const notice =
            this._imageInput === false
              ? "Images not sent: this model does not support image input. Select a vision model."
              : "Image input capability is unconfirmed; trying this request with images.";
          const imagePaths = Array.from(
            new Set(
              context.messages.flatMap(m =>
                Array.isArray(m.attachments)
                  ? (m.attachments as Array<Record<string, unknown>>)
                      .map(a => String(a.path || ""))
                      .filter(Boolean)
                  : [],
              ),
            ),
          ).sort();
          yield contextBuiltEvent({
            ...eventMeta(session, turnId),
            message_count: context.messages.length,
            stats: { ...context.stats },
            decisions: {
              image_notice: notice,
              image_notice_level: this._imageInput === false ? "warning" : "info",
              image_notice_images: imagePaths,
            },
          });
          imageNoticeSent = true;
        }

        const requestMessages = this.prepareMessages
          ? await this.prepareForModel(context.messages)
          : context.messages;

        let parsedToolCalls: ParsedToolCall[] = [];
        try {
          let recoveryAttempt = initialRecoveryAttempt;
          initialRecoveryAttempt = 0;
          let streamResult = new ModelStreamResult();

          while (true) {
            const streamResponse = this.chatClient.stream(
              requestMessages,
              await this.toolsForSession(session),
              cancellationToken,
            );
            streamResult = new ModelStreamResult();
            try {
              for await (const event of pumpModelStreamEvents({
                streamResponse,
                streamParser: this.streamParser,
                session,
                turnId,
                cancellationToken,
                contextStats: context.stats,
                persistSamplingUsage: (s, u) => this.persistSamplingUsage(s, u),
                result: streamResult,
              })) {
                yield event;
              }
              this.validateFinishReason(streamResult);
              break;
            } catch (e) {
              if (cancellationToken?.isCancelled || e instanceof CancelledError) {
                throw e instanceof CancelledError
                  ? e
                  : new CancelledError(cancellationToken?.reason || "User interrupted");
              }
              if (
                !(e instanceof ProviderError) ||
                e.code !== "stream_interrupted" ||
                recoveryAttempt >= MAX_STEP_RECOVERY_ATTEMPTS
              ) {
                throw e;
              }
              recoveryAttempt += 1;
              await this.persistRecoveryState(session, turnId, recoveryAttempt);
              yield turnStepRetryEvent({
                ...eventMeta(session, turnId),
                attempt: recoveryAttempt,
                reason: "stream_interrupted",
              });
              await this.waitForRecovery(cancellationToken, recoveryAttempt);
            }
          }

          await this.persistRecoveryState(session, turnId, 0);
          const contentText = streamResult.content;
          parsedToolCalls = streamResult.tool_calls;
          const reasoningContent = streamResult.reasoning_content;

          if (contentText || parsedToolCalls.length > 0 || reasoningContent !== null) {
            const persistOpts: {
              meta?: Record<string, unknown>;
              reasoningContent?: string | null;
            } = {};
            if (parsedToolCalls.length > 0) {
              persistOpts.meta = {
                tool_calls: parsedToolCalls.map(item => ({
                  id: item.call_id,
                  name: item.name,
                  raw_args: item.raw_args,
                })),
              };
            }
            if (reasoningContent !== null) {
              persistOpts.reasoningContent = reasoningContent;
            }
            await this.persistMessage(session, "assistant", contentText, persistOpts);
          }

          if (this.taskNotifications && session.sessionId) {
            await this.taskNotifications.modelConsumed(session.sessionId, taskContext);
          }
          if (contentText) {
            yield assistantMessageCompletedEvent({
              ...eventMeta(session, turnId),
              content: contentText,
              content_chars: contentText.length,
            });
          }
        } catch (e) {
          if (
            e instanceof ProviderError &&
            e.code === "context_length_exceeded" &&
            contextLengthRecoveryCount < 3
          ) {
            contextLengthRecoveryCount += 1;
            if (contextLengthRecoveryCount === 1) {
              const [, record] = await this.runCompact({
                session,
                context,
                reason: "context_length_error",
                phase: "mid_turn",
                phaseDetail: "context_length_recovery",
                transientSystemMessages,
                cancellationToken,
                turnId,
              });
              yield contextCompactedEvent({
                ...eventMeta(session, turnId),
                record,
              });
            } else {
              this.contextManager.reduceHardLimit(
                0.8,
                typeof context.stats.estimated_input_tokens === "number"
                  ? context.stats.estimated_input_tokens
                  : null,
              );
              forceRescueNextBuild = true;
            }
            continue;
          }
          if (e instanceof BoundaryError) {
            yield this.failedEvent(session, turnId, e);
            return;
          }
          throw e;
        }

        if (parsedToolCalls.length > 0) {
          samplingIndex += 1;
          for (const call of parsedToolCalls) {
            const [parsedArgs] = parseToolArgs(call.raw_args);
            yield toolRequestedEvent({
              ...eventMeta(session, turnId),
              tool_call_id: call.call_id,
              tool_name: call.name,
              args_preview: call.raw_args.slice(0, 500),
              arguments: parsedArgs,
            });
            if (call.name === "update_plan" && parsedArgs && Array.isArray(parsedArgs.plan)) {
              yield planUpdatedEvent({
                ...eventMeta(session, turnId),
                tool_call_id: call.call_id,
                plan: parsedArgs.plan as Array<{ step: string; status: string }>,
              });
            }
          }

          for await (const event of this.toolProcessor.execute(
            session,
            parsedToolCalls,
            cancellationToken,
            turnId,
          )) {
            yield event;
          }
        }

        if (cancellationToken?.isCancelled) {
          continue;
        }

        const steeringItem = takeSteering ? takeSteering() : null;
        steeringForSampling = steeringItem !== null;
        if (steeringItem !== null) {
          yield await this.deliverSteering(session, turnId, steeringItem);
        }

        if (parsedToolCalls.length === 0 && steeringItem === null) {
          if (this.taskNotifications && (await this.taskNotifications.deliver(session)) > 0) {
            continue;
          }
          break;
        }
      }

      yield turnCompletedEvent({
        ...eventMeta(session, turnId),
        duration_ms: Math.trunc(performance.now() - turnStartedAt),
      });
    } catch (e) {
      if (e instanceof CancelledError || cancellationToken?.isCancelled) {
        yield this.cancelledEvent(session, turnId, cancellationToken, (e as Error)?.message || "");
      } else if (e instanceof BoundaryError) {
        yield this.failedEvent(session, turnId, e);
      } else {
        const err = e as Error;
        yield turnFailedEvent({
          ...eventMeta(session, turnId),
          error: err.message || String(e),
          error_type: err.name || "Error",
        });
      }
    } finally {
      this.contextManager.restoreHardLimit(originalHardLimit);
    }
  }

  private validateFinishReason(result: ModelStreamResult): void {
    const reason = result.finish_reason;
    if (
      reason === null ||
      reason === "stop" ||
      reason === "tool_calls" ||
      reason === "function_call"
    ) {
      return;
    }
    if (reason === "length") {
      throw new ProviderError("The model stopped because its output length limit was reached.", {
        status: "rejected",
        errorType: "StreamTruncated",
        code: "stream_truncated",
      });
    }
    const code = reason === "content_filter" ? "content_filter" : "stream_finish_reason";
    const message =
      reason === "content_filter"
        ? "The model stopped because its output was filtered."
        : `The model stream ended with unsupported finish reason: ${reason}`;
    throw new ProviderError(message, {
      status: "rejected",
      errorType: "StreamFinishReasonError",
      code,
    });
  }

  private async persistRecoveryState(
    session: JsonlSessionStore,
    turnId: string,
    attempt: number,
  ): Promise<void> {
    await session.persistTurnState(turnId, "running", session.nowIso(), attempt || null);
  }

  private async currentRecoveryAttempt(session: JsonlSessionStore): Promise<number> {
    const state = await session.getTurnState();
    const val = state?.recovery_attempt;
    return typeof val === "number" && Number.isInteger(val) && val > 0 ? val : 0;
  }

  private async pendingToolCalls(session: JsonlSessionStore): Promise<ParsedToolCall[]> {
    const messages = await session.loadMessages();
    let metadata: unknown[] | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object") continue;
      if (msg.role !== "assistant") break;
      const meta = msg.meta as Record<string, unknown> | undefined;
      if (meta && Array.isArray(meta.tool_calls)) {
        metadata = meta.tool_calls;
      }
      break;
    }
    if (!metadata || metadata.length === 0) return [];
    const calls: ParsedToolCall[] = [];
    for (const item of metadata) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (rec.id && rec.name && typeof rec.raw_args === "string") {
        calls.push({
          call_id: String(rec.id),
          name: String(rec.name),
          raw_args: rec.raw_args,
        });
      }
    }
    if (calls.length === 0) return [];
    const records = await session.getToolRecords(calls.map(c => c.call_id));
    const completed = new Set(
      records.map(r => `${String(r.id || "")}\0${String(r.name || "")}\0${String(r.raw_args || "")}`),
    );
    return calls.filter(c => !completed.has(`${c.call_id}\0${c.name}\0${c.raw_args}`));
  }

  private async waitForRecovery(
    cancellationToken: CancellationToken | null,
    attempt: number,
  ): Promise<void> {
    const delaySec = Math.min(2 ** attempt, 10);
    if (!cancellationToken) {
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      return;
    }
    await cancellationToken.sleep(delaySec * 1000);
  }

  async compactContext(
    session: JsonlSessionStore,
    options?: {
      reason?: string;
      phase?: string;
      cancellationToken?: CancellationToken | null;
      turnId?: string;
    },
  ): Promise<Record<string, unknown>> {
    this.bindSession(session);
    const [, record] = await this.runCompact({
      session,
      reason: options?.reason ?? "manual",
      phase: options?.phase ?? "manual",
      cancellationToken: options?.cancellationToken ?? null,
      turnId: options?.turnId ?? "",
    });
    return record;
  }

  private async runCompact(options: {
    session: JsonlSessionStore;
    context?: ContextBuildResult | null;
    reason: string;
    phase: string;
    phaseDetail?: string | null;
    transientSystemMessages?: Record<string, unknown>[] | null;
    cancellationToken?: CancellationToken | null;
    turnId?: string;
  }): Promise<[ContextBuildResult, Record<string, unknown>]> {
    const {
      session,
      context = null,
      reason,
      phase,
      phaseDetail = null,
      transientSystemMessages = null,
      cancellationToken = null,
      turnId = "",
    } = options;
    const compactionContext = await this.buildContext(session, {
      transientSystemMessages,
      includeSkillCatalog: false,
      includeIds: true,
    });
    const record = await this.compactionService.compactAsync(
      session,
      compactionContext.messages,
      this.chatClient,
      {
        reason,
        phase,
        diagnostics: compactDiagnostics(phaseDetail),
        prepareMessages: this.prepareMessages
          ? (msgs, opts) => this.prepareForModel(msgs, opts)
          : null,
        taskReferences:
          this.taskNotifications && session.sessionId
            ? await this.taskNotifications.references(session.sessionId)
            : null,
        contextStats: context ? context.stats : compactionContext.stats,
        cancellationToken,
      },
    );
    if (this.skills) {
      await this.skills.syncCatalog(session);
    }
    const rebuilt = await this.buildContext(session, {
      transientSystemMessages,
      turnId,
    });
    const validation = validateCompactHandoffBoundary(rebuilt.messages);
    if (!validation.ok) {
      throw new Error(`Compact produced an invalid continuation boundary: ${validation.reason}`);
    }
    return [rebuilt, record];
  }

  private async deliverSteering(
    session: JsonlSessionStore,
    turnId: string,
    item: [string, string],
  ): Promise<RuntimeEventBase & { type: "queued_input_delivered" }> {
    const [inputId, text] = item;
    if (this.skills) {
      await this.skills.persistUserInput(session, text);
    } else {
      await session.persistUserInput(text);
    }
    return queuedInputDeliveredEvent({
      ...eventMeta(session, turnId),
      input_id: inputId,
      input: text,
      mode: "steering",
    });
  }

  private async buildContext(
    session: JsonlSessionStore,
    options?: {
      transientSystemMessages?: Record<string, unknown>[] | null;
      allowRescue?: boolean;
      includeSkillCatalog?: boolean;
      turnId?: string;
      includeIds?: boolean;
    },
  ): Promise<ContextBuildResult> {
    const includeSkillCatalog = options?.includeSkillCatalog ?? true;
    const context = await this.contextManager.buildMessagesAsync(session, {
      transientSystemMessages: options?.transientSystemMessages ?? null,
      allowRescue: options?.allowRescue ?? false,
      includeSkillCatalog,
      includeIds: options?.includeIds ?? false,
    });
    if (includeSkillCatalog) {
      await this.captureContextBreakdown(session, context, options?.turnId ?? "");
    }
    return context;
  }

  private async captureContextBreakdown(
    session: JsonlSessionStore,
    context: ContextBuildResult,
    turnId: string,
  ): Promise<void> {
    try {
      const messages =
        context.internal_messages.length > 0 ? context.internal_messages : context.messages;
      const snapshot = buildContextSnapshot(messages, context.stats, turnId, {
        toolSchemas: await this.toolsForSession(session),
        estimator: this.contextManager.estimator,
      });
      await session.persistContextBreakdown(snapshot);
    } catch {}
  }

  private async persistSamplingUsage(
    session: JsonlSessionStore,
    usage: Record<string, unknown>,
  ): Promise<void> {
    try {
      await session.persistSamplingUsage(usage);
    } catch {}
    if (this.usageRecorder) {
      try {
        const record = buildUsageRecord(usage, {
          sessionId: String(session.sessionId || ""),
          model: String(session.model || ""),
        });
        this.usageRecorder(record);
      } catch {}
    }
  }

  private cancelledEvent(
    session: JsonlSessionStore,
    turnId: string,
    cancellationToken: CancellationToken | null,
    fallback = "",
  ): RuntimeEventBase & { type: "turn_cancelled" } {
    const reason = cancellationToken?.reason ? cancellationToken.reason : fallback;
    return turnCancelledEvent({
      ...eventMeta(session, turnId),
      reason,
    });
  }

  private failedEvent(
    session: JsonlSessionStore,
    turnId: string,
    error: BoundaryError,
  ): RuntimeEventBase & { type: "turn_failed" } {
    return turnFailedEvent({
      ...eventMeta(session, turnId),
      error: error.message,
      error_type: error.errorType,
      status: error.status,
      error_source: error.source,
    });
  }

  private async persistMessage(
    session: JsonlSessionStore,
    role: string,
    content: string,
    options?: {
      meta?: Record<string, unknown>;
      reasoningContent?: string | null;
    },
  ): Promise<void> {
    try {
      await session.persistMessage(role, content, {
        meta: options?.meta,
        reasoningContent: options?.reasoningContent,
      });
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      const err = exc as Error;
      throw new PersistenceError(`Failed to persist ${role} message: ${err.message || String(exc)}`, {
        code: err.name || "Error",
        cause: exc,
      });
    }
  }
}

export const MAX_QUEUED_INPUTS = 4;
export const MAX_QUEUED_INPUT_CHARS = 8_000;

interface QueuedInput {
  input_id: string;
  text: string;
}

class SimpleMutex {
  private lockedFlag = false;
  private waiters: Array<() => void> = [];

  get locked(): boolean {
    return this.lockedFlag;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  async acquire(): Promise<void> {
    if (!this.lockedFlag) {
      this.lockedFlag = true;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.lockedFlag = false;
    }
  }
}

export class AgentRuntime {
  private readonly turnRunner: TurnRunner;
  private readonly sessionStore: JsonlSessionStore;
  private initialized = false;
  private readonly initializeLock = new SimpleMutex();
  private readonly turnLock = new SimpleMutex();
  private _activeTurnId = "";
  private acceptingInputs = false;
  private readonly steeringQueue: QueuedInput[] = [];
  private readonly followUpQueue: QueuedInput[] = [];
  private readonly goalEnabled: boolean;
  private runtimeSystemMessages: Array<Record<string, unknown>>;
  private activeContextMessages: Array<Record<string, unknown>> | null = null;
  private readonly skills: SkillTurnCoordinator | null;

  constructor(options: {
    turnRunner: TurnRunner;
    sessionStore: JsonlSessionStore;
    goalEnabled?: boolean;
    skills?: SkillTurnCoordinator | null;
    runtimeSystemMessages?: ReadonlyArray<Record<string, unknown>> | null;
  }) {
    this.turnRunner = options.turnRunner;
    this.sessionStore = options.sessionStore;
    this.goalEnabled = Boolean(options.goalEnabled);
    this.skills = options.skills ?? null;
    this.runtimeSystemMessages = (options.runtimeSystemMessages ?? []).map(m => ({ ...m }));
  }

  setExternalInstructions(instructions: string): void {
    const entry = instructions
      ? [{ role: "system", content: instructions, _context_kind: "external_tools" }]
      : [];
    this.runtimeSystemMessages = [
      ...this.runtimeSystemMessages.filter(m => m._context_kind !== "external_tools"),
      ...entry,
    ];
    if (this.activeContextMessages !== null) {
      this.activeContextMessages.splice(
        0,
        this.activeContextMessages.length,
        ...entry.map(m => ({ ...m })),
        ...this.activeContextMessages.filter(m => m._context_kind !== "external_tools"),
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.initializeLock.runExclusive(async () => {
      if (this.initialized) return;
      try {
        await this.sessionStore.initialize();
      } catch (exc) {
        if (exc instanceof CancelledError) throw exc;
        const err = exc as Error;
        throw new PersistenceError(
          `Failed to initialize session store: ${err.message || String(exc)}`,
          { code: err.name || "Error", cause: exc },
        );
      }
      this.initialized = true;
    });
  }

  async syncSkillCatalog(): Promise<void> {
    if (this.skills) {
      await this.skills.syncCatalog(this.sessionStore);
    }
  }

  get turnActive(): boolean {
    return this.acceptingInputs || Boolean(this._activeTurnId);
  }

  get activeTurnId(): string {
    return this._activeTurnId;
  }

  setUserQuestionResponder(responder: UserQuestionResponder | null): void {
    this.turnRunner.setUserQuestionResponder(responder);
  }

  submitSteering(text: string): Record<string, unknown> {
    return this.submitInput("steering", text, this.steeringQueue);
  }

  submitFollowUp(text: string): Record<string, unknown> {
    return this.submitInput("follow_up", text, this.followUpQueue);
  }

  unsteer(inputId?: string | null): Record<string, unknown> {
    return this.retrieveInput("steering", this.steeringQueue, inputId);
  }

  dequeueFollowUp(inputId?: string | null): Record<string, unknown> {
    return this.retrieveInput("follow_up", this.followUpQueue, inputId);
  }

  promoteFollowUp(inputId: string): Record<string, unknown> {
    const value = String(inputId || "").trim();
    if (!this.acceptingInputs || !this._activeTurnId) {
      throw new InputQueueError("No active turn accepts queued input.", "TurnNotActive");
    }
    if (!value) {
      throw new InputQueueError("input_id must not be empty.", "InvalidRequest");
    }
    const idx = this.followUpQueue.findIndex(c => c.input_id === value);
    if (idx === -1) {
      throw new InputQueueError("Queued follow-up was not found.", "InputNotPending");
    }
    const item = this.followUpQueue[idx]!;
    if (this.steeringQueue.length >= MAX_QUEUED_INPUTS) {
      throw new InputQueueError(
        `steering queue is full (maximum ${MAX_QUEUED_INPUTS}).`,
        "InputQueueFull",
      );
    }
    if (this.queueChars(this.steeringQueue) + item.text.length > MAX_QUEUED_INPUT_CHARS) {
      throw new InputQueueError(
        `steering queue exceeds ${MAX_QUEUED_INPUT_CHARS} queued characters.`,
        "InputQueueFull",
      );
    }
    this.followUpQueue.splice(idx, 1);
    this.steeringQueue.push(item);
    return {
      accepted: true,
      input_id: item.input_id,
      mode: "steering",
      pending: this.steeringQueue.length,
    };
  }

  discardPendingInputs(): void {
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
  }

  inputQueueCounts(): { steering: number; follow_up: number } {
    return {
      steering: this.steeringQueue.length,
      follow_up: this.followUpQueue.length,
    };
  }

  async getGoal(): Promise<Record<string, unknown> | null> {
    await this.requireGoalEnabled();
    const goal = await this.sessionStore.getGoal();
    return goal ? { ...goal } : null;
  }

  async setGoal(objective: string): Promise<Record<string, unknown>> {
    await this.requireGoalEnabled();
    if (this.acceptingInputs || this._activeTurnId) {
      throw new Error("Cannot replace a goal while a turn is active.");
    }
    return await this.turnLock.runExclusive(async () => {
      if (this.acceptingInputs || this._activeTurnId) {
        throw new Error("Cannot replace a goal while a turn is active.");
      }
      const goal = await this.sessionStore.setGoal(objective);
      return { ...goal };
    });
  }

  async setGoalStatus(status: string): Promise<Record<string, unknown>> {
    await this.requireGoalEnabled();
    const goal = await this.sessionStore.setGoalStatus(status);
    return { ...goal };
  }

  async clearGoal(): Promise<void> {
    await this.requireGoalEnabled();
    await this.sessionStore.clearGoal();
  }

  private async requireGoalEnabled(): Promise<void> {
    await this.initialize();
    if (!this.goalEnabled) {
      throw new Error("Goal support is unavailable.");
    }
  }

  async switchSession(sessionId: string): Promise<Record<string, unknown>> {
    return await this.rebindSession(
      () => this.sessionStore.switchSession(sessionId),
      "Cannot switch sessions while a turn is active.",
      "Failed to switch session",
    );
  }

  async createSession(): Promise<Record<string, unknown>> {
    return await this.rebindSession(
      () => this.sessionStore.createSession(),
      "Cannot create a session while a turn is active.",
      "Failed to create session",
    );
  }

  private async rebindSession(
    rebind: () => Promise<Record<string, unknown>>,
    busyMessage: string,
    persistenceLabel: string,
  ): Promise<Record<string, unknown>> {
    await this.initialize();
    if (this.acceptingInputs || this._activeTurnId) {
      throw new Error(busyMessage);
    }
    return await this.turnLock.runExclusive(async () => {
      if (this.acceptingInputs || this._activeTurnId) {
        throw new Error(busyMessage);
      }
      this.discardPendingInputs();
      try {
        const result = await rebind();
        return result && typeof result === "object"
          ? { ...result }
          : {
              session_id: this.sessionStore.sessionId,
              model: this.sessionStore.model,
            };
      } catch (exc) {
        if (exc instanceof CancelledError) throw exc;
        const err = exc as Error;
        throw new PersistenceError(`${persistenceLabel}: ${err.message || String(exc)}`, {
          code: err.name || "Error",
          cause: exc,
        });
      }
    });
  }

  async compactContext(
    reason = "manual",
    cancellationToken?: CancellationToken | null,
  ): Promise<Record<string, unknown> | null> {
    let record: Record<string, unknown> | null = null;
    let failure: Error | null = null;
    for await (const event of this.runTurn({ compact: reason, cancellationToken })) {
      if (event.type === "context_compacted" && record === null) {
        record = (event.record as Record<string, unknown>) ?? null;
      } else if (event.type === "turn_cancelled") {
        failure = new CancelledError(String(event.reason || ""));
      } else if (event.type === "turn_failed") {
        failure = new Error(String(event.error || ""));
      }
    }
    if (failure) throw failure;
    return record;
  }

  async *runTurn(options?: {
    sessionId?: string | null;
    query?: string | null;
    cancellationToken?: CancellationToken | null;
    transientSystemMessages?: Record<string, unknown>[] | null;
    resume?: boolean;
    compact?: string | null;
    delivery?: boolean;
  }): AsyncGenerator<RuntimeEventBase, void, void> {
    const query = options?.query ?? null;
    const cancellationToken = options?.cancellationToken ?? null;
    const transientSystemMessages = options?.transientSystemMessages ?? null;
    let resume = options?.resume ?? false;
    const compact = options?.compact ?? null;
    const delivery = options?.delivery ?? false;

    await this.initialize();
    if (compact && (this.turnActive || this.turnLock.locked)) {
      throw new Error("Cannot compact context while a turn is active.");
    }

    await this.turnLock.acquire();
    try {
      if (compact) {
        const messages = await this.sessionStore.getMessagesSlice();
        if (!messages.some(m => m.role !== "system")) {
          throw new Error("Not enough messages to compact. Send a message first.");
        }
      }
      const turnState = resume ? await this.sessionStore.getTurnState() : null;
      let turnId: string;
      if (resume) {
        if (!turnState || turnState.status !== "running") {
          throw new Error("No recoverable turn is available.");
        }
        turnId = String(turnState.turn_id || "");
        if (!turnId) {
          throw new Error("Recoverable turn is missing its turn id.");
        }
      } else {
        turnId = randomUUID().replace(/-/g, "");
      }

      this._activeTurnId = turnId;
      this.acceptingInputs = true;
      this.discardPendingInputs();

      try {
        if (query && !resume) {
          await this.persistUserInput(query, delivery ? { kind: "team_delivery" } : null);
        }
        await this.syncSkillCatalog();

        const startedEvent = turnStartedEvent({
          ...eventMeta(this.sessionStore, turnId),
          user_message_chars: resume ? 0 : (query || "").length,
          operation: compact ? "compact" : "prompt",
        });

        if (compact) {
          yield startedEvent;
          try {
            const record = await this.turnRunner.compactContext(this.sessionStore, {
              reason: compact,
              phase: "manual",
              cancellationToken,
            });
            yield contextCompactedEvent({
              ...eventMeta(this.sessionStore, turnId),
              record,
            });
            if (cancellationToken?.isCancelled) {
              throw new CancelledError(cancellationToken.reason);
            }
          } catch (exc) {
            this.acceptingInputs = false;
            if (exc instanceof CancelledError || cancellationToken?.isCancelled) {
              yield turnCancelledEvent({
                ...eventMeta(this.sessionStore, turnId),
                reason: (exc as Error).message || cancellationToken?.reason || "",
              });
              return;
            }
            const err = exc as Error;
            yield turnFailedEvent({
              ...eventMeta(this.sessionStore, turnId),
              error: err.message || String(exc),
              error_type: err.name || "Error",
            });
            return;
          }

          const queued = this.steeringQueue.length > 0 ? null : this.takeFollowUp();
          if (queued === null && this.steeringQueue.length === 0) {
            this.acceptingInputs = false;
            yield turnCompletedEvent({
              ...eventMeta(this.sessionStore, turnId),
            });
            return;
          }
          if (queued !== null) {
            await this.persistUserInput(queued.text);
            yield queuedInputDeliveredEvent({
              ...eventMeta(this.sessionStore, turnId),
              input_id: queued.input_id,
              input: queued.text,
              mode: "follow_up",
            });
          }
        }

        await this.persistTurnState(
          startedEvent,
          typeof turnState?.recovery_attempt === "number" ? turnState.recovery_attempt : null,
        );
        const startedPersisted = true;
        let terminalPersisted = false;

        try {
          if (!compact) {
            yield startedEvent;
          }

          let totalDurationMs = 0;
          while (true) {
            const contextMessages = [
              ...this.runtimeSystemMessages.map(m => ({ ...m })),
              ...(transientSystemMessages ?? []).map(m => ({ ...m })),
            ];
            this.activeContextMessages = contextMessages;

            const currentResume = resume;
            resume = false;
            let terminalEvent: RuntimeEventBase | null = null;

            for await (const event of this.turnRunner.runTurn({
              session: this.sessionStore,
              cancellationToken,
              turnId,
              takeSteering: () => this.takeSteering(),
              transientSystemMessages: contextMessages,
              resume: currentResume,
            })) {
              if (
                event.type === "turn_completed" ||
                event.type === "turn_failed" ||
                event.type === "turn_cancelled"
              ) {
                terminalEvent = event;
                continue;
              }
              yield event;
            }

            if (terminalEvent === null) {
              throw new Error("Turn runner ended without a terminal event.");
            }

            if (terminalEvent.type === "turn_completed") {
              totalDurationMs += Number(terminalEvent.duration_ms || 0);
            }
            if (terminalEvent.type === "turn_completed" && !cancellationToken?.isCancelled) {
              const followUp = this.takeFollowUp();
              if (followUp !== null) {
                await this.persistUserInput(followUp.text);
                yield queuedInputDeliveredEvent({
                  ...eventMeta(this.sessionStore, turnId),
                  input_id: followUp.input_id,
                  input: followUp.text,
                  mode: "follow_up",
                });
                continue;
              }
            }
            if (terminalEvent.type === "turn_failed") {
              await this.stopActiveGoal("blocked");
            } else if (terminalEvent.type === "turn_cancelled") {
              await this.stopActiveGoal("paused");
            }

            if (terminalEvent.type === "turn_completed") {
              terminalEvent.duration_ms = totalDurationMs;
            }

            this.acceptingInputs = false;
            this.discardPendingInputs();
            await this.persistTurnState(terminalEvent);
            terminalPersisted = true;
            yield terminalEvent;
            return;
          }
        } catch (exc) {
          if (startedPersisted && !terminalPersisted) {
            if (exc instanceof CancelledError) {
              await this.stopActiveGoal("paused");
              await this.persistTurnState(
                turnCancelledEvent({
                  ...eventMeta(this.sessionStore, turnId),
                  reason: exc.message || "Turn cancelled.",
                }),
              );
            } else {
              const err = exc as Error;
              await this.stopActiveGoal("blocked");
              await this.persistTurnState(
                turnFailedEvent({
                  ...eventMeta(this.sessionStore, turnId),
                  error: err.message || String(exc),
                  error_type: err.name || "Error",
                }),
              );
            }
          }
          throw exc;
        }
      } finally {
        this.activeContextMessages = null;
        this.acceptingInputs = false;
        this._activeTurnId = "";
        this.discardPendingInputs();
      }
    } finally {
      this.turnLock.release();
    }
  }

  private async stopActiveGoal(status: string): Promise<void> {
    if (!this.goalEnabled) return;
    const goal = await this.sessionStore.getGoal();
    if (!goal || goal.status !== "active") return;
    await this.sessionStore.setGoalStatus(status);
  }

  private submitInput(mode: string, text: string, queue: QueuedInput[]): Record<string, unknown> {
    const value = String(text || "").trim();
    if (!this.acceptingInputs || !this._activeTurnId) {
      throw new InputQueueError("No active turn accepts queued input.", "TurnNotActive");
    }
    if (!value) {
      throw new InputQueueError(`${mode} input must not be empty.`, "InvalidRequest");
    }
    if (value.length > MAX_QUEUED_INPUT_CHARS) {
      throw new InputQueueError(
        `${mode} input exceeds ${MAX_QUEUED_INPUT_CHARS} characters.`,
        "InputTooLong",
      );
    }
    if (this.queueChars(queue) + value.length > MAX_QUEUED_INPUT_CHARS) {
      throw new InputQueueError(
        `${mode} queue exceeds ${MAX_QUEUED_INPUT_CHARS} queued characters.`,
        "InputQueueFull",
      );
    }
    if (queue.length >= MAX_QUEUED_INPUTS) {
      throw new InputQueueError(
        `${mode} queue is full (maximum ${MAX_QUEUED_INPUTS}).`,
        "InputQueueFull",
      );
    }
    const item: QueuedInput = {
      input_id: randomUUID().replace(/-/g, ""),
      text: value,
    };
    queue.push(item);
    return {
      accepted: true,
      input_id: item.input_id,
      mode,
      pending: queue.length,
    };
  }

  private retrieveInput(
    mode: string,
    queue: QueuedInput[],
    inputId?: string | null,
  ): Record<string, unknown> {
    if (!this.acceptingInputs || !this._activeTurnId) {
      throw new InputQueueError("No active turn accepts queued input.", "TurnNotActive");
    }
    if (queue.length === 0) {
      throw new InputQueueError(`No queued ${mode} input is available.`, "InputNotPending");
    }
    let item: QueuedInput;
    if (inputId === null || inputId === undefined) {
      item = queue.pop()!;
    } else {
      const value = String(inputId).trim();
      if (!value) {
        throw new InputQueueError("input_id must not be empty.", "InvalidRequest");
      }
      const idx = queue.findIndex(c => c.input_id === value);
      if (idx === -1) {
        throw new InputQueueError(`Queued ${mode} input was not found.`, "InputNotPending");
      }
      item = queue.splice(idx, 1)[0]!;
    }
    return {
      retrieved: true,
      input_id: item.input_id,
      input: item.text,
      mode,
      pending: queue.length,
    };
  }

  private queueChars(queue: readonly QueuedInput[]): number {
    return queue.reduce((sum, item) => sum + item.text.length, 0);
  }

  private takeSteering(): [string, string] | null {
    if (this.steeringQueue.length === 0) return null;
    const item = this.steeringQueue.shift()!;
    return [item.input_id, item.text];
  }

  private takeFollowUp(): QueuedInput | null {
    if (this.followUpQueue.length === 0) return null;
    return this.followUpQueue.shift()!;
  }

  private async persistUserInput(
    content: string,
    meta?: Record<string, unknown> | null,
  ): Promise<void> {
    if (this.skills && !meta) {
      try {
        await this.skills.persistUserInput(this.sessionStore, content);
        return;
      } catch (exc) {
        if (exc instanceof CancelledError || exc instanceof BoundaryError) throw exc;
        const err = exc as Error;
        if (err.name === "ValueError" || err.message.startsWith("Unknown skill")) {
          throw err;
        }
        throw new PersistenceError(`Failed to persist user input: ${err.message || String(exc)}`, {
          code: err.name || "Error",
          cause: exc,
        });
      }
    }
    await this.sessionStore.persistUserInput(content, meta ?? null);
  }

  private async persistTurnState(
    event: RuntimeEventBase,
    recoveryAttempt?: number | null,
  ): Promise<void> {
    try {
      const status =
        event.type === "turn_started" ? "running" : event.type.replace(/^turn_/, "");
      await this.sessionStore.persistTurnState(
        event.turn_id,
        status,
        event.ts,
        recoveryAttempt ?? null,
      );
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      const err = exc as Error;
      throw new PersistenceError(`Failed to persist turn state: ${err.message || String(exc)}`, {
        code: err.name || "Error",
        cause: exc,
      });
    }
  }
}

export const GLOBAL_TOOL_CONCURRENCY_LIMIT = 512;

export class SharedRuntimeResources {
  readonly toolResultNormalizer: ToolResultNormalizer;
  readonly streamParser: MessageStreamParser;
  readonly compactionService: CompactionService;
  readonly toolOutputStore: ToolOutputStore;
  readonly toolSemaphore: AsyncSemaphore;
  readonly fileMutationQueue: FileMutationQueue;

  constructor(options: {
    toolResultNormalizer: ToolResultNormalizer;
    streamParser: MessageStreamParser;
    compactionService: CompactionService;
    toolOutputStore?: ToolOutputStore;
    toolSemaphore?: AsyncSemaphore;
    fileMutationQueue?: FileMutationQueue;
  }) {
    this.toolResultNormalizer = options.toolResultNormalizer;
    this.streamParser = options.streamParser;
    this.compactionService = options.compactionService;
    this.toolOutputStore = options.toolOutputStore ?? new ToolOutputStore();
    this.toolSemaphore =
      options.toolSemaphore ?? new AsyncSemaphore(GLOBAL_TOOL_CONCURRENCY_LIMIT);
    this.fileMutationQueue =
      options.fileMutationQueue ?? new FileMutationQueue(this.toolSemaphore);
  }
}

export interface AgentContainer {
  readonly settings: AppSettings;
  readonly chat_client: ChatClient;
  readonly session_store: JsonlSessionStore;
  readonly tool_registry: DefaultToolRegistry;
  readonly tool_executor: ToolExecutor;
  readonly tool_result_normalizer: ToolResultNormalizer;
  readonly tool_processor: ToolCallProcessor;
  readonly stream_parser: MessageStreamParser;
  readonly context_manager: ContextManager;
  readonly compaction_service: CompactionService;
  readonly turn_runner: TurnRunner;
  readonly runtime: AgentRuntime;
  readonly shell_tools: ShellTools;
  readonly web_sessions: WebSessions;
}

export function buildAgentContainer(options: {
  chatClient: ChatClient;
  imageInput?: boolean | null;
  settings?: AppSettings | null;
  sessionDir?: string | null;
  sessionId?: string | null;
  sessionStore?: JsonlSessionStore | null;
  resumeLatest?: boolean;
  enableGoal?: boolean;
  enableUserQuestion?: boolean;
  systemPrompt?: string | null;
  workspaceRoot?: string | null;
  projectId?: string | null;
  ownerAgentId?: string | null;
  sessionType?: string | null;
  parentSessionId?: string | null;
  sharedResources?: SharedRuntimeResources | null;
  shellTools?: ShellTools | null;
  webSessions?: WebSessions | null;
  taskNotifications?: TaskNotifications | null;
  externalTool?: ExternalTool | null;
  contextWindow?: number | null;
}): AgentContainer {
  const promptWorkspace = path.resolve(expandTilde(options.workspaceRoot || process.cwd()));
  const settings = options.settings ?? loadSettings();
  const toolOutputStore = options.sharedResources
    ? options.sharedResources.toolOutputStore
    : new ToolOutputStore(options.sessionDir);
  const shellTools = options.shellTools ?? new ShellTools(toolOutputStore);
  const taskNotifications =
    options.taskNotifications ??
    (shellTools.supervisor.journal ? new TaskNotifications(shellTools.supervisor.journal) : null);
  const webSessions = options.webSessions ?? new WebSessions();
  const model = settings.model;

  const sessionStore =
    options.sessionStore ??
    new JsonlSessionStore({
      sessionDir: options.sessionDir,
      sessionId: options.sessionId,
      resumeLatest: options.resumeLatest ?? false,
      model,
      systemPrompt:
        options.systemPrompt ||
        buildSystemPrompt({ environment: getSystemInfo(promptWorkspace) }),
      workspaceRoot: options.workspaceRoot,
      projectId: options.projectId,
      ownerAgentId: options.ownerAgentId,
      sessionType: options.sessionType,
      parentSessionId: options.parentSessionId,
      reasoningEffort: settings.reasoning_effort,
      provider: settings.provider,
      createMissing: !options.sessionId,
    });

  const skillRepository = new SkillRepository(promptWorkspace, {
    skillFiles: options.externalTool ? options.externalTool.skill_files : [],
  });
  let sessionOutputRoot: string | null = null;
  if (options.sessionId) {
    sessionOutputRoot = path.resolve(
      JsonlSessionStore.resolveSessionRoot(options.sessionDir),
      String(options.sessionId),
      "tool-output",
    );
  }

  let turnRunnerRef: TurnRunner | null = null;
  const catalog = buildBuiltinToolSpecs({
    enableGoal: options.enableGoal ?? false,
    enableUserQuestion: options.enableUserQuestion ?? true,
    setGoalStatus: options.enableGoal ? status => sessionStore.setGoalStatus(status) : null,
    workspaceRoot: options.workspaceRoot,
    sessionOutputRoot,
    shellTools,
    webSessions,
    mutationQueue: options.sharedResources ? options.sharedResources.fileMutationQueue : null,
    sessionBaseProvider: () => sessionStore.sessionBasePath,
    captureImage: p => sessionStore.captureImage(p),
    imageInput: () => (turnRunnerRef ? turnRunnerRef.imageInput : (options.imageInput ?? null)),
  });

  const toolSpecs = options.externalTool
    ? [...catalog, ...options.externalTool.specs(sessionStore.sessionId || "")]
    : catalog;
  const toolRegistry = new DefaultToolRegistry(toolSpecs);
  const runtimeSystemMessages: Array<Record<string, unknown>> = [];
  if (options.externalTool?.instructions) {
    runtimeSystemMessages.push({
      role: "system",
      content: options.externalTool.instructions,
      _context_kind: "external_tools",
    });
  }

  const skills = new SkillTurnCoordinator(skillRepository, {
    catalog: toolSpecs.some(s => s.name === "read_file"),
  });
  const toolExecutor = new ToolExecutor(toolRegistry);
  const toolResultNormalizer = options.sharedResources
    ? options.sharedResources.toolResultNormalizer
    : new ToolResultNormalizer();
  const toolProcessor = new ToolCallProcessor({
    toolExecutor,
    toolResultNormalizer,
    toolOutputStore,
    taskNotifications,
    globalToolSemaphore: options.sharedResources ? options.sharedResources.toolSemaphore : null,
  });
  const streamParser = options.sharedResources
    ? options.sharedResources.streamParser
    : new MessageStreamParser();
  const contextManager = new ContextManager({
    estimator: new ContextEstimator(
      new ContextBudget({ contextWindowTokens: options.contextWindow ?? null }),
    ),
    rindDocProvider: () => buildRindDocContext(options.workspaceRoot),
    goalPolicyProvider: options.enableGoal ? buildGoalPolicyPrompt : null,
  });
  const usageRecorder = (record: Record<string, unknown>): void => {
    appendUsageRecord(defaultUsageLedgerPath(), record);
  };
  const compactionService = options.sharedResources
    ? options.sharedResources.compactionService
    : new CompactionService({
        planSnapshotProvider: buildPlanSnapshot,
        usageRecorder,
      });

  const turnRunner = new TurnRunner({
    chatClient: options.chatClient,
    toolProcessor,
    streamParser,
    toolSchemas: toolRegistry.schemas,
    prepareMessages: (msgs, opts) =>
      prepareImageMessages(msgs, {
        loadImage: att => sessionStore.loadImage(att),
        imageInput: opts.imageInput,
        compact: opts.compact,
      }),
    imageInput: options.imageInput ?? null,
    contextManager,
    taskNotifications,
    compactionService,
    skills,
    usageRecorder,
  });
  turnRunnerRef = turnRunner;

  const runtime = new AgentRuntime({
    turnRunner,
    sessionStore,
    goalEnabled: options.enableGoal ?? false,
    skills,
    runtimeSystemMessages,
  });

  return {
    settings,
    chat_client: options.chatClient,
    session_store: sessionStore,
    tool_registry: toolRegistry,
    tool_executor: toolExecutor,
    tool_result_normalizer: toolResultNormalizer,
    tool_processor: toolProcessor,
    stream_parser: streamParser,
    context_manager: contextManager,
    compaction_service: compactionService,
    turn_runner: turnRunner,
    runtime,
    shell_tools: shellTools,
    web_sessions: webSessions,
  };
}
