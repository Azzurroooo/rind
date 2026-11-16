import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
  readHttpBody,
  safeFilename,
} from "./http-ws-utils.js";

export const CHANNEL_ID = "whatsapp";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 4096,
  len_unit: "utf16",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "none",
});

export const GRAPH_BASE = "https://graph.facebook.com/v20.0";
export const WEBHOOK_PATH = "/webhook";
export const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
export const DEFAULT_WEBHOOK_PORT = 8080;

const KIND_EXT: Readonly<Record<AttachmentKind, string>> = {
  image: ".jpg",
  audio: ".ogg",
  video: ".mp4",
  document: ".bin",
};

const INBOUND_MEDIA_KINDS: ReadonlySet<string> = new Set([
  "image",
  "document",
  "audio",
  "video",
]);

export interface WhatsAppChannelOptions {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly verifyToken: string;
  readonly uploadsRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly graphBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export class WhatsAppChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly verifyToken: string;
  private readonly uploadsRoot: string;
  private readonly host: string;
  private readonly port: number;
  private readonly graphBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private sink: InboundSink | null = null;
  private server: http.Server | null = null;
  private started = false;

  constructor(options: WhatsAppChannelOptions) {
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.verifyToken = options.verifyToken;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.host = options.host || DEFAULT_WEBHOOK_HOST;
    this.port = options.port ?? DEFAULT_WEBHOOK_PORT;
    this.graphBaseUrl = (options.graphBaseUrl ?? GRAPH_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
  }

  get boundPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return (addr as AddressInfo).port;
    }
    return this.port;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    }
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    if (parsedUrl.pathname !== WEBHOOK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (req.method === "GET") {
      this.handleVerify(parsedUrl.searchParams, res);
      return;
    }
    if (req.method === "POST") {
      await this.handlePayload(req, res);
      return;
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  }

  private handleVerify(query: URLSearchParams, res: http.ServerResponse): void {
    const mode = query.get("hub.mode");
    const challenge = query.get("hub.challenge");
    const token = query.get("hub.verify_token");
    if (mode !== "subscribe" || !challenge || token !== this.verifyToken) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(challenge);
  }

  private async handlePayload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await readHttpBody(req);
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected JSON object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const changes = Array.isArray((entry as Record<string, unknown>).changes)
        ? ((entry as Record<string, unknown>).changes as unknown[])
        : [];
      for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const valueRaw = (change as Record<string, unknown>).value;
        const value =
          valueRaw && typeof valueRaw === "object"
            ? (valueRaw as Record<string, unknown>)
            : {};
        const metaRaw = value.metadata;
        const metadata =
          metaRaw && typeof metaRaw === "object"
            ? (metaRaw as Record<string, unknown>)
            : {};
        if (String(metadata.phone_number_id ?? "") !== this.phoneNumberId) {
          res.writeHead(403);
          res.end();
          return;
        }
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          if (!msg || typeof msg !== "object") continue;
          const inbound = await this.normalizeMessage(msg as Record<string, unknown>);
          if (inbound && this.sink) {
            await this.sink.inbound(inbound);
          }
        }
      }
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("EVENT_RECEIVED");
  }

  private async normalizeMessage(
    message: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    const sender = String(message.from ?? "").trim();
    const kind = String(message.type ?? "");
    if (!sender) {
      return null;
    }
    let text = "";
    if (kind === "text") {
      const block =
        message.text && typeof message.text === "object"
          ? (message.text as Record<string, unknown>)
          : {};
      text = String(block.body ?? "");
    } else if (INBOUND_MEDIA_KINDS.has(kind)) {
      const block =
        message[kind] && typeof message[kind] === "object"
          ? (message[kind] as Record<string, unknown>)
          : {};
      text = String(block.caption ?? "");
    } else if (kind === "button") {
      const block =
        message.button && typeof message.button === "object"
          ? (message.button as Record<string, unknown>)
          : {};
      text = String(block.text ?? "");
    } else {
      return null;
    }
    const attachments = await this.collectAttachments(message, sender);
    return {
      channel: CHANNEL_ID,
      chat_id: sender,
      chat_type: "dm",
      sender_id: sender,
      sender_name: sender,
      thread_id: null,
      text,
      attachments,
      message_ref: String(message.id ?? ""),
    };
  }

  private async collectAttachments(
    message: Record<string, unknown>,
    sender: string,
  ): Promise<Attachment[]> {
    const kind = String(message.type ?? "");
    if (!INBOUND_MEDIA_KINDS.has(kind)) {
      return [];
    }
    const block =
      message[kind] && typeof message[kind] === "object"
        ? (message[kind] as Record<string, unknown>)
        : {};
    const mediaId = String(block.id ?? "").trim();
    if (!mediaId) {
      return [];
    }
    const reference = String(message.id || "media");
    let meta: Record<string, unknown>;
    try {
      meta = await this.graphJson(`${this.graphBaseUrl}/${encodeURIComponent(mediaId)}`);
    } catch {
      return [];
    }
    const fileSize = Number(meta.file_size ?? 0) || 0;
    if (fileSize > MAX_ATTACHMENT_BYTES) {
      await this.sendNotice(sender, OVERSIZE_NOTICE);
      return [];
    }
    const mediaUrl = String(meta.url ?? "").trim();
    if (!mediaUrl) {
      return [];
    }
    let data: Buffer;
    try {
      data = await this.graphBytes(mediaUrl);
    } catch {
      return [];
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      await this.sendNotice(sender, OVERSIZE_NOTICE);
      return [];
    }
    const contentType = String(meta.mime_type || "application/octet-stream");
    const ext = KIND_EXT[(kind as AttachmentKind) in KIND_EXT ? (kind as AttachmentKind) : "document"];
    const fallback = `${reference}${ext}`;
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const dest = path.join(dir, safeFilename(block.filename, fallback));
    fs.writeFileSync(dest, data);
    return [
      {
        path: dest,
        content_type: contentType,
        kind: attachmentKind(contentType),
      },
    ];
  }

  private bearerHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      ...(extra ?? {}),
    };
  }

  private async graphJson(url: string): Promise<Record<string, unknown>> {
    const resp = await this.fetchImpl(url, {
      method: "GET",
      headers: this.bearerHeaders(),
    });
    if (!resp.ok) {
      throw new Error(`Graph API GET failed: ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  private async graphBytes(url: string): Promise<Buffer> {
    const resp = await this.fetchImpl(url, {
      method: "GET",
      headers: this.bearerHeaders(),
    });
    if (!resp.ok) {
      throw new Error(`Graph media download failed: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  private async postJson(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: this.bearerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    return (await resp.json()) as Record<string, unknown>;
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) {
      return;
    }
    try {
      if (payload.text) {
        await this.postJson(
          `${this.graphBaseUrl}/${encodeURIComponent(this.phoneNumberId)}/messages`,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: target.chat_id,
            type: "text",
            text: { body: payload.text, preview_url: false },
          },
        );
      }
      for (const att of payload.attachments ?? []) {
        await this.sendAttachment(target.chat_id, att);
      }
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendAttachment(to: string, attachment: Attachment): Promise<void> {
    const kind = INBOUND_MEDIA_KINDS.has(attachment.kind) ? attachment.kind : "document";
    const mediaId = await this.uploadMedia(attachment);
    await this.postJson(
      `${this.graphBaseUrl}/${encodeURIComponent(this.phoneNumberId)}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: kind,
        [kind]: { id: mediaId },
      },
    );
  }

  private async uploadMedia(attachment: Attachment): Promise<string> {
    const bytes = fs.readFileSync(attachment.path);
    const filename = path.basename(attachment.path);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: attachment.content_type }), filename);
    form.append("type", attachment.content_type);
    form.append("messaging_product", "whatsapp");
    const resp = await this.fetchImpl(
      `${this.graphBaseUrl}/${encodeURIComponent(this.phoneNumberId)}/media`,
      {
        method: "POST",
        headers: this.bearerHeaders(),
        body: form,
      },
    );
    const data = (await resp.json()) as Record<string, unknown>;
    const mediaId = String(data.id ?? "");
    if (!mediaId) {
      throw new Error(`whatsapp media upload failed: ${JSON.stringify(data)}`);
    }
    return mediaId;
  }

  private async sendNotice(to: string, text: string): Promise<void> {
    if (!this.started) return;
    try {
      await this.postJson(
        `${this.graphBaseUrl}/${encodeURIComponent(this.phoneNumberId)}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: text, preview_url: false },
        },
      );
    } catch {
      // best effort
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export interface WhatsAppBuildOptions {
  readonly host?: string;
  readonly port?: number;
  readonly graphBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: WhatsAppBuildOptions,
): WhatsAppChannel {
  const extra = config.extra;
  const phoneNumberId = String(extra.phone_number_id ?? "").trim();
  const accessToken = String(extra.access_token ?? "").trim();
  const verifyToken = String(extra.verify_token ?? "").trim();
  const missing: string[] = [];
  if (!phoneNumberId) missing.push("phone_number_id");
  if (!accessToken) missing.push("access_token");
  if (!verifyToken) missing.push("verify_token");
  if (missing.length > 0) {
    throw new Error(
      `channel 'whatsapp' requires non-empty ${missing.join(", ")} (channels.whatsapp.<key>)`,
    );
  }
  const host =
    options?.host ?? (String(extra.webhook_host ?? "").trim() || DEFAULT_WEBHOOK_HOST);
  const port =
    options?.port ??
    (extra.webhook_port !== undefined ? Number(extra.webhook_port) : DEFAULT_WEBHOOK_PORT);

  return new WhatsAppChannel({
    phoneNumberId,
    accessToken,
    verifyToken,
    uploadsRoot,
    host,
    port,
    graphBaseUrl: options?.graphBaseUrl,
    fetchImpl: options?.fetchImpl,
  });
}
