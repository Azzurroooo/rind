import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ChannelConfig } from "../config.js";
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
  MAX_ATTACHMENT_BYTES,
  OVERSIZE_NOTICE,
  ensureAttachmentDir,
  safeFilename,
} from "./http-ws-utils.js";

export const CHANNEL_ID = "feishu";
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "token",
  "allow_from",
  "group_allow",
  "app_id",
  "app_secret",
]);

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 15000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: true,
  markdown: "none",
});

const MEDIA_TYPES: Readonly<Record<string, AttachmentKind>> = {
  image: "image",
  audio: "audio",
  video: "video",
  media: "video",
  file: "document",
};

const KIND_META: Readonly<Record<AttachmentKind, readonly [string, string]>> = {
  image: ["image/jpeg", ".jpg"],
  audio: ["audio/opus", ".opus"],
  video: ["video/mp4", ".mp4"],
  document: ["application/octet-stream", ".bin"],
};

const FILE_TYPE_BY_KIND: Readonly<Record<AttachmentKind, string>> = {
  image: "stream",
  audio: "opus",
  video: "mp4",
  document: "stream",
};

const EMOJI_TYPES: Readonly<Record<string, string>> = {
  "✅": "DONE",
};

export interface FeishuSdkLike {
  readonly Client: new (params: { appId: string; appSecret: string }) => FeishuClientLike;
  readonly WSClient: new (params: { appId: string; appSecret: string }) => FeishuWsClientLike;
  readonly EventDispatcher: new (params: Record<string, unknown>) => FeishuEventDispatcherLike;
}

export interface FeishuEventDispatcherLike {
  register(handles: Record<string, (data: unknown) => Promise<unknown> | unknown>): this;
}

export interface FeishuWsClientLike {
  start(options: { eventDispatcher: FeishuEventDispatcherLike }): Promise<void> | void;
  close?(options?: { force?: boolean }): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface FeishuResourceResponseLike {
  readonly file?: Buffer | Uint8Array;
  getReadableStream?(): Readable;
  writeFile?(filePath: string): Promise<unknown>;
}

export interface FeishuClientLike {
  readonly im: {
    readonly message: {
      create(payload: {
        params: { receive_id_type: "chat_id" };
        data: { receive_id: string; msg_type: string; content: string };
      }): Promise<unknown>;
    };
    readonly messageResource: {
      get(payload: {
        path: { message_id: string; file_key: string };
        params: { type: string };
      }): Promise<FeishuResourceResponseLike>;
    };
    readonly messageReaction: {
      create(payload: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: string } };
      }): Promise<unknown>;
    };
    readonly image: {
      create(payload: {
        data: { image_type: "message"; image: Buffer | fs.ReadStream };
      }): Promise<unknown>;
    };
    readonly file: {
      create(payload: {
        data: {
          file_type: string;
          file_name: string;
          file: Buffer | fs.ReadStream;
        };
      }): Promise<unknown>;
    };
  };
}

async function loadFeishuSdk(): Promise<FeishuSdkLike> {
  const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as Record<string, unknown>;
  const resolved =
    mod.default && typeof mod.default === "object"
      ? (mod.default as Record<string, unknown>)
      : mod;
  if (
    typeof resolved.Client !== "function" ||
    typeof resolved.WSClient !== "function" ||
    typeof resolved.EventDispatcher !== "function"
  ) {
    throw new Error("channel 'feishu' requires @larksuiteoapi/node-sdk");
  }
  return resolved as unknown as FeishuSdkLike;
}

export function parseFeishuContent(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  try {
    const parsed: unknown = JSON.parse(String(raw ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function postText(content: Record<string, unknown>): string {
  const rows = Array.isArray(content.content) ? content.content : [];
  const lines: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const parts: string[] = [];
    for (const node of row) {
      if (!node || typeof node !== "object") continue;
      const rec = node as Record<string, unknown>;
      const tag = String(rec.tag ?? "");
      if (tag === "text" || tag === "a") {
        parts.push(String(rec.text ?? ""));
      }
    }
    const line = parts.join("").trim();
    if (line) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function extractMessageId(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const rec = response as Record<string, unknown>;
  if (typeof rec.message_id === "string") return rec.message_id;
  if (rec.data && typeof rec.data === "object") {
    const data = rec.data as Record<string, unknown>;
    if (typeof data.message_id === "string") return data.message_id;
  }
  return "";
}

function extractDataKey(response: unknown, key: string): string {
  if (!response || typeof response !== "object") return "";
  const rec = response as Record<string, unknown>;
  if (typeof rec[key] === "string") return rec[key] as string;
  if (rec.data && typeof rec.data === "object") {
    const data = rec.data as Record<string, unknown>;
    if (typeof data[key] === "string") return data[key] as string;
  }
  return "";
}

async function readResourceBytes(
  response: FeishuResourceResponseLike | null | undefined,
  tempDir: string,
): Promise<{ bytes: Buffer; oversize: boolean } | null> {
  if (!response) return null;
  if (response.file instanceof Uint8Array || Buffer.isBuffer(response.file)) {
    const buf = Buffer.from(response.file);
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      return { bytes: Buffer.alloc(0), oversize: true };
    }
    return { bytes: buf, oversize: false };
  }
  if (typeof response.getReadableStream === "function") {
    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) {
        stream.destroy();
        return { bytes: Buffer.alloc(0), oversize: true };
      }
      chunks.push(buf);
    }
    return { bytes: Buffer.concat(chunks, total), oversize: false };
  }
  if (typeof response.writeFile === "function") {
    const tmpPath = path.join(tempDir, `.tmp-${process.pid}-${Date.now()}`);
    try {
      await response.writeFile(tmpPath);
      const stat = fs.statSync(tmpPath);
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        return { bytes: Buffer.alloc(0), oversize: true };
      }
      return { bytes: fs.readFileSync(tmpPath), oversize: false };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export interface FeishuChannelOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly uploadsRoot: string;
  readonly sdk?: FeishuSdkLike;
}

export class FeishuChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly uploadsRoot: string;
  private sdk: FeishuSdkLike | null;
  private sink: InboundSink | null = null;
  private client: FeishuClientLike | null = null;
  private wsClient: FeishuWsClientLike | null = null;
  private readonly lastMessageIds = new Map<string, string>();

  constructor(options: FeishuChannelOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.sdk = options.sdk ?? null;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    const sdk = this.sdk ?? (await loadFeishuSdk());
    this.sdk = sdk;
    this.client = new sdk.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });
    const dispatcher = new sdk.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.onEvent(data);
      },
    });
    const wsClient = new sdk.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });
    this.wsClient = wsClient;
    await wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    const wsClient = this.wsClient;
    this.wsClient = null;
    this.client = null;
    if (wsClient) {
      try {
        if (typeof wsClient.close === "function") {
          await wsClient.close();
        } else if (typeof wsClient.stop === "function") {
          await wsClient.stop();
        }
      } catch {
        // best effort
      }
    }
  }

  async onEvent(data: unknown): Promise<void> {
    let inbound: InboundMessage | null = null;
    try {
      inbound = await this.normalizeEvent(data);
    } catch {
      return;
    }
    if (inbound && this.sink) {
      await this.sink.inbound(inbound);
    }
  }

  async normalizeEvent(data: unknown): Promise<InboundMessage | null> {
    if (!data || typeof data !== "object") return null;
    const raw = data as Record<string, unknown>;
    const ev =
      raw.event && typeof raw.event === "object"
        ? (raw.event as Record<string, unknown>)
        : raw;
    const message =
      ev.message && typeof ev.message === "object"
        ? (ev.message as Record<string, unknown>)
        : null;
    const sender =
      ev.sender && typeof ev.sender === "object"
        ? (ev.sender as Record<string, unknown>)
        : null;
    if (!message || !sender) return null;

    const chatId = String(message.chat_id ?? "").trim();
    const senderIdObj =
      sender.sender_id && typeof sender.sender_id === "object"
        ? (sender.sender_id as Record<string, unknown>)
        : {};
    const openId = String(senderIdObj.open_id ?? "").trim();
    const messageId = String(message.message_id ?? "").trim();
    if (!chatId || !openId || !messageId) {
      return null;
    }

    const messageType = String(message.message_type ?? "");
    const content = parseFeishuContent(message.content);
    const text =
      messageType === "text" ? String(content.text ?? "") : postText(content);
    const attachments = await this.collectAttachments(
      messageId,
      messageType,
      content,
      chatId,
    );

    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: String(message.chat_type ?? "") === "p2p" ? "dm" : "group",
      sender_id: openId,
      sender_name: openId,
      thread_id: null,
      text,
      attachments,
      message_ref: messageId,
    };
  }

  private async collectAttachments(
    messageId: string,
    messageType: string,
    content: Record<string, unknown>,
    chatId: string,
  ): Promise<Attachment[]> {
    const kind = MEDIA_TYPES[messageType];
    if (!kind || !this.client) {
      return [];
    }
    const fileKey = String(
      content.image_key ?? content.file_key ?? content.media_key ?? messageId,
    ).trim();
    if (!fileKey) {
      return [];
    }
    const [contentType, ext] = KIND_META[kind];
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const rawFileName = String(content.file_name ?? "").trim();
    const fallback = `${messageId}${ext}`;
    const dest = path.join(dir, safeFilename(rawFileName, fallback));
    const resourceType = kind === "image" ? "image" : "file";

    let res: FeishuResourceResponseLike;
    try {
      res = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType },
      });
    } catch {
      return [];
    }

    let readResult: { bytes: Buffer; oversize: boolean } | null = null;
    try {
      readResult = await readResourceBytes(res, dir);
    } catch {
      return [];
    }
    if (!readResult) {
      return [];
    }
    if (readResult.oversize) {
      await this.sendMessage(chatId, "text", { text: OVERSIZE_NOTICE }).catch(() => {});
      return [];
    }
    fs.writeFileSync(dest, readResult.bytes);
    return [
      {
        path: dest,
        content_type: contentType,
        kind,
      },
    ];
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      if (payload.text) {
        const messageId = await this.sendMessage(target.chat_id, "text", {
          text: payload.text,
        });
        if (messageId) {
          this.lastMessageIds.set(target.chat_id, messageId);
        }
      }
      for (const att of payload.attachments ?? []) {
        await this.postAttachment(target.chat_id, att);
      }
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendMessage(
    chatId: string,
    msgType: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) return "";
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      },
    });
    return extractMessageId(resp);
  }

  private async postAttachment(chatId: string, attachment: Attachment): Promise<void> {
    if (!this.client) return;
    if (attachment.kind === "image") {
      const resp = await this.client.im.image.create({
        data: {
          image_type: "message",
          image: fs.createReadStream(attachment.path),
        },
      });
      const imageKey = extractDataKey(resp, "image_key");
      if (!imageKey) {
        throw new Error("feishu image.create returned no image_key");
      }
      await this.sendMessage(chatId, "image", { image_key: imageKey });
      return;
    }
    const resp = await this.client.im.file.create({
      data: {
        file_type: FILE_TYPE_BY_KIND[attachment.kind] ?? "stream",
        file_name: path.basename(attachment.path),
        file: fs.createReadStream(attachment.path),
      },
    });
    const fileKey = extractDataKey(resp, "file_key");
    if (!fileKey) {
      throw new Error("feishu file.create returned no file_key");
    }
    await this.sendMessage(chatId, "file", { file_key: fileKey });
  }

  async react(target: SendTarget, emoji: string): Promise<void> {
    if (!this.client) return;
    const messageId = this.lastMessageIds.get(target.chat_id);
    if (!messageId) return;
    const emojiType = EMOJI_TYPES[emoji] ?? emoji.replace(/^:|:$/g, "");
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {
      // best effort
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export interface FeishuBuildOptions {
  readonly sdk?: FeishuSdkLike;
}

export async function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: FeishuBuildOptions,
): Promise<FeishuChannel> {
  const extra = config.extra;
  const appId = String(extra.app_id ?? "").trim();
  const appSecret = String(extra.app_secret ?? "").trim();
  const missing: string[] = [];
  if (!appId) missing.push("app_id");
  if (!appSecret) missing.push("app_secret");
  if (missing.length > 0) {
    throw new Error(
      `channel 'feishu' requires non-empty ${missing.join(", ")} (channels.feishu.<key>)`,
    );
  }
  const sdk = options?.sdk ?? (await loadFeishuSdk());
  return new FeishuChannel({
    appId,
    appSecret,
    uploadsRoot,
    sdk,
  });
}
