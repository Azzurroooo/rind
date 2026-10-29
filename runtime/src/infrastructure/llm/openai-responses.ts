import type { CancellationToken } from "../../domain/cancellation.js";
import { CancelledError } from "../../domain/errors.js";
import type {
  ChatClient,
  ModelCompletion,
  ModelStreamEvent,
  ModelUsage,
  ParsedToolCall,
  RequestImage,
} from "../../domain/models.js";
import { resolveReasoningEffort } from "../providers.js";
import { DEFAULT_USER_AGENT } from "../settings.js";
import type { ApiKeyProvider } from "./openai-chat.js";
import {
  awaitWithCancellation,
  imageDataUrl,
  iterateWithCancellation,
  parseSseEvents,
  promptCacheKey,
  providerError,
  rejectsPromptCacheKey,
  throwForHttpError,
} from "./sse.js";

export interface MockOpenAIResponsesClient {
  responses: {
    create(payload: Record<string, unknown>): Promise<unknown>;
  };
  close?: () => Promise<void> | void;
}

export class OpenAIResponsesClient implements ChatClient {
  private readonly apiKey: ApiKeyProvider;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: string;
  private readonly reasoningEfforts: readonly string[];
  private readonly subscription: boolean;
  private readonly asyncClient: MockOpenAIResponsesClient | null;
  private sessionIdProvider: (() => string) | null = null;
  private promptCacheKeyDisabled = false;

  constructor(options: {
    apiKey?: ApiKeyProvider;
    model: string;
    baseUrl?: string | null;
    asyncClient?: MockOpenAIResponsesClient | null;
    reasoningEffort?: string | null;
    reasoningEfforts?: readonly string[];
    subscription?: boolean;
  }) {
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.reasoningEffort = options.reasoningEffort || "";
    this.reasoningEfforts = options.reasoningEfforts ?? [];
    this.subscription = Boolean(options.subscription);
    this.asyncClient = options.asyncClient ?? null;
  }

  setSessionIdProvider(provider: (() => string) | null): void {
    this.sessionIdProvider = provider;
  }

  private async resolveApiKey(): Promise<string> {
    return typeof this.apiKey === "function" ? await this.apiKey() : this.apiKey;
  }

  private buildPayload(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    options: { stream: boolean } = { stream: false },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.model,
      input: convertInputItems(messages),
      stream: options.stream,
    };
    const sessionId = this.sessionIdProvider ? this.sessionIdProvider() : "";
    if (sessionId && !this.promptCacheKeyDisabled) {
      payload.prompt_cache_key = promptCacheKey(sessionId);
    }
    if (this.subscription) {
      payload.store = false;
    }
    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => responseTool(t));
    }
    if (this.reasoningEffort) {
      payload.reasoning = { effort: this.reasoningEffort };
    }
    return payload;
  }

  private async executeRequest(
    payload: Record<string, unknown>,
    cancellationToken?: CancellationToken | null,
  ): Promise<unknown> {
    cancellationToken?.throwIfCancelled();
    if (this.asyncClient) {
      return await awaitWithCancellation(this.asyncClient.responses.create(payload), cancellationToken);
    }
    const stream = Boolean(payload.stream);
    const key = await this.resolveApiKey();
    const response = await awaitWithCancellation(
      fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": DEFAULT_USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: cancellationToken?.signal,
      }),
      cancellationToken,
    );
    if (!response.ok) {
      await throwForHttpError(response);
    }
    return stream ? response : await awaitWithCancellation(response.json(), cancellationToken);
  }

  private async request(
    payload: Record<string, unknown>,
    cancellationToken?: CancellationToken | null,
  ): Promise<unknown> {
    try {
      return await this.executeRequest(payload, cancellationToken);
    } catch (exc) {
      if ("prompt_cache_key" in payload && rejectsPromptCacheKey(exc)) {
        delete payload.prompt_cache_key;
        this.promptCacheKeyDisabled = true;
        return await this.executeRequest(payload, cancellationToken);
      }
      throw exc;
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
    const payload = this.buildPayload(messages, tools, { stream: false });
    if (options?.maxOutputTokens !== undefined && options.maxOutputTokens !== null && !this.subscription) {
      payload.max_output_tokens = options.maxOutputTokens;
    }
    const effort = resolveReasoningEffort(
      this.reasoningEffort,
      options?.reasoningEffort,
      this.reasoningEfforts,
    );
    if (effort) {
      payload.reasoning = { effort };
    }
    try {
      const response = await this.request(payload, cancellationToken);
      return parseCompletion(response);
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc, null, cancellationToken);
    }
  }

  async *stream(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: CancellationToken | null,
  ): AsyncGenerator<ModelStreamEvent> {
    const payload = this.buildPayload(messages, tools, { stream: true });
    const callIds = new Map<string, string>();
    try {
      const response = await this.request(payload, cancellationToken);
      for await (const raw of iterateResponseEvents(response, cancellationToken)) {
        for (const event of mapStreamEvents(raw, callIds)) {
          yield event;
        }
      }
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc, "stream_interrupted", cancellationToken);
    }
  }

  async close(): Promise<void> {
    if (this.asyncClient?.close) {
      await this.asyncClient.close();
    }
  }
}

async function* iterateResponseEvents(
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
    for await (const chunk of iterateWithCancellation(response as AsyncIterable<unknown>, cancellationToken)) {
      yield chunk;
    }
  }
}

function convertInputItems(messages: readonly Record<string, unknown>[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    const role = message.role;
    let content: unknown = message.content ?? "";
    const images = Array.isArray(message.images) ? (message.images as RequestImage[]) : [];
    if (images.length > 0) {
      content = [
        { type: "input_text", text: String(content) },
        ...images.map(image => ({
          type: "input_image",
          detail: "auto",
          image_url: imageDataUrl(image),
        })),
      ];
    }
    if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? ""),
        output: content,
      });
      continue;
    }
    const calls = role === "assistant" && Array.isArray(message.tool_calls)
      ? (message.tool_calls as Record<string, unknown>[])
      : null;
    if (calls && calls.length > 0) {
      if (message.content) {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of calls) {
        const fn = (call.function as Record<string, unknown>) ?? {};
        items.push({
          type: "function_call",
          call_id: String(call.id ?? ""),
          name: String(fn.name ?? ""),
          arguments: String(fn.arguments ?? "{}"),
        });
      }
      continue;
    }
    items.push({ role, content });
  }
  return items;
}

function responseTool(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = (tool.function as Record<string, unknown>) ?? tool;
  return {
    type: "function",
    name: fn.name ?? "",
    description: fn.description ?? "",
    parameters: fn.parameters ?? {},
  };
}

function mapStreamEvents(raw: unknown, callIds: Map<string, string>): ModelStreamEvent[] {
  const kind = String(getField(raw, "type") ?? "");
  const events: ModelStreamEvent[] = [];
  if (kind === "response.output_text.delta") {
    events.push({ kind: "text_delta", text: String(getField(raw, "delta") ?? "") });
  } else if (kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") {
    events.push({ kind: "reasoning_delta", reasoning: String(getField(raw, "delta") ?? "") });
  } else if (kind === "response.output_item.added") {
    const item = getField(raw, "item");
    if (getField(item, "type") === "function_call") {
      const callId = String(getField(item, "call_id") || getField(item, "id") || "");
      const itemId = String(getField(item, "id") || "");
      if (itemId) {
        callIds.set(itemId, callId);
      }
      events.push({ kind: "tool_start", tool_call_id: callId, tool_name: String(getField(item, "name") ?? "") });
    }
  } else if (kind === "response.function_call_arguments.delta") {
    const itemId = String(getField(raw, "item_id") ?? "");
    const callId = String(getField(raw, "call_id") || callIds.get(itemId) || itemId);
    events.push({
      kind: "tool_arguments_delta",
      tool_call_id: callId,
      tool_name: String(getField(raw, "name") ?? ""),
      arguments: String(getField(raw, "delta") ?? ""),
    });
  } else if (kind === "response.function_call_arguments.done") {
    const itemId = String(getField(raw, "item_id") ?? "");
    const callId = String(getField(raw, "call_id") || callIds.get(itemId) || itemId);
    events.push({
      kind: "tool_end",
      tool_call_id: callId,
      tool_name: String(getField(raw, "name") ?? ""),
    });
  } else if (kind === "response.completed" || kind === "response.incomplete") {
    const response = getField(raw, "response") ?? raw;
    const usage = extractUsage(getField(response, "usage"));
    if (usage) {
      events.push({ kind: "usage", usage });
    }
    const status = String(getField(response, "status") || "completed");
    events.push({
      kind: "completed",
      stop_reason:
        kind.endsWith("completed") && status === "completed"
          ? "stop"
          : status === "incomplete"
            ? "length"
            : "error",
    });
  } else if (kind === "response.failed" || kind === "error") {
    const error = getField(getField(raw, "response"), "error") || getField(raw, "error") || raw;
    const message = String(getField(error, "message") || error);
    const code = String(getField(error, "code") || "");
    throw providerError(new Error(code ? `${code}: ${message}` : message), "stream_interrupted");
  }
  return events.filter(event => event.kind !== "text_delta" || Boolean(event.text));
}

function parseCompletion(response: unknown): ModelCompletion {
  const content: string[] = [];
  const reasoning: string[] = [];
  const calls: ParsedToolCall[] = [];
  const outputs = getField(response, "output");
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      const itemType = getField(item, "type");
      if (itemType === "message") {
        const parts = getField(item, "content");
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (getField(part, "type") === "output_text" || getField(part, "type") === "text") {
              content.push(String(getField(part, "text") ?? ""));
            }
          }
        }
      } else if (itemType === "function_call") {
        calls.push({
          call_id: String(getField(item, "call_id") || getField(item, "id") || ""),
          name: String(getField(item, "name") ?? ""),
          raw_args: String(getField(item, "arguments") ?? "{}"),
        });
      }
    }
  }
  const status = String(getField(response, "status") || "completed");
  let finishReason: string = calls.length > 0 ? "tool_calls" : "stop";
  if (status !== "completed") {
    finishReason = status === "incomplete" ? "length" : "error";
  }
  return {
    content: content.join(""),
    tool_calls: calls,
    reasoning_content: reasoning.join("") || null,
    usage: extractUsage(getField(response, "usage")),
    finish_reason: finishReason,
  };
}

function extractUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const inputDetails = getField(value, "input_tokens_details");
  const outputDetails = getField(value, "output_tokens_details");
  return {
    input_tokens: Number(getField(value, "input_tokens") ?? 0) || 0,
    output_tokens: Number(getField(value, "output_tokens") ?? 0) || 0,
    cached_tokens: Number(getField(inputDetails, "cached_tokens") ?? 0) || 0,
    reasoning_tokens:
      Number(getField(outputDetails, "reasoning_tokens") ?? getField(value, "reasoning_tokens") ?? 0) || 0,
  };
}

function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
