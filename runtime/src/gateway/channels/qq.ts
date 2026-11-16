import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  type ServerWsConnection,
  defaultFetch,
  ensureAttachmentDir,
  safeFilename,
  upgradeToServerWs,
} from "./http-ws-utils.js";

export const CHANNEL_ID = "qq";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 4500,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "none",
});

export const DEFAULT_WS_PATH = "/onebot/v11";
export const DEFAULT_WS_PORT = 8082;
export const DEFAULT_BIND_HOST = "0.0.0.0";
export const ECHO_TIMEOUT_SECONDS = 120.0;

const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.\-]+)((?:,[^\[\]]*)*)\]/g;
const CQ_UNESCAPES: ReadonlyArray<readonly [string, string]> = [
  ["&#44;", ","],
  ["&#91;", "["],
  ["&#93;", "]"],
  ["&amp;", "&"],
];

const MEDIA_SEGMENTS: Readonly<Record<string, AttachmentKind>> = {
  image: "image",
  record: "audio",
  video: "video",
  file: "document",
};

const KIND_META: Readonly<Record<AttachmentKind, readonly [string, string]>> = {
  image: ["image/jpeg", ".jpg"],
  audio: ["audio/amr", ".amr"],
  video: ["video/mp4", ".mp4"],
  document: ["application/octet-stream", ".bin"],
};

const SEGMENT_BY_KIND: Readonly<Record<AttachmentKind, string>> = {
  image: "image",
  audio: "record",
  video: "video",
  document: "file",
};

export function cqUnescape(value: string): string {
  let out = value;
  for (const [entity, ch] of CQ_UNESCAPES) {
    out = out.split(entity).join(ch);
  }
  return out;
}

export function parseOneBotSegments(
  message: unknown,
): Array<[string, Record<string, string>]> {
  if (Array.isArray(message)) {
    const out: Array<[string, Record<string, string>]> = [];
    for (const seg of message) {
      if (!seg || typeof seg !== "object" || Array.isArray(seg)) continue;
      const s = seg as Record<string, unknown>;
      const rawData =
        s.data && typeof s.data === "object" && !Array.isArray(s.data)
          ? (s.data as Record<string, unknown>)
          : {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawData)) {
        params[k] = String(v ?? "");
      }
      out.push([String(s.type ?? ""), params]);
    }
    return out;
  }
  if (typeof message !== "string") {
    return [];
  }
  const segments: Array<[string, Record<string, string>]> = [];
  let cursor = 0;
  for (const match of message.matchAll(CQ_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push(["text", { text: cqUnescape(message.slice(cursor, start)) }]);
    }
    const type = cqUnescape(match[1] ?? "");
    const rawParams = match[2] ?? "";
    const params: Record<string, string> = {};
    for (const part of rawParams.split(",")) {
      const eq = part.indexOf("=");
      if (eq !== -1) {
        const key = cqUnescape(part.slice(0, eq).trim());
        const val = cqUnescape(part.slice(eq + 1).trim());
        params[key] = val;
      }
    }
    segments.push([type, params]);
    cursor = start + match[0].length;
  }
  if (cursor < message.length) {
    segments.push(["text", { text: cqUnescape(message.slice(cursor)) }]);
  }
  return segments;
}

function asOneBotId(value: string): number | string {
  if (/^\d+$/.test(value)) {
    const num = Number(value);
    if (Number.isSafeInteger(num)) {
      return num;
    }
  }
  return value;
}

function safeBearerEquals(authHeader: string | undefined, expectedToken: string): boolean {
  const raw = String(authHeader ?? "");
  const space = raw.indexOf(" ");
  if (space === -1) return false;
  const scheme = raw.slice(0, space).toLowerCase();
  if (scheme !== "bearer") return false;
  const cred = Buffer.from(raw.slice(space + 1).trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (cred.length !== expected.length) return false;
  return timingSafeEqual(cred, expected);
}

interface PendingEcho {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface QQChannelOptions {
  readonly wsHost?: string;
  readonly wsPath?: string;
  readonly wsPort?: number;
  readonly accessToken?: string;
  readonly fetchImpl?: FetchLike;
  readonly echoTimeoutSeconds?: number;
}

export class QQChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  private readonly uploadsRoot: string;
  private readonly wsHost: string;
  readonly wsPath: string;
  readonly wsPort: number;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly echoTimeoutSeconds: number;

  private sink: InboundSink | null = null;
  private server: http.Server | null = null;
  private conn: ServerWsConnection | null = null;
  private nextEchoId = 1;
  private readonly pending = new Map<string, PendingEcho>();
  private readonly chatKinds = new Map<string, "dm" | "group">();
  private sendChain: Promise<void> = Promise.resolve();

  constructor(uploadsRoot: string, options?: QQChannelOptions) {
    this.uploadsRoot = path.resolve(uploadsRoot);
    this.wsHost = options?.wsHost ?? DEFAULT_BIND_HOST;
    this.wsPath = options?.wsPath ?? DEFAULT_WS_PATH;
    this.wsPort = options?.wsPort ?? DEFAULT_WS_PORT;
    this.accessToken = String(options?.accessToken ?? "").trim();
    this.fetchImpl = options?.fetchImpl ?? defaultFetch();
    this.echoTimeoutSeconds = options?.echoTimeoutSeconds ?? ECHO_TIMEOUT_SECONDS;
  }

  get boundPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.wsPort;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== this.wsPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (
        this.accessToken &&
        !safeBearerEquals(req.headers.authorization, this.accessToken)
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(426, { Upgrade: "websocket" });
      res.end();
    });

    server.on("upgrade", (req, socket, head) => {
      const sock = socket as Socket;
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== this.wsPath) {
        sock.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (
        this.accessToken &&
        !safeBearerEquals(req.headers.authorization, this.accessToken)
      ) {
        sock.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const wsConn = upgradeToServerWs(req, sock, head);
      if (!wsConn) return;
      this.attachConnection(wsConn);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.wsPort, this.wsHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      await conn.close().catch(() => {});
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.failPending();
  }

  private attachConnection(wsConn: ServerWsConnection): void {
    this.conn = wsConn;
    wsConn.listen(
      raw => {
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          frame = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame.post_type === "message") {
          void this.processEvent(frame);
        } else if (frame.echo !== undefined && frame.echo !== null) {
          const echoKey = String(frame.echo);
          const pending = this.pending.get(echoKey);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(echoKey);
            const data =
              frame.data && typeof frame.data === "object" && !Array.isArray(frame.data)
                ? (frame.data as Record<string, unknown>)
                : {};
            pending.resolve(data);
          }
        }
      },
      () => {
        if (this.conn === wsConn) {
          this.conn = null;
        }
        this.failPending();
      },
    );
  }

  private failPending(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("onebot connection lost"));
    }
    this.pending.clear();
  }

  private async processEvent(frame: Record<string, unknown>): Promise<void> {
    try {
      const inbound = await this.normalizeEvent(frame);
      if (inbound && this.sink) {
        await this.sink.inbound(inbound);
      }
    } catch {
      // ignore malformed event
    }
  }

  async normalizeEvent(event: Record<string, unknown>): Promise<InboundMessage | null> {
    const senderId = String(event.user_id ?? "");
    const messageRef = String(event.message_id ?? "");
    const isGroup = event.message_type === "group";
    const chatId = isGroup ? String(event.group_id ?? "") : senderId;
    if (!chatId || !senderId || !messageRef) {
      return null;
    }
    this.chatKinds.set(chatId, isGroup ? "group" : "dm");
    const segments = parseOneBotSegments(event.message);
    const media = segments.filter(([kind]) => kind in MEDIA_SEGMENTS);
    const sender =
      event.sender && typeof event.sender === "object" && !Array.isArray(event.sender)
        ? (event.sender as Record<string, unknown>)
        : {};
    const selfId = String(event.self_id ?? "");
    const text = segments
      .map(([kind, params]) => {
        if (kind === "text") {
          return params.text ?? "";
        }
        if (kind === "at" && selfId && params.qq === selfId) {
          return "@rind";
        }
        return "";
      })
      .join("");
    const attachments = await this.collectAttachments(media, messageRef, chatId);
    return {
      channel: CHANNEL_ID,
      chat_id: chatId,
      chat_type: isGroup ? "group" : "dm",
      sender_id: senderId,
      sender_name: String(sender.nickname || sender.card || senderId),
      thread_id: null,
      text,
      attachments,
      message_ref: messageRef,
    };
  }

  private async collectAttachments(
    media: ReadonlyArray<[string, Record<string, string>]>,
    messageRef: string,
    chatId: string,
  ): Promise<Attachment[]> {
    if (media.length === 0) return [];
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const saved: Attachment[] = [];

    for (let i = 0; i < media.length; i += 1) {
      const [segType, params] = media[i]!;
      const kind = MEDIA_SEGMENTS[segType] ?? "document";
      const [contentType, ext] = KIND_META[kind];
      let source = (params.url ?? "").trim() || (params.file ?? "").trim();
      if (
        source &&
        !source.startsWith("http://") &&
        !source.startsWith("https://") &&
        !source.startsWith("file:") &&
        !source.includes("/") &&
        !source.includes("\\")
      ) {
        const res = await this.sendAction("get_image", { file: source });
        source = String(res?.url ?? res?.file ?? "");
      }
      if (!source) continue;
      let bytes: Buffer;
      try {
        bytes = await this.fetchSourceBytes(source);
      } catch {
        continue;
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        await this.send({ chat_id: chatId }, { text: OVERSIZE_NOTICE }).catch(() => {});
        continue;
      }
      const dest = path.join(
        dir,
        safeFilename(params.file, `${messageRef}-${i + 1}${ext}`),
      );
      fs.writeFileSync(dest, bytes);
      saved.push({ path: dest, content_type: contentType, kind });
    }
    return saved;
  }

  private async fetchSourceBytes(source: string): Promise<Buffer> {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const resp = await this.fetchImpl(source);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    }
    if (source.startsWith("file://")) {
      try {
        return fs.readFileSync(fileURLToPath(source));
      } catch {
        return fs.readFileSync(source.slice("file://".length));
      }
    }
    return fs.readFileSync(source);
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    if (!this.conn || this.conn.isClosed) return;
    try {
      const segments: Array<{ type: string; data: Record<string, string> }> = [];
      if (payload.text) {
        segments.push({ type: "text", data: { text: payload.text } });
      }
      for (const att of payload.attachments ?? []) {
        segments.push({
          type: SEGMENT_BY_KIND[att.kind],
          data: { file: pathToFileURL(att.path).href },
        });
      }
      if (segments.length === 0) return;
      const isDm = (this.chatKinds.get(target.chat_id) ?? "group") === "dm";
      const action = isDm ? "send_private_msg" : "send_group_msg";
      const idKey = isDm ? "user_id" : "group_id";
      await this.sendAction(action, {
        [idKey]: asOneBotId(target.chat_id),
        message: segments,
      });
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const conn = this.conn;
    if (!conn || conn.isClosed) {
      return null;
    }
    const echo = `rind-${this.nextEchoId++}`;
    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action ${action} timed out`));
      }, Math.max(10, this.echoTimeoutSeconds * 1000));
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
    });

    const frame = JSON.stringify({ action, params, echo });
    const writePromise = this.sendChain.then(() => conn.send(frame));
    this.sendChain = writePromise.catch(() => {});
    try {
      await writePromise;
      return await resultPromise;
    } finally {
      const p = this.pending.get(echo);
      if (p) clearTimeout(p.timer);
      this.pending.delete(echo);
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: QQChannelOptions,
): QQChannel {
  const wsPath =
    options?.wsPath ?? (String(config.extra.ws_path ?? "").trim() || DEFAULT_WS_PATH);
  if (!wsPath.startsWith("/")) {
    throw new Error("channel 'qq' ws_path must start with '/' (channels.qq.ws_path)");
  }
  const rawPort = options?.wsPort ?? config.extra.ws_port;
  if (
    rawPort !== undefined &&
    rawPort !== null &&
    (typeof rawPort !== "number" || !Number.isInteger(rawPort))
  ) {
    throw new Error("channel 'qq' ws_port must be an integer port in [1, 65535]");
  }
  const wsPort = typeof rawPort === "number" ? rawPort : DEFAULT_WS_PORT;
  const accessToken =
    options?.accessToken ?? String(config.extra.access_token ?? "").trim();
  return new QQChannel(uploadsRoot, {
    ...options,
    wsPath,
    wsPort,
    accessToken,
  });
}
