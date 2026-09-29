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

// ---------- step folding ----------

export type StepGroupable = { kind: string; id: string; status?: string }
export type StepGroup<T extends StepGroupable> = { kind: "steps"; id: string; items: T[] }
export type StreamItem<T extends StepGroupable> = T | StepGroup<T>

export const stepFoldThreshold = 3

/** Folds runs of more than `threshold` consecutive tool entries into one
 *  "N steps" group. Returns a new array; the input is never mutated. */
export function foldToolRuns<T extends StepGroupable>(entries: readonly T[], threshold = stepFoldThreshold): StreamItem<T>[] {
  const items: StreamItem<T>[] = []
  let run: T[] = []
  const flush = () => {
    if (run.length > threshold) items.push({ kind: "steps", id: `steps:${run[0].id}`, items: run })
    else items.push(...run)
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === "tool") {
      run = [...run, entry]
      continue
    }
    flush()
    items.push(entry)
  }
  flush()
  return items
}

export function isStepGroup<T extends StepGroupable>(item: StreamItem<T>): item is StepGroup<T> {
  return item.kind === "steps" && Array.isArray((item as StepGroup<T>).items)
}

export type StepSummary = { total: number; running: number; failed: number }

export function summarizeSteps(items: readonly StepGroupable[]): StepSummary {
  return items.reduce<StepSummary>((summary, item) => ({
    total: summary.total + 1,
    running: summary.running + (item.status === "running" || item.status === "pending" ? 1 : 0),
    failed: summary.failed + (item.status === "error" ? 1 : 0),
  }), { total: 0, running: 0, failed: 0 })
}

/** A group opens while it is live or failed, unless the person chose otherwise. */
export function stepGroupOpen(summary: StepSummary, choice: boolean | undefined) {
  if (choice !== undefined) return choice
  return summary.running > 0 || summary.failed > 0
}
