export const DETAIL_LIMIT = 120;

export const TIMEOUT_LINE =
  "⏱️ Worker response timed out; the task did not finish. Resend it later; if it recurs, check the network.";
export const RATE_LIMIT_LINE =
  "🚦 Model rate-limited. Wait a moment and retry, or lower concurrency.";
export const AUTH_LINE =
  "🔑 API auth/quota failed: check the apiKey in ~/.rind/settings.json, /login, or the provider console.";
export const OVERFLOW_LINE =
  "📚 Context limit exceeded: reply /compact to shrink it and retry, or send /new for a fresh session.";
export const CANCELLED_LINE = "Stopped.";
export const UNKNOWN_TEMPLATE =
  "⚠️ Task failed ({detail}). Reply /status to check state, or retry.";

type FailureKind = "cancelled" | "timeout" | "rate_limit" | "auth" | "overflow";

const SIGNATURES: ReadonlyArray<readonly [FailureKind, readonly string[]]> = [
  ["cancelled", ["cancelled", "canceled", "aborted", "已取消", "任务取消"]],
  ["timeout", ["timeout", "timed out", "超时"]],
  [
    "rate_limit",
    [
      "rate limit",
      "rate_limit",
      "ratelimit",
      "429",
      "too many requests",
      "限流",
      "请求过于频繁",
    ],
  ],
  [
    "auth",
    [
      "401",
      "403",
      "unauthorized",
      "forbidden",
      "quota",
      "billing",
      "insufficient",
      "api key",
      "api_key",
      "apikey",
      "鉴权",
      "额度",
    ],
  ],
  [
    "overflow",
    [
      "context length",
      "context_length",
      "context window",
      "maximum context",
      "context overflow",
      "token limit",
      "too many tokens",
      "上下文超限",
      "上下文过长",
    ],
  ],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Error));
}

function sourceText(source: unknown): string {
  if (isRecord(source)) {
    const parts = [
      String(source.error_type ?? ""),
      String(source.error ?? source.reason ?? ""),
      String(source.message ?? ""),
      String(source.type ?? ""),
    ].filter(Boolean);
    return parts.join(" ");
  }
  if (source instanceof Error) {
    const label = source.name || source.constructor?.name || "";
    return [label, source.message || ""].filter(Boolean).join(" ");
  }
  return String(source ?? "");
}

function sanitizeDetail(text: string): string {
  const collapsed = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!collapsed) {
    return "unknown error";
  }
  return [...collapsed].length > DETAIL_LIMIT
    ? [...collapsed].slice(0, DETAIL_LIMIT).join("")
    : collapsed;
}

export function userErrorLine(source: unknown): string {
  const haystack = sourceText(source).toLowerCase();
  for (const [kind, needles] of SIGNATURES) {
    if (needles.some(needle => haystack.includes(needle))) {
      switch (kind) {
        case "cancelled":
          return CANCELLED_LINE;
        case "timeout":
          return TIMEOUT_LINE;
        case "rate_limit":
          return RATE_LIMIT_LINE;
        case "auth":
          return AUTH_LINE;
        case "overflow":
          return OVERFLOW_LINE;
      }
    }
  }
  let raw: string;
  if (isRecord(source)) {
    raw = String(
      source.error ?? source.reason ?? source.error_type ?? source.message ?? "",
    );
  } else if (source instanceof Error) {
    raw = source.message || "";
  } else {
    raw = String(source ?? "");
  }
  return UNKNOWN_TEMPLATE.replace("{detail}", sanitizeDetail(raw));
}
