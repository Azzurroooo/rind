import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CancellationToken } from "../domain/cancellation.js";
import { CancelledError, PersistenceError, ProviderError } from "../domain/errors.js";
import {
  COMPACT_CONTINUATION_USER_CONTENT,
  COMPACT_HANDOFF_REASONING_CONTENT,
  TERMINAL_STATES,
  type ChatClient,
  type ModelCompletion,
} from "../domain/models.js";
import { imageBudgetExceeded } from "../infrastructure/images.js";
import type { JsonlSessionStore } from "../infrastructure/persistence/session-store.js";
import type { TaskJournal } from "../infrastructure/persistence/task-journal.js";
import { renderAvailableSkills } from "../infrastructure/skills.js";
import { buildCompactPrompt } from "../prompts.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;
export const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT = 90;

export function positiveInt(value: unknown, defaultValue: number): number;
export function positiveInt(value: unknown, defaultValue?: null): number | null;
export function positiveInt(value: unknown, defaultValue: number | null = null): number | null {
  if (typeof value === "boolean") return defaultValue;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function getAttr(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[name];
}

function intAttr(value: unknown, ...names: string[]): number {
  for (const name of names) {
    const raw = getAttr(value, name);
    if (raw === undefined || raw === null || typeof raw === "boolean") continue;
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function nestedIntAttr(value: unknown, parentName: string, childName: string): number {
  const parent = getAttr(value, parentName);
  if (parent === undefined || parent === null) {
    return intAttr(value, childName);
  }
  return intAttr(parent, childName);
}

export function extractUsageDict(value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null;
  let usage = getAttr(value, "usage");
  if (usage === undefined || usage === null) {
    usage = value;
  }
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = intAttr(usage, "prompt_tokens", "input_tokens");
  const cachedInputTokens =
    nestedIntAttr(usage, "prompt_tokens_details", "cached_tokens") ||
    intAttr(usage, "cached_input_tokens", "cached_tokens");
  const outputTokens = intAttr(usage, "completion_tokens", "output_tokens");
  const reasoningOutputTokens =
    nestedIntAttr(usage, "completion_tokens_details", "reasoning_tokens") ||
    intAttr(usage, "reasoning_output_tokens", "reasoning_tokens");
  const totalTokens = intAttr(usage, "total_tokens") || inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
  };
}

export function normalizeSamplingUsage(
  usage: unknown,
  options: { samplingKind: string; contextWindowTokens: number },
): Record<string, unknown> | null {
  const extracted = extractUsageDict(usage);
  if (!extracted) return null;
  const inputTokens = Math.max(0, Math.trunc(extracted.input_tokens || 0));
  const cachedTokens = Math.max(0, Math.trunc(extracted.cached_input_tokens || 0));
  const contextWindow = Math.max(1, Math.trunc(options.contextWindowTokens || 1));
  const cacheHitRate = inputTokens > 0 ? cachedTokens / inputTokens : 0.0;
  const contextUsagePercent = inputTokens / contextWindow;
  return {
    sampling_kind: options.samplingKind,
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    cache_hit_rate: cacheHitRate,
    output_tokens: Math.max(0, Math.trunc(extracted.output_tokens || 0)),
    reasoning_output_tokens: Math.max(0, Math.trunc(extracted.reasoning_output_tokens || 0)),
    total_tokens: Math.max(0, Math.trunc(extracted.total_tokens || 0)),
    context_window_tokens: contextWindow,
    context_usage_percent: contextUsagePercent,
  };
}

export const USAGE_RECORD_FIELDS = [
  "sampling_kind",
  "input_tokens",
  "cached_input_tokens",
  "cache_hit_rate",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "context_window_tokens",
  "context_usage_percent",
] as const;

function localIsoTimestamp(): string {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const mm = String(absMin % 60).padStart(2, "0");
  const localMs = now.getTime() - now.getTimezoneOffset() * 60_000;
  const localIso = new Date(localMs).toISOString().slice(0, -1);
  return `${localIso}${sign}${hh}:${mm}`;
}

export function buildUsageRecord(
  usage: Record<string, unknown>,
  options?: { sessionId?: string; model?: string; ts?: string | null },
): Record<string, unknown> {
  const source = usage && typeof usage === "object" ? usage : {};
  const record: Record<string, unknown> = {};
  for (const field of USAGE_RECORD_FIELDS) {
    if (field in source) {
      record[field] = source[field];
    }
  }
  record.ts = options?.ts || localIsoTimestamp();
  record.session_id = String(options?.sessionId || "");
  record.model = String(options?.model || "");
  return record;
}

export function attachContextAnchor(
  usage: Record<string, unknown>,
  options: {
    contextStats: Record<string, unknown>;
    model?: string | null;
    compactGeneration?: number | null;
  },
): Record<string, unknown> {
  const anchored: Record<string, unknown> = { ...(usage || {}) };
  const localTokens = positiveInt(options.contextStats?.estimated_input_tokens);
  const generation = positiveInt(options.compactGeneration);
  if (localTokens === null || generation === null) {
    return anchored;
  }
  const anchor: Record<string, unknown> = {
    local_estimated_input_tokens: localTokens,
    local_estimated_chars: nonNegativeInt(options.contextStats?.estimated_chars),
    context_message_count: nonNegativeInt(options.contextStats?.message_count),
    compact_generation: generation,
    created_at: new Date().toISOString(),
  };
  if (typeof options.model === "string" && options.model.trim()) {
    anchor.model = options.model.trim();
  }
  anchored.anchor = anchor;
  return anchored;
}

export class ContextBudget {
  hard_limit_tokens: number | null;
  system_budget_tokens: number;
  conversation_budget_tokens: number;
  tool_budget_tokens: number;
  context_window_tokens: number | null;
  auto_compact_token_limit_percent: number;
  auto_compact_enabled: boolean;

  constructor(options?: {
    hardLimitTokens?: number | null;
    systemBudgetTokens?: number;
    conversationBudgetTokens?: number;
    toolBudgetTokens?: number;
    contextWindowTokens?: number | null;
    autoCompactTokenLimitPercent?: number;
    autoCompactEnabled?: boolean;
  }) {
    this.hard_limit_tokens = options?.hardLimitTokens ?? null;
    this.system_budget_tokens = options?.systemBudgetTokens ?? 2000;
    this.conversation_budget_tokens = options?.conversationBudgetTokens ?? 6000;
    this.tool_budget_tokens = options?.toolBudgetTokens ?? 20000;
    this.context_window_tokens =
      options?.contextWindowTokens !== undefined
        ? options.contextWindowTokens
        : DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.auto_compact_token_limit_percent =
      options?.autoCompactTokenLimitPercent ?? DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT;
    this.auto_compact_enabled = options?.autoCompactEnabled ?? true;
  }

  static default(): ContextBudget {
    return new ContextBudget();
  }

  resolvedContextWindowTokens(): number {
    return positiveInt(this.context_window_tokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
  }

  resolvedAutoCompactTokenLimitPercent(): number {
    const percent = positiveInt(
      this.auto_compact_token_limit_percent,
      DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT,
    );
    return Math.min(100, percent);
  }

  resolvedAutoCompactTokenLimit(): number {
    return Math.max(
      1,
      Math.floor(
        (this.resolvedContextWindowTokens() * this.resolvedAutoCompactTokenLimitPercent()) / 100,
      ),
    );
  }

  resolvedHardLimitTokens(): number {
    return positiveInt(this.hard_limit_tokens, this.resolvedContextWindowTokens());
  }

  toDict(): Record<string, unknown> {
    return {
      hard_limit_tokens: this.resolvedHardLimitTokens(),
      system_budget_tokens: this.system_budget_tokens,
      conversation_budget_tokens: this.conversation_budget_tokens,
      tool_budget_tokens: this.tool_budget_tokens,
      context_window_tokens: this.resolvedContextWindowTokens(),
      auto_compact_token_limit_percent: this.resolvedAutoCompactTokenLimitPercent(),
      auto_compact_enabled: this.auto_compact_enabled,
      auto_compact_token_limit: this.resolvedAutoCompactTokenLimit(),
    };
  }
}

export interface ContextEstimate {
  readonly message_count: number;
  readonly estimated_input_tokens: number;
  readonly estimated_chars: number;
  readonly system_tokens: number;
  readonly conversation_tokens: number;
  readonly tool_tokens: number;
  readonly over_hard_limit: boolean;
}

const CJK_PATTERN =
  /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{30000}-\u{323af}]/u;

export class ContextEstimator {
  private static readonly MAX_CACHE_ENTRIES = 2048;
  private readonly _budget: ContextBudget;
  private readonly tokenCache = new Map<string, number>();

  constructor(budget?: ContextBudget) {
    this._budget = budget ?? ContextBudget.default();
  }

  get budget(): ContextBudget {
    return this._budget;
  }

  estimateMessages(
    messages: readonly Record<string, unknown>[],
    options?: { tokenCache?: Map<string, number> },
  ): ContextEstimate {
    let systemTokens = 0;
    let conversationTokens = 0;
    let toolTokens = 0;
    let systemChars = 0;
    let conversationChars = 0;
    let toolChars = 0;

    for (const message of messages) {
      const [tokens, chars] = this.estimateMessageTokens(message, options?.tokenCache);
      if (message.role === "system") {
        systemTokens += tokens;
        systemChars += chars;
      } else if (message.role === "tool" || Boolean(message.tool_calls)) {
        toolTokens += tokens;
        toolChars += chars;
      } else {
        conversationTokens += tokens;
        conversationChars += chars;
      }
    }

    const estimatedTokens = systemTokens + conversationTokens + toolTokens;
    const estimatedChars = systemChars + conversationChars + toolChars;

    return {
      message_count: messages.length,
      estimated_input_tokens: estimatedTokens,
      estimated_chars: estimatedChars,
      system_tokens: systemTokens,
      conversation_tokens: conversationTokens,
      tool_tokens: toolTokens,
      over_hard_limit: estimatedTokens >= this._budget.resolvedHardLimitTokens(),
    };
  }

  estimateToolSchemas(toolSchemas?: readonly Record<string, unknown>[] | null): number {
    if (!toolSchemas || toolSchemas.length === 0) return 0;
    const [tokens] = this.estimateMessageTokens({ tools: toolSchemas });
    return Math.max(0, tokens);
  }

  private estimateMessageTokens(
    message: Record<string, unknown>,
    externalCache?: Map<string, number>,
  ): [number, number] {
    const attachments = Array.isArray(message.attachments)
      ? (message.attachments as Array<Record<string, unknown>>)
      : [];
    let imageTokens = 0;
    for (const item of attachments) {
      const w = Number(item.width ?? 0);
      const h = Number(item.height ?? 0);
      imageTokens += Math.ceil(w / 32) * Math.ceil(h / 32) * 2;
    }
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(message)) {
      if (k !== "attachments") stripped[k] = v;
    }
    let payload: string;
    try {
      payload = JSON.stringify(stripped);
    } catch {
      payload = String(stripped);
    }
    const chars = payload.length;
    const cache = externalCache ?? this.tokenCache;
    const cached = cache.get(payload);
    if (cached !== undefined) {
      if (cache === this.tokenCache) {
        this.tokenCache.delete(payload);
        this.tokenCache.set(payload, cached);
      }
      return [cached + imageTokens, chars];
    }

    const tokens = CJK_PATTERN.test(payload)
      ? Math.ceil(chars / 1.5)
      : Math.ceil(chars / 3.5);

    cache.set(payload, tokens);
    if (cache === this.tokenCache && this.tokenCache.size > ContextEstimator.MAX_CACHE_ENTRIES) {
      const oldestKey = this.tokenCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.tokenCache.delete(oldestKey);
      }
    }
    return [tokens + imageTokens, chars];
  }
}

export class CompactionHandoffBuilder {
  readonly maxExcerptChars: number;

  constructor(maxExcerptChars = 1200) {
    this.maxExcerptChars = maxExcerptChars;
  }

  render(
    previousHandoff: string,
    messages: readonly Record<string, unknown>[],
    toolLines: readonly string[],
  ): string {
    const lastUser = CompactionHandoffBuilder.lastContent(messages, "user");
    const lastAssistant = CompactionHandoffBuilder.lastContent(messages, "assistant");
    const lines: string[] = [
      "Context compacted.",
      "This is a deterministic handoff generated from persisted session events.",
    ];
    if (previousHandoff) {
      lines.push("", "Previous compact handoff:", this.excerpt(previousHandoff));
    }
    if (lastUser) {
      lines.push("", "Latest user message:", this.excerpt(lastUser));
    }
    if (lastAssistant) {
      lines.push("", "Latest assistant message:", this.excerpt(lastAssistant));
    }
    if (toolLines.length > 0) {
      lines.push("", "Tool calls:", ...toolLines);
    }
    if (lines.length === 2) {
      lines.push("No prior conversational messages were available in the compacted range.");
    }
    return lines.join("\n");
  }

  renderToolLines(
    toolIds: readonly string[],
    toolRecords: readonly Record<string, unknown>[],
  ): string[] {
    const records = new Map<string, Record<string, unknown>>();
    for (const record of toolRecords) {
      if (record && typeof record === "object" && record.id) {
        records.set(String(record.id), record);
      }
    }
    const lines: string[] = [];
    let slice = toolIds;
    if (slice.length > 20) {
      lines.push(`- [${slice.length - 20} earlier tool calls omitted]`);
      slice = slice.slice(-20);
    }
    for (const callId of slice) {
      const rec = records.get(callId) ?? {};
      const suffix = rec.error_type ? `, error_type=${String(rec.error_type)}` : "";
      const okStr = rec.ok === true ? "True" : rec.ok === false ? "False" : "None";
      lines.push(`- ${callId}: ${String(rec.name || "unknown")}, ok=${okStr}${suffix}`);
    }
    return lines;
  }

  collectToolCallIds(messages: readonly Record<string, unknown>[]): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const appendId = (callId: unknown): void => {
      if (!callId) return;
      const text = String(callId);
      if (!seen.has(text)) {
        seen.add(text);
        ordered.push(text);
      }
    };
    const collectIds = (toolCalls: unknown): void => {
      if (!Array.isArray(toolCalls)) return;
      for (const item of toolCalls) {
        if (item && typeof item === "object") {
          appendId((item as Record<string, unknown>).id);
        }
      }
    };
    for (const message of messages) {
      if (message.role === "tool") {
        appendId(message.tool_call_id);
      }
      if (message.meta && typeof message.meta === "object") {
        collectIds((message.meta as Record<string, unknown>).tool_calls);
      }
      collectIds(message.tool_calls);
    }
    return ordered;
  }

  latestBoundaryIndex(messages: readonly Record<string, unknown>[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (CompactionHandoffBuilder.isBoundary(messages[i]!)) {
        return i;
      }
    }
    return -1;
  }

  digest(
    messages: readonly Record<string, unknown>[],
    previousCompaction?: Record<string, unknown> | null,
  ): string {
    const payload = {
      previous_compaction_id: previousCompaction?.id ?? null,
      source_messages: messages,
    };
    const text = JSON.stringify(payload);
    return createHash("sha1").update(text, "utf8").digest("hex");
  }

  static isBoundary(message: Record<string, unknown>): boolean {
    const meta = message.meta;
    return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>).kind === "compact_boundary");
  }

  static stripInternalFields(message: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(message)) {
      if (!k.startsWith("_")) out[k] = v;
    }
    return out;
  }

  static previousHandoff(compaction?: Record<string, unknown> | null): string {
    if (!compaction || typeof compaction !== "object") return "";
    const handoff = compaction.handoff_message;
    if (!handoff || typeof handoff !== "object") return "";
    const content = (handoff as Record<string, unknown>).content;
    return typeof content === "string" ? content : "";
  }

  private static lastContent(messages: readonly Record<string, unknown>[], role: string): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]!;
      if (msg.role !== role || (role === "assistant" && msg.tool_calls)) continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) {
        return content;
      }
    }
    return "";
  }

  private excerpt(text: string): string {
    if (text.length <= this.maxExcerptChars) return text;
    const half = Math.max(1, Math.floor((this.maxExcerptChars - 42) / 2));
    return `${text.slice(0, half).trimEnd()}\n[excerpt_truncated]\n${text.slice(-half).trimStart()}`;
  }
}

function truncateForBudget(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  const head = Math.max(1, Math.floor(limit / 2));
  const tail = Math.max(1, limit - head);
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted for summary budget ...]\n${text.slice(-tail)}`;
}

export class CompactionService {
  readonly policyVersion: string;
  readonly maxExcerptChars: number;
  readonly planSnapshotProvider: ((sessionBase: string | null) => string) | null;
  readonly usageRecorder: ((record: Record<string, unknown>) => unknown) | null;

  constructor(options?: {
    policyVersion?: string;
    maxExcerptChars?: number;
    planSnapshotProvider?: ((sessionBase: string | null) => string) | null;
    usageRecorder?: ((record: Record<string, unknown>) => unknown) | null;
  }) {
    this.policyVersion = options?.policyVersion ?? "compact_boundary_v3";
    this.maxExcerptChars = options?.maxExcerptChars ?? 2000;
    this.planSnapshotProvider = options?.planSnapshotProvider ?? null;
    this.usageRecorder = options?.usageRecorder ?? null;
  }

  async compactAsync(
    session: JsonlSessionStore,
    contextMessages: Record<string, unknown>[],
    chatClient: ChatClient,
    options?: {
      reason?: string;
      phase?: string;
      diagnostics?: Record<string, unknown> | null;
      contextStats?: Record<string, unknown> | null;
      cancellationToken?: CancellationToken | null;
      prepareMessages?: ((messages: Record<string, unknown>[], opts?: { compact?: boolean }) => Promise<Record<string, unknown>[]>) | null;
      taskReferences?: Record<string, unknown>[] | null;
    },
  ): Promise<Record<string, unknown>> {
    const reason = options?.reason ?? "manual";
    const phase = options?.phase ?? "manual";
    const diagnostics = options?.diagnostics ?? null;
    const contextStats = options?.contextStats ?? null;
    const cancellationToken = options?.cancellationToken ?? null;
    const prepareMessages = options?.prepareMessages ?? null;
    const taskReferences = options?.taskReferences ?? null;

    if (cancellationToken?.isCancelled) {
      throw new CancelledError(cancellationToken.reason);
    }
    const createdAt = new Date().toISOString();
    const rawMessages = await this.loadRawMessages(session, contextMessages);
    const toolRecords = await this.loadToolRecords(session);
    const previous = await this.loadLatestCompaction(session);
    const stats = contextStats ?? {};
    const window = positiveInt(stats.context_window_tokens, DEFAULT_CONTEXT_WINDOW_TOKENS);

    let record = this.buildCompaction(rawMessages, {
      toolRecords,
      previousCompaction: previous,
      createdAt,
      reason,
      phase,
      diagnostics,
      handoffMessages: contextMessages,
      strategy: "deterministic_fallback",
      keepRecentChars: this.keepRecentChars(contextStats),
    });

    const corpus = this.buildCompressionCorpus(contextMessages);
    let cut = (record.source as { message_end_index_exclusive: number }).message_end_index_exclusive;
    const retained = rawMessages.slice(cut);
    const retainedIds = new Set(retained.map(m => m.id).filter(Boolean));
    const retainedCalls = new Set<string>();
    for (const msg of retained) {
      for (const cid of this.toolCallIds(msg)) retainedCalls.add(cid);
    }
    let recentStart = corpus.findIndex(
      m => (m.id && retainedIds.has(m.id)) || (m.tool_call_id && retainedCalls.has(String(m.tool_call_id))),
    );
    if (recentStart === -1) recentStart = corpus.length;
    for (const msg of corpus) {
      delete msg.id;
    }

    if (
      recentStart < corpus.length &&
      (imageBudgetExceeded(corpus.slice(recentStart)) ||
        new ContextEstimator().estimateMessages(corpus.slice(recentStart)).estimated_input_tokens >=
          Math.max(1, Math.floor(window / 2)))
    ) {
      record = this.buildCompaction(rawMessages, {
        toolRecords,
        previousCompaction: previous,
        createdAt,
        reason,
        phase,
        diagnostics,
        handoffMessages: contextMessages,
        strategy: "deterministic_fallback",
        keepRecentChars: 0,
      });
      cut = (record.source as { message_end_index_exclusive: number }).message_end_index_exclusive;
      recentStart = corpus.length;
    }

    let effectiveWindow = window;
    let messages: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const maxOutputTokens = Math.max(1, Math.min(8192, Math.floor(effectiveWindow / 10)));
      messages = this.prepareSummaryRequest(corpus, recentStart, effectiveWindow, maxOutputTokens);
      if (cancellationToken?.isCancelled) {
        throw new CancelledError(cancellationToken.reason);
      }
      if (prepareMessages) {
        messages = await prepareMessages(messages, { compact: true });
      }
      try {
        const response = await chatClient.create(messages, null, cancellationToken, {
          maxOutputTokens,
          reasoningEffort: "low",
        });
        const usage = this.samplingUsage(response, contextStats);
        if (usage) {
          record.usage = usage;
          const usageError = await this.tryPersistSamplingUsage(session, usage);
          if (usageError) {
            record.usage_persist_error = usageError;
          }
          this.recordUsage(session, usage);
        }
        const content = this.assistantContent(response).trim();
        if (!content) {
          throw new Error("compact model returned empty handoff");
        }
        record.strategy = "llm_inline";
        record.handoff_message = { role: "assistant", content };
        break;
      } catch (exc) {
        if (exc instanceof CancelledError || cancellationToken?.isCancelled) {
          throw exc instanceof CancelledError ? exc : new CancelledError(cancellationToken?.reason);
        }
        if (
          exc instanceof ProviderError &&
          exc.code === "context_length_exceeded" &&
          attempt < 2 &&
          effectiveWindow > 2048
        ) {
          effectiveWindow = Math.max(2048, Math.floor((effectiveWindow * 2) / 3));
          continue;
        }
        record.strategy = "deterministic_fallback";
        const err = exc as Error & { status?: string };
        const fallbackErr: Record<string, string> = {
          type: err.name || "Error",
          message: err.message || String(exc),
        };
        if (err.status) {
          fallbackErr.status = String(err.status);
        }
        record.fallback_error = fallbackErr;
        break;
      }
    }

    const handoffMessage = record.handoff_message as { role: string; content: string };
    if (corpus.some(m => Array.isArray(m.attachments) && m.attachments.length > 0)) {
      if (
        record.strategy !== "llm_inline" ||
        !messages.some(m => Array.isArray(m.images) && m.images.length > 0)
      ) {
        handoffMessage.content +=
          "\nImages were not re-examined for this summary; only prior observations were used.";
      }
    }
    const compactedCalls = new Set<string>();
    for (const msg of rawMessages.slice(0, cut)) {
      for (const cid of this.toolCallIds(msg)) compactedCalls.add(cid);
    }
    const references = new Set<string>();
    for (const msg of [
      ...rawMessages.slice(0, cut),
      ...toolRecords.filter(r => r.id && compactedCalls.has(String(r.id))),
    ]) {
      const attachments = Array.isArray(msg.attachments)
        ? (msg.attachments as Array<Record<string, unknown>>)
        : [];
      for (const item of attachments) {
        if (typeof item.path === "string" && item.path) {
          references.add(item.path);
        }
      }
    }
    if (references.size > 0 && session.sessionBasePath) {
      const paths = Array.from(references)
        .sort()
        .map(p => path.resolve(session.sessionBasePath!, p).replace(/\\/g, "/"));
      handoffMessage.content +=
        "\n\nImage snapshots (use read_file for details):\n" + paths.join("\n");
    }
    if (this.planSnapshotProvider) {
      this.appendActivePlanSnapshot(record, session.sessionBasePath);
    }
    if (taskReferences && taskReferences.length > 0) {
      handoffMessage.content +=
        "\n\nManaged task references (runtime facts):\n" + JSON.stringify(taskReferences);
    }
    if (cancellationToken?.isCancelled) {
      throw new CancelledError(cancellationToken.reason);
    }
    try {
      return await session.persistCompaction(record);
    } catch (exc) {
      const err = exc as Error;
      throw new PersistenceError(
        `Failed to persist compaction boundary: ${err.message || String(exc)}`,
        { code: err.name || "Error", cause: exc },
      );
    }
  }

  buildCompaction(
    messages: Record<string, unknown>[],
    options?: {
      toolRecords?: Record<string, unknown>[] | null;
      previousCompaction?: Record<string, unknown> | null;
      createdAt?: string | null;
      reason?: string;
      phase?: string;
      diagnostics?: Record<string, unknown> | null;
      handoffMessages?: Record<string, unknown>[] | null;
      strategy?: string;
      keepRecentChars?: number;
    },
  ): Record<string, unknown> {
    const handoffBuilder = new CompactionHandoffBuilder(this.maxExcerptChars);
    const created = options?.createdAt || new Date().toISOString();
    const boundaryIndex = handoffBuilder.latestBoundaryIndex(messages);
    const sourceStart = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;
    const toolRecords = options?.toolRecords ?? [];
    const sourceEnd = this.retentionCut(
      messages,
      sourceStart,
      toolRecords,
      options?.keepRecentChars ?? 0,
    );
    const sourceMessages = messages
      .slice(sourceStart, sourceEnd)
      .filter(m => !CompactionHandoffBuilder.isBoundary(m))
      .map(m => ({ ...m }));
    const corpusSource = options?.handoffMessages ?? sourceMessages;
    const corpusMessages = this.buildCompressionCorpus(corpusSource);
    const previousHandoff = CompactionHandoffBuilder.previousHandoff(options?.previousCompaction);
    const toolIds = handoffBuilder.collectToolCallIds(corpusMessages);
    const toolLines = handoffBuilder.renderToolLines(toolIds, toolRecords);
    const handoff = handoffBuilder.render(previousHandoff, corpusMessages, toolLines);

    const source = {
      message_start_index: sourceStart,
      message_end_index_exclusive: sourceEnd,
      tool_call_ids: toolIds,
      history_digest: handoffBuilder.digest(corpusMessages, options?.previousCompaction),
    };

    const record: Record<string, unknown> = {
      id: randomUUID().replace(/-/g, ""),
      created_at: created,
      strategy: options?.strategy ?? "manual_deterministic",
      reason: options?.reason ?? "manual",
      phase: options?.phase ?? "manual",
      policy_version: this.policyVersion,
      source,
      continuation_user_message: {
        role: "user",
        content: COMPACT_CONTINUATION_USER_CONTENT,
      },
      handoff_message: {
        role: "assistant",
        content: handoff,
      },
      usage: {},
    };
    if (options?.diagnostics) {
      record.diagnostics = { ...options.diagnostics };
    }
    return record;
  }

  buildCompressionCorpus(contextMessages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    const corpus: Record<string, unknown>[] = [];
    for (const message of contextMessages) {
      if (!message || typeof message !== "object") continue;
      if (CompactionHandoffBuilder.isBoundary(message) || message.role === "system") continue;
      const item = CompactionHandoffBuilder.stripInternalFields(message);
      delete item.reasoning_content;
      corpus.push(item);
    }
    return corpus;
  }

  private retentionCut(
    messages: Record<string, unknown>[],
    sourceStart: number,
    toolRecords: Record<string, unknown>[],
    keepRecentChars: number,
  ): number {
    const units = this.conversationUnits(messages, sourceStart);
    if (units.length === 0 || keepRecentChars <= 0) {
      return messages.length;
    }
    const toolSizes = new Map<string, number>();
    const toolImages = new Map<string, unknown>();
    for (const rec of toolRecords) {
      if (rec && typeof rec === "object" && rec.id) {
        toolSizes.set(String(rec.id), String(rec.model_content || "").length);
        toolImages.set(String(rec.id), rec.attachments ?? []);
      }
    }

    const unitImages = (start: number, end: number): Record<string, unknown>[] =>
      messages.slice(start, end).map(m => ({
        attachments:
          (m.tool_call_id ? toolImages.get(String(m.tool_call_id)) : undefined) ??
          m.attachments ??
          [],
      }));

    let [retainedStart, retainedEnd] = units[units.length - 1]!;
    let retainedSize = this.unitSize(messages, retainedStart, retainedEnd, toolSizes);
    let retainedImgs = unitImages(retainedStart, retainedEnd);

    for (let i = units.length - 2; i >= 0; i -= 1) {
      const [uStart, uEnd] = units[i]!;
      const uSize = this.unitSize(messages, uStart, uEnd, toolSizes);
      const imgs = [...unitImages(uStart, uEnd), ...retainedImgs];
      if (retainedSize + uSize > keepRecentChars || imageBudgetExceeded(imgs)) {
        break;
      }
      retainedStart = uStart;
      retainedSize += uSize;
      retainedImgs = imgs;
    }
    return retainedStart <= units[0]![0] ? messages.length : retainedStart;
  }

  private conversationUnits(
    messages: Record<string, unknown>[],
    sourceStart: number,
  ): Array<[number, number]> {
    const units: Array<[number, number]> = [];
    let index = sourceStart;
    while (index < messages.length) {
      const message = messages[index]!;
      if (message.role === "system") {
        index += 1;
        continue;
      }
      let end = index + 1;
      if (message.role === "assistant") {
        const callIds = this.toolCallIds(message);
        if (callIds.length > 0) {
          const pending = new Set(callIds);
          while (end < messages.length && pending.size > 0) {
            const candidate = messages[end]!;
            if (candidate.role !== "tool") break;
            pending.delete(String(candidate.tool_call_id || ""));
            end += 1;
          }
        }
      }
      units.push([index, end]);
      index = end;
    }
    return units;
  }

  private unitSize(
    messages: Record<string, unknown>[],
    start: number,
    end: number,
    toolSizes: Map<string, number>,
  ): number {
    let total = 0;
    for (let i = start; i < end; i += 1) {
      total += this.messageChars(messages[i]!, toolSizes);
    }
    return total;
  }

  private toolCallIds(message: Record<string, unknown>): string[] {
    const meta = message.meta as Record<string, unknown> | undefined;
    const calls = Array.isArray(meta?.tool_calls)
      ? meta.tool_calls
      : Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    const ids: string[] = [];
    for (const call of calls) {
      if (call && typeof call === "object" && (call as Record<string, unknown>).id) {
        ids.push(String((call as Record<string, unknown>).id));
      }
    }
    return ids;
  }

  private messageChars(message: Record<string, unknown>, toolChars: Map<string, number>): number {
    if (message.role === "tool") {
      const id = String(message.tool_call_id || "");
      return toolChars.get(id) ?? String(message.content || "").length;
    }
    let size = String(message.content || "").length + String(message.reasoning_content || "").length;
    const meta = message.meta as Record<string, unknown> | undefined;
    if (meta && Array.isArray(meta.tool_calls)) {
      for (const tc of meta.tool_calls) {
        if (tc && typeof tc === "object") {
          size += String((tc as Record<string, unknown>).raw_args || "").length;
        }
      }
    }
    return size;
  }

  private keepRecentChars(contextStats?: Record<string, unknown> | null): number {
    const limit = Number.parseInt(String(contextStats?.auto_compact_token_limit ?? "0"), 10);
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    return Math.floor((Math.floor(limit / 12) * 3) / 2);
  }

  private async loadRawMessages(
    session: JsonlSessionStore,
    fallback: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    try {
      const messages = await session.loadMessages();
      if (Array.isArray(messages)) {
        return messages.map(m => ({ ...m }));
      }
    } catch {}
    return fallback.map(m => ({ ...m }));
  }

  private async loadToolRecords(session: JsonlSessionStore): Promise<Record<string, unknown>[]> {
    try {
      const records = await session.getToolRecords();
      if (Array.isArray(records)) {
        return records.map(r => ({ ...r }));
      }
    } catch {}
    return [];
  }

  private async loadLatestCompaction(
    session: JsonlSessionStore,
  ): Promise<Record<string, unknown> | null> {
    try {
      const latest = await session.getLatestCompaction();
      return latest ? { ...latest } : null;
    } catch {}
    return null;
  }

  private appendActivePlanSnapshot(
    record: Record<string, unknown>,
    sessionBase: string | null,
  ): void {
    if (!this.planSnapshotProvider) return;
    let snapshot = "";
    try {
      snapshot = String(this.planSnapshotProvider(sessionBase) || "").trim();
    } catch {
      snapshot = "";
    }
    if (!snapshot) return;
    const handoff = record.handoff_message as { content?: string } | undefined;
    if (handoff && typeof handoff.content === "string") {
      handoff.content = `${handoff.content.trimEnd()}\n\nPlan state at compact boundary:\n${snapshot}`;
    }
  }

  private assistantContent(response: ModelCompletion | Record<string, unknown>): string {
    const rec = response as Record<string, unknown>;
    let finishReason = rec.finish_reason;
    if (Array.isArray(rec.choices) && rec.choices.length > 0) {
      const first = rec.choices[0] as Record<string, unknown>;
      finishReason = first.finish_reason;
    }
    if (finishReason !== undefined && finishReason !== null && finishReason !== "stop") {
      throw new Error(`compact model did not finish the handoff: ${String(finishReason)}`);
    }
    if (typeof rec.content === "string") return rec.content;
    if (typeof rec.output_text === "string") return rec.output_text;
    if (Array.isArray(rec.choices) && rec.choices.length > 0) {
      const first = rec.choices[0] as Record<string, unknown>;
      const msg = first.message as Record<string, unknown> | undefined;
      if (typeof msg?.content === "string") return msg.content;
    }
    return "";
  }

  private samplingUsage(
    response: unknown,
    contextStats?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const contextWindow = positiveInt(
      contextStats?.context_window_tokens,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    return normalizeSamplingUsage(response, {
      samplingKind: "compact",
      contextWindowTokens: contextWindow,
    });
  }

  private async tryPersistSamplingUsage(
    session: JsonlSessionStore,
    usage: Record<string, unknown>,
  ): Promise<Record<string, string> | null> {
    try {
      await session.persistSamplingUsage(usage);
      return null;
    } catch (exc) {
      const err = exc as Error;
      return { type: err.name || "Error", message: err.message || String(exc) };
    }
  }

  private recordUsage(session: JsonlSessionStore, usage: Record<string, unknown>): void {
    if (!this.usageRecorder) return;
    const record = buildUsageRecord(usage, {
      sessionId: String(session.sessionId || ""),
      model: String(session.model || ""),
    });
    try {
      this.usageRecorder(record);
    } catch {}
  }

  private prepareSummaryRequest(
    rawCorpus: Record<string, unknown>[],
    recentStart: number,
    window: number,
    maxOutputTokens: number,
  ): Record<string, unknown>[] {
    const corpus: Record<string, unknown>[] = structuredClone(rawCorpus);
    const inputBudget = window - maxOutputTokens - Math.max(1, Math.floor(window / 20));
    const estimator = new ContextEstimator();

    const buildRequest = (
      historyStart = 0,
      droppedMessages = 0,
      truncatedContent = false,
    ): Record<string, unknown>[] => {
      const split = Math.max(historyStart, recentStart);
      const payload: Record<string, unknown> = {
        history: corpus.slice(historyStart, split),
        retained_recent_messages: corpus.slice(split),
      };
      const notes: string[] = [];
      if (droppedMessages > 0) {
        notes.push(
          `${droppedMessages} oldest history messages did not fit the summary budget and were dropped; they stay saved on disk but were not re-examined.`,
        );
      }
      if (truncatedContent) {
        notes.push(
          "Oversized message content was truncated to fit the summary budget; full records stay saved on disk.",
        );
      }
      if (notes.length > 0) {
        payload.note = [...notes, "Do not claim knowledge of them."].join(" ");
      }
      const messages = buildCompactPrompt(JSON.stringify(payload)) as Array<Record<string, unknown>>;
      const included = corpus.slice(historyStart);
      const attachments = included.flatMap(m =>
        Array.isArray(m.attachments) ? (m.attachments as Record<string, unknown>[]) : [],
      );
      if (attachments.length > 0) {
        const lastMsg = messages[messages.length - 1]!;
        if (imageBudgetExceeded(included)) {
          lastMsg.content =
            String(lastMsg.content || "") +
            "\n[Images not re-examined: image request limit exceeded. Summarize prior observations and image references only.]";
        } else {
          lastMsg.attachments = attachments;
        }
      }
      return messages;
    };

    const estimated = (msgs: Record<string, unknown>[]): number =>
      estimator.estimateMessages(msgs).estimated_input_tokens;

    let messages = buildRequest();
    if (estimated(messages) <= inputBudget) {
      return messages;
    }

    for (const message of corpus) {
      if (
        message.role === "tool" &&
        typeof message.content === "string" &&
        message.content.length > 4000
      ) {
        const omitted = message.content.length - 4000;
        message.content = `${message.content.slice(0, 2000)}\n[tool result: ${omitted} characters omitted]\n${message.content.slice(-2000)}`;
      }
    }
    messages = buildRequest();
    if (estimated(messages) <= inputBudget) {
      return messages;
    }

    const units = this.conversationUnits(corpus, 0);
    const starts = units.map(([, end]) => end).filter(end => end < corpus.length);
    const weights = units
      .filter(([, end]) => end < corpus.length)
      .map(([start, end]) =>
        estimated([{ role: "user", content: JSON.stringify(corpus.slice(start, end)) }]),
      );

    let remaining = estimated(messages);
    let index = 0;
    for (const weight of weights) {
      remaining -= weight;
      if (remaining <= inputBudget) break;
      index += 1;
    }
    index = starts.length > 0 ? Math.min(index, starts.length - 1) : 0;
    let smallest = messages;

    if (imageBudgetExceeded(corpus)) {
      for (const start of starts) {
        smallest = buildRequest(start, start);
        if (estimated(smallest) <= inputBudget) {
          return smallest;
        }
      }
    } else if (starts.length > 0) {
      smallest = buildRequest(starts[index]!, starts[index]!);
      while (estimated(smallest) > inputBudget && index + 1 < starts.length) {
        index += 1;
        smallest = buildRequest(starts[index]!, starts[index]!);
      }
      if (estimated(smallest) <= inputBudget) {
        while (index > 0) {
          const prev = buildRequest(starts[index - 1]!, starts[index - 1]!);
          if (estimated(prev) > inputBudget) break;
          smallest = prev;
          index -= 1;
        }
        return smallest;
      }
    }

    const lastStart = starts.length > 0 ? starts[starts.length - 1]! : 0;
    for (let i = lastStart; i < corpus.length; i += 1) {
      delete corpus[i]!.attachments;
    }
    smallest = buildRequest(lastStart, lastStart);
    if (estimated(smallest) <= inputBudget) {
      return smallest;
    }

    const tailOriginals = structuredClone(corpus.slice(lastStart));
    let charLimit = Math.max(
      256,
      Math.floor(((inputBudget - 450) * 3) / Math.max(1, tailOriginals.length)),
    );
    for (let pass = 0; pass < 6; pass += 1) {
      for (let i = 0; i < tailOriginals.length; i += 1) {
        const target = corpus[lastStart + i]!;
        const source = tailOriginals[i]!;
        if (typeof source.content === "string" && source.content.length > charLimit) {
          target.content = truncateForBudget(source.content, charLimit);
        }
        const targetCalls = Array.isArray(target.tool_calls) ? target.tool_calls : [];
        const sourceCalls = Array.isArray(source.tool_calls) ? source.tool_calls : [];
        for (let j = 0; j < Math.min(targetCalls.length, sourceCalls.length); j += 1) {
          const fn = (targetCalls[j] as Record<string, unknown>)?.function as
            | Record<string, unknown>
            | undefined;
          const srcFn = (sourceCalls[j] as Record<string, unknown>)?.function as
            | Record<string, unknown>
            | undefined;
          if (fn && typeof srcFn?.arguments === "string" && srcFn.arguments.length > charLimit) {
            fn.arguments = truncateForBudget(srcFn.arguments, charLimit);
          }
        }
      }
      smallest = buildRequest(lastStart, lastStart, true);
      const tokens = estimated(smallest);
      if (tokens <= inputBudget || charLimit <= 64) {
        return smallest;
      }
      charLimit = Math.max(64, Math.floor(((charLimit * inputBudget) / Math.max(1, tokens)) * 0.8));
    }
    return smallest;
  }
}

const ANCHOR_RATIO_MIN = 0.2;
const ANCHOR_RATIO_MAX = 2.0;

function anchorRatio(serverInputTokens: number, localEstimatedInputTokens: number): number {
  const ratio = serverInputTokens / localEstimatedInputTokens;
  return Math.max(ANCHOR_RATIO_MIN, Math.min(ANCHOR_RATIO_MAX, ratio));
}

export interface ContextBuildResult {
  readonly messages: Record<string, unknown>[];
  readonly stats: Record<string, unknown>;
  readonly decisions: Record<string, unknown>;
  readonly internal_messages: Record<string, unknown>[];
}

export class ContextManager {
  private readonly _estimator: ContextEstimator;
  private readonly hotMessageLimit: number;
  private readonly skillCatalogCharLimit: number;
  private readonly rindDocProvider:
    | (() => [Record<string, unknown>[], Record<string, unknown>, Record<string, unknown>])
    | null;
  private readonly goalPolicyProvider: (() => string) | null;

  constructor(options?: {
    estimator?: ContextEstimator;
    hotMessageLimit?: number;
    skillCatalogCharLimit?: number;
    rindDocProvider?:
      | (() => [Record<string, unknown>[], Record<string, unknown>, Record<string, unknown>])
      | null;
    goalPolicyProvider?: (() => string) | null;
  }) {
    this._estimator = options?.estimator ?? new ContextEstimator();
    this.hotMessageLimit = Math.max(1, Math.trunc(options?.hotMessageLimit ?? 6));
    this.skillCatalogCharLimit = Math.max(0, Math.trunc(options?.skillCatalogCharLimit ?? 8000));
    this.rindDocProvider = options?.rindDocProvider ?? null;
    this.goalPolicyProvider = options?.goalPolicyProvider ?? null;
  }

  get estimator(): ContextEstimator {
    return this._estimator;
  }

  get contextWindow(): number {
    return this._estimator.budget.resolvedContextWindowTokens();
  }

  set contextWindow(tokens: number | null) {
    this._estimator.budget.context_window_tokens = tokens;
  }

  reduceHardLimit(factor = 0.8, referenceTokens?: number | null): number {
    const budget = this._estimator.budget;
    let base = budget.resolvedHardLimitTokens();
    if (typeof referenceTokens === "number" && referenceTokens > 0) {
      base = Math.min(base, referenceTokens);
    }
    budget.hard_limit_tokens = Math.max(1, Math.floor(base * factor));
    return budget.resolvedHardLimitTokens();
  }

  snapshotHardLimit(): number | null {
    return this._estimator.budget.hard_limit_tokens;
  }

  restoreHardLimit(hardLimit: number | null): void {
    this._estimator.budget.hard_limit_tokens = hardLimit;
  }

  async buildMessagesAsync(
    session: JsonlSessionStore,
    options?: {
      pendingMessages?: Record<string, unknown>[] | null;
      transientSystemMessages?: Record<string, unknown>[] | null;
      allowRescue?: boolean;
      includeSkillCatalog?: boolean;
      includeIds?: boolean;
    },
  ): Promise<ContextBuildResult> {
    let persistedMessages: Record<string, unknown>[];
    try {
      persistedMessages = await session.getMessagesSlice({
        includeInternal: true,
        includeIds: options?.includeIds ?? false,
      });
    } catch (exc) {
      const err = exc as Error;
      throw new PersistenceError(`Failed to load session messages: ${err.message || String(exc)}`, {
        code: err.name || "Error",
        cause: exc,
      });
    }

    const pending = (options?.pendingMessages ?? []).map(m => ({ ...m }));
    const budget = this._estimator.budget;
    let fullMessages = [...persistedMessages, ...pending];
    const [rindMessages, rindStats, rindDecisions] = this.buildRindDocMessages();
    const [skillMessages, skillStats, skillDecisions] =
      options?.includeSkillCatalog ?? true
        ? await this.buildSkillCatalogMessages(session)
        : [
            [],
            { skill_count: 0, skill_index_chars: 0 },
            { skills_available: false, skill_catalog_injected: false, skill_error_type: null },
          ];
    const extraSystemMessages = [
      ...rindMessages,
      ...(await this.goalPolicyMessage(session)),
      ...this.validSystemMessages(options?.transientSystemMessages ?? null),
      ...skillMessages,
    ];
    if (extraSystemMessages.length > 0) {
      fullMessages = this.insertAfterFirstSystem(fullMessages, extraSystemMessages);
    }

    let messages = [...fullMessages];
    const hotMessageCount = Math.min(
      this.hotMessageLimit,
      fullMessages.filter(m => this.isConversationMessage(m) && !this.isSkillSnapshot(m)).length,
    );

    let finalMessages = messages.map(m => this.stripInternalFields(m));
    let finalEstimate = this._estimator.estimateMessages(messages);

    let droppedCount = 0;
    while (
      (options?.allowRescue ?? false) &&
      finalEstimate.over_hard_limit &&
      finalMessages.length > 1
    ) {
      const previousTokens = finalEstimate.estimated_input_tokens;
      [messages, finalMessages] = this.rescueContext(messages, finalMessages);
      finalEstimate = this._estimator.estimateMessages(messages);
      droppedCount += 1;
      if (droppedCount > 50 || finalEstimate.estimated_input_tokens >= previousTokens) {
        break;
      }
    }

    const toolMessages = finalMessages.filter(m => m.role === "tool").map(m => ({ ...m }));
    const autoCompactStatus = await this.buildTokenPressureStatus(session, finalEstimate);
    const contextWindowTokens = budget.resolvedContextWindowTokens();
    const contextUsagePercent =
      finalEstimate.estimated_input_tokens / Math.max(1, contextWindowTokens);

    const stats: Record<string, unknown> = {
      message_count: messages.length,
      persisted_message_count: persistedMessages.length,
      pending_message_count: pending.length,
      tool_message_count: toolMessages.length,
      hot_message_count: hotMessageCount,
      estimated_input_tokens: finalEstimate.estimated_input_tokens,
      estimated_chars: finalEstimate.estimated_chars,
      system_tokens: finalEstimate.system_tokens,
      conversation_tokens: finalEstimate.conversation_tokens,
      tool_tokens: finalEstimate.tool_tokens,
      context_window_tokens: contextWindowTokens,
      auto_compact_token_limit_percent: budget.resolvedAutoCompactTokenLimitPercent(),
      auto_compact_token_limit: budget.resolvedAutoCompactTokenLimit(),
      context_usage_percent: contextUsagePercent,
      budget: budget.toDict(),
      ...autoCompactStatus,
      ...rindStats,
      ...skillStats,
    };

    const decisions: Record<string, unknown> = {
      mode: "session_backed",
      source: "session_queries",
      uses_pending_overlay: pending.length > 0,
      over_conversation_budget:
        finalEstimate.conversation_tokens >= budget.conversation_budget_tokens,
      over_tool_budget: finalEstimate.tool_tokens >= budget.tool_budget_tokens,
      over_system_budget: finalEstimate.system_tokens >= budget.system_budget_tokens,
      auto_compact_token_limit_reached: autoCompactStatus.auto_compact_token_limit_reached,
      ...rindDecisions,
      ...skillDecisions,
    };

    return {
      messages: finalMessages,
      stats,
      decisions,
      internal_messages: messages.map(m => ({ ...m })),
    };
  }

  rescueContext(
    internalMessages: Record<string, unknown>[],
    finalMessages: Record<string, unknown>[],
  ): [Record<string, unknown>[], Record<string, unknown>[]] {
    const marker = "[DROPPED FOR CONTEXT RESCUE]";
    const shrinkable = (msg: Record<string, unknown>): boolean => {
      if (msg.role === "system") return false;
      if (typeof msg.content === "string" && msg.content !== marker && msg.content.length > marker.length) {
        return true;
      }
      if (
        (Array.isArray(msg.attachments) && msg.attachments.length > 0) ||
        Boolean(msg.reasoning_content)
      ) {
        return true;
      }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      return calls.some(c => {
        const fn = (c as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
        return String(fn?.arguments || "").length > 200;
      });
    };

    const stripHeavyFields = (item: Record<string, unknown>): void => {
      delete item.attachments;
      if ("reasoning_content" in item) {
        item.reasoning_content = "";
      }
      const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (const call of calls) {
        const fn = (call as Record<string, unknown>)?.function as
          | Record<string, unknown>
          | undefined;
        if (fn && String(fn.arguments || "").length > 200) {
          fn.arguments = "{}";
        }
      }
    };

    let targetIdx = -1;
    for (let i = 0; i < Math.max(0, finalMessages.length - 2); i += 1) {
      if (shrinkable(internalMessages[i]!)) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx !== -1) {
      for (const collection of [internalMessages, finalMessages]) {
        const item = collection[targetIdx]!;
        if (typeof item.content === "string" && item.content.length > marker.length) {
          item.content = marker;
        }
        stripHeavyFields(item);
      }
      return [internalMessages, finalMessages];
    }

    for (let i = finalMessages.length - 1; i >= 0; i -= 1) {
      if (!shrinkable(internalMessages[i]!)) continue;
      for (const collection of [internalMessages, finalMessages]) {
        const item = collection[i]!;
        stripHeavyFields(item);
        if (typeof item.content === "string" && item.content.length > 512) {
          const limit = Math.max(256, Math.floor(item.content.length / 2));
          const head = Math.floor(limit / 2);
          const tail = limit - head;
          item.content = `${item.content.slice(0, head)}\n[... truncated for context rescue ...]\n${item.content.slice(-tail)}`;
        } else if (typeof item.content === "string" && item.content.length > marker.length) {
          item.content = marker;
        }
      }
      break;
    }
    return [internalMessages, finalMessages];
  }

  private async buildTokenPressureStatus(
    session: JsonlSessionStore,
    finalEstimate: ContextEstimate,
  ): Promise<Record<string, unknown>> {
    const budget = this._estimator.budget;
    const compactGeneration = await this.getCompactGeneration(session);
    const usage = await this.getLatestAssistantSamplingUsage(session);
    const anchor = this.resolveUsageAnchor({
      usage,
      currentTokens: finalEstimate.estimated_input_tokens,
      compactGeneration,
      model: session.model,
    });

    let localDelta = 0;
    let activeTokens = finalEstimate.estimated_input_tokens;
    let tokenSource = "local_estimate";
    if (anchor.usable) {
      const anchorLocal = anchor.local_estimated_input_tokens as number;
      const anchorServer = anchor.server_input_tokens as number;
      localDelta = Math.max(0, finalEstimate.estimated_input_tokens - anchorLocal);
      const ratio = anchorRatio(anchorServer, anchorLocal);
      activeTokens = anchorServer + Math.trunc(localDelta * ratio);
      tokenSource = "assistant_usage_plus_local_delta";
    }

    const limit = budget.resolvedAutoCompactTokenLimit();
    const reached = Boolean(budget.auto_compact_enabled && activeTokens >= limit);
    return {
      auto_compact_enabled: Boolean(budget.auto_compact_enabled),
      auto_compact_token_limit_reached: reached,
      auto_compact_active_tokens: activeTokens,
      auto_compact_token_source: tokenSource,
      auto_compact_compact_generation: compactGeneration,
      auto_compact_anchor_usable: Boolean(anchor.usable),
      auto_compact_anchor_fallback_reason: anchor.fallback_reason,
      auto_compact_anchor_input_tokens: anchor.server_input_tokens,
      auto_compact_anchor_local_estimated_input_tokens: anchor.local_estimated_input_tokens,
      auto_compact_anchor_compact_generation: anchor.compact_generation,
      auto_compact_anchor_model: anchor.model,
      auto_compact_anchor_model_status: anchor.model_status,
      auto_compact_local_delta_tokens: localDelta,
    };
  }

  private async getCompactGeneration(session: JsonlSessionStore): Promise<number> {
    try {
      const generation = positiveInt(await session.getCompactGeneration());
      if (generation !== null) return generation;
    } catch {}
    return 1;
  }

  private async getLatestAssistantSamplingUsage(
    session: JsonlSessionStore,
  ): Promise<Record<string, unknown>> {
    try {
      const usage = await session.getLatestAssistantSamplingUsage();
      if (usage && typeof usage === "object") {
        return { ...usage };
      }
    } catch {}
    return {};
  }

  private resolveUsageAnchor(options: {
    usage: Record<string, unknown>;
    currentTokens: number;
    compactGeneration: number;
    model?: string | null;
  }): Record<string, unknown> {
    const result: Record<string, unknown> = {
      usable: false,
      fallback_reason: null,
      server_input_tokens: null,
      local_estimated_input_tokens: null,
      compact_generation: null,
      model: null,
      model_status: null,
    };
    const { usage } = options;
    if (!usage || Object.keys(usage).length === 0) {
      result.fallback_reason = "missing_usage";
      return result;
    }
    if (usage.sampling_kind !== "assistant") {
      result.fallback_reason = "non_assistant_usage";
      return result;
    }
    const serverInputTokens = positiveInt(usage.input_tokens);
    if (serverInputTokens === null) {
      result.fallback_reason = "invalid_server_input_tokens";
      return result;
    }
    const anchor = usage.anchor as Record<string, unknown> | undefined;
    if (!anchor || typeof anchor !== "object") {
      result.fallback_reason = "missing_anchor";
      result.server_input_tokens = serverInputTokens;
      return result;
    }

    const localEstimate = positiveInt(anchor.local_estimated_input_tokens);
    const anchorGeneration = positiveInt(anchor.compact_generation);
    const anchorModel = typeof anchor.model === "string" && anchor.model.trim() ? anchor.model.trim() : null;
    const currentModel = typeof options.model === "string" && options.model.trim() ? options.model.trim() : null;

    result.server_input_tokens = serverInputTokens;
    result.local_estimated_input_tokens = localEstimate;
    result.compact_generation = anchorGeneration;
    result.model = anchorModel;

    if (localEstimate === null) {
      result.fallback_reason = "invalid_anchor_local_estimate";
      return result;
    }
    if (anchorGeneration !== options.compactGeneration) {
      result.fallback_reason = "compact_generation_mismatch";
      return result;
    }
    if (options.currentTokens < localEstimate) {
      result.fallback_reason = "current_estimate_below_anchor";
      return result;
    }
    if (anchorModel && currentModel && anchorModel !== currentModel) {
      result.fallback_reason = "model_mismatch";
      result.model_status = "mismatch";
      return result;
    }

    result.usable = true;
    result.model_status = anchorModel && currentModel ? "matched" : "anchor_model_unknown";
    return result;
  }

  private stripInternalFields(message: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(message)) {
      if (!k.startsWith("_")) out[k] = v;
    }
    return out;
  }

  private async goalPolicyMessage(session: JsonlSessionStore): Promise<Record<string, unknown>[]> {
    if (!this.goalPolicyProvider) return [];
    const goal = await session.getGoal();
    if (!goal || goal.status !== "active") return [];
    return [
      {
        role: "system",
        content: this.goalPolicyProvider(),
        _context_kind: "goal_policy",
      },
    ];
  }

  private buildRindDocMessages(): [
    Record<string, unknown>[],
    Record<string, unknown>,
    Record<string, unknown>,
  ] {
    const stats: Record<string, unknown> = {
      rind_docs_user_exists: false,
      rind_docs_project_exists: false,
      rind_docs_user_bytes: 0,
      rind_docs_project_bytes: 0,
      rind_docs_user_injected_bytes: 0,
      rind_docs_project_injected_bytes: 0,
      rind_docs_injected_chars: 0,
    };
    const decisions: Record<string, unknown> = {
      rind_docs_injected: false,
      rind_docs_truncated: false,
      rind_docs_truncated_scopes: [],
      rind_docs_user_path: null,
      rind_docs_project_path: null,
      rind_docs_error_type: null,
    };
    if (!this.rindDocProvider) {
      return [[], stats, decisions];
    }
    try {
      const [messages, pStats, pDecisions] = this.rindDocProvider();
      if (pStats && typeof pStats === "object") Object.assign(stats, pStats);
      if (pDecisions && typeof pDecisions === "object") Object.assign(decisions, pDecisions);
      return [this.validSystemMessages(messages), stats, decisions];
    } catch (exc) {
      decisions.rind_docs_error_type = (exc as Error).name || "Error";
      return [[], stats, decisions];
    }
  }

  private async buildSkillCatalogMessages(
    session: JsonlSessionStore,
  ): Promise<[Record<string, unknown>[], Record<string, unknown>, Record<string, unknown>]> {
    const stats: Record<string, unknown> = {
      skill_count: 0,
      skill_index_chars: 0,
    };
    const decisions: Record<string, unknown> = {
      skills_available: false,
      skill_catalog_injected: false,
      skill_error_type: null,
    };
    if (typeof session.getSkillCatalog !== "function") {
      return [[], stats, decisions];
    }
    let entries: { name: string; description: string; location: string }[];
    try {
      entries = await session.getSkillCatalog();
    } catch (exc) {
      decisions.skill_error_type = (exc as Error).name || "Error";
      return [[], stats, decisions];
    }
    if (!entries || entries.length === 0) {
      return [[], stats, decisions];
    }
    const content = renderAvailableSkills(entries, this.skillCatalogCharLimit);
    const messages = content
      ? [{ role: "system", content, _context_kind: "skill_catalog" }]
      : [];
    stats.skill_count = entries.length;
    stats.skill_index_chars = content.length;
    decisions.skills_available = true;
    decisions.skill_catalog_injected = messages.length > 0;
    return [messages, stats, decisions];
  }

  private validSystemMessages(
    messages: readonly Record<string, unknown>[] | null,
  ): Record<string, unknown>[] {
    const valid: Record<string, unknown>[] = [];
    for (const message of messages ?? []) {
      if (message && typeof message === "object" && message.role === "system" && typeof message.content === "string") {
        valid.push({ ...message });
      }
    }
    return valid;
  }

  private insertAfterFirstSystem(
    messages: readonly Record<string, unknown>[],
    extraMessages: readonly Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (extraMessages.length === 0) return [...messages];
    const result: Record<string, unknown>[] = [];
    let inserted = false;
    for (const message of messages) {
      result.push({ ...message });
      if (!inserted && message.role === "system") {
        for (const item of extraMessages) result.push({ ...item });
        inserted = true;
      }
    }
    if (!inserted) {
      return [...extraMessages.map(m => ({ ...m })), ...result];
    }
    return result;
  }

  private isConversationMessage(message: Record<string, unknown>): boolean {
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (message.tool_calls) return false;
    return typeof message.content === "string" && Boolean(message.content.trim());
  }

  private isSkillSnapshot(message: Record<string, unknown>): boolean {
    const meta = (message._rind_meta || message.meta) as Record<string, unknown> | undefined;
    return Boolean(meta && typeof meta === "object" && meta.kind === "skill_snapshot");
  }
}

const TOOL_ROW_LIMIT = 5;
const RIND_DOC_USER_MARKER = "--- user-doc ---";
const RIND_DOC_PROJECT_MARKER = "--- project-doc ---";
const CONTEXT_KIND_LABELS: Record<string, string> = {
  skill_catalog: "Skill catalog",
  goal_policy: "Goal policy",
  rind_init: "RIND init",
};

export function buildContextSnapshot(
  messages: readonly Record<string, unknown>[],
  stats: Record<string, unknown>,
  turnId = "",
  options?: {
    toolSchemas?: readonly Record<string, unknown>[] | null;
    capturedAt?: string | null;
    estimator?: ContextEstimator;
  },
): Record<string, unknown> {
  const safeStats = stats && typeof stats === "object" ? stats : {};
  const estimator = options?.estimator ?? new ContextEstimator();
  const sections = buildSnapshotSections(messages, estimator);
  const toolSchemas = options?.toolSchemas ?? null;
  const toolSchemaTokens =
    toolSchemas && toolSchemas.length > 0 ? estimator.estimateToolSchemas(toolSchemas) : 0;
  if (toolSchemas && toolSchemas.length > 0) {
    const sysSection = sections.find(s => s.key === "system_prompt");
    const sysOrder = sysSection ? (sysSection._order as number) : -1;
    sections.push({
      key: "tool_specs",
      label: "Tool specifications",
      tokens: toolSchemaTokens,
      messages: toolSchemas.length,
      _order: sysOrder + 0.5,
    });
  }
  let estimatedTotal = positiveInt(safeStats.estimated_input_tokens);
  if (estimatedTotal === null) {
    estimatedTotal = sections.reduce((sum, s) => sum + Number(s.tokens || 0), 0);
  } else {
    estimatedTotal += toolSchemaTokens;
  }
  const orderedSections = sections
    .sort((a, b) => Number(a._order) - Number(b._order))
    .map(({ _order, ...rest }) => rest);
  return {
    captured_at: options?.capturedAt || localIsoTimestamp(),
    turn_id: String(turnId || ""),
    estimated_total: estimatedTotal,
    context_window_tokens: positiveInt(
      safeStats.context_window_tokens,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    ),
    sections: orderedSections,
  };
}

function buildSnapshotSections(
  messages: readonly Record<string, unknown>[],
  estimator: ContextEstimator,
): Array<Record<string, unknown>> {
  const buckets = new Map<string, Record<string, unknown>>();
  const assign = (key: string, label: string, tokens: number, order: number): void => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, tokens: 0, messages: 0, _order: order };
      buckets.set(key, bucket);
    }
    bucket.tokens = Number(bucket.tokens) + Math.max(0, Math.trunc(tokens));
    bucket.messages = Number(bucket.messages) + 1;
  };

  const estimateMsg = (msg: Record<string, unknown>): number =>
    Math.max(0, Math.trunc(estimator.estimateMessages([msg]).estimated_input_tokens));

  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") continue;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const cid = String((call as Record<string, unknown>).id || "");
      const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined;
      const name = String(fn?.name || "");
      if (cid && name && !toolNames.has(cid)) {
        toolNames.set(cid, name);
      }
    }
  }

  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "tool") continue;
    const name = toolNames.get(String(msg.tool_call_id || "")) || "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const topTools = new Set(
    Array.from(counts.keys())
      .sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b))
      .slice(0, TOOL_ROW_LIMIT),
  );

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const kind = typeof message._context_kind === "string" ? message._context_kind.trim() : "";
    if (kind) {
      const total = estimateMsg(message);
      if (kind === "rind_docs") {
        const content = typeof message.content === "string" ? message.content : "";
        const hasUser = content.includes(RIND_DOC_USER_MARKER);
        const hasProject = content.includes(RIND_DOC_PROJECT_MARKER);
        if (hasUser && hasProject) {
          const userSegment = content
            .split(RIND_DOC_USER_MARKER)[1]!
            .split(RIND_DOC_PROJECT_MARKER)[0]!;
          const userTokens = Math.min(total, estimateMsg({ role: "system", content: userSegment }));
          assign("rind_docs_user", "RIND.md · user", userTokens, index);
          assign("rind_docs_project", "RIND.md · project", total - userTokens, index);
        } else if (hasUser) {
          assign("rind_docs_user", "RIND.md · user", total, index);
        } else if (hasProject) {
          assign("rind_docs_project", "RIND.md · project", total, index);
        } else {
          assign("rind_docs", "RIND.md", total, index);
        }
      } else {
        const label = CONTEXT_KIND_LABELS[kind];
        if (!label) {
          assign(`kind:${kind}`, kind, total, index);
        } else {
          assign(kind, label, total, index);
        }
      }
      continue;
    }

    const role = message.role;
    if (role === "tool") {
      const name = toolNames.get(String(message.tool_call_id || "")) || "unknown";
      if (topTools.has(name)) {
        assign(`tool:${name}`, `Tool results · ${name}`, estimateMsg(message), index);
      } else {
        assign("tool:other", "Tool results · other", estimateMsg(message), index);
      }
      continue;
    }
    const meta = message.meta as Record<string, unknown> | undefined;
    if (
      (meta && meta.kind === "compact_boundary") ||
      (role === "user" && message.content === COMPACT_CONTINUATION_USER_CONTENT) ||
      (role === "assistant" && message.reasoning_content === COMPACT_HANDOFF_REASONING_CONTENT)
    ) {
      assign("compaction_handoff", "Compaction handoff", estimateMsg(message), index);
      continue;
    }
    if (role === "system") {
      assign("system_prompt", "System prompt (incl. capsule)", estimateMsg(message), index);
    } else if (role === "user") {
      assign("chat_user", "Chat · user inputs", estimateMsg(message), index);
    } else if (role === "assistant") {
      const total = estimateMsg(message);
      const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      if (reasoning) {
        const reasoningTokens = Math.min(
          total,
          estimateMsg({ role: "assistant", reasoning_content: reasoning }),
        );
        assign("chat_assistant", "Chat · assistant replies", total - reasoningTokens, index);
        assign("reasoning", "Reasoning content", reasoningTokens, index);
      } else {
        assign("chat_assistant", "Chat · assistant replies", total, index);
      }
    } else {
      const label = String(role || "unknown");
      assign(`role:${label}`, label, estimateMsg(message), index);
    }
  }

  return Array.from(buckets.values());
}

export function pendingNotification(record: Record<string, unknown>): boolean {
  return Boolean(
    record.event_id &&
      record.committed &&
      record.handoff &&
      !record.delivered &&
      record.notify === "on_exit" &&
      record.status !== "cancelled",
  );
}

export function taskReference(record: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: record.task_id ?? null,
    status: record.status ?? null,
    notify: record.notify ?? null,
    origin_tool_call_id: record.origin_tool_call_id ?? null,
    event_id: record.event_id ?? null,
  };
}

function structuredResultText(record: Record<string, unknown>): string {
  const payload = record.result;
  return payload && typeof payload === "object" ? JSON.stringify(payload) : "";
}

export class TaskNotifications {
  readonly store: TaskJournal;
  readonly changed: ((record: Record<string, unknown>) => void) | null;
  readonly requestId: ((sessionId: string) => string | null) | null;

  constructor(
    store: TaskJournal,
    changed?: ((record: Record<string, unknown>) => void) | null,
    requestId?: ((sessionId: string) => string | null) | null,
  ) {
    this.store = store;
    this.changed = changed ?? null;
    this.requestId = requestId ?? null;
  }

  async resultCommitted(
    sessionId: string,
    toolName: string,
    callId: string,
    result: string,
  ): Promise<void> {
    if (!["bash", "task_control", "bash_output"].includes(toolName)) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const data = payload.data as Record<string, unknown> | undefined;
    if (!payload.ok || !data || typeof data !== "object" || !data.task_id) return;
    const taskId = String(data.task_id);
    const record = await this.store.get(sessionId, taskId);
    if (!record) return;
    const changes: Record<string, unknown> = {};
    if (toolName === "bash" && record.origin_tool_call_id === callId) {
      changes.committed = true;
    }
    if (TERMINAL_STATES.has(String(data.status ?? ""))) {
      changes.delivered = true;
    }
    const diff: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (record[k] !== v) diff[k] = v;
    }
    if (Object.keys(diff).length > 0) {
      const updated = await this.store.update(sessionId, taskId, diff);
      if (this.changed) {
        this.changed(updated);
      }
    }
  }

  async deliver(session: JsonlSessionStore): Promise<number> {
    const sessionId = session.sessionId;
    if (!sessionId) return 0;
    let records = await this.store.relevant(sessionId);
    if (Object.keys(records).length === 0) return 0;
    const messages = await session.loadMessages();
    let pendingCalls = new Set<string>();
    const projected = new Set<string>();
    for (const message of messages) {
      const meta = (message.meta as Record<string, unknown>) || {};
      const role = message.role;
      if (role === "assistant") {
        const calls = Array.isArray(meta.tool_calls) ? meta.tool_calls : [];
        pendingCalls = new Set(
          calls
            .map(c => (c && typeof c === "object" ? String((c as Record<string, unknown>).id || "") : ""))
            .filter(Boolean),
        );
      } else if (role === "tool") {
        pendingCalls.delete(String(message.tool_call_id || ""));
      } else if (role === "user") {
        pendingCalls.clear();
      }
      if (meta.kind === "task_notification" && Array.isArray(meta.event_ids)) {
        for (const eid of meta.event_ids) projected.add(String(eid));
      }
    }
    if (pendingCalls.size > 0) return 0;

    const toolMessages = new Map<string, Record<string, unknown>>();
    for (const m of messages) {
      if (m.role === "tool" && m.tool_call_id) {
        toolMessages.set(String(m.tool_call_id), m);
      }
    }
    for (const tool of await session.getToolRecords(Array.from(toolMessages.keys()))) {
      const name = String(tool.name || "");
      if (name === "task_control" || name === "bash_output") {
        const resText = structuredResultText(tool);
        try {
          const payload = JSON.parse(resText) as Record<string, unknown>;
          const data = payload?.data as Record<string, unknown> | undefined;
          if (data && typeof data.task_id === "string" && data.task_id in records) {
            await this.resultCommitted(sessionId, name, String(tool.id || ""), resText);
          }
        } catch {}
      }
    }
    for (const record of Object.values(records)) {
      const origin = String(record.origin_tool_call_id || "");
      if (!record.committed && origin && toolMessages.has(origin)) {
        const tools = await session.getToolRecords([origin]);
        if (tools.length > 0) {
          await this.resultCommitted(
            sessionId,
            "bash",
            origin,
            structuredResultText(tools[tools.length - 1]!),
          );
        }
      }
    }
    records = await this.store.relevant(sessionId);
    const pending = Object.values(records).filter(r => pendingNotification(r));
    const freshCandidates = pending.filter(r => !projected.has(String(r.event_id)));
    const fresh: Record<string, unknown>[] = [];
    if (freshCandidates.length > 0) {
      for (const candidate of freshCandidates) {
        const latest = await this.store.get(sessionId, String(candidate.task_id));
        if (latest) fresh.push(latest);
      }
      const facts = fresh.map(r => {
        const rMeta = (r.meta as Record<string, unknown>) || {};
        return {
          ...taskReference(r),
          exit_code: r.exit_code ?? null,
          elapsed_ms: r.elapsed_ms ?? null,
          reason: r.reason ?? null,
          output_path: rMeta.output_path ?? null,
          output_incomplete: Boolean(rMeta.output_incomplete),
        };
      });
      const untrusted = fresh.map(r => ({
        task_id: r.task_id,
        stdout: String(r.stdout || "").slice(-2000),
        stderr: String(r.stderr || "").slice(-2000),
      }));
      await session.persistMessage(
        "user",
        JSON.stringify({
          runtime_notification: "task_completed",
          facts,
          untrusted_process_output: untrusted,
        }),
        {
          meta: {
            kind: "task_notification",
            event_ids: fresh.map(r => r.event_id),
          },
        },
      );
    }
    for (const record of pending) {
      await this.store.update(sessionId, String(record.task_id), { delivered: true });
    }
    return fresh.length;
  }

  async references(sessionId: string): Promise<Record<string, unknown>[]> {
    const records = await this.store.relevant(sessionId);
    return Object.values(records)
      .filter(
        r =>
          !TERMINAL_STATES.has(String(r.status ?? "")) ||
          pendingNotification(r) ||
          (Boolean(r.delivered) && !r.consumed),
      )
      .map(r => taskReference(r));
  }

  async modelConsumed(sessionId: string, references: readonly Record<string, unknown>[]): Promise<void> {
    for (const ref of references) {
      const taskId = String(ref.task_id || "");
      if (!taskId) continue;
      const record = await this.store.get(sessionId, taskId);
      if (record && record.delivered && !record.consumed) {
        await this.store.update(sessionId, taskId, {
          consumed: true,
          continuation_error: "",
        });
      }
    }
  }

  async continuationFailed(sessionId: string, error: string): Promise<void> {
    const records = await this.store.relevant(sessionId);
    for (const record of Object.values(records)) {
      if (record.delivered && !record.consumed) {
        await this.store.update(sessionId, String(record.task_id), {
          continuation_error: error,
        });
      }
    }
  }
}
