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
import { DEFAULT_USER_AGENT } from "../settings.js";
import {
  awaitWithCancellation,
  iterateWithCancellation,
  parseSseEvents,
  providerError,
  throwForHttpError,
} from "./sse.js";

export interface MockAnthropicClient {
  messages: {
    create(payload: Record<string, unknown>): Promise<unknown>;
  };
  close?: () => Promise<void> | void;
}

export class AnthropicMessagesClient implements ChatClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly asyncClient: MockAnthropicClient | null;

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string | null;
    asyncClient?: MockAnthropicClient | null;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    this.asyncClient = options.asyncClient ?? null;
  }

  private messagesEndpoint(): string {
    return this.baseUrl.endsWith("/v1") ? `${this.baseUrl}/messages` : `${this.baseUrl}/v1/messages`;
  }

  private async executeRequest(
    payload: Record<string, unknown>,
    stream: boolean,
    cancellationToken?: CancellationToken | null,
  ): Promise<unknown> {
    cancellationToken?.throwIfCancelled();
    if (this.asyncClient) {
      return await awaitWithCancellation(this.asyncClient.messages.create(payload), cancellationToken);
    }
    const response = await awaitWithCancellation(
      fetch(this.messagesEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
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

  async create(
    messages: readonly Record<string, unknown>[],
    tools?: readonly Record<string, unknown>[] | null,
    cancellationToken?: CancellationToken | null,
    options?: {
      maxOutputTokens?: number | null;
      reasoningEffort?: string | null;
    },
  ): Promise<ModelCompletion> {
    const [system, converted] = convertMessages(messages);
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: converted,
      max_tokens: options?.maxOutputTokens ?? 32768,
    };
    if (system) payload.system = system;
    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => anthropicTool(t));
    }
    try {
      const response = await this.executeRequest(payload, false, cancellationToken);
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
    const [system, converted] = convertMessages(messages);
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: converted,
      max_tokens: 32768,
      stream: true,
    };
    if (system) payload.system = system;
    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => anthropicTool(t));
    }
    let usage: ModelUsage | null = null;
    try {
      const response = await this.executeRequest(payload, true, cancellationToken);
      for await (const raw of iterateAnthropicEvents(response, cancellationToken)) {
        const [events, nextUsage] = mapEvents(raw, usage);
        usage = nextUsage;
        for (const event of events) {
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

async function* iterateAnthropicEvents(
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

function convertMessages(
  messages: readonly Record<string, unknown>[],
): [string, Record<string, unknown>[]] {
  const system: string[] = [];
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const role = message.role;
    const rawImages = Array.isArray(message.images) ? (message.images as RequestImage[]) : [];
    const imageBlocks = rawImages.map(image => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mime_type,
        data: image.data.toString("base64"),
      },
    }));
    if (role === "system") {
      system.push(String(message.content ?? ""));
      continue;
    }
    if (role === "tool") {
      const text = String(message.content ?? "");
      const content =
        imageBlocks.length > 0
          ? [...(text ? [{ type: "text", text }] : []), ...imageBlocks]
          : text;
      const block: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id ?? ""),
        content,
      };
      let parsedPayload: unknown = null;
      try {
        parsedPayload = JSON.parse(text);
      } catch {
        parsedPayload = null;
      }
      if (
        message.is_error ||
        (parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload) && (parsedPayload as Record<string, unknown>).ok === false)
      ) {
        block.is_error = true;
      }
      const last = result.length > 0 ? result[result.length - 1] : null;
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        (last.content as Record<string, unknown>[]).some(item => item.type === "tool_result")
      ) {
        (last.content as Record<string, unknown>[]).push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }
    const contentBlocks: Record<string, unknown>[] = [];
    if (message.content) {
      contentBlocks.push({ type: "text", text: String(message.content) });
    }
    contentBlocks.push(...imageBlocks);
    const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
    for (const call of toolCalls) {
      const fn = (call.function as Record<string, unknown>) ?? {};
      let args: unknown = {};
      try {
        args = JSON.parse(String(fn.arguments ?? "{}"));
      } catch {
        args = {};
      }
      contentBlocks.push({
        type: "tool_use",
        id: String(call.id ?? ""),
        name: String(fn.name ?? ""),
        input: args && typeof args === "object" && !Array.isArray(args) ? args : {},
      });
    }
    const plainText = contentBlocks.length === 1 && contentBlocks[0].type === "text";
    result.push({
      role: role === "assistant" ? "assistant" : "user",
      content: plainText ? contentBlocks[0].text : contentBlocks.length > 0 ? contentBlocks : "",
    });
  }
  return [system.join("\n\n"), result];
}

function anthropicTool(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = (tool.function as Record<string, unknown>) ?? tool;
  return {
    name: fn.name ?? "",
    description: fn.description ?? "",
    input_schema: fn.parameters ?? {},
  };
}

function mapEvents(
  raw: unknown,
  previousUsage: ModelUsage | null = null,
): [ModelStreamEvent[], ModelUsage | null] {
  const eventType = String(getField(raw, "type") ?? "");
  if (eventType === "content_block_start") {
    const block = getField(raw, "content_block");
    if (getField(block, "type") === "tool_use") {
      return [
        [
          {
            kind: "tool_start",
            tool_call_id: String(getField(block, "id") ?? ""),
            tool_name: String(getField(block, "name") ?? ""),
          },
        ],
        previousUsage,
      ];
    }
  } else if (eventType === "content_block_delta") {
    const delta = getField(raw, "delta");
    const kind = getField(delta, "type");
    if (kind === "text_delta") {
      return [[{ kind: "text_delta", text: String(getField(delta, "text") ?? "") }], previousUsage];
    }
    if (kind === "thinking_delta") {
      return [[{ kind: "reasoning_delta", reasoning: String(getField(delta, "thinking") ?? "") }], previousUsage];
    }
    if (kind === "input_json_delta") {
      return [[{ kind: "tool_arguments_delta", arguments: String(getField(delta, "partial_json") ?? "") }], previousUsage];
    }
  } else if (eventType === "content_block_stop") {
    return [[{ kind: "tool_end" }], previousUsage];
  } else if (eventType === "message_delta") {
    const delta = getField(raw, "delta");
    const usage = extractUsage(getField(raw, "usage"), previousUsage);
    const events: ModelStreamEvent[] = [];
    if (usage !== null) {
      events.push({ kind: "usage", usage });
    }
    const stopReasonMap: Record<string, string> = {
      end_turn: "stop",
      tool_use: "tool_calls",
      max_tokens: "length",
    };
    events.push({
      kind: "completed",
      stop_reason: stopReasonMap[String(getField(delta, "stop_reason") ?? "")] ?? "error",
    });
    return [events, usage ?? previousUsage];
  } else if (eventType === "message_start") {
    const usage = extractUsage(getField(getField(raw, "message"), "usage"), previousUsage);
    return [usage ? [{ kind: "usage", usage }] : [], usage ?? previousUsage];
  } else if (eventType === "error") {
    const error = getField(raw, "error") ?? raw;
    throw providerError(new Error(String(getField(error, "message") || error)), "stream_interrupted");
  }
  return [[], previousUsage];
}

function parseCompletion(response: unknown): ModelCompletion {
  const content: string[] = [];
  const reasoning: string[] = [];
  const calls: ParsedToolCall[] = [];
  const blocks = getField(response, "content");
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const kind = getField(block, "type");
      if (kind === "text") {
        content.push(String(getField(block, "text") ?? ""));
      } else if (kind === "thinking") {
        reasoning.push(String(getField(block, "thinking") ?? ""));
      } else if (kind === "tool_use") {
        calls.push({
          call_id: String(getField(block, "id") ?? ""),
          name: String(getField(block, "name") ?? ""),
          raw_args: JSON.stringify(getField(block, "input") ?? {}),
        });
      }
    }
  }
  const stopReasonMap: Record<string, string> = {
    end_turn: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
  };
  const reason = stopReasonMap[String(getField(response, "stop_reason") ?? "")] ?? "error";
  return {
    content: content.join(""),
    tool_calls: calls,
    reasoning_content: reasoning.join("") || null,
    usage: extractUsage(getField(response, "usage")),
    finish_reason: reason,
  };
}

function extractUsage(value: unknown, previous: ModelUsage | null = null): ModelUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rawInput = getField(value, "input_tokens");
  const rawCacheRead = getField(value, "cache_read_input_tokens");
  const rawCacheWrite = getField(value, "cache_creation_input_tokens");
  const cacheRead =
    rawCacheRead !== undefined && rawCacheRead !== null
      ? Number(rawCacheRead) || 0
      : previous
        ? previous.cached_tokens
        : 0;
  let inputTokens: number;
  if (rawInput !== undefined || rawCacheRead !== undefined || rawCacheWrite !== undefined) {
    const uncached =
      rawInput !== undefined && rawInput !== null
        ? Number(rawInput) || 0
        : Math.max(0, previous ? previous.input_tokens - previous.cached_tokens : 0);
    inputTokens = uncached + cacheRead + (Number(rawCacheWrite ?? 0) || 0);
  } else {
    inputTokens = previous ? previous.input_tokens : 0;
  }
  const rawOutput = getField(value, "output_tokens");
  const outputTokens =
    rawOutput !== undefined && rawOutput !== null
      ? Number(rawOutput) || 0
      : previous
        ? previous.output_tokens
        : 0;
  const details = getField(value, "output_tokens_details");
  const rawReasoning = details !== undefined && details !== null ? getField(details, "thinking_tokens") : getField(value, "thinking_tokens");
  const reasoningTokens =
    rawReasoning !== undefined && rawReasoning !== null
      ? Number(rawReasoning) || 0
      : previous
        ? previous.reasoning_tokens
        : 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cacheRead,
    reasoning_tokens: reasoningTokens,
  };
}

function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
