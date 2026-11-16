import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlSessionStore, DefaultToolRegistry, ToolSpec, ToolExecutor, ToolCallProcessor, ToolResultNormalizer } from "../dist/index.js";
import { createDeferred } from "../dist/domain/cancellation.js";

async function fixture(t, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-parallel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = new JsonlSessionStore({ sessionDir: path.join(root, "sessions"), workspaceRoot: root });
  await session.initialize();
  await session.persistUserInput("Read both");
  const calls = ["slow", "fast"].map(id => ({ call_id: id, name: "read", raw_args: JSON.stringify({ id }) }));
  await session.persistMessage("assistant", "", { meta: { tool_calls: calls.map(c => ({ id: c.call_id, name: c.name, raw_args: c.raw_args })) } });
  const registry = new DefaultToolRegistry([new ToolSpec({ name: "read", description: "Read", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, isAsync: true, parallel: true, handler })]);
  const processor = new ToolCallProcessor({ toolExecutor: new ToolExecutor(registry), toolResultNormalizer: new ToolResultNormalizer() });
  return { session, calls, processor };
}

test("parallel results persist on completion, model order and recovery remain deterministic", async t => {
  const slow = createDeferred();
  t.after(() => slow.resolve());
  let executions = 0;
  const { session, calls, processor } = await fixture(t, async args => {
    executions++;
    if (args.id === "slow") await slow.promise;
    return JSON.stringify({ ok: true, tool: "read", data: args.id });
  });
  const events = [];
  for await (const event of processor.execute(session, calls)) {
    events.push(event);
    if (event.type === "tool_result" && event.tool_call_id === "fast") {
      assert.deepEqual((await session.getToolRecords()).map(r => r.id), ["fast"]);
      assert.equal(slow.done, false);
      slow.resolve();
    }
  }
  assert.deepEqual(events.filter(e => e.type === "tool_result").map(e => e.tool_call_id), ["fast", "slow"]);
  const messages = await session.getMessagesSlice();
  assert.deepEqual(messages.filter(m => m.role === "tool").map(m => m.tool_call_id), ["slow", "fast"]);
  for await (const event of processor.execute(session, calls)) assert.notEqual(event.type, "tool_call_started");
  assert.equal(executions, 2);
  assert.equal((await session.getToolRecords()).length, 2);
});

test("early consumer return cancels and joins owned parallel work", async t => {
  let stopped = false;
  const { session, calls, processor } = await fixture(t, async args => {
    if (args.id === "slow") {
      try { await args._cancellation_token.sleep(60000); }
      finally { stopped = true; }
    }
    return JSON.stringify({ ok: true, tool: "read", data: args.id });
  });
  for await (const event of processor.execute(session, calls)) {
    if (event.type === "tool_result") break;
  }
  assert.equal(stopped, true);
});

test("one persistence failure is reported after other parallel results commit", async t => {
  const { session, calls, processor } = await fixture(t, async args => JSON.stringify({ ok: true, tool: "read", data: args.id }));
  const persist = session.persistToolCall.bind(session);
  session.persistToolCall = async (...args) => { if (args[0] === "slow") throw new Error("disk rejected"); return persist(...args); };
  const events = [];
  await assert.rejects(async () => { for await (const event of processor.execute(session, calls)) events.push(event); }, /Failed to persist tool result/);
  assert.ok(events.some(e => e.type === "tool_result" && e.tool_call_id === "fast" && e.status === "completed"));
  assert.deepEqual((await session.getToolRecords()).map(r => r.id), ["fast"]);
});
