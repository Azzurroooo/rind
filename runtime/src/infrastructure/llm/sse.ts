import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CancellationToken } from "../../domain/cancellation.js";
import { CancelledError, ProviderError } from "../../domain/errors.js";
import { sha256Hex, type RequestImage } from "../../domain/models.js";

const OVERFLOW_RE =
  /prompt is too long|input is too long for requested model|exceeds the context window|input token count[\s\S]*exceeds the maximum|maximum prompt length is \d+|reduce the length of the messages|maximum context length|exceeds the limit of \d+|exceeds the available context size|greater than the context length|context window exceeds limit|exceeded model token limit|context length of only \d+|context[_ ]length[_ ]exceeded|context_overflow|request_too_large|too many tokens|token limit exceeded/i;

const NON_OVERFLOW_RE = /too many tokens,\s*please wait|tokens per minute|rate[_ ]limit/i;

export function redactImageText(text: string): string {
  const withoutDataUrl = text.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=_-]+/g, "[image data omitted]");
  return withoutDataUrl.replace(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{80,}={0,2}/g, "[encoded data omitted]");
}

export function imageDataUrl(image: RequestImage): string {
  return `data:${image.mime_type};base64,${image.data.toString("base64")}`;
}

export function separateToolImages(messages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const pending: RequestImage[] = [];
  const sources: string[] = [];

  const flush = () => {
    if (pending.length > 0) {
      result.push({
        role: "user",
        content: `Images from tool results (in order):\n${sources.join("\n")}`,
        images: [...pending],
      });
      pending.length = 0;
      sources.length = 0;
    }
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      flush();
      result.push(message);
      continue;
    }
    const copied: Record<string, unknown> = { ...message };
    const images = Array.isArray(copied.images) ? (copied.images as RequestImage[]) : [];
    delete copied.images;
    for (const image of images) {
      pending.push(image);
      sources.push(`Image ${pending.length}: tool call ${String(message.tool_call_id ?? "")}`);
    }
    result.push(copied);
  }
  flush();
  return result;
}

export function chatMessages(
  messages: readonly Record<string, unknown>[],
  options: { reasoning?: boolean } = {},
): Record<string, unknown>[] {
  const includeReasoning = Boolean(options.reasoning) || messages.some(m => "reasoning_content" in m);
  const result: Record<string, unknown>[] = [];
  for (const message of separateToolImages(messages)) {
    const copied: Record<string, unknown> = { ...message };
    const images = Array.isArray(copied.images) ? (copied.images as RequestImage[]) : [];
    delete copied.images;
    if (images.length > 0) {
      copied.content = [
        { type: "text", text: String(copied.content ?? "") },
        ...images.map(image => ({
          type: "image_url",
          image_url: { url: imageDataUrl(image) },
        })),
      ];
    }
    if (includeReasoning && copied.role === "assistant" && (copied.reasoning_content === null || copied.reasoning_content === undefined)) {
      copied.reasoning_content = "";
    }
    result.push(copied);
  }
  return result;
}

export function isContextOverflow(text: string, httpStatus?: number | null): boolean {
  if (NON_OVERFLOW_RE.test(text)) {
    return false;
  }
  if (OVERFLOW_RE.test(text)) {
    return true;
  }
  return httpStatus === 413;
}

export class HttpStatusError extends Error {
  readonly status_code: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status_code = statusCode;
  }
}

export function providerError(exc: unknown, code?: string | null): ProviderError {
  if (exc instanceof ProviderError) {
    if (exc.code !== "context_length_exceeded" && isContextOverflow(exc.message)) {
      return new ProviderError(exc.message, {
        status: "rejected",
        errorType: exc.error_type,
        code: "context_length_exceeded",
      });
    }
    return exc;
  }
  if (exc instanceof CancelledError || (exc instanceof Error && exc.name === "AbortError")) {
    throw new CancelledError(exc instanceof CancelledError ? exc.reason : "cancelled");
  }
  const errObj = exc as { message?: string; status_code?: number; status?: number; code?: unknown; name?: string } | null;
  const rawMessage = exc instanceof Error ? exc.message : String(exc);
  const text = redactImageText(rawMessage);
  const rawStatus = errObj?.status_code ?? errObj?.status ?? (typeof errObj?.code === "number" ? errObj.code : undefined);
  const httpStatus = typeof rawStatus === "number" ? rawStatus : null;
  const errType = (exc instanceof Error ? exc.constructor.name : undefined) || errObj?.name || "Error";

  let status: "failed" | "timed_out" | "rejected" | "unavailable" = "failed";
  let resolvedCode: string | null = code ?? null;

  if (isContextOverflow(text, httpStatus)) {
    status = "rejected";
    resolvedCode = "context_length_exceeded";
  } else if (
    httpStatus === 408 ||
    httpStatus === 504 ||
    errType.includes("Timeout") ||
    /timed?\s*out/i.test(text)
  ) {
    status = "timed_out";
  } else if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    status = "rejected";
    resolvedCode = "provider_rejected";
  } else if (
    (httpStatus !== null && httpStatus >= 500) ||
    httpStatus === 429 ||
    errType.includes("Connection") ||
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(text)
  ) {
    status = "unavailable";
  } else {
    status = resolvedCode === "stream_interrupted" ? "unavailable" : "failed";
  }
  return new ProviderError(text, { status, errorType: errType, code: resolvedCode });
}

export function promptCacheKey(sessionId: string): string {
  return "rind:" + createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 24);
}

export function rejectsPromptCacheKey(exc: unknown): boolean {
  const text = (exc instanceof Error ? exc.message : String(exc)).toLowerCase();
  return (
    text.includes("prompt_cache_key") &&
    ["unsupported", "unknown", "invalid", "unrecognized", "not support", "extra_forbidden"].some(marker =>
      text.includes(marker),
    )
  );
}

export interface LlmCallTrace {
  record(
    api: string,
    operation: string,
    payload: Record<string, unknown>,
    options?: {
      sessionId?: string;
      baseUrl?: string;
      status?: string;
      usage?: unknown;
      error?: string | null;
    },
  ): void;
}

export function makeTrace(tracePath?: string | null): LlmCallTrace | null {
  const resolved = tracePath || process.env.RIND_LLM_TRACE_PATH;
  if (!resolved) {
    return null;
  }
  const filePath = path.resolve(resolved);
  return {
    record(api, operation, payload, options = {}) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const messages = Array.isArray(payload.messages)
          ? (payload.messages as Record<string, unknown>[])
          : Array.isArray(payload.input)
            ? (payload.input as Record<string, unknown>[])
            : [];
        const prefixHashes: string[] = [];
        const running: unknown[] = [];
        for (const item of messages) {
          running.push(traceReady(item));
          const serialized = JSON.stringify(running);
          prefixHashes.push(sha256Hex(serialized).slice(0, 16));
        }
        const entry = {
          ts: new Date().toISOString(),
          session_id: options.sessionId ?? "",
          api,
          operation,
          base_url: options.baseUrl ?? "",
          model: payload.model,
          prompt_cache_key: payload.prompt_cache_key ?? null,
          reasoning_effort:
            payload.reasoning_effort ??
            (payload.reasoning && typeof payload.reasoning === "object"
              ? (payload.reasoning as Record<string, unknown>).effort
              : null),
          message_count: messages.length,
          prefix_hashes: prefixHashes,
          tool_names: Array.isArray(payload.tools)
            ? (payload.tools as Record<string, unknown>[]).map(t => {
                const fn = t.function as Record<string, unknown> | undefined;
                return String(t.name ?? fn?.name ?? "");
              })
            : [],
          status: options.status ?? "ok",
          usage: traceReady(options.usage ?? null),
          error: options.error ?? null,
          payload: traceReady(payload),
        };
        fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // Tracing is diagnostic only
      }
    },
  };
}

function traceReady(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<bytes:${value.byteLength}>`;
  }
  if (Array.isArray(value)) {
    return value.map(item => traceReady(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = traceReady(v);
    }
    return out;
  }
  return value;
}

export async function* parseSseEvents(
  response: Response,
  cancellationToken?: CancellationToken | null,
): AsyncGenerator<{ event: string | null; data: string }> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];

  const onCancel = () => {
    reader.cancel().catch(() => {});
  };
  const unsubscribe = cancellationToken ? cancellationToken.onCancel(onCancel) : () => {};

  try {
    while (true) {
      cancellationToken?.throwIfCancelled();
      const { value, done } = await reader.read();
      cancellationToken?.throwIfCancelled();
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line === "") {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join("\n") };
            eventName = null;
            dataLines = [];
          } else {
            eventName = null;
          }
          continue;
        }
        if (line.startsWith(":")) {
          continue;
        }
        const colonIdx = line.indexOf(":");
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        let val = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
        if (val.startsWith(" ")) {
          val = val.slice(1);
        }
        if (field === "event") {
          eventName = val;
        } else if (field === "data") {
          dataLines.push(val);
        }
      }
      if (done) {
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
        }
        break;
      }
    }
  } finally {
    unsubscribe();
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export async function throwForHttpError(response: Response): Promise<never> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = response.statusText || `HTTP ${response.status}`;
  }
  let message = bodyText.trim() || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object") {
      const errObj = (parsed as Record<string, unknown>).error ?? parsed;
      if (typeof errObj === "string" && errObj.trim()) {
        message = errObj.trim();
      } else if (errObj && typeof errObj === "object") {
        const msg = (errObj as Record<string, unknown>).message ?? (errObj as Record<string, unknown>).detail;
        if (typeof msg === "string" && msg.trim()) {
          message = `${response.status}: ${msg.trim()}`;
        }
      }
    }
  } catch {
    // keep bodyText
  }
  throw new HttpStatusError(response.status, message);
}
