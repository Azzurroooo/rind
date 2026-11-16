import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  COMPACT_CONTINUATION_USER_CONTENT,
  COMPACT_HANDOFF_REASONING_CONTENT,
  CompactionService,
  ContextBudget,
  ContextEstimator,
  ContextManager,
  DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DefaultToolRegistry,
  JsonlSessionStore,
  MessageStreamParser,
  ProviderError,
  SkillRepository,
  SkillTurnCoordinator,
  ToolCallProcessor,
  ToolExecutor,
  ToolResultNormalizer,
  ToolSpec,
  TurnRunner,
  applyLatestCompactBoundary,
  attachContextAnchor,
  buildPlanSnapshot,
  buildContextSnapshot,
  buildRindDocContext,
  buildUsageRecord,
  extractUsageDict,
  isCompactBoundaryMessage,
  normalizeSamplingUsage,
  writePlan,
} from "../dist/index.js";

class ScriptedCompactChatClient {
  constructor({ createSteps = [], streamSteps = [] } = {}) {
    this.model = "scripted-compact-model";
    this.createSteps = [...createSteps];
    this.streamSteps = [...streamSteps];
    this.createCalls = [];
    this.streamCalls = [];
  }

  async create(messages, tools, cancellationToken, options = {}) {
    const cloned = structuredClone(messages);
    this.createCalls.push({ messages: cloned, tools, options });
    const step = this.createSteps.shift() || { content: "Compacted handoff summary." };
    if (typeof step.onCall === "function") {
      await step.onCall({ messages: cloned, options });
    }
    if (step.error) {
      throw step.error;
    }
    return {
      content: step.content ?? "Compacted handoff summary.",
      tool_calls: step.tool_calls || [],
      usage: step.usage || {
        input_tokens: 90,
        output_tokens: 30,
        cached_input_tokens: 10,
        reasoning_output_tokens: 5,
      },
      reasoning_content: null,
      finish_reason: step.finish_reason ?? "stop",
    };
  }

  async *stream(messages, tools, cancellationToken, options = {}) {
    const cloned = structuredClone(messages);
    this.streamCalls.push({ messages: cloned, tools, options });
    const step = this.streamSteps.shift() || { text: "Done." };
    if (typeof step.onCall === "function") {
      await step.onCall({ messages: cloned, options });
    }
    if (step.error) {
      throw step.error;
    }
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        yield { kind: "tool_start", tool_call_id: tc.id, tool_name: tc.name };
        yield {
          kind: "tool_arguments_delta",
          tool_call_id: tc.id,
          tool_name: tc.name,
          arguments: tc.arguments,
        };
        yield { kind: "tool_end", tool_call_id: tc.id, tool_name: tc.name };
      }
      yield {
        kind: "usage",
        usage: step.usage || {
          input_tokens: 120,
          output_tokens: 20,
          cached_tokens: 0,
          reasoning_tokens: 0,
        },
      };
      yield { kind: "completed", stop_reason: "tool_calls" };
      return;
    }
    if (step.text) {
      yield { kind: "text_delta", text: step.text };
    }
    yield {
      kind: "usage",
      usage: step.usage || {
        input_tokens: 110,
        output_tokens: 25,
        cached_tokens: 22,
        reasoning_tokens: 4,
      },
    };
    yield { kind: "completed", stop_reason: "stop" };
  }

  async close() {}
}

function makeRegistry(specs = []) {
  const readSpec = new ToolSpec({
    name: "read_file",
    description: "Read file stub",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async args => JSON.stringify({ ok: true, tool: "read_file", data: { path: args.path } }),
  });
  return new DefaultToolRegistry([readSpec, ...specs]);
}

test("usage extraction, sampling normalization, context anchoring, and usage record construction", () => {
  assert.equal(extractUsageDict(null), null);
  assert.equal(extractUsageDict(undefined), null);
  assert.equal(extractUsageDict("not-an-object"), null);

  // OpenAI Chat Completions nested usage format
  const chatExtracted = extractUsageDict({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 250,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 80 },
    },
  });
  assert.deepEqual(chatExtracted, {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 250,
    reasoning_output_tokens: 80,
    total_tokens: 1250,
  });

  // Responses / normalized usage format with explicit total_tokens
  const responsesExtracted = extractUsageDict({
    input_tokens: 500,
    cached_input_tokens: 125,
    output_tokens: 100,
    reasoning_output_tokens: 30,
    total_tokens: 600,
  });
  assert.deepEqual(responsesExtracted, {
    input_tokens: 500,
    cached_input_tokens: 125,
    output_tokens: 100,
    reasoning_output_tokens: 30,
    total_tokens: 600,
  });

  const normalized = normalizeSamplingUsage(chatExtracted, {
    samplingKind: "assistant",
    contextWindowTokens: 2000,
  });
  assert.equal(normalized.sampling_kind, "assistant");
  assert.equal(normalized.input_tokens, 1000);
  assert.equal(normalized.cached_input_tokens, 400);
  assert.equal(normalized.cache_hit_rate, 0.4);
  assert.equal(normalized.output_tokens, 250);
  assert.equal(normalized.reasoning_output_tokens, 80);
  assert.equal(normalized.total_tokens, 1250);
  assert.equal(normalized.context_window_tokens, 2000);
  assert.equal(normalized.context_usage_percent, 0.5);

  // Zero input tokens clamps cache_hit_rate to 0 and non-positive window clamps to 1
  const zeroInput = normalizeSamplingUsage(
    { input_tokens: 0, cached_input_tokens: 50, output_tokens: 12 },
    { samplingKind: "compact", contextWindowTokens: 0 },
  );
  assert.equal(zeroInput.cache_hit_rate, 0);
  assert.equal(zeroInput.context_window_tokens, 1);
  assert.equal(zeroInput.context_usage_percent, 0);

  // attachContextAnchor requires positive estimated_input_tokens and compactGeneration
  const unanchoredMissingGen = attachContextAnchor(normalized, {
    contextStats: { estimated_input_tokens: 900, estimated_chars: 3150, message_count: 6 },
    model: "gpt-5.4",
    compactGeneration: 0,
  });
  assert.equal("anchor" in unanchoredMissingGen, false);

  const unanchoredMissingTokens = attachContextAnchor(normalized, {
    contextStats: { estimated_input_tokens: 0, estimated_chars: 0, message_count: 1 },
    model: "gpt-5.4",
    compactGeneration: 1,
  });
  assert.equal("anchor" in unanchoredMissingTokens, false);

  const anchored = attachContextAnchor(normalized, {
    contextStats: { estimated_input_tokens: 920, estimated_chars: 3220, message_count: 7 },
    model: "  gpt-5.4  ",
    compactGeneration: 2,
  });
  assert.equal(anchored.anchor.local_estimated_input_tokens, 920);
  assert.equal(anchored.anchor.local_estimated_chars, 3220);
  assert.equal(anchored.anchor.context_message_count, 7);
  assert.equal(anchored.anchor.compact_generation, 2);
  assert.equal(anchored.anchor.model, "gpt-5.4");
  assert.match(anchored.anchor.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // buildUsageRecord copies only USAGE_RECORD_FIELDS and attaches metadata
  const ledgerRecord = buildUsageRecord(
    { ...anchored, ignored_extra_field: "drop-me" },
    { sessionId: "sess_123", model: "gpt-5.4", ts: "2026-11-11T10:00:00+08:00" },
  );
  assert.equal(ledgerRecord.ts, "2026-11-11T10:00:00+08:00");
  assert.equal(ledgerRecord.session_id, "sess_123");
  assert.equal(ledgerRecord.model, "gpt-5.4");
  assert.equal(ledgerRecord.input_tokens, 1000);
  assert.equal(ledgerRecord.cache_hit_rate, 0.4);
  assert.equal("anchor" in ledgerRecord, false);
  assert.equal("ignored_extra_field" in ledgerRecord, false);

  const autoTsRecord = buildUsageRecord(normalized, { sessionId: "sess_auto", model: "o3" });
  assert.match(String(autoTsRecord.ts), /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/);
});

test("ContextBudget, ContextEstimator, and ContextManager token pressure & anchor delta thresholds", async t => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 256000);
  assert.equal(DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT, 90);

  const defaultBudget = ContextBudget.default();
  assert.equal(defaultBudget.resolvedContextWindowTokens(), 256000);
  assert.equal(defaultBudget.resolvedAutoCompactTokenLimitPercent(), 90);
  assert.equal(defaultBudget.resolvedAutoCompactTokenLimit(), 230400);

  const smallBudget = new ContextBudget({
    contextWindowTokens: 1000,
    autoCompactTokenLimitPercent: 80,
    hardLimitTokens: 900,
  });
  assert.equal(smallBudget.resolvedAutoCompactTokenLimit(), 800);
  assert.equal(smallBudget.resolvedHardLimitTokens(), 900);

  const estimator = new ContextEstimator(smallBudget);
  const asciiEst = estimator.estimateMessages([{ role: "user", content: "a".repeat(350) }]);
  const cjkEst = estimator.estimateMessages([{ role: "user", content: "中".repeat(350) }]);
  assert.ok(
    cjkEst.estimated_input_tokens > asciiEst.estimated_input_tokens * 2,
    `Expected CJK token estimate (${cjkEst.estimated_input_tokens}) > 2x ASCII (${asciiEst.estimated_input_tokens})`,
  );

  const withImageEst = estimator.estimateMessages([
    {
      role: "user",
      content: "Inspect screenshot",
      attachments: [{ path: "attachments/img.png", mime_type: "image/png", width: 640, height: 320 }],
    },
  ]);
  // 640/32 * 320/32 * 2 = 20 * 10 * 2 = 400 image tokens plus text overhead
  assert.ok(withImageEst.estimated_input_tokens >= 400);

  const schemaTokens = estimator.estimateToolSchemas([
    {
      type: "function",
      function: {
        name: "search_code",
        description: "Search repository files",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  ]);
  assert.ok(schemaTokens > 0);

  // Verify usage-anchor delta triggers auto_compact_token_limit_reached even when raw local estimate is below limit
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-ctx-pressure-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "System prompt.",
  });
  await store.initialize();
  await store.persistUserInput("First short message");
  await store.persistMessage("assistant", "First short reply");

  const manager = new ContextManager({ estimator });
  const baseBuild = await manager.buildMessagesAsync(store, { includeSkillCatalog: false });
  assert.equal(baseBuild.stats.auto_compact_token_source, "local_estimate");
  assert.equal(baseBuild.decisions.auto_compact_token_limit_reached, false);

  // Persist assistant sampling usage anchored near the 800-token threshold (790 server input tokens)
  const anchoredUsage = attachContextAnchor(
    normalizeSamplingUsage(
      { input_tokens: 790, output_tokens: 20, cached_input_tokens: 0 },
      { samplingKind: "assistant", contextWindowTokens: 1000 },
    ),
    {
      contextStats: baseBuild.stats,
      model: "scripted-compact-model",
      compactGeneration: await store.getCompactGeneration(),
    },
  );
  await store.persistSamplingUsage(anchoredUsage);

  // Append more user text so local delta pushes server_input_tokens + scaled_delta >= 800
  await store.persistUserInput("Additional follow-up details ".repeat(8));
  const deltaBuild = await manager.buildMessagesAsync(store, { includeSkillCatalog: false });
  assert.equal(deltaBuild.stats.auto_compact_anchor_usable, true);
  assert.equal(deltaBuild.stats.auto_compact_token_source, "assistant_usage_plus_local_delta");
  assert.equal(deltaBuild.decisions.auto_compact_token_limit_reached, true);

  // Changing session model invalidates anchor with model_mismatch fallback
  await store.updateSelection("openai", "different-model");
  const mismatchBuild = await manager.buildMessagesAsync(store, { includeSkillCatalog: false });
  assert.equal(mismatchBuild.stats.auto_compact_anchor_usable, false);
  assert.equal(mismatchBuild.stats.auto_compact_anchor_fallback_reason, "model_mismatch");
  assert.equal(mismatchBuild.stats.auto_compact_token_source, "local_estimate");
});

test("TurnRunner auto-compacts before first sampling when token threshold is reached, and guards manual compact on empty session", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-auto-compact-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const emptyStore = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "System prompt.",
  });
  await emptyStore.initialize();

  const registry = makeRegistry();
  const emptyClient = new ScriptedCompactChatClient();
  const emptyRunner = new TurnRunner({
    chatClient: emptyClient,
    toolProcessor: new ToolCallProcessor({
      toolExecutor: new ToolExecutor(registry),
      toolResultNormalizer: new ToolResultNormalizer(),
    }),
    streamParser: new MessageStreamParser(),
    toolSchemas: registry.schemas,
    contextManager: new ContextManager(),
    compactionService: new CompactionService(),
  });
  const emptyRuntime = new AgentRuntime({
    turnRunner: emptyRunner,
    sessionStore: emptyStore,
  });

  await assert.rejects(
    () => emptyRuntime.compactContext("manual"),
    /Not enough messages to compact\. Send a message first\./,
  );

  // Now populate a session whose token estimate exceeds a tight auto-compact window (200 * 50% = 100 tokens)
  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "System prompt.",
  });
  await store.initialize();
  await store.persistUserInput("Historical context item alpha ".repeat(20));
  await store.persistMessage("assistant", "Completed alpha work ".repeat(20));

  const usageRecords = [];
  const client = new ScriptedCompactChatClient({
    createSteps: [{ content: "Auto-compacted summary: alpha module finished." }],
    streamSteps: [{ text: "Proceeding with beta after auto-compaction." }],
  });
  const contextManager = new ContextManager({
    estimator: new ContextEstimator(
      new ContextBudget({
        contextWindowTokens: 200,
        autoCompactTokenLimitPercent: 50,
      }),
    ),
  });
  const runner = new TurnRunner({
    chatClient: client,
    toolProcessor: new ToolCallProcessor({
      toolExecutor: new ToolExecutor(registry),
      toolResultNormalizer: new ToolResultNormalizer(),
    }),
    streamParser: new MessageStreamParser(),
    toolSchemas: registry.schemas,
    contextManager,
    compactionService: new CompactionService({
      usageRecorder: rec => usageRecords.push(rec),
    }),
    usageRecorder: rec => usageRecords.push(rec),
  });
  const runtime = new AgentRuntime({
    turnRunner: runner,
    sessionStore: store,
  });

  const events = [];
  for await (const ev of runtime.runTurn({ query: "Start beta work" })) {
    events.push(ev);
  }

  assert.equal(client.createCalls.length, 1, "Expected 1 compaction LLM call");
  assert.equal(client.streamCalls.length, 1, "Expected 1 assistant stream call after auto-compaction");

  const compactedEv = events.find(e => e.type === "context_compacted");
  assert.ok(compactedEv, "Expected context_compacted event");
  assert.equal(compactedEv.record.reason, "auto");
  assert.equal(compactedEv.record.phase, "mid_turn");
  assert.equal(compactedEv.record.strategy, "llm_inline");
  assert.equal(compactedEv.record.diagnostics?.auto_compact_phase_detail, "before_first_sampling");

  // Streamed assistant call sees the compacted handoff instead of raw historical messages
  const streamedContents = client.streamCalls[0].messages.map(m => String(m.content || ""));
  assert.ok(streamedContents.some(c => c.includes("Auto-compacted summary: alpha module finished.")));
  assert.equal(
    streamedContents.some(c => c.includes("Historical context item alpha")),
    false,
  );
  assert.ok(usageRecords.some(r => r.sampling_kind === "compact"));
  assert.ok(usageRecords.some(r => r.sampling_kind === "assistant"));
});

test("AgentRuntime and CompactionService recover from context_length_exceeded via compaction retry, rescueContext, and deterministic fallback", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-overflow-recovery-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "System prompt.",
  });
  await store.initialize();
  await store.persistUserInput("Large prior turn input: " + "X".repeat(2400));
  await store.persistMessage("assistant", "Large prior turn output: " + "Y".repeat(2400));

  // 1) CompactionService.compactAsync retries on context_length_exceeded by shrinking effectiveWindow,
  //    and appends active plan snapshot + taskReferences.
  writePlan(
    [
      { step: "Audit overflow path", status: "completed" },
      { step: "Verify rescue fallback", status: "in_progress" },
    ],
    store.sessionBasePath,
  );

  const compactRetryClient = new ScriptedCompactChatClient({
    createSteps: [
      {
        error: new ProviderError("prompt is too long", {
          status: "rejected",
          code: "context_length_exceeded",
        }),
      },
      { content: "Handoff after shrinking summary window." },
    ],
  });
  const serviceWithPlan = new CompactionService({
    planSnapshotProvider: buildPlanSnapshot,
  });
  const preCompactCtx = await new ContextManager().buildMessagesAsync(store, {
    includeIds: true,
    includeSkillCatalog: false,
  });
  const retryRecord = await serviceWithPlan.compactAsync(
    store,
    preCompactCtx.messages,
    compactRetryClient,
    {
      reason: "manual",
      phase: "manual",
      contextStats: { context_window_tokens: 9000 },
      taskReferences: [
        { task_id: "task_abc", status: "running", notify: "on_exit", origin_tool_call_id: "tc_1" },
      ],
    },
  );
  assert.equal(compactRetryClient.createCalls.length, 2);
  assert.ok(
    compactRetryClient.createCalls[1].options.maxOutputTokens <
      compactRetryClient.createCalls[0].options.maxOutputTokens,
    "Second summary attempt must shrink maxOutputTokens budget",
  );
  assert.equal(retryRecord.strategy, "llm_inline");
  assert.match(retryRecord.handoff_message.content, /Handoff after shrinking summary window\./);
  assert.match(retryRecord.handoff_message.content, /Plan state at compact boundary:/);
  assert.match(retryRecord.handoff_message.content, /Verify rescue fallback/);
  assert.match(retryRecord.handoff_message.content, /Managed task references \(runtime facts\):/);
  assert.match(retryRecord.handoff_message.content, /task_abc/);

  // 2) CompactionService.compactAsync falls back to deterministic_fallback on non-overflow error
  await store.persistUserInput("Post-compact message before deterministic fallback");
  await store.persistMessage("assistant", "Post-compact assistant reply");
  const failingSummaryClient = new ScriptedCompactChatClient({
    createSteps: [
      {
        error: new ProviderError("upstream gateway unavailable", {
          status: "unavailable",
          code: "upstream_down",
        }),
      },
    ],
  });
  const fallbackCtx = await new ContextManager().buildMessagesAsync(store, {
    includeIds: true,
    includeSkillCatalog: false,
  });
  const fallbackRecord = await serviceWithPlan.compactAsync(
    store,
    fallbackCtx.messages,
    failingSummaryClient,
    { reason: "manual", phase: "manual" },
  );
  assert.equal(fallbackRecord.strategy, "deterministic_fallback");
  assert.equal(fallbackRecord.fallback_error.status, "unavailable");
  assert.match(
    fallbackRecord.handoff_message.content,
    /This is a deterministic handoff generated from persisted session events\./,
  );
  assert.match(fallbackRecord.handoff_message.content, /Previous compact handoff:/);

  // 3) TurnRunner automatic recovery on 2 consecutive context_length_exceeded errors during stream():
  //    1st overflow -> mid-turn compaction (reason: "context_length_error")
  //    2nd overflow -> reduceHardLimit + forceRescueNextBuild ("[DROPPED FOR CONTEXT RESCUE]") -> succeeds,
  //    and restores original hard_limit_tokens in finally!
  const turnStore = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "System prompt.",
  });
  await turnStore.initialize();
  await turnStore.persistUserInput("Turn 1 heavy payload " + "A".repeat(1600));
  await turnStore.persistMessage("assistant", "Turn 1 heavy response " + "B".repeat(1600));

  const overflowClient = new ScriptedCompactChatClient({
    createSteps: [{ content: "Detailed compacted handoff " + "H".repeat(900) }],
    streamSteps: [
      {
        error: new ProviderError("context_length_exceeded on attempt 1", {
          status: "rejected",
          code: "context_length_exceeded",
        }),
      },
      {
        error: new ProviderError("context_length_exceeded on attempt 2", {
          status: "rejected",
          code: "context_length_exceeded",
        }),
      },
      { text: "Recovered after compaction + context rescue!" },
    ],
  });

  const budget = new ContextBudget({
    contextWindowTokens: 500,
    hardLimitTokens: 450,
    autoCompactEnabled: false,
  });
  const contextManager = new ContextManager({
    estimator: new ContextEstimator(budget),
  });
  const registry = makeRegistry();
  const runner = new TurnRunner({
    chatClient: overflowClient,
    toolProcessor: new ToolCallProcessor({
      toolExecutor: new ToolExecutor(registry),
      toolResultNormalizer: new ToolResultNormalizer(),
    }),
    streamParser: new MessageStreamParser(),
    toolSchemas: registry.schemas,
    contextManager,
    compactionService: new CompactionService(),
  });
  const runtime = new AgentRuntime({ turnRunner: runner, sessionStore: turnStore });

  const turnEvents = [];
  for await (const ev of runtime.runTurn({ query: "Continue after overflow" })) {
    turnEvents.push(ev);
  }

  assert.equal(overflowClient.createCalls.length, 1);
  assert.equal(overflowClient.streamCalls.length, 3);
  const recoveryCompactEv = turnEvents.find(e => e.type === "context_compacted");
  assert.ok(recoveryCompactEv);
  assert.equal(recoveryCompactEv.record.reason, "context_length_error");
  assert.equal(
    recoveryCompactEv.record.diagnostics?.auto_compact_phase_detail,
    "context_length_recovery",
  );
  assert.ok(
    overflowClient.streamCalls[2].messages.some(m =>
      String(m.content || "").includes("[DROPPED FOR CONTEXT RESCUE]"),
    ),
    "Second overflow retry must shrink context with [DROPPED FOR CONTEXT RESCUE]",
  );
  assert.ok(
    turnEvents.some(
      e =>
        e.type === "assistant_message_completed" &&
        e.content === "Recovered after compaction + context rescue!",
    ),
  );
  assert.equal(
    budget.hard_limit_tokens,
    450,
    "Original hard_limit_tokens must be restored after turn completes",
  );
});

test("compaction boundary persistence, RIND.md + active skill re-injection, and steering/follow-up queue preservation across compaction", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-boundary-skills-queues-"));
  const rindHome = path.join(tmp, "home");
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  const skillDir = path.join(workspace, ".agents", "skills", "deploy-check");
  await mkdir(rindHome, { recursive: true });
  await mkdir(skillDir, { recursive: true });

  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  await writeFile(path.join(rindHome, "RIND.md"), "User rule: Always run deterministic tests.", "utf8");
  await writeFile(path.join(workspace, "RIND.md"), "Project rule: Keep CLI separate from runtime.", "utf8");
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: deploy-check",
      "description: Verify deployment readiness checklist",
      "---",
      "Step 1: Verify health endpoint.",
      "Step 2: Check rollback tag.",
    ].join("\n"),
    "utf8",
  );

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-compact-model",
    provider: "openai",
    systemPrompt: "Base system prompt.",
  });
  await store.initialize();

  const skillRepo = new SkillRepository(workspace);
  const skills = new SkillTurnCoordinator(skillRepo, { catalog: true });
  const registry = makeRegistry();
  const contextManager = new ContextManager({
    estimator: new ContextEstimator(
      new ContextBudget({
        contextWindowTokens: 4000,
        autoCompactEnabled: false,
      }),
    ),
    rindDocProvider: () => buildRindDocContext(workspace),
  });

  let runtimeRef = null;
  const client = new ScriptedCompactChatClient({
    createSteps: [
      {
        content: "Handoff summary: initial deploy-check setup completed.",
        onCall: async () => {
          // Queue both steering and follow-up inputs WHILE manual compaction is in-flight!
          const steerAck = runtimeRef.submitSteering("Include canary verification note");
          const followAck = runtimeRef.submitFollowUp("Run post-compact verification with $deploy-check");
          assert.equal(steerAck.accepted, true);
          assert.equal(followAck.accepted, true);
        },
      },
    ],
    streamSteps: [
      { text: "Initial skill turn complete." },
      { text: "Post-compaction steering turn complete." },
      { text: "Post-compaction follow-up turn handled $deploy-check!" },
    ],
  });

  const runner = new TurnRunner({
    chatClient: client,
    toolProcessor: new ToolCallProcessor({
      toolExecutor: new ToolExecutor(registry),
      toolResultNormalizer: new ToolResultNormalizer(),
    }),
    streamParser: new MessageStreamParser(),
    toolSchemas: registry.schemas,
    contextManager,
    compactionService: new CompactionService(),
    skills,
  });
  const runtime = new AgentRuntime({
    turnRunner: runner,
    sessionStore: store,
    skills,
  });
  runtimeRef = runtime;

  // Turn 1: invoke $deploy-check so skill_snapshot + skill_catalog are active before compaction
  for await (const _ev of runtime.runTurn({ query: "Prepare release using $deploy-check" })) {
    // drain
  }
  assert.equal(await store.getCompactGeneration(), 1);

  // Turn 2: run manual compaction; onCall queues steering + follow-up mid-compaction!
  const compactTurnEvents = [];
  for await (const ev of runtime.runTurn({ compact: "manual" })) {
    compactTurnEvents.push(ev);
  }

  // Verify boundary persistence & isCompactBoundaryMessage / applyLatestCompactBoundary
  assert.equal(await store.getCompactGeneration(), 2);
  const rawMessages = await store.loadMessages();
  const boundaryMsgs = rawMessages.filter(m => isCompactBoundaryMessage(m));
  assert.equal(boundaryMsgs.length, 1);
  assert.equal(isCompactBoundaryMessage({ role: "assistant", content: "ordinary" }), false);

  const compactions = [await store.getLatestCompaction()];
  const projected = applyLatestCompactBoundary(rawMessages, compactions);
  assert.equal(projected.some(m => isCompactBoundaryMessage(m)), false);
  assert.ok(projected.some(m => m.role === "user" && m.content === COMPACT_CONTINUATION_USER_CONTENT));
  assert.ok(
    projected.some(
      m =>
        m.role === "assistant" &&
        m.reasoning_content === COMPACT_HANDOFF_REASONING_CONTENT &&
        String(m.content).includes("Handoff summary: initial deploy-check setup completed."),
    ),
  );

  // Verify queued follow-up and steering were both preserved and delivered after manual compaction!
  const deliveredModes = compactTurnEvents
    .filter(e => e.type === "queued_input_delivered")
    .map(e => e.mode);
  assert.ok(deliveredModes.includes("follow_up"), "Expected queued follow_up delivery after compaction");
  assert.ok(deliveredModes.includes("steering"), "Expected queued steering delivery after compaction");

  // Verify post-compaction model requests contain:
  // 1) Re-injected user & project RIND.md
  // 2) Re-injected <available_skills> catalog
  // 3) Compacted handoff summary
  // 4) Steering continuation (streamCalls[1]) AND follow-up $deploy-check skill snapshot (streamCalls[2])!
  assert.equal(client.streamCalls.length, 3);
  const steeringSent = client.streamCalls[1].messages;
  const followUpSent = client.streamCalls[2].messages;

  const systemText = followUpSent
    .filter(m => m.role === "system")
    .map(m => String(m.content || ""))
    .join("\n");
  assert.match(systemText, /User rule: Always run deterministic tests\./);
  assert.match(systemText, /Project rule: Keep CLI separate from runtime\./);
  assert.match(systemText, /<available_skills>/);
  assert.match(systemText, /deploy-check/);

  const steeringNonSystem = steeringSent
    .filter(m => m.role !== "system")
    .map(m => String(m.content || ""))
    .join("\n");
  assert.match(steeringNonSystem, /Handoff summary: initial deploy-check setup completed\./);
  assert.match(steeringNonSystem, /Include canary verification note/);

  const followUpNonSystem = followUpSent
    .filter(m => m.role !== "system")
    .map(m => String(m.content || ""))
    .join("\n");
  assert.match(followUpNonSystem, /Handoff summary: initial deploy-check setup completed\./);
  assert.match(followUpNonSystem, /Step 1: Verify health endpoint\./);
});


test("context estimates track nested mutations and include tool schemas in pressure exactly once", async t => {
  const estimator = new ContextEstimator(new ContextBudget({ contextWindowTokens: 1000, hardLimitTokens: 900 }));
  const message = { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "a".repeat(100) } }] };
  const before = estimator.estimateMessages([message]).estimated_input_tokens;
  message.tool_calls[0].function.arguments = "中".repeat(100);
  assert.ok(estimator.estimateMessages([message]).estimated_input_tokens > before);
  const schemas = [{ type: "function", function: { name: "read", description: "a".repeat(4000) } }];
  const schemaBefore = estimator.estimateToolSchemas(schemas);
  schemas[0].function.description = "中".repeat(4000);
  assert.ok(estimator.estimateToolSchemas(schemas) > schemaBefore);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-schema-budget-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const store = new JsonlSessionStore({ sessionDir: path.join(tmp, "sessions"), workspaceRoot: tmp });
  await store.initialize();
  await store.persistUserInput("hello");
  const manager = new ContextManager({ estimator });
  const context = await manager.buildMessagesAsync(store, { includeSkillCatalog: false, toolSchemas: schemas });
  assert.equal(estimator.estimateMessages(context.internal_messages, { toolSchemas: schemas }).over_hard_limit, true);
  assert.equal(context.decisions.auto_compact_token_limit_reached, true);
  const snapshot = buildContextSnapshot(context.internal_messages, context.stats, "turn", { estimator, toolSchemas: schemas });
  assert.equal(snapshot.estimated_total, context.stats.estimated_input_tokens);
  assert.equal(context.stats.tool_schema_tokens, estimator.estimateToolSchemas(schemas));
});
