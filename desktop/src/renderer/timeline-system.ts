// Pure helpers for runtime system events that are not assistant or tool
// output: step retries, compaction, context builds, background waits and
// task continuation failures (spec sections 5 and 8).

export type SystemTone = "info" | "warning"
export type SystemLine = { content: string; tone: SystemTone }

export type ContextSnapshot = {
  messageCount: number
  estimatedTokens: number | null
  contextWindowTokens: number | null
  autoCompactTokenLimit: number | null
  usagePercent: number | null
}

export type BackgroundWait = { count: number; startedAt: string }

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function asString(value: unknown) { return typeof value === "string" ? value : "" }
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}
function clip(value: string, limit = 240) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function retryLine(event: Record<string, unknown>): SystemLine {
  const attempt = asCount(event.attempt)
  const reason = clip(asString(event.reason))
  const head = attempt ? `Retrying step (attempt ${Math.round(attempt)})` : "Retrying step"
  return { content: reason ? `${head}: ${reason}` : head, tone: "warning" }
}

export function compactionLine(event: Record<string, unknown>): SystemLine {
  const record = asRecord(event.record)
  const reason = asString(record.reason)
  const fallback = asString(record.strategy) === "deterministic_fallback"
  const origin = reason === "auto" ? "Context compacted automatically" : "Context compacted"
  return { content: fallback ? `${origin} (summary fallback)` : origin, tone: fallback ? "warning" : "info" }
}

/** Image and similar notices the worker attaches to a context build. */
export function contextBuiltLine(event: Record<string, unknown>): SystemLine | undefined {
  const decisions = asRecord(event.decisions)
  const notice = clip(asString(decisions.image_notice))
  if (!notice) return undefined
  return { content: notice, tone: asString(decisions.image_notice_level) === "warning" ? "warning" : "info" }
}

export function contextSnapshotFrom(event: Record<string, unknown>): ContextSnapshot {
  const stats = asRecord(event.stats)
  return {
    messageCount: asCount(event.message_count) ?? 0,
    estimatedTokens: asCount(stats.estimated_input_tokens),
    contextWindowTokens: asCount(stats.context_window_tokens),
    autoCompactTokenLimit: asCount(stats.auto_compact_token_limit),
    usagePercent: asCount(stats.context_usage_percent),
  }
}

/** `background_wait` is null when no managed task holds the session. */
export function backgroundWaitFrom(event: Record<string, unknown>): BackgroundWait | null {
  const wait = asRecord(event.background_wait)
  const count = asCount(wait.count)
  return count ? { count: Math.round(count), startedAt: asString(wait.started_at) } : null
}

export function continuationFailure(event: Record<string, unknown>): string {
  return clip(asString(event.error), 2000) || "A background task could not continue the session."
}
