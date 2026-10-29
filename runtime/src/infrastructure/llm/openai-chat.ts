import type { CancellationToken } from "../../domain/cancellation.js";
import { CancelledError } from "../../domain/errors.js";
import type {
  ChatClient,
  FinishReason,
  ModelCompletion,
  ModelStreamEvent,
  ModelUsage,
  ParsedToolCall,
} from "../../domain/models.js";
import { resolveReasoningEffort } from "../providers.js";
import { DEFAULT_USER_AGENT } from "../settings.js";
import {
  chatMessages,
  HttpStatusError,
  parseSseEvents,
  promptCacheKey,
  providerError,
  rejectsPromptCacheKey,
  throwForHttpError,
} from "./sse.js";

const FINISH_REASON_MAP: Readonly<Record<string, FinishReason>> = {
  stop: "stop",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  length: "length",
  content_filter: "content_filter",
};

export type ApiKeyProvider = string | (() => Promise<string> | string);

export interface MockOpenAIChatClient {
  chat: {
    completions: {
      create(payload: Record<string, unknown>): Promise<unknown>;
    };
  };
  close?: () => Promise<void> | void;
}

export class OpenAIChatCompletionsClient implements ChatClient {
  private readonly apiKey: ApiKeyProvider;
  private readonly _model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: string | null;
  private readonly reasoningEfforts: readonly string[];
  private readonly asyncClient: MockOpenAIChatClient | null;
  private reasoningEffortDisabled = false;
  private promptCacheKeyDisabled = false;
  private sessionIdProvider: (() => string) | null = null;

  constructor(options: {
    apiKey?: ApiKeyProvider;
    model: string;
    baseUrl?: string | null;
    asyncClient?: MockOpenAIChatClient | null;
    reasoningEffort?: string | null;
    reasoningEfforts?: readonly string[];
  }) {
    this.apiKey = options.apiKey ?? "";
    this._model = options.model;
    this.baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.reasoningEffort = (options.reasoningEffort || "").trim() || null;
    this.reasoningEfforts = options.reasoningEfforts ?? [];
    this.asyncClient = options.asyncClient ?? null;
  }

  get model(): string {
    return this._model;
  }

  setSessionIdProvider(provider: (() => string) | null): void {
    this.sessionIdProvider = provider;
  }

  private async resolveApiKey(): Promise<string> {
    return typeof this.apiKey === "function" ? await this.apiKey() : this.apiKey;
  }

  private addPromptCacheKey(payload: Record<string, unknown>): void {
    if (this.promptCacheKeyDisabled || !this.sessionIdProvider) {
      return;
    }
    const sessionId = this.sessionIdProvider();
    if (sessionId) {
      payload.prompt_cache_key = promptCacheKey(sessionId);
    }
  }

  private shouldRetryWithMaxCompletionTokens(exc: unknown): boolean {
    const status = (exc as { status_code?: number; status?: number })?.status_code ?? (exc as { status?: number })?.status;
    const text = (exc instanceof Error ? exc.message : String(exc)).toLowerCase();
    return (
      (status === 400 || status === 422) &&
      text.includes("max_tokens") &&
      ["unsupported", "unknown", "unrecognized", "not support", "extra_forbidden"].some(m => text.includes(m))
    );
  }

  private shouldRetryWithoutReasoningEffort(exc: unknown): boolean {
    const text = (exc instanceof Error ? exc.message : String(exc)).toLowerCase();
    return [
      "reasoning_effort",
      "request was blocked",
      "blocked",
      "unsupported",
      "unknown",
      "invalid",
      "unrecognized",
      "not support",
      "not supported",
      "extra_forbidden",
    ].some(m => text.includes(m));
  }

  private async executeRequest(
    payload: Record<string, unknown>,
    stream: boolean,
    cancellationToken?: CancellationToken | null,
  ): Promise<unknown> {
    cancellationToken?.throwIfCancelled();
    if (this.asyncClient) {
      return await this.asyncClient.chat.completions.create(payload);
    }
    const url = `${this.baseUrl}/chat/completions`;
    const key = await this.resolveApiKey();
    const maxRetries = 4;
    for (let attempt = 0; ; attempt++) {
      cancellationToken?.throwIfCancelled();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: stream ? "text/event-stream" : "application/json",
            Authorization: `Bearer ${key}`,
            "User-Agent": DEFAULT_USER_AGENT,
          },
          body: JSON.stringify(payload),
          signal: cancellationToken?.signal,
        });
      } catch (err) {
        if (cancellationToken?.isCancelled || (err instanceof Error && err.name === "AbortError")) {
          throw new CancelledError(cancellationToken?.reason || "cancelled");
        }
        if (attempt < maxRetries) {
          await sleepBeforeRetry(attempt, cancellationToken);
          continue;
        }
        throw err;
      }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          await sleepBeforeRetry(attempt, cancellationToken);
          continue;
        }
        await throwForHttpError(response);
      }
      return stream ? response : await response.json();
    }
  }

  private async request(
    messages: readonly Record<string, unknown>[],
    tools: readonly Record<string, unknown>[] | null | undefined,
    stream: boolean,
    cancellationToken?: CancellationToken | null,
    options?: {
      maxOutputTokens?: number | null;
      reasoningEffort?: string | null;
    },
  ): Promise<unknown> {
    cancellationToken?.throwIfCancelled();
    const effort = resolveReasoningEffort(
      this.reasoningEffort,
      options?.reasoningEffort,
      this.reasoningEfforts,
    );
    const reasoning =
      Boolean(effort && !this.reasoningEffortDisabled) || this._model.toLowerCase().includes("deepseek");
    const payload: Record<string, unknown> = {
      model: this._model,
      messages: chatMessages(messages, { reasoning }),
      stream,
    };
    if (options?.maxOutputTokens !== undefined && options.maxOutputTokens !== null) {
      payload.max_tokens = options.maxOutputTokens;
    }
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    if (tools && tools.length > 0) {
      payload.tools = [...tools];
      payload.tool_choice = "auto";
    }
    this.addPromptCacheKey(payload);
    if (effort && !this.reasoningEffortDisabled) {
      payload.reasoning_effort = effort;
    }

    while (true) {
      try {
        return await this.executeRequest(payload, stream, cancellationToken);
      } catch (exc) {
        if (exc instanceof CancelledError) {
          throw exc;
        }
        const isStatusErr =
          exc instanceof HttpStatusError ||
          typeof (exc as { status_code?: unknown })?.status_code === "number" ||
          typeof (exc as { status?: unknown })?.status === "number";
        if (isStatusErr) {
          if ("max_tokens" in payload && this.shouldRetryWithMaxCompletionTokens(exc)) {
            payload.max_completion_tokens = payload.max_tokens;
            delete payload.max_tokens;
            continue;
          }
          if ("prompt_cache_key" in payload && rejectsPromptCacheKey(exc)) {
            delete payload.prompt_cache_key;
            this.promptCacheKeyDisabled = true;
            continue;
          }
          if ("reasoning_effort" in payload && this.shouldRetryWithoutReasoningEffort(exc)) {
            delete payload.reasoning_effort;
            if (options?.reasoningEffort === undefined || options?.reasoningEffort === null) {
              this.reasoningEffortDisabled = true;
            }
            continue;
          }
        }
        throw exc;
      }
    }
  }

  async create(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: CancellationToken | null,
    options?: {
      maxOutputTokens?: number | null;
      reasoningEffort?: string | null;
    },
  ): Promise<ModelCompletion> {
    try {
      const result = await this.request(messages, tools, false, cancellationToken, options);
      return parseCompletion(result);
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc);
    }
  }

  async *stream(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: CancellationToken | null,
  ): AsyncGenerator<ModelStreamEvent> {
    let streamResponse: unknown;
    try {
      streamResponse = await this.request(messages, tools, true, cancellationToken);
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc);
    }

    const callIds = new Map<number, string>();
    try {
      for await (const chunk of iterateChunks(streamResponse, cancellationToken)) {
        for (const event of mapChunkEvents(chunk, callIds)) {
          yield event;
        }
      }
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc, "stream_interrupted");
    }
  }

  async close(): Promise<void> {
    if (this.asyncClient?.close) {
      await this.asyncClient.close();
    }
  }
}

async function sleepBeforeRetry(attempt: number, cancellationToken?: CancellationToken | null): Promise<void> {
  const delayMs = Math.min(2000, 250 * 2 ** attempt);
  if (cancellationToken) {
    await cancellationToken.sleep(delayMs);
  } else {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

async function* iterateChunks(
  response: unknown,
  cancellationToken?: CancellationToken | null,
): AsyncGenerator<unknown> {
  if (typeof Response !== "undefined" && response instanceof Response) {
    for await (const event of parseSseEvents(response, cancellationToken)) {
      const data = event.data.trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      yield JSON.parse(data);
    }
    return;
  }
  if (response && typeof (response as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of response as AsyncIterable<unknown>) {
      cancellationToken?.throwIfCancelled();
      yield chunk;
    }
  }
}

function mapChunkEvents(chunk: unknown, callIds: Map<number, string>): ModelStreamEvent[] {
  const usage = extractUsage(getField(chunk, "usage"));
  const events: ModelStreamEvent[] = [];
  const choices = getField(chunk, "choices");
  if (usage !== null) {
    events.push({ kind: "usage", usage });
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    return events;
  }
  const choice = choices[0];
  const delta = getField(choice, "delta");
  if (delta && typeof delta === "object") {
    const text = getField(delta, "content");
    if (text) {
      events.push({ kind: "text_delta", text: String(text) });
    }
    const reasoning = getField(delta, "reasoning_content");
    if (reasoning !== undefined && reasoning !== null) {
      events.push({ kind: "reasoning_delta", reasoning: String(reasoning) });
    }
    const toolCalls = getField(delta, "tool_calls");
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = getField(call, "function");
        const index = Number(getField(call, "index") ?? 0) || 0;
        let callId = String(getField(call, "id") ?? "");
        if (callId) {
          callIds.set(index, callId);
        } else {
          callId = callIds.get(index) ?? "";
        }
        const name = String(getField(fn, "name") ?? "");
        if (callId && name) {
          events.push({ kind: "tool_start", tool_call_id: callId, tool_name: name });
        }
        const argumentsDelta = getField(fn, "arguments");
        if (argumentsDelta) {
          events.push({
            kind: "tool_arguments_delta",
            tool_call_id: callId,
            tool_name: name,
            arguments: String(argumentsDelta),
          });
        }
      }
    }
  }
  const finish = getField(choice, "finish_reason");
  if (finish !== undefined && finish !== null) {
    events.push({ kind: "completed", stop_reason: normalizeFinishReason(String(finish)) });
  }
  return events;
}

function parseCompletion(response: unknown): ModelCompletion {
  const choices = getField(response, "choices");
  const firstChoice = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
  const message = getField(firstChoice, "message");
  const finishReason = getField(firstChoice, "finish_reason");
  const calls: ParsedToolCall[] = [];
  const rawCalls = getField(message, "tool_calls");
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const fn = getField(call, "function");
      calls.push({
        call_id: String(getField(call, "id") ?? ""),
        name: String(getField(fn, "name") ?? ""),
        raw_args: String(getField(fn, "arguments") ?? ""),
      });
    }
  }
  const rawReasoning = getField(message, "reasoning_content");
  return {
    content: String(getField(message, "content") ?? ""),
    tool_calls: calls,
    reasoning_content: typeof rawReasoning === "string" ? rawReasoning : null,
    usage: extractUsage(getField(response, "usage")),
    finish_reason:
      finishReason !== undefined && finishReason !== null && finishReason !== ""
        ? normalizeFinishReason(String(finishReason))
        : null,
  };
}

function extractUsage(rawUsage: unknown): ModelUsage | null {
  if (!rawUsage || typeof rawUsage !== "object") {
    return null;
  }
  const promptDetails = getField(rawUsage, "prompt_tokens_details");
  const completionDetails = getField(rawUsage, "completion_tokens_details");
  return {
    input_tokens: Number(getField(rawUsage, "prompt_tokens") ?? getField(rawUsage, "input_tokens") ?? 0) || 0,
    output_tokens: Number(getField(rawUsage, "completion_tokens") ?? getField(rawUsage, "output_tokens") ?? 0) || 0,
    cached_tokens: Number(getField(promptDetails, "cached_tokens") ?? 0) || 0,
    reasoning_tokens: Number(getField(completionDetails, "reasoning_tokens") ?? 0) || 0,
  };
}

function normalizeFinishReason(value: string): FinishReason {
  return FINISH_REASON_MAP[value] ?? "error";
}

function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
