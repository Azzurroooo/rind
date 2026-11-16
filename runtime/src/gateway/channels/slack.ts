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

export const CHANNEL_ID = "slack";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 40000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: true,
  markdown: "subset",
});

const SKIPPED_SUBTYPES: ReadonlySet<string> = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
  "bot_message",
]);

const EMOJI_NAMES: Readonly<Record<string, string>> = {
  "✅": "white_check_mark",
  "👀": "eyes",
  "🧠": "brain",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "❌": "x",
  "⏹️": "stop_button",
  "💻": "computer",
  "🌐": "globe_with_meridians",
  "📋": "clipboard",
  "🛠️": "hammer_and_wrench",
};

const EXTENSION_FOR_KIND: Readonly<Record<AttachmentKind, string>> = {
  image: ".jpg",
  audio: ".ogg",
  video: ".mp4",
  document: ".bin",
};

export interface SlackChannelOptions {
  readonly fetchImpl?: FetchLike;
  readonly wsFactory?: WebSocketFactory;
  readonly apiBaseUrl?: string;
  readonly reconnectDelayMs?: number;
}

function senderName(event: Record<string, unknown>): string {
  const profile = event.user_profile;
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    const p = profile as Record<string, unknown>;
    const name = String(p.display_name || p.real_name || "");
    if (name) return name;
  }
  return String(event.user ?? "");
}

export class SlackChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly appToken: string;
  private readonly botToken: string;
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
  private readonly lastTs = new Map<string, string>();

  constructor(options: {
    appToken: string;
    botToken: string;
    uploadsRoot: string;
    fetchImpl?: FetchLike;
    wsFactory?: WebSocketFactory;
    apiBaseUrl?: string;
    reconnectDelayMs?: number;
  }) {
    this.appToken = options.appToken;
    this.botToken = options.botToken;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
    this.wsFactory =
      options.wsFactory ?? (url => new UndiciWebSocket(url) as unknown as WebSocketLike);
    this.apiBaseUrl = (
      options.apiBaseUrl ?? "https://slack.com/api"
    ).replace(/\/+$/, "");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.stopping = false;
    this.started = true;
    await this.openSocketMode();
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

  private async openSocketMode(): Promise<void> {
    if (this.stopping) return;
    const resp = await this.fetchImpl(`${this.apiBaseUrl}/apps.connections.open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const body = (await resp.json()) as Record<string, unknown>;
    const url = String(body?.url ?? "");
    if (!body?.ok || !url) {
      throw new Error(
        `Slack apps.connections.open failed: ${String(body?.error ?? resp.status)}`,
      );
    }

    const ws = this.wsFactory(url);
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
                : "Slack Socket Mode WS error",
            ),
          );
        }
      });
      ws.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Slack Socket Mode WS closed before open"));
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
        void this.handleSocketFrame(ws, raw);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== null) return;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocketMode().catch(() => {
        if (!this.stopping) {
          this.scheduleReconnect();
        }
      });
    }, this.reconnectDelayMs);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private async handleSocketFrame(ws: WebSocketLike, raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof frame.envelope_id === "string" && frame.envelope_id) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      }
    }

    if (frame.type === "disconnect") {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      return;
    }

    if (frame.type === "events_api") {
      const payload =
        frame.payload && typeof frame.payload === "object"
          ? (frame.payload as Record<string, unknown>)
          : {};
      const event =
        payload.event && typeof payload.event === "object"
          ? (payload.event as Record<string, unknown>)
          : null;
      if (event) {
        const etype = String(event.type ?? "");
        if (etype === "message" || etype === "app_mention") {
          const inbound = await this.normalizeEvent(event);
          if (inbound && this.sink) {
            await this.sink.inbound(inbound);
          }
        }
      }
    }
  }

  async normalizeEvent(event: Record<string, unknown>): Promise<InboundMessage | null> {
    if (event.bot_id || SKIPPED_SUBTYPES.has(String(event.subtype ?? ""))) {
      return null;
    }
    const chatId = String(event.channel ?? "");
    const senderId = String(event.user ?? "");
    if (!chatId || !senderId) {
      return null;
    }
    const threadTs = event.thread_ts ? String(event.thread_ts) : null;
    const attachments = await this.collectAttachments(event, chatId);
    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: event.channel_type === "im" ? "dm" : "group",
      sender_id: senderId,
      sender_name: senderName(event),
      thread_id: threadTs,
      text: String(event.text ?? ""),
      attachments,
      message_ref: String(event.ts ?? ""),
    };
  }

  private async collectAttachments(
    event: Record<string, unknown>,
    chatId: string,
  ): Promise<Attachment[]> {
    const rawFiles = Array.isArray(event.files) ? event.files : [];
    const files = rawFiles.filter(
      (f): f is Record<string, unknown> =>
        Boolean(f && typeof f === "object" && !Array.isArray(f)),
    );
    if (files.length === 0) return [];
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const saved: Attachment[] = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]!;
      const size = Number(file.size ?? 0) || 0;
      if (size > MAX_ATTACHMENT_BYTES) {
        await this.postSlackJson("chat.postMessage", {
          channel: chatId,
          text: OVERSIZE_NOTICE,
        }).catch(() => {});
        continue;
      }
      const contentType = String(file.mimetype || "application/octet-stream");
      const kind = attachmentKind(contentType);
      const url = String(file.url_private_download || file.url_private || "");
      if (!url) continue;
      const fallback = `${String(event.ts ?? "file")}-${i + 1}${EXTENSION_FOR_KIND[kind]}`;
      const dest = path.join(dir, safeFilename(file.name, fallback));
      try {
        const resp = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!resp.ok) continue;
        const bytes = Buffer.from(await resp.arrayBuffer());
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          await this.postSlackJson("chat.postMessage", {
            channel: chatId,
            text: OVERSIZE_NOTICE,
          }).catch(() => {});
          continue;
        }
        fs.writeFileSync(dest, bytes);
        saved.push({
          path: dest,
          content_type: contentType,
          kind,
        });
      } catch {
        // skip failed download
      }
    }
    return saved;
  }

  private async postSlackJson(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const body = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok || !body?.ok) {
      throw new Error(`Slack ${method} failed: ${String(body?.error ?? resp.status)}`);
    }
    return body;
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) return;
    try {
      if (payload.text) {
        const response = await this.postSlackJson("chat.postMessage", {
          channel: target.chat_id,
          text: payload.text,
          ...(target.thread_id ? { thread_ts: target.thread_id } : {}),
        });
        const ts = String(response.ts ?? "");
        if (ts) {
          this.lastTs.set(target.chat_id, ts);
        }
      }
      for (const att of payload.attachments ?? []) {
        await this.uploadExternalFile(target, att);
      }
    } catch {
      // logged/ignored per §8
    }
  }

  private async uploadExternalFile(
    target: SendTarget,
    attachment: Attachment,
  ): Promise<void> {
    const bytes = fs.readFileSync(attachment.path);
    const filename = path.basename(attachment.path);
    const params = new URLSearchParams({
      filename,
      length: String(bytes.byteLength),
    });
    const getUrlResp = await this.fetchImpl(
      `${this.apiBaseUrl}/files.getUploadURLExternal?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.botToken}` },
      },
    );
    const urlData = (await getUrlResp.json()) as Record<string, unknown>;
    const uploadUrl = String(urlData.upload_url ?? "");
    const fileId = String(urlData.file_id ?? "");
    if (!urlData.ok || !uploadUrl || !fileId) {
      throw new Error("Slack files.getUploadURLExternal failed");
    }

    const putResp = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": attachment.content_type },
      body: bytes,
    });
    if (!putResp.ok) {
      throw new Error(`Slack external upload failed: ${putResp.status}`);
    }

    await this.postSlackJson("files.completeUploadExternal", {
      files: [{ id: fileId, title: filename }],
      channel_id: target.chat_id,
      ...(target.thread_id ? { thread_ts: target.thread_id } : {}),
    });
  }

  async react(target: SendTarget, emoji: string): Promise<void> {
    if (!this.started) return;
    const ts = this.lastTs.get(target.chat_id) || target.thread_id;
    if (!ts) return;
    const name = EMOJI_NAMES[emoji] ?? emoji.replace(/^:|:$/g, "");
    try {
      await this.postSlackJson("reactions.add", {
        channel: target.chat_id,
        timestamp: ts,
        name,
      });
    } catch {
      // best effort
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: SlackChannelOptions,
): SlackChannel {
  const appToken = String(config.extra.app_token ?? "").trim();
  const botToken =
    String(config.extra.bot_token ?? "").trim() || String(config.token ?? "").trim();
  if (!appToken.startsWith("xapp-")) {
    throw new Error(
      "channel 'slack' requires a Slack app token starting with xapp- (channels.slack.app_token)",
    );
  }
  if (!botToken.startsWith("xoxb-")) {
    throw new Error(
      "channel 'slack' requires a Slack bot token starting with xoxb- (channels.slack.bot_token)",
    );
  }
  return new SlackChannel({
    appToken,
    botToken,
    uploadsRoot,
    ...options,
  });
}
