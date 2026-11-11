import fs from "node:fs";
import path from "node:path";
import { WebSocket as UndiciWebSocket } from "undici";
import type { ChannelConfig } from "../config.js";
import type { WebSocketFactory, WebSocketLike } from "../transports.js";
import {
  type Attachment,
  type AttachmentKind,
  type Channel,
  type ChannelCapabilities,
  type InboundMessage,
  type InboundSink,
  type OutboundPayload,
  type SendTarget,
  createCapabilities,
} from "../types.js";
import {
  type FetchLike,
  MAX_ATTACHMENT_BYTES,
  OVERSIZE_NOTICE,
  defaultFetch,
  ensureAttachmentDir,
  safeFilename,
} from "./http-ws-utils.js";

export const CHANNEL_ID = "dingtalk";
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "token",
  "allow_from",
  "group_allow",
  "client_id",
  "client_secret",
]);

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 5000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "subset",
});

export const BOT_CALLBACK_TOPIC = "/v1.0/im/bot/messages/get";
export const GROUP_SEND_API = "/v1.0/robot/groupMessages/send";
export const DIRECT_SEND_API = "/v1.0/robot/oToMessages/send";
export const MSG_KEY = "sampleMarkdown";
const TITLE_MAX_CHARS = 40;

const KIND_BY_MEDIA_TYPE: Readonly<Record<string, AttachmentKind>> = {
  picture: "image",
  image: "image",
  audio: "audio",
  video: "video",
};

const KIND_EXT: Readonly<Record<AttachmentKind, string>> = {
  image: ".jpg",
  audio: ".audio",
  video: ".mp4",
  document: ".bin",
};

const KIND_CONTENT_TYPE: Readonly<Record<AttachmentKind, string>> = {
  image: "image/jpeg",
  audio: "audio/mpeg",
  video: "video/mp4",
  document: "application/octet-stream",
};

function titleOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Rind";
  const firstLine = (trimmed.split(/\r?\n/, 1)[0] ?? "").trim();
  return [...firstLine].slice(0, TITLE_MAX_CHARS).join("") || "Rind";
}

export interface DingTalkChannelOptions {
  readonly fetchImpl?: FetchLike;
  readonly wsFactory?: WebSocketFactory;
  readonly apiBaseUrl?: string;
  readonly reconnectDelayMs?: number;
}

export class DingTalkChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly uploadsRoot: string;
  private readonly fetchImpl: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly apiBaseUrl: string;
  private readonly reconnectDelayMs: number;

  private sink: InboundSink | null = null;
  private ws: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private started = false;
  private accessToken = "";
  private tokenExpiresAt = 0;
  private readonly dmSenders = new Map<string, string>();

  constructor(options: {
    clientId: string;
    clientSecret: string;
    uploadsRoot: string;
    fetchImpl?: FetchLike;
    wsFactory?: WebSocketFactory;
    apiBaseUrl?: string;
    reconnectDelayMs?: number;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
    this.wsFactory =
      options.wsFactory ?? (url => new UndiciWebSocket(url) as unknown as WebSocketLike);
    this.apiBaseUrl = (
      options.apiBaseUrl ?? "https://api.dingtalk.com"
    ).replace(/\/+$/, "");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.stopping = false;
    this.started = true;
    await this.openStreamConnection();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
    }
  }

  private async openStreamConnection(): Promise<void> {
    if (this.stopping) return;
    const resp = await this.fetchImpl(`${this.apiBaseUrl}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: [
          { type: "EVENT", topic: "*" },
          { type: "CALLBACK", topic: BOT_CALLBACK_TOPIC },
        ],
        ua: "rind-gateway/1.0",
      }),
    });
    const body = (await resp.json()) as Record<string, unknown>;
    const endpoint = String(body?.endpoint ?? "");
    const ticket = String(body?.ticket ?? "");
    if (!resp.ok || !endpoint || !ticket) {
      throw new Error(`DingTalk gateway/connections/open failed (${resp.status})`);
    }
    const sep = endpoint.includes("?") ? "&" : "?";
    const wsUrl = `${endpoint}${sep}ticket=${encodeURIComponent(ticket)}`;
    const ws = this.wsFactory(wsUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      ws.addEventListener("open", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      ws.addEventListener("error", (ev: unknown) => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              ev && typeof ev === "object" && "message" in ev
                ? String((ev as { message?: unknown }).message)
                : "DingTalk Stream WS error",
            ),
          );
        }
      });
      ws.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("DingTalk Stream WS closed before open"));
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (!this.stopping) {
          this.scheduleReconnect();
        }
      });
      ws.addEventListener("message", (ev: { data?: unknown }) => {
        const raw =
          typeof ev?.data === "string"
            ? ev.data
            : ev?.data instanceof ArrayBuffer
              ? Buffer.from(ev.data).toString("utf8")
              : String(ev?.data ?? "");
        void this.handleStreamFrame(ws, raw);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== null) return;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openStreamConnection().catch(() => {
        if (!this.stopping) {
          this.scheduleReconnect();
        }
      });
    }, this.reconnectDelayMs);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private async handleStreamFrame(ws: WebSocketLike, raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const headers =
      frame.headers && typeof frame.headers === "object" && !Array.isArray(frame.headers)
        ? (frame.headers as Record<string, unknown>)
        : {};
    const messageId = String(headers.messageId ?? "");
    const topic = String(headers.topic ?? "");
    const frameType = String(frame.type ?? "");

    if (messageId && ws.readyState === 1) {
      let ackData = "{}";
      if (frameType === "SYSTEM" && topic === "ping" && typeof frame.data === "string") {
        ackData = frame.data;
      }
      ws.send(
        JSON.stringify({
          code: 200,
          headers: {
            contentType: "application/json",
            messageId,
          },
          message: "OK",
          data: ackData,
        }),
      );
    }

    if (frameType === "SYSTEM" && topic === "disconnect") {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      return;
    }

    if (frameType === "CALLBACK") {
      let dataObj: Record<string, unknown> = {};
      if (typeof frame.data === "string") {
        try {
          const parsed: unknown = JSON.parse(frame.data);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            dataObj = parsed as Record<string, unknown>;
          }
        } catch {
          return;
        }
      } else if (
        frame.data &&
        typeof frame.data === "object" &&
        !Array.isArray(frame.data)
      ) {
        dataObj = frame.data as Record<string, unknown>;
      }
      const inbound = await this.normalizeCallback(dataObj);
      if (inbound && this.sink) {
        await this.sink.inbound(inbound);
      }
    }
  }

  async normalizeCallback(data: Record<string, unknown>): Promise<InboundMessage | null> {
    const chatId = String(data.conversationId ?? "");
    const senderId = String(data.senderStaffId || data.senderId || "");
    const messageRef = String(data.msgId ?? "");
    if (!chatId || !senderId || !messageRef) {
      return null;
    }
    const chatType = String(data.conversationType ?? "") === "1" ? "dm" : "group";
    if (chatType === "dm") {
      this.dmSenders.set(chatId, senderId);
    }
    const media =
      data.content && typeof data.content === "object" && !Array.isArray(data.content)
        ? (data.content as Record<string, unknown>)
        : {};
    let text = "";
    if (data.text && typeof data.text === "object" && !Array.isArray(data.text)) {
      text = String((data.text as Record<string, unknown>).content ?? "");
    } else if (typeof data.text === "string") {
      text = data.text;
    }
    const attachments = await this.collectAttachments(media, messageRef, chatId);
    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: chatType,
      sender_id: senderId,
      sender_name: String(data.senderNick || senderId),
      thread_id: null,
      text,
      attachments,
      message_ref: messageRef,
    };
  }

  private async collectAttachments(
    media: Record<string, unknown>,
    messageRef: string,
    chatId: string,
  ): Promise<Attachment[]> {
    const url = String(media.downloadUrl ?? "").trim();
    if (!url) return [];
    const kind = KIND_BY_MEDIA_TYPE[String(media.mediaType ?? "")] ?? "document";
    let ext = KIND_EXT[kind];
    try {
      const parsed = new URL(url);
      const parsedExt = path.posix.extname(parsed.pathname);
      if (parsedExt) ext = parsedExt;
    } catch {
      // keep default ext
    }
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const dest = path.join(
      dir,
      safeFilename(`${messageRef}${ext}`, `${messageRef}${KIND_EXT[kind]}`),
    );
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) return [];
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        await this.send({ chat_id: chatId }, { text: OVERSIZE_NOTICE }).catch(() => {});
        return [];
      }
      fs.writeFileSync(dest, bytes);
      return [
        {
          path: dest,
          content_type: KIND_CONTENT_TYPE[kind],
          kind,
        },
      ];
    } catch {
      return [];
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = performance.now() / 1000;
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const resp = await this.fetchImpl(`${this.apiBaseUrl}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: this.clientId,
        appSecret: this.clientSecret,
      }),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    const token = String(data?.accessToken ?? "");
    if (!resp.ok || !token) {
      throw new Error(`DingTalk accessToken failed (${resp.status})`);
    }
    const expireIn = Number(data?.expireIn ?? 7200) || 7200;
    this.accessToken = token;
    this.tokenExpiresAt = now + Math.max(300, expireIn - 300);
    return token;
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) return;
    try {
      if (payload.text) {
        const token = await this.getAccessToken();
        const msgParam = JSON.stringify({
          content: payload.text,
          title: titleOf(payload.text),
        });
        const staffId = this.dmSenders.get(target.chat_id);
        const apiPath = staffId ? DIRECT_SEND_API : GROUP_SEND_API;
        const body = staffId
          ? {
              robotCode: this.clientId,
              userIds: [staffId],
              msgKey: MSG_KEY,
              msgParam,
            }
          : {
              robotCode: this.clientId,
              openConversationId: target.chat_id,
              msgKey: MSG_KEY,
              msgParam,
            };
        await this.fetchImpl(`${this.apiBaseUrl}${apiPath}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify(body),
        });
      }
    } catch {
      // logged/ignored per §8
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: DingTalkChannelOptions,
): DingTalkChannel {
  const clientId = String(config.extra.client_id ?? "").trim();
  const clientSecret = String(config.extra.client_secret ?? "").trim();
  const missing: string[] = [];
  if (!clientId) missing.push("client_id");
  if (!clientSecret) missing.push("client_secret");
  if (missing.length > 0) {
    throw new Error(
      `channel 'dingtalk' requires non-empty ${missing.join(", ")} (channels.dingtalk.<key>)`,
    );
  }
  return new DingTalkChannel({
    clientId,
    clientSecret,
    uploadsRoot,
    ...options,
  });
}
