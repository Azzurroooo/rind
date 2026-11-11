import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const OVERSIZE_NOTICE = "Attachment too large (per-file limit 20MB); skipped.";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

const proxyAgents = new Map<string, ProxyAgent>();

export function getProxyDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  const trimmed = String(proxyUrl ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return undefined;
  }
  let agent = proxyAgents.get(trimmed);
  if (!agent) {
    agent = new ProxyAgent(trimmed);
    proxyAgents.set(trimmed, agent);
  }
  return agent;
}

export function defaultFetch(proxyUrl?: string): FetchLike {
  const dispatcher = getProxyDispatcher(proxyUrl);
  return async (input, init) => {
    const opts = dispatcher ? { ...(init ?? {}), dispatcher } : init;
    return (await undiciFetch(input as any, opts as any)) as unknown as Response;
  };
}

export function safeFilename(raw: unknown, fallback: string): string {
  const normalized = String(raw ?? "").replace(/\\/g, "/");
  const base = path.posix.basename(normalized).trim();
  const cleaned = base
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned || fallback;
}

export function ensureAttachmentDir(
  uploadsRoot: string,
  channelId: string,
  now: Date = new Date(),
): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dir = path.join(uploadsRoot, channelId, `${yyyy}${mm}${dd}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function readHttpBody(
  req: http.IncomingMessage,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("HTTP request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, total)));
    req.on("error", reject);
  });
}

// --- Minimal RFC 6455 WebSocket Server Framing (for QQ OneBot & tests) ------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_FRAME_BYTES = 24 * 1024 * 1024;

export function encodeServerWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export class ServerWsConnection {
  readonly socket: Socket;
  readonly request: http.IncomingMessage;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  constructor(socket: Socket, request: http.IncomingMessage) {
    this.socket = socket;
    this.request = request;
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  async send(text: string): Promise<void> {
    if (this.isClosed) {
      throw new Error("WebSocket connection closed");
    }
    const frame = encodeServerWsFrame(0x01, Buffer.from(text, "utf8"));
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(code = 1000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code, 0);
      const frame = encodeServerWsFrame(0x08, payload);
      await new Promise<void>(resolve => {
        this.socket.end(frame, () => resolve());
      });
    }
  }

  listen(onMessage: (raw: string) => void, onClose: () => void): void {
    let closeCalled = false;
    const notifyClose = (): void => {
      if (closeCalled) return;
      closeCalled = true;
      this.closed = true;
      onClose();
    };
    this.socket.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames(onMessage, notifyClose);
    });
    this.socket.on("close", notifyClose);
    this.socket.on("error", notifyClose);
  }

  private drainFrames(onMessage: (raw: string) => void, onClose: () => void): void {
    while (this.buffer.length >= 2 && !this.closed) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_FRAME_BYTES)) {
          void this.close(1009);
          onClose();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_FRAME_BYTES) {
        void this.close(1009);
        onClose();
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) {
        return;
      }

      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i & 3]!;
        }
      }

      if (opcode === 0x08) {
        void this.close(1000);
        onClose();
        return;
      }
      if (opcode === 0x09) {
        if (!this.isClosed) {
          this.socket.write(encodeServerWsFrame(0x0a, payload));
        }
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }
      if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (this.fragmentBytes + payload.length > MAX_WS_FRAME_BYTES) {
          void this.close(1009);
          onClose();
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) {
          const text = Buffer.concat(this.fragments, this.fragmentBytes).toString("utf8");
          this.fragments = [];
          this.fragmentBytes = 0;
          onMessage(text);
        }
      }
    }
  }
}

export function upgradeToServerWs(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
): ServerWsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key.trim()) {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1")
    .update(key.trim() + WS_GUID)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  if (head && head.length > 0) {
    socket.unshift(head);
  }
  return new ServerWsConnection(socket, req);
}
