import fs from "node:fs";
import path from "node:path";
import { WebSocket as UndiciWebSocket } from "undici";
import type { ChannelConfig } from "../config.js";
import type { WebSocketFactory, WebSocketLike } from "../transports.js";
import {
  type Attachment,
  type Channel,
  type ChannelCapabilities,
  type InboundMessage,
  type InboundSink,
  type OutboundPayload,
  type SendTarget,
  attachmentKind,
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

export const CHANNEL_ID = "discord";
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "token",
  "allow_from",
  "group_allow",
]);

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 2000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "subset",
});

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;

const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

export interface DiscordChannelOptions {
  readonly fetchImpl?: FetchLike;
  readonly wsFactory?: WebSocketFactory;
  readonly gatewayUrl?: string;
  readonly apiBaseUrl?: string;
  readonly heartbeatJitter?: number;
  readonly reconnectDelayMs?: number;
}

function senderName(author: Record<string, unknown>): string {
  return String(
    author.global_name ?? author.display_name ?? author.username ?? author.name ?? "",
  );
}

export class DiscordChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly token: string;
  private readonly uploadsRoot: string;
  private readonly fetchImpl: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly defaultGatewayUrl: string;
  private readonly apiBaseUrl: string;
  private readonly heartbeatJitter: number | undefined;
  private readonly reconnectDelayMs: number;

  private sink: InboundSink | null = null;
  private ws: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private initialHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private started = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private readonly threadParents = new Map<string, string>();

  constructor(token: string, uploadsRoot: string, options?: DiscordChannelOptions) {
    this.token = token;
    this.uploadsRoot = path.resolve(uploadsRoot);
    this.fetchImpl = options?.fetchImpl ?? defaultFetch();
    this.wsFactory =
      options?.wsFactory ?? (url => new UndiciWebSocket(url) as unknown as WebSocketLike);
    this.defaultGatewayUrl =
      options?.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    this.apiBaseUrl = (
      options?.apiBaseUrl ?? "https://discord.com/api/v10"
    ).replace(/\/+$/, "");
    this.heartbeatJitter = options?.heartbeatJitter;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 1500;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.stopping = false;
    this.started = true;
    await this.connectGateway(false);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.clearTimers();
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

  private clearTimers(): void {
    if (this.initialHeartbeatTimer !== null) {
      clearTimeout(this.initialHeartbeatTimer);
      this.initialHeartbeatTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private gatewayEndpoint(resume: boolean): string {
    const base =
      resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.defaultGatewayUrl;
    if (base.includes("v=")) {
      return base;
    }
    const sep = base.includes("?") ? "&" : "?";
    return `${base.replace(/\/+$/, "")}/${sep}v=10&encoding=json`;
  }

  private async connectGateway(resume: boolean): Promise<void> {
    if (this.stopping) return;
    this.clearTimers();
    const url = this.gatewayEndpoint(resume);
    const ws = this.wsFactory(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onOpen = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const onError = (ev: unknown): void => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              ev && typeof ev === "object" && "message" in ev
                ? String((ev as { message?: unknown }).message)
                : "Discord gateway WS failed",
            ),
          );
        }
      };
      const onClose = (): void => {
        if (!settled) {
          settled = true;
          reject(new Error("Discord gateway closed during open"));
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        this.clearTimers();
        if (!this.stopping) {
          this.scheduleReconnect(Boolean(this.sessionId && this.seq !== null));
        }
      };
      const onMessage = (ev: { data?: unknown }): void => {
        const raw =
          typeof ev?.data === "string"
            ? ev.data
            : ev?.data instanceof ArrayBuffer
              ? Buffer.from(ev.data).toString("utf8")
              : String(ev?.data ?? "");
        void this.handleGatewayPayload(ws, raw, resume);
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    });
  }

  private scheduleReconnect(resume: boolean): void {
    if (this.stopping || this.reconnectTimer !== null) return;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectGateway(resume).catch(() => {
        if (!this.stopping) {
          this.scheduleReconnect(false);
        }
      });
    }, this.reconnectDelayMs);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private sendWs(ws: WebSocketLike, payload: Record<string, unknown>): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  private async handleGatewayPayload(
    ws: WebSocketLike,
    raw: string,
    preferResume: boolean,
  ): Promise<void> {
    let packet: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      packet = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const op = Number(packet.op ?? -1);
    if (typeof packet.s === "number") {
      this.seq = packet.s;
    }
    const eventName = typeof packet.t === "string" ? packet.t : "";
    const d =
      packet.d && typeof packet.d === "object" && !Array.isArray(packet.d)
        ? (packet.d as Record<string, unknown>)
        : {};

    if (op === OP_HELLO) {
      const intervalMs = Math.max(50, Number(d.heartbeat_interval ?? 41250) || 41250);
      const jitter = this.heartbeatJitter ?? Math.random();
      const firstDelay = Math.max(0, Math.floor(intervalMs * jitter));
      const firstTimer = setTimeout(() => {
        this.initialHeartbeatTimer = null;
        this.sendWs(ws, { op: OP_HEARTBEAT, d: this.seq });
        const loop = setInterval(() => {
          this.sendWs(ws, { op: OP_HEARTBEAT, d: this.seq });
        }, intervalMs);
        loop.unref?.();
        this.heartbeatTimer = loop;
      }, firstDelay);
      firstTimer.unref?.();
      this.initialHeartbeatTimer = firstTimer;

      if (preferResume && this.sessionId && this.seq !== null) {
        this.sendWs(ws, {
          op: OP_RESUME,
          d: {
            token: this.token,
            session_id: this.sessionId,
            seq: this.seq,
          },
        });
      } else {
        this.sendWs(ws, {
          op: OP_IDENTIFY,
          d: {
            token: this.token,
            intents: DISCORD_INTENTS,
            properties: {
              os: process.platform,
              browser: "rind-gateway",
              device: "rind-gateway",
            },
          },
        });
      }
      return;
    }

    if (op === OP_HEARTBEAT) {
      this.sendWs(ws, { op: OP_HEARTBEAT, d: this.seq });
      return;
    }

    if (op === OP_RECONNECT) {
      try {
        ws.close(4000);
      } catch {
        // ignore
      }
      return;
    }

    if (op === OP_INVALID_SESSION) {
      const resumable = packet.d === true;
      if (!resumable) {
        this.sessionId = null;
        this.seq = null;
      }
      try {
        ws.close(4000);
      } catch {
        // ignore
      }
      return;
    }

    if (op === OP_DISPATCH) {
      if (eventName === "READY") {
        if (typeof d.session_id === "string") {
          this.sessionId = d.session_id;
        }
        if (typeof d.resume_gateway_url === "string") {
          this.resumeGatewayUrl = d.resume_gateway_url;
        }
        if (d.user && typeof d.user === "object") {
          const user = d.user as Record<string, unknown>;
          if (user.id) this.botUserId = String(user.id);
        }
      } else if (eventName === "THREAD_CREATE" || eventName === "THREAD_UPDATE") {
        const threadId = String(d.id ?? "");
        const parentId = String(d.parent_id ?? "");
        if (threadId && parentId) {
          this.threadParents.set(threadId, parentId);
        }
      } else if (eventName === "MESSAGE_CREATE") {
        const inbound = await this.normalizeMessageCreate(d);
        if (inbound && this.sink) {
          await this.sink.inbound(inbound);
        }
      }
    }
  }

  async normalizeMessageCreate(
    message: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    const author =
      message.author && typeof message.author === "object"
        ? (message.author as Record<string, unknown>)
        : null;
    if (!author || Boolean(author.bot)) {
      return null;
    }
    const senderId = String(author.id ?? "");
    if (!senderId || (this.botUserId && senderId === this.botUserId)) {
      return null;
    }
    const rawChannelId = String(message.channel_id ?? "");
    if (!rawChannelId) return null;

    const isDm = !message.guild_id;
    let chatId = rawChannelId;
    let threadId: string | null = null;

    if (!isDm) {
      if (message.thread && typeof message.thread === "object") {
        const th = message.thread as Record<string, unknown>;
        if (th.id) {
          threadId = String(th.id);
        }
      } else if (
        THREAD_CHANNEL_TYPES.has(Number(message.channel_type ?? -1)) ||
        this.threadParents.has(rawChannelId) ||
        typeof message.parent_id === "string"
      ) {
        const parent =
          (typeof message.parent_id === "string" && message.parent_id) ||
          this.threadParents.get(rawChannelId);
        if (parent) {
          chatId = parent;
          threadId = rawChannelId;
        } else {
          threadId = rawChannelId;
        }
      }
    }

    const attachments = await this.collectAttachments(message, rawChannelId);
    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: isDm ? "dm" : "group",
      sender_id: senderId,
      sender_name: senderName(author),
      thread_id: threadId,
      text: String(message.content ?? ""),
      attachments,
      message_ref: String(message.id ?? ""),
    };
  }

  private async collectAttachments(
    message: Record<string, unknown>,
    channelId: string,
  ): Promise<Attachment[]> {
    const rawList = Array.isArray(message.attachments) ? message.attachments : [];
    if (rawList.length === 0) return [];
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const saved: Attachment[] = [];

    for (let i = 0; i < rawList.length; i += 1) {
      const item = rawList[i];
      if (!item || typeof item !== "object") continue;
      const src = item as Record<string, unknown>;
      const size = Number(src.size ?? 0) || 0;
      if (size > MAX_ATTACHMENT_BYTES) {
        await this.postText(channelId, OVERSIZE_NOTICE);
        continue;
      }
      const url = String(src.url ?? src.proxy_url ?? "");
      if (!url) continue;
      const contentType = String(src.content_type || "application/octet-stream");
      const fallback = `${String(message.id ?? "file")}-${i + 1}`;
      const dest = path.join(dir, safeFilename(src.filename, fallback));
      try {
        const resp = await this.fetchImpl(url);
        if (!resp.ok) continue;
        const bytes = Buffer.from(await resp.arrayBuffer());
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          await this.postText(channelId, OVERSIZE_NOTICE);
          continue;
        }
        fs.writeFileSync(dest, bytes);
        saved.push({
          path: dest,
          content_type: contentType,
          kind: attachmentKind(contentType),
        });
      } catch {
        // skip failed download
      }
    }
    return saved;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bot ${this.token}`,
      ...(extra ?? {}),
    };
  }

  private async postText(channelId: string, content: string): Promise<void> {
    if (!this.started) return;
    try {
      await this.fetchImpl(
        `${this.apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: this.authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ content }),
        },
      );
    } catch {
      // best effort
    }
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) return;
    const destChannelId = target.thread_id || target.chat_id;
    const url = `${this.apiBaseUrl}/channels/${encodeURIComponent(destChannelId)}/messages`;
    try {
      if (payload.text) {
        await this.fetchImpl(url, {
          method: "POST",
          headers: this.authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ content: payload.text }),
        });
      }
      for (const att of payload.attachments ?? []) {
        const form = new FormData();
        const bytes = fs.readFileSync(att.path);
        const filename = path.basename(att.path);
        form.append(
          "payload_json",
          JSON.stringify({
            attachments: [{ id: 0, filename }],
          }),
        );
        form.append(
          "files[0]",
          new Blob([bytes], { type: att.content_type }),
          filename,
        );
        await this.fetchImpl(url, {
          method: "POST",
          headers: this.authHeaders(),
          body: form as unknown as BodyInit,
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
  options?: DiscordChannelOptions,
): DiscordChannel {
  const token = String(config.token ?? "").trim();
  if (!token) {
    throw new Error(
      "channel 'discord' requires a non-empty token (channels.discord.token)",
    );
  }
  return new DiscordChannel(token, uploadsRoot, options);
}
