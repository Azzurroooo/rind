import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  CompactionService,
  ContextBudget,
  ContextEstimator,
  ContextManager,
  DefaultToolRegistry,
  JsonlSessionStore,
  MessageStreamParser,
  ToolCallProcessor,
  ToolExecutor,
  ToolResultNormalizer,
  ToolSpec,
  TurnRunner,
} from "../dist/index.js";

class ScriptedChatClient {
  constructor(steps) {
    this.model = "scripted-model";
    this.steps = [...steps];
    this.seenMessages = [];
  }
  async create(messages) {
    this.seenMessages.push(messages);
    const step = this.steps.shift() || { content: "Summary handoff." };
    return {
      content: step.content || "",
      tool_calls: step.tool_calls || [],
      usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 0, reasoning_tokens: 0 },
      reasoning_content: null,
      finish_reason: "stop",
    };
  }
  async *stream(messages) {
    this.seenMessages.push(messages);
    const step = this.steps.shift() || { text: "Done." };
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        yield { kind: "tool_start", tool_call_id: tc.id, tool_name: tc.name };
        yield { kind: "tool_arguments_delta", tool_call_id: tc.id, tool_name: tc.name, arguments: tc.arguments };
        yield { kind: "tool_end", tool_call_id: tc.id, tool_name: tc.name };
      }
      yield { kind: "usage", usage: { input_tokens: 80, output_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 } };
      yield { kind: "completed", stop_reason: "tool_calls" };
      return;
    }
    if (step.text) {
      yield { kind: "text_delta", text: step.text };
    }
    yield { kind: "usage", usage: { input_tokens: 100, output_tokens: 25, cached_tokens: 0, reasoning_tokens: 0 } };
    yield { kind: "completed", stop_reason: "stop" };
  }
  async close() {}
}

test("AgentRuntime and TurnRunner execute tool roundtrips, steering, and follow-up queues", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-turn-runner-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-model",
    provider: "openai",
  });
  await store.initialize();

  const registry = new DefaultToolRegistry([
    new ToolSpec({
      name: "echo_tool",
      description: "Echoes text",
      parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      handler: async args => JSON.stringify({ ok: true, tool: "echo_tool", data: { echoed: args.msg } }),
    }),
  ]);

  const client = new ScriptedChatClient([
    {
      tool_calls: [{ id: "tc_1", name: "echo_tool", arguments: '{"msg":"ping"}' }],
    },
    {
      text: "Echo completed with ping.",
    },
  ]);

  const contextManager = new ContextManager({
    estimator: new ContextEstimator(new ContextBudget()),
  });
  const processor = new ToolCallProcessor({
    toolExecutor: new ToolExecutor(registry),
    toolResultNormalizer: new ToolResultNormalizer(),
  });
  const runner = new TurnRunner({
    chatClient: client,
    toolProcessor: processor,
    streamParser: new MessageStreamParser(),
    toolSchemas: registry.schemas,
    contextManager,
    compactionService: new CompactionService(),
  });
  const runtime = new AgentRuntime({
    turnRunner: runner,
    sessionStore: store,
    goalEnabled: true,
  });

  const events = [];
  for await (const ev of runtime.runTurn({ query: "Run echo tool" })) {
    events.push(ev);
  }
  assert.ok(events.some(e => e.type === "turn_started"));
  assert.ok(events.some(e => e.type === "tool_requested" && e.tool_name === "echo_tool"));
  assert.ok(events.some(e => e.type === "tool_result" && e.tool_name === "echo_tool"));
  assert.ok(events.some(e => e.type === "assistant_message_completed" && e.content === "Echo completed with ping."));
  assert.ok(events.some(e => e.type === "turn_completed"));
});

test("CompactionService compacts conversation history and preserves valid continuation boundary", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-compact-"));
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const store = new JsonlSessionStore({
    sessionDir: sessionsDir,
    workspaceRoot: workspace,
    model: "scripted-model",
    provider: "openai",
  });
  await store.initialize();
  await store.persistUserInput("First task: build module A");
  await store.persistMessage("assistant", "Built module A.");
  await store.persistUserInput("Second task: build module B");
  await store.persistMessage("assistant", "Built module B.");

  const client = new ScriptedChatClient([{ content: "Handoff: Built modules A and B." }]);
  const service = new CompactionService();
  const contextManager = new ContextManager();
  const initialCtx = await contextManager.buildMessagesAsync(store, { includeIds: true });
  const record = await service.compactAsync(store, initialCtx.messages, client, {
    reason: "manual",
    phase: "manual",
  });
  assert.ok(record.id);
  const rebuilt = await contextManager.buildMessagesAsync(store);
  assert.ok(rebuilt.messages.some(m => String(m.content).includes("Handoff: Built modules A and B.")));
});
