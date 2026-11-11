import fs from "node:fs";
import path from "node:path";
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

export const CHANNEL_ID = "telegram";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 4000,
  len_unit: "utf16",
  supports_typing: true,
  supports_buttons: true,
  supports_reaction: true,
  markdown: "none",
});

export const BUTTON_CALLBACK_PREFIX = "ans:";
export const LONG_POLL_SECONDS = 25;
export const POLL_ERROR_PAUSE_SECONDS = 3.0;
export const TYPING_ACTION = "typing";
export const REACTION_EMOJI = "👀";

const EXTENSION_FOR_KIND: Readonly<Record<AttachmentKind, string>> = {
  image: ".jpg",
  audio: ".ogg",
  video: ".mp4",
  document: ".bin",
};

interface MediaSource {
  readonly fileId: string;
  readonly fileSize: number;
  readonly kind: AttachmentKind;
  readonly contentType: string;
  readonly filename: string | null;
}

function senderName(user: Record<string, unknown>): string {
  const first = String(user.first_name ?? "").trim();
  const last = String(user.last_name ?? "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full || String(user.username ?? "").trim();
}

export interface TelegramChannelOptions {
  readonly proxy?: string;
  readonly fetchImpl?: FetchLike;
  readonly apiBaseUrl?: string;
  readonly longPollSeconds?: number;
  readonly pollErrorPauseSeconds?: number;
}

export class TelegramChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly token: string;
  private readonly uploadsRoot: string;
  private readonly proxy: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly longPollSeconds: number;
  private readonly pollErrorPauseSeconds: number;
  private sink: InboundSink | null = null;
  private stopController: AbortController | null = null;
  private pollTask: Promise<void> | null = null;
  private started = false;
  private readonly lastMessageId = new Map<string, number>();

  constructor(token: string, uploadsRoot: string, options?: TelegramChannelOptions) {
    this.token = token;
    this.uploadsRoot = path.resolve(uploadsRoot);
    this.proxy = String(options?.proxy ?? "").trim();
    this.fetchImpl = options?.fetchImpl ?? defaultFetch(this.proxy);
    this.apiBaseUrl = (options?.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.longPollSeconds = options?.longPollSeconds ?? LONG_POLL_SECONDS;
    this.pollErrorPauseSeconds = options?.pollErrorPauseSeconds ?? POLL_ERROR_PAUSE_SECONDS;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.stopController = new AbortController();
    this.started = true;
    await this.callApi("deleteWebhook", { drop_pending_updates: true });
    this.pollTask = this.pollLoop(this.stopController.signal);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopController?.abort();
    this.stopController = null;
    const task = this.pollTask;
    this.pollTask = null;
    if (task) {
      await Promise.allSettled([task]);
    }
  }

  private methodUrl(method: string): string {
    return `${this.apiBaseUrl}/bot${this.token}/${method}`;
  }

  private fileUrl(filePath: string): string {
    return `${this.apiBaseUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, "")}`;
  }

  private async callApi(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const resp = await this.fetchImpl(this.methodUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const body = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok || !body?.ok) {
      throw new Error(
        `Telegram ${method} failed (${resp.status}): ${String(body?.description ?? "")}`,
      );
    }
    return body.result;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      let updates: unknown;
      try {
        updates = await this.callApi(
          "getUpdates",
          { offset, timeout: this.longPollSeconds },
          signal,
        );
      } catch {
        if (signal.aborted) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(
            resolve,
            Math.max(10, this.pollErrorPauseSeconds * 1000),
          );
          timer.unref?.();
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        continue;
      }
      if (!Array.isArray(updates)) continue;
      for (const update of updates) {
        if (signal.aborted) return;
        if (update && typeof update === "object") {
          const u = update as Record<string, unknown>;
          const updateId = Number(u.update_id ?? 0) || 0;
          offset = Math.max(offset, updateId + 1);
          await this.deliverUpdate(u);
        }
      }
    }
  }

  async deliverUpdate(update: Record<string, unknown>): Promise<void> {
    const normalized = await this.normalizeUpdate(update);
    if (normalized && this.sink) {
      await this.sink.inbound(normalized);
    }
  }

  private async normalizeUpdate(
    update: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    if (update.callback_query && typeof update.callback_query === "object") {
      return await this.normalizeCallback(
        update.callback_query as Record<string, unknown>,
      );
    }
    if (update.message && typeof update.message === "object") {
      return await this.normalizeMessage(update.message as Record<string, unknown>);
    }
    return null;
  }

  private async normalizeMessage(
    message: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    const chat =
      message.chat && typeof message.chat === "object"
        ? (message.chat as Record<string, unknown>)
        : null;
    const user =
      (message.from && typeof message.from === "object"
        ? (message.from as Record<string, unknown>)
        : null) ??
      (message.from_user && typeof message.from_user === "object"
        ? (message.from_user as Record<string, unknown>)
        : null);
    if (!chat || !user) return null;
    const chatId = String(chat.id ?? "");
    if (!chatId) return null;
    const threadRaw = message.message_thread_id;
    const threadId = threadRaw ? String(threadRaw) : null;
    const text = String(message.text ?? message.caption ?? "");
    const attachments = await this.collectAttachments(message, chatId);
    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: String(chat.type ?? "") === "private" ? "dm" : "group",
      sender_id: String(user.id ?? ""),
      sender_name: senderName(user),
      thread_id: threadId,
      text,
      attachments,
      message_ref: `${chatId}:${String(message.message_id ?? "")}`,
    };
  }

  private async normalizeCallback(
    callback: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    const data = String(callback.data ?? "");
    if (!data.startsWith(BUTTON_CALLBACK_PREFIX)) {
      return null;
    }
    const rawIdx = data.slice(BUTTON_CALLBACK_PREFIX.length);
    if (!/^\d+$/.test(rawIdx)) {
      return null;
    }
    const index = Number.parseInt(rawIdx, 10);
    const message =
      callback.message && typeof callback.message === "object"
        ? (callback.message as Record<string, unknown>)
        : null;
    const chat =
      message?.chat && typeof message.chat === "object"
        ? (message.chat as Record<string, unknown>)
        : null;
    const user =
      (callback.from && typeof callback.from === "object"
        ? (callback.from as Record<string, unknown>)
        : null) ??
      (callback.from_user && typeof callback.from_user === "object"
        ? (callback.from_user as Record<string, unknown>)
        : null);
    if (!chat || !user) return null;
    const callbackId = String(callback.id ?? "");
    if (callbackId) {
      try {
        await this.callApi("answerCallbackQuery", { callback_query_id: callbackId });
      } catch {
        // best effort
      }
    }
    return {
      channel: CHANNEL_ID,
      chat_id: String(chat.id ?? ""),
      chat_type: String(chat.type ?? "") === "private" ? "dm" : "group",
      sender_id: String(user.id ?? ""),
      sender_name: senderName(user),
      thread_id: null,
      text: String(index + 1),
      attachments: [],
      message_ref: callbackId || `${BUTTON_CALLBACK_PREFIX}${index}`,
    };
  }

  private extractMediaSources(message: Record<string, unknown>): MediaSource[] {
    const sources: MediaSource[] = [];
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      let largest: Record<string, unknown> | null = null;
      let bestArea = -1;
      let bestSize = -1;
      for (const item of message.photo) {
        if (!item || typeof item !== "object") continue;
        const p = item as Record<string, unknown>;
        const area = (Number(p.width ?? 0) || 0) * (Number(p.height ?? 0) || 0);
        const size = Number(p.file_size ?? 0) || 0;
        if (area > bestArea || (area === bestArea && size > bestSize)) {
          bestArea = area;
          bestSize = size;
          largest = p;
        }
      }
      if (largest && largest.file_id) {
        sources.push({
          fileId: String(largest.file_id),
          fileSize: Number(largest.file_size ?? 0) || 0,
          kind: "image",
          contentType: "image/jpeg",
          filename: null,
        });
      }
    }
    if (message.document && typeof message.document === "object") {
      const doc = message.document as Record<string, unknown>;
      if (doc.file_id) {
        const contentType = String(doc.mime_type || "application/octet-stream");
        sources.push({
          fileId: String(doc.file_id),
          fileSize: Number(doc.file_size ?? 0) || 0,
          kind: attachmentKind(contentType),
          contentType,
          filename: doc.file_name ? String(doc.file_name) : null,
        });
      }
    }
    if (message.voice && typeof message.voice === "object") {
      const voice = message.voice as Record<string, unknown>;
      if (voice.file_id) {
        sources.push({
          fileId: String(voice.file_id),
          fileSize: Number(voice.file_size ?? 0) || 0,
          kind: "audio",
          contentType: "audio/ogg",
          filename: null,
        });
      }
    }
    if (message.video && typeof message.video === "object") {
      const video = message.video as Record<string, unknown>;
      if (video.file_id) {
        const contentType = String(video.mime_type || "video/mp4");
        sources.push({
          fileId: String(video.file_id),
          fileSize: Number(video.file_size ?? 0) || 0,
          kind: attachmentKind(contentType),
          contentType,
          filename: video.file_name ? String(video.file_name) : null,
        });
      }
    }
    return sources;
  }

  private async collectAttachments(
    message: Record<string, unknown>,
    chatId: string,
  ): Promise<Attachment[]> {
    const sources = this.extractMediaSources(message);
    if (sources.length === 0) return [];
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const saved: Attachment[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const src = sources[i]!;
      if (src.fileSize > MAX_ATTACHMENT_BYTES) {
        await this.sendNotice(chatId, OVERSIZE_NOTICE);
        continue;
      }
      const fallback = `${String(message.message_id ?? "file")}-${i + 1}${EXTENSION_FOR_KIND[src.kind]}`;
      const dest = path.join(dir, safeFilename(src.filename, fallback));
      try {
        const fileInfo = (await this.callApi("getFile", {
          file_id: src.fileId,
        })) as Record<string, unknown>;
        const remotePath = String(fileInfo?.file_path ?? "");
        if (!remotePath) continue;
        const downloadResp = await this.fetchImpl(this.fileUrl(remotePath));
        if (!downloadResp.ok) continue;
        const bytes = Buffer.from(await downloadResp.arrayBuffer());
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          await this.sendNotice(chatId, OVERSIZE_NOTICE);
          continue;
        }
        fs.writeFileSync(dest, bytes);
        saved.push({
          path: dest,
          content_type: src.contentType,
          kind: src.kind,
        });
      } catch {
        // skip failed download
      }
    }
    return saved;
  }

  private async sendNotice(chatId: string, text: string): Promise<void> {
    if (!this.started) return;
    try {
      await this.callApi("sendMessage", { chat_id: chatId, text });
    } catch {
      // best effort
    }
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) return;
    const threadParam = target.thread_id
      ? {
          message_thread_id: /^\d+$/.test(target.thread_id)
            ? Number.parseInt(target.thread_id, 10)
            : target.thread_id,
        }
      : {};
    try {
      const choices = payload.choices ?? [];
      const replyMarkup =
        choices.length > 0
          ? {
              inline_keyboard: choices.map((label, index) => [
                {
                  text: String(label),
                  callback_data: `${BUTTON_CALLBACK_PREFIX}${index}`,
                },
              ]),
            }
          : undefined;
      if (payload.text || replyMarkup) {
        const sent = (await this.callApi("sendMessage", {
          chat_id: target.chat_id,
          text: payload.text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...threadParam,
        })) as Record<string, unknown>;
        const messageId = Number(sent?.message_id ?? 0);
        if (messageId > 0) {
          this.lastMessageId.set(target.chat_id, messageId);
        }
      }
      for (const att of payload.attachments ?? []) {
        await this.sendAttachment(target.chat_id, att, target.thread_id ?? null);
      }
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    threadId: string | null,
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (threadId) {
      form.append("message_thread_id", threadId);
    }
    const bytes = fs.readFileSync(attachment.path);
    const blob = new Blob([bytes], { type: attachment.content_type });
    const fieldName = attachment.kind === "image" ? "photo" : "document";
    const endpoint = attachment.kind === "image" ? "sendPhoto" : "sendDocument";
    form.append(fieldName, blob, path.basename(attachment.path));
    const resp = await this.fetchImpl(this.methodUrl(endpoint), {
      method: "POST",
      body: form as unknown as BodyInit,
    });
    if (!resp.ok) {
      throw new Error(`Telegram ${endpoint} failed with status ${resp.status}`);
    }
  }

  async typing(target: SendTarget): Promise<void> {
    if (!this.started) return;
    const threadParam = target.thread_id
      ? {
          message_thread_id: /^\d+$/.test(target.thread_id)
            ? Number.parseInt(target.thread_id, 10)
            : target.thread_id,
        }
      : {};
    try {
      await this.callApi("sendChatAction", {
        chat_id: target.chat_id,
        action: TYPING_ACTION,
        ...threadParam,
      });
    } catch {
      // best effort
    }
  }

  async react(target: SendTarget, emoji: string): Promise<void> {
    if (!this.started) return;
    const messageId = this.lastMessageId.get(target.chat_id);
    if (!messageId) return;
    try {
      await this.callApi("setMessageReaction", {
        chat_id: target.chat_id,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: emoji || REACTION_EMOJI }],
        is_big: false,
      });
    } catch {
      // best effort
    }
  }
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: TelegramChannelOptions,
): TelegramChannel {
  const token = String(config.token ?? "").trim();
  if (!token) {
    throw new Error(
      "channel 'telegram' requires a non-empty token (channels.telegram.token)",
    );
  }
  const proxy = options?.proxy ?? String(config.extra.proxy ?? "").trim();
  return new TelegramChannel(token, uploadsRoot, { ...options, proxy });
}
