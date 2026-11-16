import { createHash } from "node:crypto";
import type { CancellationToken } from "../../domain/cancellation.js";
import { CancelledError, ProviderError } from "../../domain/errors.js";
import type { RequestImage } from "../../domain/models.js";

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

export const MODEL_IDLE_TIMEOUT_MS = 600_000;

export function isCancellationError(exc: unknown, cancellationToken?: CancellationToken | null): boolean {
  if (cancellationToken?.isCancelled || exc instanceof CancelledError) {
    return true;
  }
  if (exc instanceof Error) {
    if (exc.name === "AbortError") {
      return true;
    }
    if (exc.cause instanceof CancelledError || (exc.cause instanceof Error && exc.cause.name === "AbortError")) {
      return true;
    }
  }
  return false;
}

export async function awaitWithCancellation<T>(
  promise: Promise<T>,
  cancellationToken?: CancellationToken | null,
  timeoutMs = MODEL_IDLE_TIMEOUT_MS,
): Promise<T> {
  cancellationToken?.throwIfCancelled();
  let timer = null as ReturnType<typeof setTimeout> | null;
  let unsubscribe = null as (() => void) | null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutSec = Math.round(timeoutMs / 1000);
      reject(
        new ProviderError(`Model stream timed out after ${timeoutSec}s of inactivity`, {
          status: "timed_out",
          errorType: "TimeoutError",
        }),
      );
    }, timeoutMs);
  });

  const races: Promise<T>[] = [promise, timeoutPromise];
  if (cancellationToken) {
    const cancelPromise = new Promise<never>((_, reject) => {
      unsubscribe = cancellationToken.onCancel(() => {
        reject(new CancelledError(cancellationToken.reason || "cancelled"));
      });
    });
    races.push(cancelPromise);
  }

  try {
    return await Promise.race(races);
  } catch (exc) {
    void promise.catch(() => {});
    if (isCancellationError(exc, cancellationToken)) {
      throw new CancelledError(
        cancellationToken?.reason || (exc instanceof CancelledError ? exc.reason : "cancelled"),
      );
    }
    throw exc;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    unsubscribe?.();
  }
}

export async function fetchModelResponse(
  url: string,
  init: RequestInit,
  token?: CancellationToken | null,
  timeoutMs = MODEL_IDLE_TIMEOUT_MS,
): Promise<Response> {
  token?.throwIfCancelled();
  const controller = new AbortController();
  const unsubscribe = token?.onCancel(() => controller.abort()) ?? (() => {});
  const pending = Promise.resolve().then(() => fetch(url, { ...init, signal: controller.signal }));
  let response: Response;
  try {
    response = await awaitWithCancellation(pending, token, timeoutMs);
  } catch (error) {
    controller.abort();
    unsubscribe();
    void pending.then(r => r.body?.cancel()).catch(() => {});
    throw error;
  }
  if (!response.body) {
    unsubscribe();
    return response;
  }
  const reader = response.body.getReader();
  const finish = (abort: boolean) => {
    unsubscribe();
    if (abort) {
      controller.abort();
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  };
  // The response owns the request until EOF or cancellation, including JSON/error bodies.
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { value, done } = await awaitWithCancellation(reader.read(), token, timeoutMs);
        if (done) {
          finish(false);
          stream.close();
        } else {
          stream.enqueue(value);
        }
      } catch (error) {
        finish(true);
        stream.error(error);
      }
    },
    cancel() { finish(true); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function modelRetryDelay(attempt: number, headers?: Headers, now = Date.now()): number {
  const value = headers?.get("retry-after");
  if (value) {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(delay) && delay >= 0) return Math.min(60_000, delay);
  }
  return Math.min(2000, 250 * 2 ** attempt) * (0.9 + Math.random() * 0.2);
}

export function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

export async function* parseSseJsonEvents(
  response: Response,
  cancellationToken?: CancellationToken | null,
): AsyncGenerator<unknown> {
  for await (const event of parseSseEvents(response, cancellationToken)) {
    const data = event.data.trim();
    if (data === "[DONE]") return;
    if (!data) {
      continue;
    }
    yield JSON.parse(data);
  }
}

export function providerError(
  exc: unknown,
  code?: string | null,
  cancellationToken?: CancellationToken | null,
): ProviderError {
  if (isCancellationError(exc, cancellationToken)) {
    throw new CancelledError(
      cancellationToken?.reason || (exc instanceof CancelledError ? exc.reason : "cancelled"),
    );
  }
  if (exc instanceof ProviderError) {
    if (exc.code !== "context_length_exceeded" && isContextOverflow(exc.message)) {
      return new ProviderError(exc.message, {
        status: "rejected",
        errorType: exc.errorType,
        code: "context_length_exceeded",
      });
    }
    return exc;
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
      const { value, done } = await awaitWithCancellation(reader.read(), cancellationToken);
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
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export async function throwForHttpError(response: Response, token?: CancellationToken | null): Promise<never> {
  let bodyText = "";
  const reader = response.body?.getReader();
  try {
    if (reader) {
      const decoder = new TextDecoder();
      let remaining = 64 * 1024;
      while (remaining > 0) {
        const { value, done } = await awaitWithCancellation(reader.read(), token);
        if (done) break;
        bodyText += decoder.decode(value.subarray(0, remaining), { stream: true });
        remaining -= value.length;
      }
      bodyText += decoder.decode();
    }
  } catch (error) {
    if (isCancellationError(error, token) || error instanceof ProviderError) throw error;
    bodyText = response.statusText || `HTTP ${response.status}`;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
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
