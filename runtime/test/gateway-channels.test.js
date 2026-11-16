import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocket as UndiciWebSocket } from "undici";

import {
  LOADERS,
  buildChannel as buildRegisteredChannel,
} from "../dist/gateway/channels/index.js";
import { getProxyDispatcher } from "../dist/gateway/channels/http-ws-utils.js";
import * as telegram from "../dist/gateway/channels/telegram.js";
import * as discord from "../dist/gateway/channels/discord.js";
import * as slack from "../dist/gateway/channels/slack.js";
import * as qq from "../dist/gateway/channels/qq.js";
import * as dingtalk from "../dist/gateway/channels/dingtalk.js";
import * as wecom from "../dist/gateway/channels/wecom.js";
import * as whatsapp from "../dist/gateway/channels/whatsapp-cloud.js";
import * as feishu from "../dist/gateway/channels/feishu.js";
import * as email from "../dist/gateway/channels/email-channel.js";

async function withTempDir(t, prefix = "rind-gw-chan-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

function makeConfig(id, { token = "", extra = {} } = {}) {
  return {
    id,
    token,
    allow_from: [],
    group_allow: [],
    extra,
  };
}

class RecordingSink {
  constructor() {
    this.messages = [];
  }
  async inbound(msg) {
    this.messages.push(msg);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bytesResponse(bytes, status = 200, contentType = "application/octet-stream") {
  return new Response(bytes, {
    status,
    headers: { "Content-Type": contentType },
  });
}

class FakeWs {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.emit("open", {});
      }
    });
  }

  send(data) {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn(event);
    }
  }

  pushJson(obj) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

// --- 0. Channel Registry -----------------------------------------------------

test("channels registry registers all 9 channels and isolates invalid/unknown configs", async t => {
  const dir = await withTempDir(t);
  assert.deepEqual(Object.keys(LOADERS).sort(), [
    "dingtalk",
    "discord",
    "email",
    "feishu",
    "qq",
    "slack",
    "telegram",
    "wecom",
    "whatsapp",
  ]);

  const logs = [];
  const unknown = await buildRegisteredChannel("icq", makeConfig("icq"), dir, {
    logger: m => logs.push(m),
  });
  assert.equal(unknown, null);
  assert.match(logs[0], /no adapter installed/);

  const badTelegram = await buildRegisteredChannel(
    "telegram",
    makeConfig("telegram", { token: "" }),
    dir,
    { logger: m => logs.push(m) },
  );
  assert.equal(badTelegram, null);
  assert.match(logs[1], /telegram failed to start/);
});

// --- 1. Telegram -------------------------------------------------------------

test("TelegramChannel: long-polling, ans:<idx> callback, media <=20MB / >20MB notice, buttons, reactions, and proxy", async t => {
  const dir = await withTempDir(t);
  assert.ok(getProxyDispatcher("http://127.0.0.1:7890"));
  assert.equal(getProxyDispatcher(""), undefined);

  const apiCalls = [];
  let updateBatches = [
    [
      {
        update_id: 100,
        message: {
          message_id: 50,
          chat: { id: 9001, type: "private" },
          from: { id: 42, first_name: "Ada", last_name: "Lovelace" },
          caption: "look at this",
          photo: [
            { file_id: "small", width: 50, height: 50, file_size: 10 },
            { file_id: "big", width: 200, height: 200, file_size: 12 },
          ],
        },
      },
      {
        update_id: 101,
        callback_query: {
          id: "cbq-1",
          data: "ans:1",
          from: { id: 42, username: "ada" },
          message: { chat: { id: 9001, type: "private" } },
        },
      },
      {
        update_id: 102,
        message: {
          message_id: 51,
          chat: { id: 9001, type: "private" },
          from: { id: 42, username: "ada" },
          document: {
            file_id: "huge_doc",
            file_size: 21 * 1024 * 1024,
            mime_type: "application/pdf",
            file_name: "huge.pdf",
          },
        },
      },
    ],
  ];

  const fetchImpl = async (input, init) => {
    const url = String(input);
    apiCalls.push({ url, init });
    if (url.includes("/file/bot")) {
      return bytesResponse(Buffer.from("jpeg-bytes"), 200, "image/jpeg");
    }
    if (url.endsWith("/getUpdates")) {
      const next = updateBatches.shift() ?? [];
      if (next.length === 0) {
        await new Promise(r => setTimeout(r, 40));
      }
      return jsonResponse({ ok: true, result: next });
    }
    if (url.endsWith("/getFile")) {
      return jsonResponse({ ok: true, result: { file_path: "photos/big.jpg" } });
    }
    if (url.endsWith("/sendMessage")) {
      return jsonResponse({ ok: true, result: { message_id: 777 } });
    }
    return jsonResponse({ ok: true, result: true });
  };

  const ch = telegram.buildChannel(
    makeConfig("telegram", { token: "123:TOK" }),
    path.join(dir, "uploads"),
    { fetchImpl, longPollSeconds: 1, pollErrorPauseSeconds: 0.05 },
  );
  const sink = new RecordingSink();
  await ch.start(sink);

  await waitUntil(() => sink.messages.length === 3, 2000, "3 telegram inbound messages");

  // 1. Photo message downloaded largest photo
  assert.equal(sink.messages[0].sender_name, "Ada Lovelace");
  assert.equal(sink.messages[0].text, "look at this");
  assert.equal(sink.messages[0].attachments.length, 1);
  assert.equal(
    fs.readFileSync(sink.messages[0].attachments[0].path, "utf8"),
    "jpeg-bytes",
  );

  // 2. Callback query ans:1 -> "2" and answered callback
  assert.equal(sink.messages[1].text, "2");
  assert.ok(apiCalls.some(c => c.url.endsWith("/answerCallbackQuery")));

  // 3. Oversize document dropped and OVERSIZE_NOTICE sent
  assert.equal(sink.messages[2].attachments.length, 0);
  assert.ok(
    apiCalls.some(
      c => c.url.endsWith("/sendMessage") && String(c.init?.body ?? "").includes("20MB"),
    ),
  );

  // Outbound buttons, photo FormData, typing, and reaction
  const outImg = path.join(dir, "reply.png");
  await writeFile(outImg, Buffer.from("png"), "utf8");
  await ch.send(
    { chat_id: "9001" },
    {
      text: "Choose one",
      choices: ["Alpha", "Beta"],
      attachments: [{ path: outImg, content_type: "image/png", kind: "image" }],
    },
  );
  await ch.typing({ chat_id: "9001" });
  await ch.react({ chat_id: "9001" }, "✅");
  await ch.stop();

  const sendMsgCall = apiCalls.find(
    c =>
      c.url.endsWith("/sendMessage") &&
      String(c.init?.body ?? "").includes("inline_keyboard"),
  );
  assert.ok(sendMsgCall);
  assert.ok(apiCalls.some(c => c.url.endsWith("/sendPhoto")));
  assert.ok(apiCalls.some(c => c.url.endsWith("/sendChatAction")));
  const reactCall = apiCalls.find(c => c.url.endsWith("/setMessageReaction"));
  assert.ok(reactCall);
  assert.deepEqual(JSON.parse(String(reactCall.init?.body ?? "{}")).reaction, [
    { type: "emoji", emoji: "✅" },
  ]);
});

// --- 2. Discord --------------------------------------------------------------

test("DiscordChannel: Gateway v10 Hello/Heartbeat/Identify/Resume, bot filter, DM/thread, and REST FormData", async t => {
  const dir = await withTempDir(t);
  const sockets = [];
  const restCalls = [];

  const ch = discord.buildChannel(
    makeConfig("discord", { token: "disc-tok" }),
    path.join(dir, "uploads"),
    {
      heartbeatJitter: 0,
      reconnectDelayMs: 20,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        restCalls.push({ url: u, init });
        if (u.startsWith("https://cdn.discord.test/")) {
          return bytesResponse(Buffer.from("png-data"), 200, "image/png");
        }
        return jsonResponse({ id: "out-1" });
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  await waitUntil(() => sockets.length === 1 && sockets[0].readyState === 1, 500, "ws1 open");

  // Send Op 10 Hello -> expect Op 2 Identify with intents 37377 + Op 1 Heartbeat
  sockets[0].pushJson({ op: 10, d: { heartbeat_interval: 5000 } });
  await waitUntil(() => sockets[0].sent.length >= 2, 500, "identify + heartbeat");
  const frames1 = sockets[0].sent.map(s => JSON.parse(s));
  const identify = frames1.find(f => f.op === 2);
  assert.ok(identify);
  assert.equal(identify.d.intents, 37377);
  assert.ok(frames1.some(f => f.op === 1));

  // READY sets botUserId and resumeGatewayUrl
  sockets[0].pushJson({
    op: 0,
    t: "READY",
    s: 1,
    d: {
      user: { id: "bot-99" },
      session_id: "sess-d1",
      resume_gateway_url: "wss://resume.discord.test",
    },
  });

  // Bot's own message is ignored
  sockets[0].pushJson({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: {
      id: "m-self",
      channel_id: "c1",
      author: { id: "bot-99", bot: true, username: "rind" },
      content: "loop",
    },
  });

  // User DM with attachment
  sockets[0].pushJson({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: {
      id: "m-user",
      channel_id: "dm-77",
      author: { id: "u-1", global_name: "Grace" },
      content: "check attachment",
      attachments: [
        {
          filename: "pic.png",
          size: 8,
          content_type: "image/png",
          url: "https://cdn.discord.test/pic.png",
        },
      ],
    },
  });
  await waitUntil(() => sink.messages.length === 1, 1000, "discord DM delivered");
  assert.equal(sink.messages[0].chat_type, "dm");
  assert.equal(sink.messages[0].sender_name, "Grace");
  assert.equal(sink.messages[0].attachments.length, 1);

  // Drop socket -> reconnects to resume_gateway_url with Op 6 Resume!
  sockets[0].close(1006);
  await waitUntil(() => sockets.length === 2, 1000, "discord reconnect");
  assert.match(sockets[1].url, /resume\.discord\.test/);
  sockets[1].pushJson({ op: 10, d: { heartbeat_interval: 5000 } });
  await waitUntil(
    () => sockets[1].sent.some(s => JSON.parse(s).op === 6),
    500,
    "Op 6 Resume sent",
  );

  // Outbound send with text + file
  const fileOut = path.join(dir, "note.txt");
  await writeFile(fileOut, "hello", "utf8");
  await ch.send(
    { chat_id: "dm-77" },
    {
      text: "Here you go",
      attachments: [{ path: fileOut, content_type: "text/plain", kind: "document" }],
    },
  );
  assert.ok(restCalls.some(c => c.url.endsWith("/channels/dm-77/messages")));
  await ch.stop();
});

// --- 3. Slack ----------------------------------------------------------------

test("SlackChannel: Socket Mode envelope_id ack, disconnect reconnect, events_api, upload external, and reactions", async t => {
  const dir = await withTempDir(t);
  const sockets = [];
  const apiCalls = [];

  const ch = slack.buildChannel(
    makeConfig("slack", {
      extra: { app_token: "xapp-1-abc", bot_token: "xoxb-1-def" },
    }),
    path.join(dir, "uploads"),
    {
      reconnectDelayMs: 20,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        apiCalls.push({ url: u, init });
        if (u.endsWith("/apps.connections.open")) {
          return jsonResponse({ ok: true, url: "wss://wss.slack.test/link" });
        }
        if (u === "https://files.slack.test/private/a.png") {
          return bytesResponse(Buffer.from("slack-img"), 200, "image/png");
        }
        if (u.includes("/files.getUploadURLExternal")) {
          return jsonResponse({
            ok: true,
            upload_url: "https://upload.slack.test/put",
            file_id: "F123",
          });
        }
        if (u === "https://upload.slack.test/put") {
          return new Response("OK", { status: 200 });
        }
        if (u.endsWith("/chat.postMessage")) {
          return jsonResponse({ ok: true, ts: "1700000001.000100" });
        }
        return jsonResponse({ ok: true });
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  await waitUntil(() => sockets.length === 1 && sockets[0].readyState === 1, 500, "slack ws");

  sockets[0].pushJson({
    envelope_id: "env-1",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "D100",
        channel_type: "im",
        user: "U42",
        text: "hi slack",
        ts: "1700000000.000001",
        files: [
          {
            name: "a.png",
            size: 9,
            mimetype: "image/png",
            url_private_download: "https://files.slack.test/private/a.png",
          },
        ],
      },
    },
  });

  await waitUntil(() => sink.messages.length === 1, 1000, "slack inbound");
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { envelope_id: "env-1" });
  assert.equal(sink.messages[0].chat_type, "dm");
  assert.equal(sink.messages[0].attachments.length, 1);

  // `disconnect` frame triggers clean reconnect
  sockets[0].pushJson({ type: "disconnect", reason: "refresh_requested" });
  await waitUntil(() => sockets.length >= 2, 1000, "slack reconnect");

  // Outbound text + external upload + white_check_mark reaction
  const outDoc = path.join(dir, "report.txt");
  await writeFile(outDoc, "report", "utf8");
  await ch.send(
    { chat_id: "D100", thread_id: "1700000000.000001" },
    {
      text: "All green",
      attachments: [{ path: outDoc, content_type: "text/plain", kind: "document" }],
    },
  );
  await ch.react({ chat_id: "D100" }, "✅");
  await ch.stop();

  assert.ok(apiCalls.some(c => c.url.endsWith("/files.completeUploadExternal")));
  const reactCall = apiCalls.find(c => c.url.endsWith("/reactions.add"));
  assert.ok(reactCall);
  assert.equal(JSON.parse(String(reactCall.init.body)).name, "white_check_mark");
});

// --- 4. QQ (OneBot v11 Reverse WS Server) ------------------------------------

test("QQChannel: real reverse WS server, Bearer auth, CQ codes, get_image echo RPC, and send_private_msg", async t => {
  const dir = await withTempDir(t);
  const imgFile = path.join(dir, "qq-cat.jpg");
  await writeFile(imgFile, Buffer.from("qq-jpg"), "utf8");

  const ch = qq.buildChannel(
    makeConfig("qq", {
      extra: { ws_port: 0, ws_path: "/onebot/v11", access_token: "qq-secret" },
    }),
    path.join(dir, "uploads"),
    { wsHost: "127.0.0.1", wsPort: 0 },
  );
  const sink = new RecordingSink();
  await ch.start(sink);
  t.after(async () => {
    await ch.stop();
  });

  const port = ch.boundPort;
  assert.ok(port > 0);

  // Unauthorized HTTP upgrade rejected
  const badResp = await fetch(`http://127.0.0.1:${port}/onebot/v11`);
  assert.equal(badResp.status, 401);

  // Connect real WebSocket client with valid Bearer token
  const clientActions = [];
  const wsClient = new UndiciWebSocket(`ws://127.0.0.1:${port}/onebot/v11`, {
    headers: { Authorization: "Bearer qq-secret" },
  });
  await new Promise((resolve, reject) => {
    wsClient.addEventListener("open", () => resolve());
    wsClient.addEventListener("error", err => reject(err));
  });

  wsClient.addEventListener("message", ev => {
    const req = JSON.parse(String(ev.data));
    clientActions.push(req);
    if (req.action === "get_image") {
      wsClient.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { file: imgFile },
          echo: req.echo,
        }),
      );
    } else {
      wsClient.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { message_id: 99 },
          echo: req.echo,
        }),
      );
    }
  });

  // Group message with CQ code @bot + image token requiring get_image
  wsClient.send(
    JSON.stringify({
      post_type: "message",
      self_id: 88888,
      message_type: "group",
      group_id: 777,
      user_id: 12345,
      message_id: 501,
      sender: { card: "Bob" },
      message: "[CQ:at,qq=88888] analyze [CQ:image,file=cached_abc]",
    }),
  );

  await waitUntil(() => sink.messages.length === 1, 2000, "qq group message");
  assert.equal(sink.messages[0].chat_type, "group");
  assert.equal(sink.messages[0].text, "@rind analyze ");
  assert.equal(sink.messages[0].attachments.length, 1);

  // Private message -> send_private_msg reply
  wsClient.send(
    JSON.stringify({
      post_type: "message",
      self_id: 88888,
      message_type: "private",
      user_id: 12345,
      message_id: 502,
      sender: { nickname: "Bob" },
      message: [{ type: "text", data: { text: "ping" } }],
    }),
  );
  await waitUntil(() => sink.messages.length === 2, 2000, "qq dm message");

  await ch.send(
    { chat_id: "12345" },
    {
      text: "pong",
      attachments: [{ path: imgFile, content_type: "image/jpeg", kind: "image" }],
    },
  );
  const privSend = clientActions.find(a => a.action === "send_private_msg");
  assert.ok(privSend);
  assert.equal(privSend.params.user_id, 12345);

  wsClient.close();
  await ch.stop();
});

// --- 5. DingTalk -------------------------------------------------------------

test("DingTalkChannel: Stream Mode ping & CALLBACK acks, OAuth2 cache, and sampleMarkdown DM/group send", async t => {
  const dir = await withTempDir(t);
  const sockets = [];
  const httpCalls = [];
  let tokenFetches = 0;

  const ch = dingtalk.buildChannel(
    makeConfig("dingtalk", {
      extra: { client_id: "dt-id", client_secret: "dt-sec" },
    }),
    path.join(dir, "uploads"),
    {
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        httpCalls.push({ url: u, init });
        if (u.endsWith("/v1.0/gateway/connections/open")) {
          return jsonResponse({
            endpoint: "wss://stream.dingtalk.test/connect",
            ticket: "tk-1",
          });
        }
        if (u.endsWith("/v1.0/oauth2/accessToken")) {
          tokenFetches += 1;
          return jsonResponse({ accessToken: "dt-access-tok", expireIn: 7200 });
        }
        return jsonResponse({ processQueryKey: "ok" });
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  await waitUntil(() => sockets.length === 1 && sockets[0].readyState === 1, 500, "dt ws");
  assert.match(sockets[0].url, /ticket=tk-1/);

  // SYSTEM ping ack
  sockets[0].pushJson({
    type: "SYSTEM",
    headers: { topic: "ping", messageId: "sys-1" },
    data: JSON.stringify({ opaque: "123" }),
  });
  await waitUntil(() => sockets[0].sent.length >= 1, 500, "ping ack");
  const pingAck = JSON.parse(sockets[0].sent[0]);
  assert.equal(pingAck.code, 200);
  assert.equal(pingAck.headers.messageId, "sys-1");

  // CALLBACK inbound DM
  sockets[0].pushJson({
    type: "CALLBACK",
    headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-1" },
    data: JSON.stringify({
      conversationId: "cid-dm-1",
      conversationType: "1",
      senderStaffId: "staff-42",
      senderNick: "Lin",
      msgId: "msg-dt-1",
      text: { content: "deploy status" },
    }),
  });
  await waitUntil(() => sink.messages.length === 1, 1000, "dt callback");
  assert.equal(sink.messages[0].chat_type, "dm");
  assert.equal(sink.messages[0].sender_id, "staff-42");

  // Two sends reuse cached OAuth2 token; DM uses oToMessages/send, group uses groupMessages/send
  await ch.send({ chat_id: "cid-dm-1" }, { text: "First line\nBody" });
  await ch.send({ chat_id: "cid-group-9" }, { text: "Group reply" });
  assert.equal(tokenFetches, 1);
  assert.ok(httpCalls.some(c => c.url.includes("/oToMessages/batchSend") || c.url.includes("/oToMessages/send")));
  assert.ok(httpCalls.some(c => c.url.includes("/groupMessages/send")));
  await ch.stop();
});

// --- 6. WeCom ----------------------------------------------------------------

test("WeComChannel: AES-256-CBC PKCS#7 callback verify & XML decrypt, event ignore, media, and message/send", async t => {
  const dir = await withTempDir(t);
  const aesKey = Buffer.alloc(32, 7).toString("base64").slice(0, 43);
  const corpId = "ww_corp_123";
  const token = "wecom_tok";
  const apiCalls = [];

  const ch = wecom.buildChannel(
    makeConfig("wecom", {
      token,
      extra: {
        corp_id: corpId,
        agent_id: 1000002,
        secret: "wecom_sec",
        encoding_aes_key: aesKey,
        callback_host: "127.0.0.1",
        callback_port: 0,
      },
    }),
    path.join(dir, "uploads"),
    {
      host: "127.0.0.1",
      port: 0,
      fetchImpl: async (url, init) => {
        const u = String(url);
        apiCalls.push({ url: u, init });
        if (u.includes("/gettoken")) {
          return jsonResponse({ errcode: 0, access_token: "wc-tok", expires_in: 7200 });
        }
        if (u.includes("/media/get")) {
          return bytesResponse(Buffer.from("wecom-img"), 200, "image/jpeg");
        }
        if (u.includes("/media/upload")) {
          return jsonResponse({ errcode: 0, media_id: "mid-up-1" });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok" });
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  t.after(async () => {
    await ch.stop();
  });
  const baseUrl = `http://127.0.0.1:${ch.boundPort}/wecom/callback`;

  // 1. GET echostr verification
  const echostr = wecom.wecomEncrypt(aesKey, "hello-wecom-verify", corpId);
  const ts = "1700000000";
  const nonce = "n1";
  const sig = wecom.wecomSignature(token, ts, nonce, echostr);
  const verifyResp = await fetch(
    `${baseUrl}?msg_signature=${encodeURIComponent(sig)}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
  );
  assert.equal(verifyResp.status, 200);
  assert.equal(await verifyResp.text(), "hello-wecom-verify");

  // Bad signature -> 403
  const badSigResp = await fetch(
    `${baseUrl}?msg_signature=bad&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
  );
  assert.equal(badSigResp.status, 403);

  // 2. Malformed XML -> 400
  const badXmlResp = await fetch(`${baseUrl}?timestamp=${ts}&nonce=${nonce}`, {
    method: "POST",
    body: "not-xml",
  });
  assert.equal(badXmlResp.status, 400);

  // 3. Encrypted XML POST with text + image media
  const innerXml = `<xml>
    <ToUserName><![CDATA[${corpId}]]></ToUserName>
    <FromUserName><![CDATA[zhangsan]]></FromUserName>
    <CreateTime>1700000001</CreateTime>
    <MsgType><![CDATA[image]]></MsgType>
    <Content><![CDATA[please inspect]]></Content>
    <MediaId><![CDATA[media_1]]></MediaId>
    <MsgId>90001</MsgId>
  </xml>`;
  const encBody = wecom.wecomEncrypt(aesKey, innerXml, corpId);
  const postSig = wecom.wecomSignature(token, ts, nonce, encBody);
  const postResp = await fetch(
    `${baseUrl}?msg_signature=${encodeURIComponent(postSig)}&timestamp=${ts}&nonce=${nonce}`,
    {
      method: "POST",
      body: `<xml><Encrypt><![CDATA[${encBody}]]></Encrypt></xml>`,
    },
  );
  assert.equal(postResp.status, 200);
  assert.equal(await postResp.text(), "success");
  assert.equal(sink.messages.length, 1);
  assert.equal(sink.messages[0].sender_id, "zhangsan");
  assert.equal(sink.messages[0].attachments.length, 1);

  // 4. Outbound text + attachment
  const outImg = path.join(dir, "wc.jpg");
  await writeFile(outImg, Buffer.from("jpg"), "utf8");
  await ch.send(
    { chat_id: "zhangsan" },
    {
      text: "Checked!",
      attachments: [{ path: outImg, content_type: "image/jpeg", kind: "image" }],
    },
  );
  assert.ok(apiCalls.some(c => c.url.includes("/media/upload")));
  assert.ok(apiCalls.some(c => c.url.includes("/message/send")));
  await ch.stop();
});

// --- 7. WhatsApp Cloud API ---------------------------------------------------

test("WhatsAppChannel: GET /webhook verify, POST /webhook Graph v20.0 inbound/media, and outbound send", async t => {
  const dir = await withTempDir(t);
  const graphCalls = [];

  const ch = whatsapp.buildChannel(
    makeConfig("whatsapp", {
      extra: {
        phone_number_id: "100200300",
        access_token: "wa-secret-tok",
        verify_token: "my-verify-tok",
        webhook_host: "127.0.0.1",
        webhook_port: 0,
      },
    }),
    path.join(dir, "uploads"),
    {
      host: "127.0.0.1",
      port: 0,
      fetchImpl: async (url, init) => {
        const u = String(url);
        graphCalls.push({ url: u, init });
        if (u.endsWith("/v20.0/media-99")) {
          return jsonResponse({
            url: "https://lookaside.whatsapp.test/media-99",
            mime_type: "image/jpeg",
            file_size: 7,
          });
        }
        if (u === "https://lookaside.whatsapp.test/media-99") {
          return bytesResponse(Buffer.from("wa-jpeg"), 200, "image/jpeg");
        }
        if (u.endsWith("/100200300/media")) {
          return jsonResponse({ id: "wa-uploaded-1" });
        }
        return jsonResponse({ messages: [{ id: "wamid.out" }] });
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  t.after(async () => {
    await ch.stop();
  });
  const baseUrl = `http://127.0.0.1:${ch.boundPort}/webhook`;

  // Verify handshake
  const okVerify = await fetch(
    `${baseUrl}?hub.mode=subscribe&hub.verify_token=my-verify-tok&hub.challenge=ch_42`,
  );
  assert.equal(okVerify.status, 200);
  assert.equal(await okVerify.text(), "ch_42");

  const badVerify = await fetch(
    `${baseUrl}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ch_42`,
  );
  assert.equal(badVerify.status, 403);

  // Wrong phone_number_id -> 403
  const wrongPhone = await fetch(baseUrl, {
    method: "POST",
    body: JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "other" } } }] }],
    }),
  });
  assert.equal(wrongPhone.status, 403);

  // Valid image + button messages
  const inboundResp = await fetch(baseUrl, {
    method: "POST",
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "100200300" },
                messages: [
                  {
                    id: "wamid.1",
                    from: "8613800138000",
                    type: "image",
                    image: { id: "media-99", caption: "receipt photo" },
                  },
                  {
                    id: "wamid.2",
                    from: "8613800138000",
                    type: "button",
                    button: { text: "Approve" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  });
  assert.equal(inboundResp.status, 200);
  assert.equal(await inboundResp.text(), "EVENT_RECEIVED");
  assert.equal(sink.messages.length, 2);
  assert.equal(sink.messages[0].text, "receipt photo");
  assert.equal(sink.messages[0].attachments.length, 1);
  assert.equal(sink.messages[1].text, "Approve");

  // Outbound send
  const outDoc = path.join(dir, "invoice.pdf");
  await writeFile(outDoc, Buffer.from("pdf"), "utf8");
  await ch.send(
    { chat_id: "8613800138000" },
    {
      text: "Processed",
      attachments: [
        { path: outDoc, content_type: "application/pdf", kind: "document" },
      ],
    },
  );
  assert.ok(graphCalls.some(c => c.url.endsWith("/100200300/media")));
  assert.ok(graphCalls.some(c => c.url.endsWith("/100200300/messages")));
  await ch.stop();
});

// --- 8. Feishu ---------------------------------------------------------------

test("FeishuChannel: fake SDK WSClient/EventDispatcher, post rich-text, messageResource.get file_key, and DONE reaction", async t => {
  const dir = await withTempDir(t);
  const calls = {
    messages: [],
    resources: [],
    reactions: [],
    images: [],
    files: [],
  };
  let receiveHandler = null;
  let resourcePayload = Buffer.from("feishu-img-bytes");

  const fakeSdk = {
    Client: class {
      constructor(params) {
        this.params = params;
        this.im = {
          message: {
            create: async req => {
              calls.messages.push(req);
              return { data: { message_id: `om_${calls.messages.length}` } };
            },
          },
          messageResource: {
            get: async req => {
              calls.resources.push(req);
              const buf = resourcePayload;
              return {
                getReadableStream: () => Readable.from([buf]),
              };
            },
          },
          messageReaction: {
            create: async req => {
              calls.reactions.push(req);
              return { data: {} };
            },
          },
          image: {
            create: async req => {
              calls.images.push(req);
              return { image_key: "img_v2_uploaded" };
            },
          },
          file: {
            create: async req => {
              calls.files.push(req);
              return { file_key: "file_v2_uploaded" };
            },
          },
        };
      }
    },
    EventDispatcher: class {
      register(map) {
        receiveHandler = map["im.message.receive_v1"];
        return this;
      }
    },
    WSClient: class {
      constructor() {
        this.closed = false;
      }
      async start() {}
      async close() {
        this.closed = true;
      }
    },
  };

  const ch = await feishu.buildChannel(
    makeConfig("feishu", { extra: { app_id: "cli_1", app_secret: "sec_1" } }),
    path.join(dir, "uploads"),
    { sdk: fakeSdk },
  );
  const sink = new RecordingSink();
  await ch.start(sink);
  assert.equal(typeof receiveHandler, "function");

  // 1. Group post rich-text flattening
  await receiveHandler({
    sender: { sender_id: { open_id: "ou_alice" } },
    message: {
      chat_id: "oc_grp1",
      chat_type: "group",
      message_id: "om_post_1",
      message_type: "post",
      content: JSON.stringify({
        content: [
          [
            { tag: "text", text: "Check " },
            { tag: "a", text: "build log", href: "https://ci.test" },
          ],
          [{ tag: "text", text: "second line" }],
        ],
      }),
    },
  });
  assert.equal(sink.messages.length, 1);
  assert.equal(sink.messages[0].chat_type, "group");
  assert.equal(sink.messages[0].text, "Check build log\nsecond line");

  // 2. P2P image downloads using image_key as file_key!
  await receiveHandler({
    event: {
      sender: { sender_id: { open_id: "ou_alice" } },
      message: {
        chat_id: "oc_p2p",
        chat_type: "p2p",
        message_id: "om_img_1",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_real_key" }),
      },
    },
  });
  assert.equal(sink.messages.length, 2);
  assert.equal(sink.messages[1].chat_type, "dm");
  assert.equal(sink.messages[1].attachments.length, 1);
  assert.deepEqual(calls.resources[0], {
    path: { message_id: "om_img_1", file_key: "img_v2_real_key" },
    params: { type: "image" },
  });

  // 3. Oversize stream is aborted and sends notice
  resourcePayload = Buffer.alloc(21 * 1024 * 1024, 0x61);
  await receiveHandler({
    sender: { sender_id: { open_id: "ou_alice" } },
    message: {
      chat_id: "oc_p2p",
      chat_type: "p2p",
      message_id: "om_big_1",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_big" }),
    },
  });
  assert.equal(sink.messages[2].attachments.length, 0);
  assert.match(calls.messages[0].data.content, /20MB/);

  // 4. Outbound text + image + DONE reaction
  const imgOut = path.join(dir, "feishu-out.png");
  await writeFile(imgOut, Buffer.from("png"), "utf8");
  await ch.send(
    { chat_id: "oc_p2p" },
    {
      text: "Fixed!",
      attachments: [{ path: imgOut, content_type: "image/png", kind: "image" }],
    },
  );
  await ch.react({ chat_id: "oc_p2p" }, "✅");
  assert.equal(calls.images.length, 1);
  assert.equal(calls.reactions.length, 1);
  assert.equal(calls.reactions[0].data.reaction_type.emoji_type, "DONE");
  await ch.stop();
});

// --- 9. Email (IMAP + PostalMime + Nodemailer SMTP) --------------------------

test("EmailChannel: normalizeSubject, PostalMime multipart parsing, >20MB notice, In-Reply-To threading, and SMTP TLS", async t => {
  const dir = await withTempDir(t);

  assert.equal(
    email.normalizeSubject("Re: Re[2]: FWD:   Build   Failed "),
    "build failed",
  );
  assert.equal(email.normalizeSubject(""), "");

  const rawMime = [
    'From: "Ada Lovelace" <ada@example.com>',
    "To: bot@example.com",
    "Subject: Build Failed",
    "Message-ID: <msg-001@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUND1"',
    "",
    "--BOUND1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please inspect the attached trace.",
    "--BOUND1",
    'Content-Type: text/plain; name="trace.log"',
    'Content-Disposition: attachment; filename="trace.log"',
    "",
    "stacktrace line 1",
    "--BOUND1--",
    "",
  ].join("\r\n");

  let unseenUids = [10];
  let loggedOut = false;
  const seenFlags = [];
  const smtpConfigs = [];
  const sentMails = [];

  const ch = await email.buildChannel(
    makeConfig("email", {
      extra: {
        imap_host: "imap.example.com",
        imap_port: 993,
        imap_ssl: true,
        smtp_host: "smtp.example.com",
        smtp_port: 465,
        smtp_starttls: false,
        username: "bot@example.com",
        password: "auth-code",
      },
    }),
    path.join(dir, "uploads"),
    {
      pollIntervalOverride: 10,
      imapFactory: () => ({
        capabilities: new Set(),
        async connect() {},
        async mailboxOpen() {},
        async search() {
          const out = unseenUids;
          unseenUids = [];
          return out;
        },
        async *fetch(uids) {
          for (const uid of uids) {
            yield { uid, source: Buffer.from(rawMime, "utf8") };
          }
        },
        async messageFlagsAdd(uids, flags) {
          seenFlags.push({ uids, flags });
        },
        async logout() {
          loggedOut = true;
        },
      }),
      smtpTransportFactory: cfg => {
        smtpConfigs.push(cfg);
        return {
          async sendMail(mail) {
            sentMails.push(mail);
            return { messageId: "<reply@example.com>" };
          },
          close() {},
        };
      },
    },
  );

  const sink = new RecordingSink();
  await ch.start(sink);
  await waitUntil(() => sink.messages.length === 1, 2000, "email inbound");

  const msg = sink.messages[0];
  assert.equal(msg.chat_id, "ada@example.com");
  assert.equal(msg.sender_name, "Ada Lovelace");
  assert.equal(msg.thread_id, "build failed");
  assert.equal(msg.message_ref, "<msg-001@example.com>");
  assert.match(msg.text, /Please inspect the attached trace/);
  assert.equal(msg.attachments.length, 1);
  assert.equal(path.basename(msg.attachments[0].path), "trace.log");
  assert.equal(seenFlags.length, 1);

  // Reply uses Re: subject + In-Reply-To + implicit TLS secure=true on port 465
  const patchFile = path.join(dir, "fix.diff");
  await writeFile(patchFile, "diff --git", "utf8");
  await ch.send(
    { chat_id: "ada@example.com", thread_id: "build failed" },
    {
      text: "Here is the fix.",
      attachments: [{ path: patchFile, content_type: "text/plain", kind: "document" }],
    },
  );
  assert.equal(smtpConfigs[0].secure, true);
  assert.equal(smtpConfigs[0].requireTLS, false);
  assert.equal(sentMails[0].subject, "Re: Build Failed");
  assert.equal(sentMails[0].inReplyTo, "<msg-001@example.com>");
  assert.equal(sentMails[0].attachments.length, 1);

  await ch.stop();
  assert.equal(loggedOut, true);
});
