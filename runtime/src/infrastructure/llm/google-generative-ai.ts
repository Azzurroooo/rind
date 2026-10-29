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
import { parseSseEvents, providerError, separateToolImages, throwForHttpError } from "./sse.js";

export interface MockGoogleGenAIClient {
  aio: {
    models: {
      generate_content(params: {
        model: string;
        contents: unknown[];
        config: Record<string, unknown>;
      }): Promise<unknown>;
      generate_content_stream(params: {
        model: string;
        contents: unknown[];
        config: Record<string, unknown>;
      }): Promise<unknown>;
    };
    close?: () => Promise<void> | void;
  };
  close?: () => Promise<void> | void;
}

export class GoogleGenerativeAIClient implements ChatClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly client: MockGoogleGenAIClient | null;
  private readonly sendToolCallIds: boolean;

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string | null;
    client?: MockGoogleGenAIClient | null;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.client = options.client ?? null;
    this.sendToolCallIds = requiresToolCallIds(options.model);
  }

  private endpoint(stream: boolean): string {
    const base = this.baseUrl.endsWith("/v1beta") ? this.baseUrl : `${this.baseUrl}/v1beta`;
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${base}/models/${encodeURIComponent(this.model)}:${method}`;
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
    const [contents, config] = buildRequest(messages, tools, this.sendToolCallIds);
    if (options?.maxOutputTokens !== undefined && options.maxOutputTokens !== null) {
      config.max_output_tokens = options.maxOutputTokens;
    }
    try {
      cancellationToken?.throwIfCancelled();
      if (this.client) {
        const response = await this.client.aio.models.generate_content({
          model: this.model,
          contents,
          config,
        });
        return parseCompletion(response);
      }
      const body = buildRestBody(contents, config);
      const response = await fetch(this.endpoint(false), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "User-Agent": DEFAULT_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: cancellationToken?.signal,
      });
      if (!response.ok) {
        await throwForHttpError(response);
      }
      return parseCompletion(await response.json());
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
    const [contents, config] = buildRequest(messages, tools, this.sendToolCallIds);
    let nextFallbackIdx = 0;
    const fallbackId = () => `call_${nextFallbackIdx++}`;
    try {
      cancellationToken?.throwIfCancelled();
      let streamSource: unknown;
      if (this.client) {
        streamSource = await this.client.aio.models.generate_content_stream({
          model: this.model,
          contents,
          config,
        });
      } else {
        const body = buildRestBody(contents, config);
        const response = await fetch(this.endpoint(true), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-goog-api-key": this.apiKey,
            "User-Agent": DEFAULT_USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: cancellationToken?.signal,
        });
        if (!response.ok) {
          await throwForHttpError(response);
        }
        streamSource = response;
      }
      for await (const raw of iterateGeminiEvents(streamSource, cancellationToken)) {
        for (const event of mapEvents(raw, fallbackId)) {
          yield event;
        }
      }
    } catch (exc) {
      if (exc instanceof CancelledError) throw exc;
      throw providerError(exc, "stream_interrupted");
    }
  }

  async close(): Promise<void> {
    try {
      if (this.client?.aio?.close) {
        await this.client.aio.close();
      }
    } finally {
      if (this.client?.close) {
        await this.client.close();
      }
    }
  }
}

function buildRestBody(contents: unknown[], config: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { contents };
  if (config.system_instruction) {
    body.systemInstruction = { parts: [{ text: String(config.system_instruction) }] };
  }
  if (config.tools) {
    body.tools = config.tools;
  }
  if (config.max_output_tokens !== undefined) {
    body.generationConfig = { maxOutputTokens: config.max_output_tokens };
  }
  return body;
}

async function* iterateGeminiEvents(
  source: unknown,
  cancellationToken?: CancellationToken | null,
): AsyncGenerator<unknown> {
  if (typeof Response !== "undefined" && source instanceof Response) {
    for await (const event of parseSseEvents(source, cancellationToken)) {
      const data = event.data.trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      yield JSON.parse(data);
    }
    return;
  }
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of source as AsyncIterable<unknown>) {
      cancellationToken?.throwIfCancelled();
      yield chunk;
    }
  }
}

function buildRequest(
  messages: readonly Record<string, unknown>[],
  tools: readonly Record<string, unknown>[] | null | undefined,
  sendToolCallIds: boolean,
): [Record<string, unknown>[], Record<string, unknown>] {
  const [system, contents] = convertContents(messages, sendToolCallIds);
  const config: Record<string, unknown> = {};
  if (system) config.system_instruction = system;
  if (tools && tools.length > 0) {
    config.tools = [{ function_declarations: tools.map(t => declaration(t)) }];
  }
  return [contents, config];
}

function convertContents(
  messages: readonly Record<string, unknown>[],
  sendToolCallIds: boolean,
): [string, Record<string, unknown>[]] {
  const system: string[] = [];
  const contents: Record<string, unknown>[] = [];
  const names = new Map<string, string>();
  for (const message of separateToolImages(messages)) {
    const role = message.role;
    if (role === "system") {
      system.push(String(message.content ?? ""));
      continue;
    }
    if (role === "tool") {
      const callId = String(message.tool_call_id ?? "");
      const response: Record<string, unknown> = {
        name: names.get(callId) ?? "",
        response: { output: String(message.content ?? "") },
      };
      if (sendToolCallIds) {
        response.id = callId;
      }
      const part = { function_response: response };
      const last = contents.length > 0 ? contents[contents.length - 1] : null;
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.parts) &&
        (last.parts as Record<string, unknown>[]).some(item => "function_response" in item)
      ) {
        (last.parts as Record<string, unknown>[]).push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    if (message.content) {
      parts.push({ text: String(message.content) });
    }
    const images = Array.isArray(message.images) ? (message.images as RequestImage[]) : [];
    for (const image of images) {
      parts.push({
        inline_data: {
          mime_type: image.mime_type,
          data: image.data,
        },
      });
    }
    const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
    for (const call of toolCalls) {
      const fn = (call.function as Record<string, unknown>) ?? {};
      const callId = String(call.id ?? "");
      const fnName = String(fn.name ?? "");
      const functionCall: Record<string, unknown> = {
        name: fnName,
        args: parseArgs(fn.arguments),
      };
      names.set(callId, fnName);
      if (sendToolCallIds) {
        functionCall.id = callId;
      }
      parts.push({ function_call: functionCall });
    }
    if (parts.length > 0) {
      contents.push({
        role: role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }
  return [system.join("\n\n"), contents];
}

function declaration(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = (tool.function as Record<string, unknown>) ?? tool;
  return {
    name: fn.name ?? "",
    description: fn.description ?? "",
    parameters_json_schema: fn.parameters ?? {},
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapEvents(chunk: unknown, fallbackId: () => string): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [];
  const usage = extractUsage(getField(chunk, "usage_metadata") ?? getField(chunk, "usageMetadata"));
  if (usage !== null) {
    events.push({ kind: "usage", usage });
  }
  const candidates = getField(chunk, "candidates");
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return events;
  }
  const candidate = candidates[0];
  const parts = getField(getField(candidate, "content"), "parts");
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const functionCall = getField(part, "function_call") ?? getField(part, "functionCall");
      if (functionCall) {
        const callId = String(getField(functionCall, "id") || "") || fallbackId();
        const name = String(getField(functionCall, "name") ?? "");
        events.push({ kind: "tool_start", tool_call_id: callId, tool_name: name });
        events.push({
          kind: "tool_arguments_delta",
          tool_call_id: callId,
          tool_name: name,
          arguments: JSON.stringify(getField(functionCall, "args") ?? {}),
        });
        events.push({ kind: "tool_end", tool_call_id: callId });
        continue;
      }
      const text = getField(part, "text");
      if (!text) continue;
      if (getField(part, "thought")) {
        events.push({ kind: "reasoning_delta", reasoning: String(text) });
      } else {
        events.push({ kind: "text_delta", text: String(text) });
      }
    }
  }
  const finish = getField(candidate, "finish_reason") ?? getField(candidate, "finishReason");
  if (finish !== undefined && finish !== null) {
    events.push({ kind: "completed", stop_reason: stopReason(String(finish)) });
  }
  return events;
}

function parseCompletion(response: unknown): ModelCompletion {
  const candidates = getField(response, "candidates");
  const candidate = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null;
  const parts = getField(getField(candidate, "content"), "parts");
  const content: string[] = [];
  const reasoning: string[] = [];
  const calls: ParsedToolCall[] = [];
  if (Array.isArray(parts)) {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const text = getField(part, "text");
      const functionCall = getField(part, "function_call") ?? getField(part, "functionCall");
      if (functionCall) {
        const callId = String(getField(functionCall, "id") || "") || `call_${i}`;
        calls.push({
          call_id: callId,
          name: String(getField(functionCall, "name") ?? ""),
          raw_args: JSON.stringify(getField(functionCall, "args") ?? {}),
        });
      } else if (text && getField(part, "thought")) {
        reasoning.push(String(text));
      } else if (text) {
        content.push(String(text));
      }
    }
  }
  const finish = getField(candidate, "finish_reason") ?? getField(candidate, "finishReason");
  return {
    content: content.join(""),
    tool_calls: calls,
    reasoning_content: reasoning.join("") || null,
    usage: extractUsage(getField(response, "usage_metadata") ?? getField(response, "usageMetadata")),
    finish_reason: finish !== undefined && finish !== null ? stopReason(String(finish)) : null,
  };
}

function extractUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    input_tokens: Number(getField(value, "prompt_token_count") ?? getField(value, "promptTokenCount") ?? 0) || 0,
    output_tokens: Number(getField(value, "candidates_token_count") ?? getField(value, "candidatesTokenCount") ?? 0) || 0,
    cached_tokens: Number(getField(value, "cached_content_token_count") ?? getField(value, "cachedContentTokenCount") ?? 0) || 0,
    reasoning_tokens: Number(getField(value, "thoughts_token_count") ?? getField(value, "thoughtsTokenCount") ?? 0) || 0,
  };
}

function stopReason(value: string): string {
  const parts = value.split(".");
  const reason = parts[parts.length - 1].toUpperCase();
  const map: Record<string, string> = {
    STOP: "stop",
    MAX_TOKENS: "length",
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    PROHIBITED_CONTENT: "content_filter",
  };
  return map[reason] ?? "error";
}

function requiresToolCallIds(model: string): boolean {
  const lowered = model.toLowerCase();
  const match = /^gemini-(\d+)/.exec(lowered);
  return Boolean(match && Number.parseInt(match[1], 10) >= 3) || lowered.startsWith("gpt-oss-");
}

function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
