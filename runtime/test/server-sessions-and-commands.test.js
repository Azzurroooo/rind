import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  RuntimeDispatcher,
  RuntimeWorker,
  buildRindInitPrompt,
  resolveProjectDocPath,
  resolveUserDocPath,
} from "../dist/index.js";

async function startFixtureProvider() {
  const seenRequests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "fixture-fast" }, { id: "fixture-pro" }],
        }),
      );
      return;
    }
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      seenRequests.push(body);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const userMsgs = msgs.filter(m => m.role === "user");
      const lastUser = String(userMsgs[userMsgs.length - 1]?.content || "");
      const reply = `Echo[${userMsgs.length}]: ${lastUser}`;

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl,
    seenRequests,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function configureFixtureHome(rindHome, baseUrl) {
  await writeFile(
    path.join(rindHome, "settings.json"),
    JSON.stringify({ provider: "custom-gw", model: "fixture-fast", reasoningEffort: "low" }),
    "utf8",
  );
  await writeFile(
    path.join(rindHome, "auth.json"),
    JSON.stringify({ "custom-gw": { type: "api_key", key: "test-key" } }),
    "utf8",
  );
  await writeFile(
    path.join(rindHome, "providers.json"),
    JSON.stringify({
      providers: {
        "custom-gw": {
          name: "Custom Gateway",
          api: "openai-chat",
          baseUrl,
          models: {
            "fixture-fast": {
              contextWindow: 128000,
              reasoningEfforts: ["low", "medium", "high"],
            },
            "fixture-pro": {
              contextWindow: 256000,
              reasoningEfforts: ["low", "medium", "high"],
            },
          },
        },
      },
    }),
    "utf8",
  );
}

function createMemoryClient(worker, options = {}) {
  const sent = [];
  const writer = {
    async send(msg) {
      sent.push(msg);
    },
  };
  const dispatcher = new RuntimeDispatcher(worker, {
    writer,
    allowSessionConfiguration: options.allowSessionConfiguration ?? true,
    goalEnabled: options.goalEnabled ?? true,
  });
  let counter = 0;
  async function rpc(method, params = {}) {
    counter += 1;
    const requestId = `req_${counter}`;
    await dispatcher.dispatch({
      kind: "request",
      request_id: requestId,
      method,
      params,
    });
    const res = sent.find(m => m.kind === "response" && m.request_id === requestId);
    assert.ok(res, `Expected RPC response for ${method} (${requestId})`);
    return res;
  }
  return { sent, dispatcher, rpc };
}

test("RuntimeDispatcher initialize zero-residue contract, session lifecycle (new/list/switch/fork/delete), and corrupt JSONL rejection", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-srv-lifecycle-"));
  const rindHome = path.join(tmp, "home");
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(rindHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;
  const fixture = await startFixtureHomeAndServer(rindHome);

  async function startFixtureHomeAndServer(homeDir) {
    const srv = await startFixtureProvider();
    await configureFixtureHome(homeDir, srv.baseUrl);
    return srv;
  }

  const worker = new RuntimeWorker({
    workspaceRoot: workspace,
    sessionDir: sessionsDir,
  });
  const client = createMemoryClient(worker);

  t.after(async () => {
    client.dispatcher.close();
    await worker.close();
    await fixture.close();
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  // Calling session RPC before initialize returns ServerNotReady
  const preInit = await client.rpc("session/list", {});
  assert.equal(preInit.error?.type, "ServerNotReady");

  // 1) initialize: returns protocol v2, capabilities, methods, commands, empty session_id, and ZERO disk residue
  const initRes = await client.rpc("initialize", {});
  assert.equal(initRes.error, undefined);
  assert.equal(initRes.result.protocol_version, "2");
  assert.equal(initRes.result.session_id, "");
  assert.ok(Array.isArray(initRes.result.capabilities));
  assert.ok(initRes.result.capabilities.includes("rind/goals"));
  assert.ok(Array.isArray(initRes.result.methods));
  assert.ok(initRes.result.methods.includes("session/open"));
  assert.ok(initRes.result.methods.includes("session/fork"));
  assert.ok(Array.isArray(initRes.result.commands));
  assert.ok(initRes.result.commands.some(c => c.name === "init"));
  assert.equal(existsSync(sessionsDir), false, "No session directory may be created before first prompt");

  // Deferred draft via session/create still leaves zero session directories on disk before prompt
  const draftRes = await client.rpc("session/create", { workspace_root: workspace });
  const draftId = draftRes.result.session_id;
  assert.ok(draftId);
  assert.equal(existsSync(path.join(sessionsDir, draftId)), false);

  // First prompt materializes draftId and persists turn 1 + turn 2
  const p1 = await client.rpc("session/prompt", { session_id: draftId, input: "First question" });
  assert.equal(p1.result.ok, true);
  assert.equal(existsSync(path.join(sessionsDir, draftId, "messages.jsonl")), true);

  const p2 = await client.rpc("session/prompt", { session_id: draftId, input: "Second question" });
  assert.equal(p2.result.ok, true);

  // 2) session/new creates an explicit session; prompt it so both appear in session/list
  const newRes = await client.rpc("session/new", { workspace_root: workspace });
  const secondId = newRes.result.session_id;
  assert.ok(secondId && secondId !== draftId);
  await client.rpc("session/prompt", { session_id: secondId, input: "Other session prompt" });

  const listRes = await client.rpc("session/list", { workspace_root: workspace });
  assert.equal(listRes.error, undefined);
  const listedIds = listRes.result.sessions.map(s => s.id);
  assert.ok(listedIds.includes(draftId));
  assert.ok(listedIds.includes(secondId));

  const groupedList = await client.rpc("session/list", {
    per_workspace_limit: 1,
    exclude_session_ids: [secondId],
  });
  assert.equal(groupedList.result.sessions.length, 1);
  assert.equal(groupedList.result.sessions[0].id, draftId);
  assert.ok(Array.isArray(groupedList.result.totals));

  // 3) session/switch loads session metadata cleanly (1 system + 2 user + 2 assistant = 5 messages)
  const switchRes = await client.rpc("session/switch", { session_id: draftId });
  assert.equal(switchRes.error, undefined);
  assert.equal(switchRes.result.session_id, draftId);
  assert.equal(switchRes.result.message_count, 5);

  // 4) session/fork (both partial before_message_id fork and independent subsequent turns)
  const fullReplay = await client.rpc("session/replay", { session_id: draftId });
  const secondUserMsg = fullReplay.result.messages.find(
    m => m.role === "user" && m.content === "Second question",
  );
  assert.ok(secondUserMsg?.id, "Expected message id on second user message");

  const forkRes = await client.rpc("session/fork", {
    session_id: draftId,
    before_message_id: secondUserMsg.id,
  });
  assert.equal(forkRes.error, undefined);
  assert.equal(forkRes.result.forked_from, draftId);
  const forkedId = forkRes.result.session_id;
  assert.ok(forkedId && forkedId !== draftId);

  const forkedReplayBefore = await client.rpc("session/replay", { session_id: forkedId });
  const forkedTextsBefore = forkedReplayBefore.result.messages.map(m => m.content);
  assert.ok(forkedTextsBefore.includes("First question"));
  assert.equal(
    forkedTextsBefore.includes("Second question"),
    false,
    "before_message_id fork must exclude messages from the cut point onward",
  );

  // Subsequent turns on forked session and original session remain independent
  await client.rpc("session/prompt", { session_id: forkedId, input: "Fork-only branch turn" });
  await client.rpc("session/prompt", { session_id: draftId, input: "Original-only branch turn" });

  const forkedAfter = (await client.rpc("session/replay", { session_id: forkedId })).result.messages.map(
    m => m.content,
  );
  const origAfter = (await client.rpc("session/replay", { session_id: draftId })).result.messages.map(
    m => m.content,
  );
  assert.ok(forkedAfter.includes("Fork-only branch turn"));
  assert.equal(forkedAfter.includes("Original-only branch turn"), false);
  assert.ok(origAfter.includes("Original-only branch turn"));
  assert.equal(origAfter.includes("Fork-only branch turn"), false);

  // 5) session/delete rejects deleting worker.sessionId if active/current, deletes non-current session,
  //    emits session_deleted event, and removes directory from disk
  worker.sessionId = secondId;
  const blockedDelete = await client.rpc("session/delete", { session_id: secondId });
  assert.equal(blockedDelete.error?.type, "InvalidRequest");
  assert.match(blockedDelete.error?.message, /Cannot delete the current session/);

  worker.sessionId = draftId;
  client.sent.length = 0;
  const delRes = await client.rpc("session/delete", { session_id: secondId });
  assert.equal(delRes.error, undefined);
  assert.deepEqual(delRes.result, { ok: true, deleted: secondId });
  assert.equal(existsSync(path.join(sessionsDir, secondId)), false);
  assert.ok(
    client.sent.some(
      m =>
        m.kind === "event" &&
        m.event?.type === "session_deleted" &&
        m.event?.session_id === secondId,
    ),
  );

  // 6) Corrupt JSONL session rejection (corrupt messages.jsonl and corrupt meta.json)
  const corruptId = "20261111_120000_corrupt1";
  const corruptDir = path.join(sessionsDir, corruptId);
  await mkdir(corruptDir, { recursive: true });
  await writeFile(
    path.join(corruptDir, "meta.json"),
    JSON.stringify({
      schema_version: "2.0",
      session_id: corruptId,
      title: "Corrupt",
      created_at: "2026-11-11T00:00:00Z",
      updated_at: "2026-11-11T00:00:00Z",
      model: "fixture-fast",
      provider: "custom-gw",
      cwd: workspace,
      workspace_root: workspace,
      message_count: 1,
      tool_call_count: 0,
    }),
    "utf8",
  );
  await writeFile(
    path.join(corruptDir, "messages.jsonl"),
    '{"role":"user","content":"valid"}\n{corrupt_jsonl_line\n',
    "utf8",
  );

  const corruptReplay = await client.rpc("session/replay", { session_id: corruptId });
  assert.ok(corruptReplay.error, "Expected error when replaying session with corrupt messages.jsonl");

  const corruptEventReplay = await client.rpc("session/replay", {
    session_id: corruptId,
    after_cursor: 0,
  });
  assert.ok(corruptEventReplay.error, "Expected error on cursor replay of corrupt messages.jsonl");

  // Corrupt meta.json is rejected on session/switch
  const badMetaId = "20261111_120001_badmeta1";
  const badMetaDir = path.join(sessionsDir, badMetaId);
  await mkdir(badMetaDir, { recursive: true });
  await writeFile(path.join(badMetaDir, "meta.json"), "{truncated-json", "utf8");
  const badSwitch = await client.rpc("session/switch", { session_id: badMetaId });
  assert.ok(badSwitch.error, "Expected error when switching to session with corrupt meta.json");
});

test("Multi-subscriber session/subscribe, session/unsubscribe, and session/replay (after_cursor & tail windowing)", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-srv-pubsub-replay-"));
  const rindHome = path.join(tmp, "home");
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  await mkdir(rindHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;
  const fixture = await startFixtureProvider();
  await configureFixtureHome(rindHome, fixture.baseUrl);

  const worker = new RuntimeWorker({
    workspaceRoot: workspace,
    sessionDir: sessionsDir,
  });
  const clientA = createMemoryClient(worker);
  const clientB = createMemoryClient(worker);

  t.after(async () => {
    clientA.dispatcher.close();
    clientB.dispatcher.close();
    await worker.close();
    await fixture.close();
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  await clientA.rpc("initialize", {});
  await clientB.rpc("initialize", {});

  const created = await clientA.rpc("session/create", { workspace_root: workspace });
  const sessionId = created.result.session_id;

  // Prompt 1 before clientB subscribes -> clientA receives events, clientB receives none
  await clientA.rpc("session/prompt", { session_id: sessionId, input: "Turn one" });
  assert.ok(
    clientA.sent.some(m => m.kind === "event" && m.event?.session_id === sessionId),
  );
  assert.equal(
    clientB.sent.some(m => m.kind === "event" && m.event?.session_id === sessionId),
    false,
  );

  // clientB subscribes to sessionId -> receives live fanout events when background delivery runs on worker
  const subRes = await clientB.rpc("session/subscribe", { session_id: sessionId });
  assert.equal(subRes.result.ok, true);
  assert.deepEqual(subRes.result.subscribed, [sessionId]);

  async function waitForEvent(clientObj, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = clientObj.sent.find(predicate);
      if (hit) return hit;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error("Timed out waiting for expected event");
  }

  clientA.sent.length = 0;
  clientB.sent.length = 0;
  const deliv2 = await clientA.rpc("rind/session/deliver", {
    session_id: sessionId,
    text: "Turn two",
  });
  assert.equal(deliv2.result.queued, true);
  await waitForEvent(
    clientB,
    m => m.kind === "event" && m.event?.session_id === sessionId && m.event?.type === "turn_completed",
  );
  const bEventTypes = clientB.sent
    .filter(m => m.kind === "event" && m.event?.session_id === sessionId)
    .map(m => m.event.type);
  assert.ok(bEventTypes.includes("turn_started"));
  assert.ok(bEventTypes.includes("assistant_message_completed"));
  assert.ok(bEventTypes.includes("turn_completed"));

  // clientB unsubscribes -> receives zero events when Turn three delivery runs, while clientA still receives them
  const unsubRes = await clientB.rpc("session/unsubscribe", { session_id: sessionId });
  assert.equal(unsubRes.result.ok, true);
  assert.deepEqual(unsubRes.result.subscribed, []);

  clientA.sent.length = 0;
  clientB.sent.length = 0;
  const deliv3 = await clientA.rpc("rind/session/deliver", {
    session_id: sessionId,
    text: "Turn three",
  });
  assert.equal(deliv3.result.queued, true);
  await waitForEvent(
    clientA,
    m => m.kind === "event" && m.event?.session_id === sessionId && m.event?.type === "turn_completed",
  );
  assert.equal(
    clientB.sent.some(m => m.kind === "event" && m.event?.session_id === sessionId),
    false,
  );

  // session/replay: tail windowing, start/end slicing, and validation
  const full = await clientA.rpc("session/replay", { session_id: sessionId });
  assert.equal(full.result.messages.length, 7); // 1 system + 3 * (user + assistant)
  assert.equal(full.result.message_total, 7);

  const tail2 = await clientA.rpc("session/replay", { session_id: sessionId, tail: 2 });
  assert.equal(tail2.result.messages.length, 2);
  assert.equal(tail2.result.message_total, 7);
  assert.equal(tail2.result.messages[0].content, "Turn three");
  assert.match(tail2.result.messages[1].content, /Turn three/);

  const invalidCombo = await clientA.rpc("session/replay", {
    session_id: sessionId,
    start: 1,
    tail: 2,
  });
  assert.equal(invalidCombo.error?.type, "InvalidRequest");

  // session/replay: after_cursor durable event pagination
  const pageAll = await clientB.rpc("session/replay", {
    session_id: sessionId,
    after_cursor: 0,
  });
  assert.equal(pageAll.error, undefined);
  const totalCursor = pageAll.result.cursor;
  assert.ok(totalCursor >= 7, `Expected >= 7 durable events, got ${totalCursor}`);
  assert.equal(pageAll.result.events.length, totalCursor);

  const pageFrom3 = await clientB.rpc("session/replay", {
    session_id: sessionId,
    after_cursor: 3,
  });
  assert.equal(pageFrom3.result.cursor, totalCursor);
  assert.equal(pageFrom3.result.events.length, totalCursor - 3);
  assert.equal(pageFrom3.result.events[0].sequence, 4);

  const pageAtEnd = await clientB.rpc("session/replay", {
    session_id: sessionId,
    after_cursor: totalCursor,
  });
  assert.deepEqual(pageAtEnd.result.events, []);
  assert.equal(pageAtEnd.result.cursor, totalCursor);
});

test("Slash commands (/help, /status, /rename, /model, /skill, /import, /init), folder defaults, and workspace file boundaries", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-srv-commands-files-"));
  const rindHome = path.join(tmp, "home");
  const sessionsDir = path.join(tmp, "sessions");
  const workspace = path.join(tmp, "workspace");
  const worktreeGitDir = path.join(workspace, ".git", "worktrees", "wt-feature");
  const worktreeWorkspace = path.join(tmp, "worktree-feature");
  const otherWorkspace = path.join(tmp, "other-workspace");
  const projectSkillDir = path.join(workspace, ".agents", "skills", "lint-audit");
  const claudeSkillDir = path.join(workspace, ".claude", "skills", "claude-helper");
  await mkdir(rindHome, { recursive: true });
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktreeWorkspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await mkdir(projectSkillDir, { recursive: true });
  await mkdir(claudeSkillDir, { recursive: true });
  await writeFile(path.join(worktreeWorkspace, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

  await writeFile(
    path.join(projectSkillDir, "SKILL.md"),
    "---\nname: lint-audit\ndescription: Run lint checks\n---\nLint workflow.\n",
    "utf8",
  );
  await writeFile(
    path.join(claudeSkillDir, "SKILL.md"),
    "---\nname: claude-helper\ndescription: Imported Claude skill\n---\nClaude workflow.\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "README.md"), "# Sample Workspace\n", "utf8");

  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;
  const fixture = await startFixtureProvider();
  await configureFixtureHome(rindHome, fixture.baseUrl);

  const worker = new RuntimeWorker({
    workspaceRoot: workspace,
    sessionDir: sessionsDir,
  });
  const client = createMemoryClient(worker);

  t.after(async () => {
    client.dispatcher.close();
    await worker.close();
    await fixture.close();
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  await client.rpc("initialize", {});
  const conv = await client.rpc("session/create", { workspace_root: workspace });
  const sessionId = conv.result.session_id;
  await client.rpc("session/prompt", { session_id: sessionId, input: "Initial workspace prompt" });

  // 1) /help and /help compact
  const helpRes = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/help",
  });
  assert.equal(helpRes.result.display?.type, "help");
  assert.match(helpRes.result.text, /# Commands/);

  const helpCompact = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/help compact",
  });
  assert.equal(helpCompact.result.display?.command?.name, "compact");
  assert.match(helpCompact.result.text, /# \/compact/);

  // 2) /status
  const statusRes = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/status",
  });
  assert.equal(statusRes.result.display?.type, "status");
  assert.equal(statusRes.result.display?.selection?.provider, "custom-gw");
  assert.equal(statusRes.result.display?.selection?.model, "fixture-fast");

  // 3) /rename <name> and /rename --reset
  client.sent.length = 0;
  const renameRes = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/rename Release Readiness Review",
  });
  assert.equal(renameRes.result.display?.type, "session_renamed");
  assert.equal(renameRes.result.display?.name, "Release Readiness Review");
  assert.ok(
    client.sent.some(
      m =>
        m.kind === "event" &&
        m.event?.type === "session_renamed" &&
        m.event?.name === "Release Readiness Review",
    ),
  );

  const resetNameRes = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/rename --reset",
  });
  assert.equal(resetNameRes.result.display?.name, null);
  assert.equal(resetNameRes.result.display?.title, "Initial workspace prompt");

  // 4) /model and /model set <model>
  const modelShow = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/model",
  });
  assert.match(modelShow.result.text, /fixture-fast/);

  client.sent.length = 0;
  const modelSet = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/model set fixture-pro",
  });
  assert.match(modelSet.result.text, /Model changed to fixture-pro/);
  assert.ok(
    client.sent.some(
      m =>
        m.kind === "event" &&
        m.event?.type === "session_settings_changed" &&
        m.event?.model === "fixture-pro",
    ),
  );

  // 5) /skill and /import
  const skillBefore = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/skill",
  });
  assert.equal(skillBefore.result.display?.type, "skills");
  assert.match(skillBefore.result.text, /lint-audit/);

  // Enable claude_project=on via /import and verify claude-helper becomes active in /skill
  const importEnable = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/import claude_project=on",
  });
  assert.equal(importEnable.result.display?.type, "skill_imports");
  const claudeSrc = importEnable.result.display.sources.find(s => s.id === "claude_project");
  assert.equal(claudeSrc?.enabled, true);

  const skillAfter = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/skill",
  });
  const activeSkillNames = skillAfter.result.display.sources
    .filter(s => s.enabled)
    .flatMap(s => s.skills.filter(sk => sk.status === "active").map(sk => sk.name));
  assert.ok(activeSkillNames.includes("lint-audit"));
  assert.ok(activeSkillNames.includes("claude-helper"));

  // 6) /init (project and user scopes using buildRindInitPrompt)
  const initProj = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/init project",
  });
  const expectedProjPath = resolveProjectDocPath(workspace);
  assert.ok(initProj.result.next_prompt);
  assert.equal(
    initProj.result.next_prompt.transient_system_messages[0]._context_kind,
    "rind_init",
  );
  assert.equal(
    initProj.result.next_prompt.transient_system_messages[0].content,
    buildRindInitPrompt("project", expectedProjPath),
  );

  const initUser = await client.rpc("rind/command/execute", {
    session_id: sessionId,
    input: "/init user",
  });
  const expectedUserPath = resolveUserDocPath();
  assert.equal(
    initUser.result.next_prompt.transient_system_messages[0].content,
    buildRindInitPrompt("user", expectedUserPath),
  );

  // 7) Folder defaults: set, get, resolve (folder + git worktree main_repository inheritance + settings fallback), unset
  client.sent.length = 0;
  const fdSet = await client.rpc("rind/folder_defaults/set", {
    workspace_root: workspace,
    scope: "folder",
    provider_id: "custom-gw",
    model_id: "fixture-pro",
    reasoning_effort: "high",
  });
  assert.equal(fdSet.error, undefined);
  assert.equal(fdSet.result.resolved.model, "fixture-pro");
  assert.equal(fdSet.result.resolved.reasoning_effort, "high");
  assert.equal(fdSet.result.resolved.model_source, "folder");
  assert.ok(
    client.sent.some(m => m.kind === "event" && m.event?.type === "folder_defaults_changed"),
  );

  const fdGet = await client.rpc("rind/folder_defaults/get", { workspace_root: workspace });
  assert.equal(fdGet.result.folder.model, "fixture-pro");
  assert.equal(fdGet.result.folder.reasoning_effort, "high");

  const fdResolve = await client.rpc("rind/folder_defaults/resolve", {
    workspace_roots: [workspace, worktreeWorkspace, otherWorkspace],
  });
  assert.equal(fdResolve.result.folders[workspace].model, "fixture-pro");
  assert.equal(fdResolve.result.folders[workspace].model_source, "folder");
  assert.equal(fdResolve.result.folders[workspace].connection_ready, true);
  assert.equal(fdResolve.result.folders[worktreeWorkspace].model, "fixture-pro");
  assert.equal(fdResolve.result.folders[worktreeWorkspace].model_source, "main_repository");
  assert.equal(fdResolve.result.folders[otherWorkspace].model, "fixture-fast");
  assert.equal(fdResolve.result.folders[otherWorkspace].model_source, "settings");

  const fdUnsetEffort = await client.rpc("rind/folder_defaults/unset", {
    workspace_root: workspace,
    group: "reasoning_effort",
  });
  assert.equal(fdUnsetEffort.result.resolved.reasoning_effort, "low");
  assert.equal(fdUnsetEffort.result.resolved.model, "fixture-pro");

  const fdUnsetModel = await client.rpc("rind/folder_defaults/unset", {
    workspace_root: workspace,
    group: "model",
  });
  assert.equal(fdUnsetModel.result.resolved.model, "fixture-fast");
  assert.equal(fdUnsetModel.result.resolved.model_source, "settings");

  // 8) Workspace file/list, file/read, file/write and strict path/upload boundary checks
  const payloadBytes = Buffer.from("Uploaded report payload\n", "utf8");
  const writeOk = await client.rpc("file/write", {
    path: "uploads/reports/q4.txt",
    content_base64: payloadBytes.toString("base64"),
  });
  assert.equal(writeOk.error, undefined);
  assert.deepEqual(writeOk.result, {
    path: "uploads/reports/q4.txt",
    size: payloadBytes.length,
  });

  const listRoot = await client.rpc("file/list", { path: "" });
  assert.equal(listRoot.error, undefined);
  assert.ok(listRoot.result.entries.some(e => e.name === "README.md" && e.type === "file"));
  assert.ok(listRoot.result.entries.some(e => e.name === "uploads" && e.type === "dir"));

  const readBack = await client.rpc("file/read", { path: "uploads/reports/q4.txt" });
  assert.equal(readBack.error, undefined);
  assert.equal(readBack.result.mime, "text/plain");
  assert.equal(readBack.result.size, payloadBytes.length);
  assert.equal(
    Buffer.from(readBack.result.content_base64, "base64").toString("utf8"),
    "Uploaded report payload\n",
  );

  // Boundary violations
  const writeOutsideUploads = await client.rpc("file/write", {
    path: "README.md",
    content_base64: payloadBytes.toString("base64"),
  });
  assert.equal(writeOutsideUploads.error?.type, "InvalidRequest");
  assert.match(writeOutsideUploads.error?.message, /restricted to the uploads\/ directory/);

  const writeTraversal = await client.rpc("file/write", {
    path: "uploads/../../escape.txt",
    content_base64: payloadBytes.toString("base64"),
  });
  assert.equal(writeTraversal.error?.type, "InvalidRequest");

  const readTraversal = await client.rpc("file/read", { path: "../outside.txt" });
  assert.equal(readTraversal.error?.type, "InvalidRequest");

  const readAbsolute = await client.rpc("file/read", {
    path: path.join(workspace, "README.md"),
  });
  assert.equal(readAbsolute.error?.type, "InvalidRequest");

  const writeBadBase64 = await client.rpc("file/write", {
    path: "uploads/bad.bin",
    content_base64: "%%%not_base64%%%",
  });
  assert.equal(writeBadBase64.error?.type, "DecodeError");

  const readMissing = await client.rpc("file/read", { path: "uploads/does-not-exist.txt" });
  assert.equal(readMissing.error?.type, "NotFound");

  const listMissing = await client.rpc("file/list", { path: "missing-dir" });
  assert.equal(listMissing.error?.type, "NotFound");

  // Verify no stray files were written outside tmp
  const rootEntries = await readdir(workspace);
  assert.equal(rootEntries.includes("escape.txt"), false);
});
