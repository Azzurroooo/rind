import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

export const CHANNEL_ID = "wecom";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 2048,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "none",
});

export const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
export const CALLBACK_PATH = "/wecom/callback";
export const DEFAULT_CALLBACK_HOST = "0.0.0.0";
export const DEFAULT_CALLBACK_PORT = 8081;

const KIND_EXT: Readonly<Record<AttachmentKind, string>> = {
  image: ".jpg",
  audio: ".ogg",
  video: ".mp4",
  document: ".bin",
};

const KIND_CONTENT_TYPE: Readonly<Record<AttachmentKind, string>> = {
  image: "image/jpeg",
  audio: "audio/amr",
  video: "video/mp4",
  document: "application/octet-stream",
};

const KIND_MSGTYPE: Readonly<Record<AttachmentKind, string>> = {
  image: "image",
  audio: "voice",
  video: "video",
  document: "file",
};

const BASE64_43_RE = /^[A-Za-z0-9+/]{43}$/;

export function decodeEncodingAesKey(encodingAesKey: string): Buffer {
  const trimmed = String(encodingAesKey ?? "").trim();
  if (!BASE64_43_RE.test(trimmed)) {
    throw new Error("encoding_aes_key must be a 43-character base64 string");
  }
  const key = Buffer.from(`${trimmed}=`, "base64");
  if (key.byteLength !== 32) {
    throw new Error("encoding_aes_key must decode to 32 bytes");
  }
  return key;
}

export function wecomSignature(token: string, ...parts: string[]): string {
  const sorted = [token, ...parts].sort().join("");
  return createHash("sha1").update(sorted, "utf8").digest("hex");
}

export function wecomDecrypt(
  encodingAesKey: string,
  ciphertextB64: string,
  receiveId: string,
): Buffer {
  const key = decodeEncodingAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const cipherBytes = Buffer.from(ciphertextB64, "base64");
  if (cipherBytes.byteLength === 0 || cipherBytes.byteLength % 16 !== 0) {
    throw new Error("invalid wecom ciphertext length");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  if (padded.byteLength === 0) {
    throw new Error("empty decrypted payload");
  }
  const padLen = padded[padded.byteLength - 1]!;
  if (padLen < 1 || padLen > 32 || padLen > padded.byteLength) {
    throw new Error("invalid PKCS7 padding");
  }
  for (let i = 1; i <= padLen; i += 1) {
    if (padded[padded.byteLength - i] !== padLen) {
      throw new Error("corrupt PKCS7 padding");
    }
  }
  const plain = padded.subarray(0, padded.byteLength - padLen);
  if (plain.byteLength < 20) {
    throw new Error("decrypted payload shorter than header");
  }
  const msgLen = plain.readUInt32BE(16);
  if (20 + msgLen > plain.byteLength) {
    throw new Error("invalid message length in decrypted payload");
  }
  const tail = plain.subarray(20 + msgLen).toString("utf8");
  if (tail !== receiveId) {
    throw new Error("wecom callback receiveid mismatch");
  }
  return Buffer.from(plain.subarray(20, 20 + msgLen));
}

export function wecomEncrypt(
  encodingAesKey: string,
  plaintext: Buffer | string,
  receiveId: string,
): string {
  const key = decodeEncodingAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const msg = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const rand = randomBytes(16);
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(msg.byteLength, 0);
  const recvBuf = Buffer.from(receiveId, "utf8");
  const raw = Buffer.concat([rand, lenBuf, msg, recvBuf]);
  const rem = raw.byteLength % 32;
  const padLen = rem === 0 ? 32 : 32 - rem;
  const pad = Buffer.alloc(padLen, padLen);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, pad])), cipher.final()]).toString(
    "base64",
  );
}

function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseWecomXml(xmlText: string): Record<string, string> {
  const rootMatch = /^\s*(?:<\?xml[^>]*\?>\s*)?<xml(?:\s[^>]*)?>([\s\S]*)<\/xml>\s*$/i.exec(
    xmlText,
  );
  if (!rootMatch) {
    throw new Error("wecom callback body is not valid <xml>");
  }
  const inner = rootMatch[1]!;
  const fields: Record<string, string> = {};
  const tagPattern =
    /<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(inner)) !== null) {
    const tag = match[1]!;
    if (match[2] !== undefined) {
      fields[tag] = match[2];
    } else {
      fields[tag] = unescapeXmlEntities((match[3] ?? "").trim());
    }
  }
  return fields;
}

export interface WeComChannelOptions {
  readonly corpId: string;
  readonly agentId: number;
  readonly secret: string;
  readonly token: string;
  readonly encodingAesKey: string;
  readonly uploadsRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export class WeComChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly corpId: string;
  private readonly agentId: number;
  private readonly secret: string;
  private readonly token: string;
  private readonly encodingAesKey: string;
  private readonly uploadsRoot: string;
  private readonly host: string;
  private readonly port: number;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private sink: InboundSink | null = null;
  private server: http.Server | null = null;
  private started = false;
  private accessToken = "";
  private tokenExpiresAt = 0;

  constructor(options: WeComChannelOptions) {
    this.corpId = options.corpId;
    this.agentId = options.agentId;
    this.secret = options.secret;
    this.token = options.token;
    this.encodingAesKey = options.encodingAesKey;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.host = options.host || DEFAULT_CALLBACK_HOST;
    this.port = options.port ?? DEFAULT_CALLBACK_PORT;
    this.apiBaseUrl = (options.apiBaseUrl ?? API_BASE).replace(/\/+$/, "");
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

  private sigMatches(query: URLSearchParams, ...parts: string[]): boolean {
    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const expected = query.get("msg_signature") ?? "";
    return wecomSignature(this.token, timestamp, nonce, ...parts) === expected;
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    if (parsedUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (req.method === "GET") {
      this.handleVerify(parsedUrl.searchParams, res);
      return;
    }
    if (req.method === "POST") {
      await this.handleMessage(parsedUrl.searchParams, req, res);
      return;
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  }

  private handleVerify(query: URLSearchParams, res: http.ServerResponse): void {
    const echostr = query.get("echostr") ?? "";
    if (!echostr || !this.sigMatches(query, echostr)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const plain = wecomDecrypt(this.encodingAesKey, echostr, this.corpId);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(plain.toString("utf8"));
    } catch {
      res.writeHead(403);
      res.end();
    }
  }

  private async handleMessage(
    query: URLSearchParams,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let outerFields: Record<string, string>;
    try {
      const body = await readHttpBody(req);
      outerFields = parseWecomXml(body.toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const encrypt = (outerFields.Encrypt ?? "").trim();
    if (!encrypt || !this.sigMatches(query, encrypt)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let innerFields: Record<string, string>;
    try {
      const plain = wecomDecrypt(this.encodingAesKey, encrypt, this.corpId);
      innerFields = parseWecomXml(plain.toString("utf8"));
    } catch {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const message = await this.normalizeMessage(innerFields);
      if (message && this.sink) {
        await this.sink.inbound(message);
      }
    } catch {
      // keep webhook 200 ack resilient
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("success");
  }

  private async normalizeMessage(
    fields: Record<string, string>,
  ): Promise<InboundMessage | null> {
    const msgType = String(fields.MsgType ?? "");
    const isEvent = msgType.toLowerCase() === "event";
    const sender = isEvent ? "" : String(fields.FromUserName ?? "").trim();
    if (!sender) {
      return null;
    }
    const attachments = await this.collectAttachments(fields, sender);
    const msgId = String(fields.MsgId ?? "").trim();
    const messageRef = msgId || `${fields.CreateTime ?? ""}:${sender}`;
    return {
      channel: CHANNEL_ID,
      chat_id: sender,
      chat_type: "dm",
      sender_id: sender,
      sender_name: sender,
      thread_id: null,
      text: String(fields.Content ?? ""),
      attachments,
      message_ref: messageRef,
    };
  }

  private async collectAttachments(
    fields: Record<string, string>,
    sender: string,
  ): Promise<Attachment[]> {
    const mediaId = String(fields.MediaId ?? "").trim();
    if (!mediaId) {
      return [];
    }
    const msgType = String(fields.MsgType ?? "");
    const kind: AttachmentKind =
      msgType === "image"
        ? "image"
        : msgType === "voice"
          ? "audio"
          : msgType === "video"
            ? "video"
            : "document";
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const fallback = `${fields.MsgId || "file"}${KIND_EXT[kind]}`;
    const dest = path.join(dir, safeFilename(fields.FileName, fallback));
    let bytes: Buffer;
    try {
      bytes = await this.apiBytes("media/get", { media_id: mediaId });
    } catch {
      return [];
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      await this.sendText(sender, OVERSIZE_NOTICE).catch(() => {});
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
  }

  private async getAccessToken(): Promise<string> {
    const now = performance.now() / 1000;
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const params = new URLSearchParams({
      corpid: this.corpId,
      corpsecret: this.secret,
    });
    const resp = await this.fetchImpl(`${this.apiBaseUrl}/gettoken?${params.toString()}`, {
      method: "GET",
    });
    const data = (await resp.json()) as Record<string, unknown>;
    const token = String(data.access_token ?? "");
    if (!token) {
      throw new Error(`wecom gettoken failed: ${String(data.errmsg ?? "no access_token")}`);
    }
    const expiresIn = Number(data.expires_in ?? 7200) || 7200;
    this.accessToken = token;
    this.tokenExpiresAt = now + Math.max(300, expiresIn - 300);
    return token;
  }

  private async apiJson(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({ access_token: token });
    const resp = await this.fetchImpl(
      `${this.apiBaseUrl}/${endpoint}?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  private async apiBytes(
    endpoint: string,
    extraParams: Record<string, string>,
  ): Promise<Buffer> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({ access_token: token, ...extraParams });
    const resp = await this.fetchImpl(
      `${this.apiBaseUrl}/${endpoint}?${params.toString()}`,
      { method: "GET" },
    );
    if (!resp.ok) {
      throw new Error(`wecom ${endpoint} HTTP ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.started) {
      return;
    }
    try {
      if (payload.text) {
        await this.sendText(target.chat_id, payload.text);
      }
      for (const att of payload.attachments ?? []) {
        const msgType = KIND_MSGTYPE[att.kind] ?? "file";
        const mediaId = await this.uploadMedia(att, msgType);
        await this.apiJson("message/send", {
          touser: target.chat_id,
          msgtype: msgType,
          agentid: this.agentId,
          [msgType]: { media_id: mediaId },
        });
      }
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendText(userId: string, text: string): Promise<void> {
    await this.apiJson("message/send", {
      touser: userId,
      msgtype: "text",
      agentid: this.agentId,
      text: { content: text },
    });
  }

  private async uploadMedia(attachment: Attachment, msgType: string): Promise<string> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({ access_token: token, type: msgType });
    const bytes = fs.readFileSync(attachment.path);
    const filename = path.basename(attachment.path);
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: attachment.content_type }), filename);
    const resp = await this.fetchImpl(
      `${this.apiBaseUrl}/media/upload?${params.toString()}`,
      {
        method: "POST",
        body: form,
      },
    );
    const data = (await resp.json()) as Record<string, unknown>;
    const mediaId = String(data.media_id ?? "");
    if (!mediaId) {
      throw new Error(`wecom media/upload failed: ${String(data.errmsg ?? "no media_id")}`);
    }
    return mediaId;
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export interface WeComBuildOptions {
  readonly host?: string;
  readonly port?: number;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: WeComBuildOptions,
): WeComChannel {
  const extra = config.extra;
  const corpId = String(extra.corp_id ?? "").trim();
  const agentIdStr = String(extra.agent_id ?? "").trim();
  const secret = String(extra.secret ?? "").trim();
  const encodingAesKey = String(extra.encoding_aes_key ?? "").trim();
  const token = String(config.token ?? "").trim();

  const missing: string[] = [];
  if (!corpId) missing.push("corp_id");
  if (!agentIdStr) missing.push("agent_id");
  if (!secret) missing.push("secret");
  if (!encodingAesKey) missing.push("encoding_aes_key");
  if (!token) missing.push("token");
  if (missing.length > 0) {
    throw new Error(
      `channel 'wecom' requires non-empty ${missing.join(", ")} (channels.wecom.<key>)`,
    );
  }
  if (!/^\d+$/.test(agentIdStr)) {
    throw new Error(
      "channel 'wecom' agent_id must be an integer (channels.wecom.agent_id)",
    );
  }
  try {
    decodeEncodingAesKey(encodingAesKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`channel 'wecom' encoding_aes_key is invalid: ${detail}`);
  }
  const host = options?.host ?? (String(extra.callback_host ?? "").trim() || DEFAULT_CALLBACK_HOST);
  const port =
    options?.port ??
    (extra.callback_port !== undefined ? Number(extra.callback_port) : DEFAULT_CALLBACK_PORT);

  return new WeComChannel({
    corpId,
    agentId: Number.parseInt(agentIdStr, 10),
    secret,
    token,
    encodingAesKey,
    uploadsRoot,
    host,
    port,
    apiBaseUrl: options?.apiBaseUrl,
    fetchImpl: options?.fetchImpl,
  });
}
