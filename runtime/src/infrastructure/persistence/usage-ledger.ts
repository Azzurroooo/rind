import path from "node:path";
import { resolveRindHome } from "../paths.js";
import { SessionFiles } from "./atomic-files.js";

export const USAGE_LEDGER_FILENAME = "usage.jsonl";
export const USAGE_SUMMARY_DEFAULT_DAYS = 7;
export const USAGE_SUMMARY_MAX_DAYS = 365;
export const USAGE_SUMMARY_MODEL_LIMIT = 5;
export const USAGE_SUMMARY_SESSION_LIMIT = 5;

const SESSION_FILES = new SessionFiles();

export function defaultUsageLedgerPath(): string {
  return path.join(resolveRindHome(), USAGE_LEDGER_FILENAME);
}

export function appendUsageRecord(filePath: string, record: Record<string, unknown>): void {
  SESSION_FILES.appendJsonl(filePath, { ...record });
}

export function loadUsageRecords(filePath: string): Record<string, unknown>[] {
  return SESSION_FILES.readJsonl(filePath);
}

function windowDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
    return USAGE_SUMMARY_DEFAULT_DAYS;
  }
  return Math.min(days, USAGE_SUMMARY_MAX_DAYS);
}

function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function recordVolume(record: Record<string, unknown>): number {
  const total = nonNegative(record.total_tokens);
  if (total > 0) {
    return total;
  }
  return nonNegative(record.input_tokens) + nonNegative(record.output_tokens);
}

function parseTs(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

export function summarizeUsage(
  records: readonly Record<string, unknown>[],
  days: number = USAGE_SUMMARY_DEFAULT_DAYS,
  options?: { now?: Date },
): Record<string, unknown> {
  const wDays = windowDays(days);
  const end = options?.now ?? new Date();
  const cutoffMs = end.getTime() - wDays * 24 * 60 * 60 * 1000;

  const totals = {
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    samples: 0,
    compactions: 0,
  };
  const byDay = new Map<string, number>();
  const byModel = new Map<string, { tokens: number; samples: number }>();
  const sessions = new Map<
    string,
    { session_id: string; _lastMs: number; updated_at: string; tokens: number; samples: number }
  >();

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const ts = parseTs(record.ts);
    if (!ts || ts.getTime() < cutoffMs) {
      continue;
    }
    const volume = recordVolume(record);
    totals.input += nonNegative(record.input_tokens);
    totals.cached += nonNegative(record.cached_input_tokens);
    totals.output += nonNegative(record.output_tokens);
    totals.reasoning += nonNegative(record.reasoning_output_tokens);
    totals.total += volume;
    totals.samples += 1;
    if (record.sampling_kind === "compact") {
      totals.compactions += 1;
    }
    const day = ts.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + volume);
    const model = String(record.model || "unknown");
    const modelBucket = byModel.get(model) ?? { tokens: 0, samples: 0 };
    modelBucket.tokens += volume;
    modelBucket.samples += 1;
    byModel.set(model, modelBucket);

    const sessionId = String(record.session_id || "");
    if (sessionId) {
      let session = sessions.get(sessionId);
      const iso = ts.toISOString();
      if (!session) {
        session = {
          session_id: sessionId,
          _lastMs: ts.getTime(),
          updated_at: iso,
          tokens: 0,
          samples: 0,
        };
        sessions.set(sessionId, session);
      } else if (ts.getTime() > session._lastMs) {
        session._lastMs = ts.getTime();
        session.updated_at = iso;
      }
      session.tokens += volume;
      session.samples += 1;
    }
  }

  const sortedDays = Array.from(byDay.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, tokens]) => ({ day, tokens }));

  const sortedModels = Array.from(byModel.entries())
    .sort(([mA, bA], [mB, bB]) => (bB.tokens !== bA.tokens ? bB.tokens - bA.tokens : mA.localeCompare(mB)))
    .slice(0, USAGE_SUMMARY_MODEL_LIMIT)
    .map(([model, bucket]) => ({ model, tokens: bucket.tokens, samples: bucket.samples }));

  const recentSessions = Array.from(sessions.values())
    .sort((a, b) =>
      b.updated_at !== a.updated_at
        ? b.updated_at.localeCompare(a.updated_at)
        : b.session_id.localeCompare(a.session_id),
    )
    .slice(0, USAGE_SUMMARY_SESSION_LIMIT)
    .map(({ session_id, updated_at, tokens, samples }) => ({
      session_id,
      updated_at,
      tokens,
      samples,
    }));

  return {
    days: wDays,
    totals,
    by_day: sortedDays,
    by_model: sortedModels,
    recent_sessions: recentSessions,
  };
}
