import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  APPROVE_COMMAND,
  AUTH_LINE,
  CANCELLED_LINE,
  CHANNEL_EXTRA_KEYS,
  COOLDOWN_NOTICE,
  CommandHub,
  ConfigError,
  CooldownGate,
  GUIDES,
  OFFLINE_NOTICE,
  OVERFLOW_LINE,
  Outbound,
  PAIRING_FULL_NOTICE,
  PairingStore,
  QUESTION_EXPIRED_REPLY,
  RATE_LIMIT_LINE,
  ReactionController,
  RuntimeMethod,
  SecurityGate,
  SessionCreateError,
  SessionRouter,
  StdioTransport,
  TIMEOUT_LINE,
  TITLE_RESERVE,
  TurnPump,
  WebSocketTransport,
  WorkerClient,
  allGuides,
  attachmentKind,
  buildConfig,
  buildConfigData,
  buildPromptText,
  collectAnswersEnv,
  createCapabilities,
  degradeMarkdown,
  discoverTelegram,
  firstLineTitle,
  formatAttachmentPromptRef,
  gatewayMain,
  isAddressedToBot,
  loadConfig,
  looksLikeSourceDir,
  parseYaml,
  renderChoices,
  renderYaml,
  runChecks,
  runGateway,
  sessionKey,
  setProbeHooks,
  splitText,
  toolEmoji,
  userErrorLine,
  workerAlive,
} from "../dist/gateway/index.js";
import { FakeWorker, MemoryTransport } from "./helpers/fake-worker.mjs";
import { LOADERS } from "../dist/gateway/channels/index.js";

async function withTempDir(t, prefix = "rind-gw-core-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function waitUntil(predicate, timeoutMs = 2000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function makeInbound(overrides = {}) {
  return {
    channel: "telegram",
    chat_id: "100",
    chat_type: "dm",
    sender_id: "u1",
    sender_name: "Alice",
    thread_id: null,
    text: "hello",
    attachments: [],
    message_ref: "m1",
    ...overrides,
  };
}

test("gateway deduplication is scoped to channel and chat, and uncertain delivery is not advertised as queued", async () => {
  const requests = [];
  const worker = {
    connected: true, onEvent() {}, async subscribe() {},
    async request(method, params) { requests.push({ method, params }); throw new Error("Disconnected"); },
  };
  const pump = new TurnPump({
    worker, workspaceRoot: ".", security: { admit: () => ({ allow: true }) },
    router: { async ensureSession(key) { return { session_id: key }; } },
  });
  const first = new RecordingChannel("telegram");
  const second = new RecordingChannel("discord");
  pump.registerChannel(first);
  pump.registerChannel(second);
  for (const overrides of [{}, {}, { chat_id: "200" }, { channel: "discord" }]) {
    await pump.inbound(makeInbound(overrides));
  }
  assert.equal(requests.length, 3);
  // The failed request was not placed in the offline queue and must not be automatically resent.
  await pump.tick();
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(first), /delivery is unconfirmed/);
  assert.doesNotMatch(JSON.stringify(first), /queued for retry/);
});

class RecordingChannel {
  constructor(id = "telegram", capOverrides = {}) {
    this.id = id;
    this.capabilities = createCapabilities({
      max_text_length: 4000,
      len_unit: "utf16",
      supports_typing: true,
      supports_buttons: true,
      supports_reaction: true,
      markdown: "none",
      ...capOverrides,
    });
    this.sent = [];
    this.typings = [];
    this.reactions = [];
    this.started = false;
  }

  async start(sink) {
    this.sink = sink;
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  async send(target, payload) {
    this.sent.push({ target, payload });
  }

  async typing(target) {
    this.typings.push(target);
  }

  async react(target, emoji) {
    this.reactions.push({ target, emoji });
  }
}

// --- 1. Types & Config -------------------------------------------------------

test("attachmentKind classifies MIME types and falls back to document", () => {
  assert.equal(attachmentKind("image/png"), "image");
  assert.equal(attachmentKind("audio/ogg"), "audio");
  assert.equal(attachmentKind("video/mp4"), "video");
  assert.equal(attachmentKind("application/pdf"), "document");
  assert.equal(attachmentKind("malformed"), "document");
});

test("config parseYaml/renderYaml/buildConfig supports env interpolation, strict keys, and round-trip", async t => {
  const ws = await withTempDir(t);
  const yaml = `
# gateway config comment
worker: \${GW_WORKER}
workspace: "${ws.replace(/\\/g, "/")}"
worker_token: "sec#ret" # inline comment preserved inside quotes
cooldown_per_minute: 25
pairing:
  enabled: true
  ttl_minutes: 120
channels:
  telegram:
    token: \${TG_TOK}
    proxy: http://127.0.0.1:7890
    allow_from: ['123456789', "alice"]
  email:
    imap_host: imap.example.com
    imap_port: 993
    imap_ssl: true
    smtp_host: smtp.example.com
    smtp_port: 465
    smtp_starttls: false
    username: bot@example.com
    password: 'p''w'
    poll_interval: 30
`;
  const parsed = parseYaml(yaml, {
    env: { GW_WORKER: "ws://127.0.0.1:8765", TG_TOK: "123:ABC" },
  });
  const cfg = buildConfig(parsed);
  assert.equal(cfg.worker, "ws://127.0.0.1:8765");
  assert.equal(cfg.worker_token, "sec#ret");
  assert.equal(cfg.cooldown_per_minute, 25);
  assert.equal(cfg.pairing.ttl_minutes, 120);
  assert.equal(cfg.channels.telegram.token, "123:ABC");
  assert.equal(cfg.channels.telegram.extra.proxy, "http://127.0.0.1:7890");
  assert.deepEqual(cfg.channels.telegram.allow_from, ["123456789", "alice"]);
  assert.equal(cfg.channels.email.extra.password, "p'w");
  assert.equal(cfg.channels.email.extra.imap_port, 993);

  // Missing env variable throws ConfigError
  assert.throws(
    () => parseYaml("worker: ${MISSING_VAR}\n", { env: {} }),
    err => err instanceof ConfigError && /MISSING_VAR/.test(err.message),
  );

  // Tab indentation is rejected
  assert.throws(
    () => parseYaml("channels:\n\ttelegram:\n", { env: {} }),
    err => err instanceof ConfigError && /tab indentation/.test(err.message),
  );

  // Unknown root & channel keys are rejected
  assert.throws(
    () => buildConfig({ worker: "stdio", workspace: ws, bogus: 1 }),
    err => err instanceof ConfigError && /unknown key: bogus/.test(err.message),
  );
  assert.throws(
    () =>
      buildConfig({
        worker: "stdio",
        workspace: ws,
        channels: { telegram: { token: "t", unknown_field: "x" } },
      }),
    err =>
      err instanceof ConfigError &&
      /unknown key: channels\.telegram\.unknown_field/.test(err.message),
  );

  // Numeric sender IDs and $ strings survive renderYaml -> parseYaml -> buildConfig
  const rendered = renderYaml({
    worker: "stdio",
    workspace: ws,
    channels: {
      telegram: {
        token: "$literal_dollar",
        allow_from: ["987654321"],
      },
    },
  });
  assert.match(rendered, /'987654321'/);
  const roundTripped = buildConfig(parseYaml(rendered, { env: {} }));
  assert.equal(roundTripped.worker, "stdio");
  assert.equal(roundTripped.channels.telegram.token, "$literal_dollar");
  assert.deepEqual(roundTripped.channels.telegram.allow_from, ["987654321"]);
});

// --- 2. Chunking & Errors (Bug Fix 4) ----------------------------------------

test("chunking preserves code fences, handles utf16 surrogates, degrades markdown, and renders choices", () => {
  assert.equal(firstLineTitle("\n  Hello world\nSecond line"), "Hello world");
  assert.equal([...firstLineTitle("x".repeat(80))].length, 48);

  const fenced = "Intro paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro.";
  const single = splitText(fenced, 1000, "chars");
  assert.equal(single.length, 1);

  // Surrogate-pair emoji 😀 counts as 2 UTF-16 code units, never split mid-pair
  const emojis = "😀".repeat(30); // 60 utf16 units
  const parts = splitText(emojis, TITLE_RESERVE + 10, "utf16");
  assert.ok(parts.length >= 6);
  for (const part of parts) {
    assert.ok(part.length <= 10);
    assert.equal(part.includes("\uFFFD"), false);
    for (let i = 0; i < part.length; i += 1) {
      const code = part.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = part.charCodeAt(i + 1);
        assert.ok(low >= 0xdc00 && low <= 0xdfff, "high surrogate must be paired");
        i += 1;
      }
    }
  }

  const degraded = degradeMarkdown("# Heading\nSee **[docs](https://x.test)**\n```sh\nls -la\n```");
  assert.equal(degraded, "Heading\nSee docs\n    ls -la");

  const choices = renderChoices(["One", "Two", "Three", "Four", "Five", "Six"]);
  assert.match(choices, /1\. One/);
  assert.match(choices, /5\. Five/);
  assert.match(choices, /\(1 more omitted\)/);
  assert.match(choices, /Reply with a number/);
});

test("userErrorLine classifies known failure signatures and BUG FIX 4 reads event.reason", () => {
  assert.equal(userErrorLine(new Error("Request timed out")), TIMEOUT_LINE);
  assert.equal(userErrorLine("HTTP 429 Too Many Requests"), RATE_LIMIT_LINE);
  assert.equal(userErrorLine({ message: "401 Unauthorized api_key" }), AUTH_LINE);
  assert.equal(userErrorLine("maximum context length exceeded"), OVERFLOW_LINE);
  assert.equal(userErrorLine({ error: "turn cancelled by user" }), CANCELLED_LINE);

  // BUG FIX 4: replayed turn_failed events carry `reason` rather than `error`
  assert.equal(
    userErrorLine({ type: "turn_failed", reason: "429 rate limit exceeded" }),
    RATE_LIMIT_LINE,
  );
  const unknownFromReason = userErrorLine({
    type: "turn_failed",
    reason: `disk   full\n${"x".repeat(200)}`,
  });
  assert.equal(unknownFromReason.includes("\n"), false);
  assert.match(unknownFromReason, /disk full/);
  assert.ok(unknownFromReason.length < 200);
});

// --- 3. Router & Security (Bug Fix 2) ----------------------------------------

test("SessionRouter persists state.json atomically, recovers corrupt state, and retries session/new", async t => {
  const dir = await withTempDir(t);
  const statePath = path.join(dir, "state.json");

  assert.equal(sessionKey(makeInbound()), "telegram:dm:100");
  assert.equal(
    sessionKey(makeInbound({ chat_type: "group", thread_id: "t9" })),
    "telegram:group:100:t9",
  );

  let attempts = 0;
  const flakyWorker = {
    async request(method) {
      assert.equal(method, "session/new");
      attempts += 1;
      if (attempts === 1) throw new Error("transient glitch");
      return { session_id: "sess-1" };
    },
  };

  const router = new SessionRouter(statePath);
  const rec = await router.ensureSession("telegram:dm:100", flakyWorker, dir);
  assert.equal(rec.session_id, "sess-1");
  assert.equal(attempts, 2);
  assert.equal(router.updateCursor("telegram:dm:100", 5), true);
  assert.equal(router.updateCursor("telegram:dm:100", 3), false);

  // Reload from persisted state.json
  const router2 = new SessionRouter(statePath);
  assert.deepEqual(router2.lookup("telegram:dm:100"), {
    session_id: "sess-1",
    cursor: 5,
  });

  // Corrupt state.json is backed up to state.json.corrupt
  await writeFile(statePath, "{not-valid-json", "utf8");
  const router3 = new SessionRouter(statePath);
  assert.equal(router3.lookup("telegram:dm:100"), undefined);
  assert.equal(fs.existsSync(`${statePath}.corrupt`), true);

  // Double failure raises SessionCreateError
  await assert.rejects(
    () =>
      router3.createSession(
        "telegram:dm:200",
        {
          async request() {
            throw new Error("down");
          },
        },
        dir,
      ),
    SessionCreateError,
  );
});

test("SecurityGate, CooldownGate, isAddressedToBot, and BUG FIX 2 live pairing.json reload", async t => {
  const dir = await withTempDir(t);
  const pairingPath = path.join(dir, "pairing.json");

  assert.equal(isAddressedToBot(makeInbound({ text: "yo @Rind!" }), ["rind"]), true);
  assert.equal(isAddressedToBot(makeInbound({ text: "(@bot,)" }), ["bot"]), true);
  assert.equal(isAddressedToBot(makeInbound({ text: "hi @rind，please check" })), true);
  assert.equal(isAddressedToBot(makeInbound({ text: "（@BOT）：run tests" })), true);
  assert.equal(
    isAddressedToBot(makeInbound({ text: "email me at a@b.com" }), ["rind", "bot"]),
    false,
  );
  assert.equal(isAddressedToBot(makeInbound({ text: "hello everyone" })), false);
  assert.equal(APPROVE_COMMAND, "rind gateway approve {code}");

  const livePairing = new PairingStore(pairingPath);
  const gate = new SecurityGate({
    pairing: livePairing,
    cooldown: new CooldownGate(2),
    allowFrom: { telegram: ["allowed-user"] },
    groupAllow: { telegram: ["grp-1"] },
    pairingEnabled: true,
    pairingTtlSeconds: 3600,
  });

  // Unknown DM user receives pairing notice referencing `rind gateway approve <CODE>`
  const unknownMsg = makeInbound({ sender_id: "new-user" });
  const v1 = gate.admit(unknownMsg);
  assert.equal(v1.allow, false);
  assert.equal(v1.pairing, true);
  assert.match(v1.notice, /rind gateway approve [A-Z2-9]{6}/);
  const codeMatch = /pairing code: `([A-Z2-9]{6})`/.exec(v1.notice);
  assert.ok(codeMatch);
  const code = codeMatch[1];

  // BUG FIX 2: Out-of-process CLI approval updates pairing.json; live gate reloads immediately!
  const cliPairing = new PairingStore(pairingPath);
  assert.equal(cliPairing.approve(code), true);
  assert.equal(cliPairing.approve(code), false); // one-time use

  const vAfterApprove = gate.admit(unknownMsg);
  assert.equal(vAfterApprove.allow, true);

  // Cooldown triggers on 3rd message within 60s (limit = 2), notice once
  assert.equal(gate.admit(unknownMsg).allow, true);
  const vCool1 = gate.admit(unknownMsg);
  assert.equal(vCool1.allow, false);
  assert.equal(vCool1.notice, COOLDOWN_NOTICE);
  const vCool2 = gate.admit(unknownMsg);
  assert.equal(vCool2.allow, false);
  assert.equal(vCool2.notice, "");

  // Group requires both group_allow AND @rind/@bot mention
  assert.equal(
    gate.admit(
      makeInbound({ chat_type: "group", chat_id: "grp-1", text: "no mention" }),
    ).allow,
    false,
  );
  assert.equal(
    gate.admit(
      makeInbound({ chat_type: "group", chat_id: "grp-1", sender_id: "guser", text: "@rind hi" }),
    ).allow,
    true,
  );

  // Pairing pending cap = 3
  for (const id of ["p1", "p2", "p3"]) {
    const res = gate.admit(makeInbound({ sender_id: id }));
    assert.match(res.notice, /pairing code:/);
  }
  const fourth = gate.admit(makeInbound({ sender_id: "p4" }));
  assert.equal(fourth.notice, PAIRING_FULL_NOTICE);
});

// --- 4. Reactions (Bug Fix 3), Commands & Outbound ---------------------------

test("ReactionController state machine and BUG FIX 3 event.tool_name emoji classification", async () => {
  assert.equal(toolEmoji("run_command"), "💻");
  assert.equal(toolEmoji("search_web"), "🌐");
  assert.equal(toolEmoji("plan"), "📋");
  assert.equal(toolEmoji("custom_tool"), "🛠️");

  const seen = [];
  let nowSec = 100;
  const rc = new ReactionController({
    react: async (_pos, emoji) => {
      seen.push(emoji);
    },
    clock: () => nowSec,
    debounceSeconds: 0.01,
    stallWarnSeconds: 10,
    staleWarnSeconds: 30,
    stallScanSeconds: 100, // manual scan in test
    holdSeconds: 0.03,
  });

  const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
  const pos = ["telegram", { chat_id: "100" }];
  await rc.queued(pos);
  await settle();
  await rc.onEvent(pos, { type: "turn_started" });
  await settle();
  // BUG FIX 3: protocol emits `tool_name` (not `tool`)
  await rc.onEvent(pos, { type: "tool_requested", tool_name: "run_command" });
  await settle();

  await rc.onEvent(pos, { type: "turn_completed" });
  assert.deepEqual(seen, ["👀", "🧠", "💻", "✅"]);

  // Queueing a new turn during terminal hold defers 👀 until hold expires
  await rc.queued(pos);
  assert.deepEqual(seen, ["👀", "🧠", "💻", "✅"]);
  await waitUntil(() => seen.length === 5, 1000, "deferred queued emoji");
  assert.equal(seen[4], "👀");
  await rc.cancel(pos);

  // Rapid intermediates debounce to the final one, and stall warnings fire at 10s / 30s
  seen.length = 0;
  await rc.onEvent(pos, { type: "turn_started" });
  await rc.onEvent(pos, { type: "tool_requested", tool_name: "run_command" });
  await rc.onEvent(pos, { type: "tool_requested", tool_name: "search_web" });
  await settle();
  assert.deepEqual(seen, ["🌐"]);

  nowSec += 11;
  rc.checkStalls();
  await settle(10);
  assert.deepEqual(seen, ["🌐", "⏳"]);

  nowSec += 20;
  rc.checkStalls();
  await settle(10);
  assert.deepEqual(seen, ["🌐", "⏳", "⚠️"]);
  await rc.aclose();
});

test("Outbound serializes stopTyping after in-flight typing and stops on 2 failures", async () => {
  let resolveInFlight;
  let inFlightDone = false;
  const ch = new RecordingChannel("telegram");
  ch.typing = () =>
    new Promise(resolve => {
      resolveInFlight = () => {
        inFlightDone = true;
        resolve();
      };
    });

  const outbound = new Outbound(
    { telegram: ch },
    { typingResendSeconds: 0.02, typingTtlSeconds: 5, typingFailureLimit: 2 },
  );
  outbound.startTyping("k1", "telegram", { chat_id: "1" });
  await waitUntil(() => Boolean(resolveInFlight), 500, "typing started");

  const stopPromise = outbound.stopTyping("k1");
  let stopped = false;
  void stopPromise.then(() => {
    stopped = true;
  });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(stopped, false, "stopTyping must wait for in-flight typing call");
  resolveInFlight();
  await stopPromise;
  assert.equal(inFlightDone, true);

  // 2-failure tripwire halts typing loop
  let failCalls = 0;
  const failingCh = new RecordingChannel("telegram");
  failingCh.typing = async () => {
    failCalls += 1;
    throw new Error("network error");
  };
  const outbound2 = new Outbound(
    { telegram: failingCh },
    { typingResendSeconds: 0.01, typingTtlSeconds: 5, typingFailureLimit: 2 },
  );
  outbound2.startTyping("k2", "telegram", { chat_id: "1" });
  await waitUntil(() => failCalls >= 2, 500, "2 typing failures");
  await new Promise(r => setTimeout(r, 40));
  assert.equal(failCalls, 2);
  await outbound2.stopTyping("k2");
});

test("CommandHub dispatches /help, /status, /compact, /stop, /new, and unknown commands", async () => {
  const calls = [];
  let active = "sess-active";
  const sessions = { "telegram:dm:1": { session_id: "sess-active", cursor: 2 } };
  const worker = {
    connected: true,
    async request(method, params) {
      calls.push([method, params]);
      return { ok: true };
    },
    async subscribe(sid) {
      calls.push(["subscribe", sid]);
    },
  };
  const router = {
    lookup: k => sessions[k],
    allSessions: () => sessions,
    createSession: async k => {
      const rec = { session_id: "sess-new12345", cursor: 0 };
      sessions[k] = rec;
      return rec;
    },
  };
  const hub = new CommandHub({
    workerGetter: () => worker,
    router,
    links: {
      activeSession: () => active,
      finishTurn: async () => {
        active = null;
      },
      queueDepth: () => 0,
      bindTarget: (sid, pos) => calls.push(["bind", sid, pos]),
    },
    workspaceRoot: "/ws",
  });
  const ctx = {
    channel_id: "telegram",
    target: { chat_id: "1" },
    message: makeInbound(),
    key: "telegram:dm:1",
  };

  assert.match(await hub.dispatch("/help", ctx), /\/stop/);
  assert.match(await hub.dispatch("/status", ctx), /task: running/);
  assert.equal(await hub.dispatch("/compact", ctx), "Context compaction requested");
  assert.equal(await hub.dispatch("/stop", ctx), "Stopped");
  assert.equal(active, null);
  assert.equal(await hub.dispatch("/stop", ctx), null); // idle /stop is silent
  assert.match(await hub.dispatch("/new", ctx), /New session started \(session sess-new\)/);
  assert.match(await hub.dispatch("/wat", ctx), /Unknown command/);
});

// --- 5. Transports, WorkerClient & TurnPump (Bug Fix 1 & Bug Fix 5) ----------

test("StdioTransport drains cleanly on EOF and force-kills hung worker on timeout", async () => {
  // Clean exit 0 on stdin EOF
  const cleanScript = `
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ kind: "event", bye: true }) + "\\n");
      process.exit(0);
    });
    process.stdin.resume();
  `;
  const tClean = new StdioTransport([process.execPath, "-e", cleanScript], {
    shutdownTimeoutSeconds: 2,
  });
  await tClean.open();
  await tClean.close();

  // Non-zero exit code raises during close()
  const badExitScript = `
    process.stdin.on("end", () => process.exit(3));
    process.stdin.resume();
  `;
  const tBad = new StdioTransport([process.execPath, "-e", badExitScript], {
    shutdownTimeoutSeconds: 2,
  });
  await tBad.open();
  await assert.rejects(() => tBad.close(), /code 3/);

  // Hung child ignoring EOF is force-killed after shutdownTimeoutSeconds
  const hungScript = `
    setInterval(() => {}, 10000);
    process.stdin.resume();
  `;
  const tHung = new StdioTransport([process.execPath, "-e", hungScript], {
    shutdownTimeoutSeconds: 0.15,
  });
  await tHung.open();
  await assert.rejects(() => tHung.close(), /shutdown timed out/);
});

test("WorkerClient enforces capability gate and replays missed events across reconnect without duplicates", async () => {
  const outdated = new FakeWorker({ capabilities: ["sessions"] });
  const badClient = new WorkerClient("ws://fake", null, {
    transport: new MemoryTransport(outdated),
  });
  await assert.rejects(() => badClient.start(), /rind\/session-subscriptions/);

  const worker = new FakeWorker();
  const sid = worker.newSession();
  let cursor = 0;
  const received = [];
  const client = new WorkerClient("ws://fake", null, {
    transport: new MemoryTransport(worker),
    cursorProvider: () => cursor,
    reconnectInitialSeconds: 0.02,
    reconnectMaxSeconds: 0.05,
  });
  client.onEvent(async (env, replayed) => {
    received.push({ type: env.event.type, seq: env.sequence, replayed });
    if (env.durability === "durable" && typeof env.sequence === "number") {
      cursor = Math.max(cursor, env.sequence);
    }
  });

  await client.start();
  await client.subscribe(sid);
  worker.pushEvent(sid, { type: "turn_started" });
  await waitUntil(() => cursor === 1, 1000, "first live event");

  // Drop connection, emit durable events while disconnected, and verify catch-up replay!
  worker.dropConnections();
  worker.pushEvent(sid, {
    type: "assistant_message_completed",
    content: "missed while offline",
  });
  worker.pushEvent(sid, { type: "turn_completed" });

  await waitUntil(() => client.connected && cursor >= 3, 2000, "reconnect catch-up");
  await client.stop();

  const types = received.map(r => r.type);
  assert.deepEqual(types, [
    "turn_started",
    "assistant_message_completed",
    "turn_completed",
  ]);
  assert.equal(received[1].replayed, true);
  assert.equal(received[2].replayed, true);
});

test("TurnPump end-to-end: turns, follow-up, BUG FIX 1 hyphenated question respond, BUG FIX 5 attachment refs, and offline queue", async t => {
  assert.equal(RuntimeMethod.RIND_USER_QUESTION_RESPOND, "rind/user-question/respond");

  const ws = await withTempDir(t);
  const runtimeDir = path.join(ws, ".rind");
  await mkdir(runtimeDir, { recursive: true });

  // Verify BUG FIX 5 helper directly first
  const winUpload = path.join(ws, "uploads", "telegram", "20261111", "screen.png");
  assert.equal(
    formatAttachmentPromptRef(winUpload, ws),
    "uploads/telegram/20261111/screen.png",
  );
  assert.equal(
    buildPromptText(
      "",
      [{ path: winUpload, content_type: "image/png", kind: "image" }],
      ws,
    ),
    "uploads/telegram/20261111/screen.png",
  );

  const fakeWorker = new FakeWorker();
  const router = new SessionRouter(path.join(runtimeDir, "state.json"));
  const client = new WorkerClient("ws://fake", null, {
    transport: new MemoryTransport(fakeWorker),
    cursorProvider: sid => {
      const k = router.keyForSession(sid);
      return k ? router.cursorFor(k) : 0;
    },
    reconnectInitialSeconds: 0.02,
    reconnectMaxSeconds: 0.05,
  });
  const security = new SecurityGate({
    pairing: new PairingStore(path.join(runtimeDir, "pairing.json")),
    cooldown: new CooldownGate(100),
    allowFrom: { telegram: ["u1"] },
  });
  let clockNow = 1000;
  const pump = new TurnPump({
    worker: client,
    router,
    security,
    workspaceRoot: ws,
    clock: () => clockNow,
    questionTtl: 300,
  });
  const channel = new RecordingChannel("telegram", { supports_buttons: true });
  pump.registerChannel(channel);
  await client.start();

  // 1. Image-only message (empty text + attachment) starts a turn with POSIX uploads/... ref!
  const turn1Task = pump.inbound(
    makeInbound({
      message_ref: "img-only-1",
      text: "",
      attachments: [{ path: winUpload, content_type: "image/png", kind: "image" }],
    }),
  );
  await waitUntil(() => fakeWorker.prompts.length === 1, 1000, "image prompt dispatched");
  const [sid, promptInput] = fakeWorker.prompts[0];
  assert.equal(promptInput, "uploads/telegram/20261111/screen.png");

  // 2. Duplicate message_ref is ignored
  await pump.inbound(makeInbound({ message_ref: "img-only-1", text: "dup" }));
  assert.equal(fakeWorker.prompts.length, 1);

  // 3. Follow-up while turn is active routes to rind/session/follow_up
  await pump.inbound(makeInbound({ message_ref: "fu-1", text: "also check logs" }));
  assert.deepEqual(fakeWorker.followUps, [[sid, "also check logs"]]);

  // 4. BUG FIX 1: user_question_requested -> numeric answer sends `rind/user-question/respond`
  fakeWorker.pushEvent(sid, {
    type: "user_question_requested",
    tool_call_id: "tc-ask-1",
    question: "Which environment?",
    options: ["staging", "production"],
  });
  await waitUntil(
    () => channel.sent.some(s => s.payload.text === "Which environment?"),
    1000,
    "question sent with buttons",
  );
  const questionMsg = channel.sent.find(s => s.payload.text === "Which environment?");
  assert.deepEqual(questionMsg.payload.choices, ["staging", "production"]);

  await pump.inbound(makeInbound({ message_ref: "ans-1", text: "2" }));
  assert.deepEqual(fakeWorker.answers, [[sid, "tc-ask-1", "production"]]);

  // Complete turn and check assistant reply + persisted cursor
  fakeWorker.pushEvent(sid, {
    type: "assistant_message_completed",
    content: "**Done** deploying!",
  });
  fakeWorker.pushEvent(sid, { type: "turn_completed" });
  await turn1Task;
  await waitUntil(
    () =>
      pump.activeSession("telegram:dm:100") === null &&
      channel.sent.some(s => s.payload.text.includes("Done deploying!")),
    1000,
    "assistant reply delivered and turn 1 finished",
  );
  assert.ok(router.cursorFor("telegram:dm:100") >= 2);

  // 5. Question expiry with timeout option auto-selects it; without timeout sends QUESTION_EXPIRED_REPLY
  const turn2Task = pump.inbound(makeInbound({ message_ref: "t2", text: "next turn" }));
  await waitUntil(() => fakeWorker.prompts.length === 2, 1000, "second turn");
  fakeWorker.pushEvent(sid, {
    type: "user_question_requested",
    tool_call_id: "tc-exp",
    question: "Confirm?",
    options: ["yes", "no"],
  });
  await waitUntil(
    () => channel.sent.some(s => s.payload.text === "Confirm?"),
    1000,
    "second question",
  );
  clockNow += 301;
  await pump.expireQuestions();
  assert.ok(channel.sent.some(s => s.payload.text === QUESTION_EXPIRED_REPLY));
  fakeWorker.pushEvent(sid, { type: "turn_completed" });
  await turn2Task;
  await waitUntil(() => pump.activeSession("telegram:dm:100") === null, 1000, "turn 2 done");

  await client.stop();

  // 6. Offline command gets OFFLINE_NOTICE while queued
  await pump.inbound(makeInbound({ message_ref: "off-cmd", text: "/status" }));
  assert.ok(channel.sent.some(s => s.payload.text === OFFLINE_NOTICE));
});

// --- 6. CLI, Onboarding, Probes, Doctor & Status (Bug Fix 6) -----------------

test("onboarding guides match channel registry and config schema", () => {
  const loaderIds = Object.keys(LOADERS).sort();
  const guideIds = Object.keys(GUIDES).sort();
  assert.deepEqual(guideIds, loaderIds);

  for (const guide of allGuides()) {
    assert.ok(guide.label && guide.emoji && guide.summary, guide.id);
    assert.ok(guide.setup_steps.length > 0, guide.id);
    assert.equal(typeof guide.probe, "function", guide.id);
    const allowed = new Set(["token", ...(CHANNEL_EXTRA_KEYS[guide.id] ?? [])]);
    for (const spec of guide.fields) {
      assert.ok(
        allowed.has(spec.name),
        `${guide.id}.${spec.name} missing from CHANNEL_EXTRA_KEYS`,
      );
    }
  }
  assert.ok(GUIDES.feishu.scopes.some(s => s.includes("im:message.p2p.msg:readonly")));
  assert.ok(GUIDES.slack.scopes.some(s => s.includes("connections:write")));
});

test("probes and Telegram sender discovery work offline via probe hooks", async t => {
  const captured = {};
  setProbeHooks({
    getJson: async (url, _headers, proxy) => {
      captured.url = url;
      captured.proxy = proxy;
      if (url.includes("getMe")) {
        if (url.includes("bad")) return [401, { ok: false }];
        if (url.includes("timeout")) throw new Error("request timed out");
        return [200, { ok: true, result: { username: "rind_test_bot" } }];
      }
      if (url.includes("getUpdates")) {
        return [
          200,
          {
            result: [
              { update_id: 1, message: { from: { id: 111, username: "alice" } } },
              { update_id: 2, message: { from: { id: 222 } } },
            ],
          },
        ];
      }
      return [200, {}];
    },
    postJson: async () => [200, { code: 10003, msg: "invalid app_id" }],
  });
  t.after(() => setProbeHooks(null));

  const tgOk = await GUIDES.telegram.probe({
    token: "good",
    proxy: "http://127.0.0.1:7890",
  });
  assert.equal(tgOk.ok, true);
  assert.match(tgOk.detail, /@rind_test_bot/);
  assert.equal(captured.proxy, "http://127.0.0.1:7890");

  const tgTimeout = await GUIDES.telegram.probe({ token: "timeout" });
  assert.equal(tgTimeout.ok, false);
  assert.match(tgTimeout.detail, /Connection timed out/);
  assert.match(tgTimeout.detail, /proxy/);

  const feishuErr = await GUIDES.feishu.probe({ app_id: "a", app_secret: "s" });
  assert.equal(feishuErr.ok, false);
  assert.match(feishuErr.detail, /10003/);

  const senders = await discoverTelegram({ token: "good" }, 1.0, {
    sleepMs: async () => {},
  });
  assert.deepEqual(senders, ["111 (@alice)", "222"]);
});

test("gatewayMain CLI: --help, init --yes, interactive init, approve, doctor --fix, and BUG FIX 6 status", async t => {
  const root = await withTempDir(t);
  const ws = path.join(root, "workspace");
  await mkdir(ws, { recursive: true });

  // 1. --help
  const helpOut = [];
  assert.equal(await gatewayMain(["--help"], { stdout: l => helpOut.push(l) }), 0);
  assert.match(helpOut.join("\n"), /rind gateway/);

  // 2. init --yes missing env reports RIND_GW_TELEGRAM_TOKEN
  const missingErr = [];
  assert.equal(
    await gatewayMain(["init", "--yes", "--channel", "telegram", "--workspace", ws], {
      env: {},
      stderr: l => missingErr.push(l),
    }),
    2,
  );
  assert.match(missingErr.join("\n"), /RIND_GW_TELEGRAM_TOKEN/);

  // 3. init --yes writes config with stdio worker & numeric ID quoted
  const initOut = [];
  const initErr = [];
  assert.equal(
    await gatewayMain(
      [
        "init",
        "--yes",
        "--channel",
        "telegram,unknown_chan",
        "--worker-url",
        "stdio",
        "--workspace",
        ws,
      ],
      {
        env: {
          RIND_GW_TELEGRAM_TOKEN: "123:ABC",
          RIND_GW_TELEGRAM_ALLOW_FROM: "987654",
        },
        stdout: l => initOut.push(l),
        stderr: l => initErr.push(l),
        workerAliveImpl: async w => workerAlive(w, null),
      },
    ),
    0,
  );
  assert.match(initErr.join("\n"), /unknown_chan/);
  const cfgPath = path.join(ws, ".rind", "gateway.yaml");
  assert.equal(fs.existsSync(cfgPath), true);
  const cfg = loadConfig(cfgPath, { env: {} });
  assert.equal(cfg.worker, "stdio");
  assert.deepEqual(cfg.channels.telegram.allow_from, ["987654"]);

  // 4. BUG FIX 6: `status --config <cfgPath>` from an unrelated workspace directory:
  //    - handles `worker: stdio` cleanly (returns 0 without opening WS "stdio")
  //    - reads `.rind/state.json` and `.rind/pairing.json` from `config.workspace`!
  const otherDir = path.join(root, "other-cwd");
  await mkdir(otherDir, { recursive: true });
  await writeFile(
    path.join(ws, ".rind", "state.json"),
    JSON.stringify({
      version: 1,
      sessions: { "telegram:dm:987654": { session_id: "sess-xyz", cursor: 9 } },
    }),
    "utf8",
  );
  const store = new PairingStore(path.join(ws, ".rind", "pairing.json"));
  const code = store.ensurePending("telegram", "55555", 3600);

  const statusOut = [];
  const statusExit = await gatewayMain(
    ["status", "--config", cfgPath, "--workspace", otherDir],
    { stdout: l => statusOut.push(l) },
  );
  assert.equal(statusExit, 0);
  const statusText = statusOut.join("\n");
  assert.match(statusText, /session mappings: 1/);
  assert.match(statusText, /sess-xyz \(cursor 9\)/);
  assert.match(statusText, /pairing: 1 pending, 0 approved/);
  assert.match(statusText, /stdio mode/);

  // 5. `approve` subcommand works and rejects reuse
  assert.equal(
    await gatewayMain(["--workspace", ws, "approve", code], { stdout: () => {} }),
    0,
  );
  assert.equal(
    await gatewayMain(["approve", code, "--workspace", ws], { stderr: () => {} }),
    1,
  );

  // 6. `doctor` detects corrupt state.json and `--fix` backs it up as .corrupt
  await writeFile(path.join(ws, ".rind", "state.json"), "{broken", "utf8");
  assert.equal(
    await gatewayMain(["doctor", "--config", cfgPath], {
      stdout: () => {},
      stderr: () => {},
    }),
    1,
  );
  assert.equal(
    await gatewayMain(["doctor", "--config", cfgPath, "--fix"], {
      stdout: () => {},
      stderr: () => {},
    }),
    0,
  );
  assert.equal(fs.existsSync(path.join(ws, ".rind", "state.json.corrupt")), true);

  // 7. Interactive wizard via piped stdin + source-dir detection
  const fakeRepo = path.join(root, "fake-repo");
  await mkdir(path.join(fakeRepo, "runtime", "src"), { recursive: true });
  await mkdir(path.join(fakeRepo, "frontend-cli"), { recursive: true });
  await writeFile(path.join(fakeRepo, "runtime", "src", "cli.ts"), "// cli", "utf8");
  assert.equal(looksLikeSourceDir(fakeRepo), true);
  assert.equal(looksLikeSourceDir(ws), false);

  const wsInteractive = path.join(root, "ws-interactive");
  await mkdir(wsInteractive, { recursive: true });
  const wizardStdin =
    [
      "7", // 7th sorted guide = telegram
      "stdio",
      wsInteractive,
      "", // worker token
      "999:TOK", // telegram token
      "", // proxy
      "42", // allow_from
      "", // group_allow
      "n", // probe
      "n", // discover
      "y", // write
      "n", // start now
    ].join("\n") + "\n";
  assert.equal(
    await gatewayMain(["init"], {
      env: {},
      stdin: wizardStdin,
      stdout: () => {},
      stderr: () => {},
    }),
    0,
  );
  assert.equal(fs.existsSync(path.join(wsInteractive, ".rind", "gateway.yaml")), true);

  // 8. Missing config offers wizard, cancels cleanly on EOF, and shares stream buffer on "Y\n..."
  const emptyWs = path.join(root, "empty-ws");
  await mkdir(emptyWs, { recursive: true });
  const offerOut = [];
  assert.equal(
    await gatewayMain(["--workspace", emptyWs], {
      stdin: Readable.from(["Y\n"]),
      stdout: l => offerOut.push(l),
      stderr: () => {},
    }),
    1,
  );
  assert.match(offerOut.join("\n"), /Cancelled/);

  const streamWs = path.join(root, "stream-ws");
  await mkdir(streamWs, { recursive: true });
  assert.equal(
    await gatewayMain(["--workspace", streamWs], {
      env: {},
      stdin: Readable.from(["Y\n" + wizardStdin.replace(wsInteractive, streamWs)]),
      stdout: () => {},
      stderr: () => {},
    }),
    0,
  );
  assert.equal(fs.existsSync(path.join(streamWs, ".rind", "gateway.yaml")), true);
});

test("runGateway wires worker, router, security, channel, and shuts down cleanly on abort", async t => {
  const ws = await withTempDir(t);
  const runtimeDir = path.join(ws, ".rind");
  await mkdir(runtimeDir, { recursive: true });

  const fakeWorker = new FakeWorker();
  const channel = new RecordingChannel("telegram");
  const config = buildConfig({
    worker: "ws://127.0.0.1:8765",
    workspace: ws,
    channels: {
      telegram: { token: "t", allow_from: ["u1"] },
    },
  });

  const ac = new AbortController();
  const runPromise = runGateway(
    config,
    runtimeDir,
    new PairingStore(path.join(runtimeDir, "pairing.json")),
    {
      transport: new MemoryTransport(fakeWorker),
      registryOptions: {
        loaders: {
          telegram: async () => ({
            buildChannel: () => channel,
          }),
        },
      },
      signal: ac.signal,
    },
  );

  await waitUntil(() => channel.started, 1000, "channel started");
  const msgPromise = channel.sink.inbound(
    makeInbound({ message_ref: "rg-1", text: "ping gateway" }),
  );
  await waitUntil(() => fakeWorker.prompts.length === 1, 1000, "worker received prompt");
  const [sid] = fakeWorker.prompts[0];
  fakeWorker.pushEvent(sid, {
    type: "assistant_message_completed",
    content: "pong from worker",
  });
  fakeWorker.pushEvent(sid, { type: "turn_completed" });
  await msgPromise;
  await waitUntil(() => channel.sent.length === 1, 1000, "reply sent");
  assert.match(channel.sent[0].payload.text, /pong from worker/);

  ac.abort();
  assert.equal(await runPromise, 0);
  assert.equal(channel.started, false);

  // Also check WebSocketTransport ?token= query handling with fake WebSocket
  const openedUrls = [];
  const fakeWsTransport = new WebSocketTransport("ws://127.0.0.1:8765?token=abc", {
    wsFactory: url => {
      openedUrls.push(url);
      const listeners = new Map();
      queueMicrotask(() => {
        for (const fn of listeners.get("open") ?? []) fn({});
      });
      return {
        readyState: 1,
        send() {},
        close() {
          for (const fn of listeners.get("close") ?? []) fn({});
        },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
      };
    },
  });
  await fakeWsTransport.open();
  assert.deepEqual(openedUrls, ["ws://127.0.0.1:8765?token=abc"]);
  await fakeWsTransport.close();

  // Verify runChecks reports clean config
  await writeFile(
    path.join(runtimeDir, "gateway.yaml"),
    renderYaml({ worker: "stdio", workspace: ws, channels: { telegram: { token: "t" } } }),
    "utf8",
  );
  const checks = await runChecks(null, ws);
  assert.equal(checks.every(c => c.ok === true), true);
});
