import { createHash } from "node:crypto";
import type http from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
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

export class ServerWebSocket {
  readonly socket: Socket;
  readonly request: http.IncomingMessage;
  private readonly maxMessageBytes: number;
  private closed = false;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  constructor(
    socket: Socket,
    request: http.IncomingMessage,
    options?: { maxMessageBytes?: number },
  ) {
    this.socket = socket;
    this.request = request;
    this.maxMessageBytes = options?.maxMessageBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES;
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  async sendText(text: string): Promise<void> {
    if (this.isClosed) {
      throw new Error("ConnectionClosed");
    }
    const frame = encodeWsFrame(0x01, Buffer.from(text, "utf8"));
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async send(text: string): Promise<void> {
    await this.sendText(text);
  }

  async close(code = 1000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code, 0);
      const frame = encodeWsFrame(0x08, payload);
      await new Promise<void>(resolve => {
        this.socket.end(frame, () => resolve());
      });
    }
  }

  listen(onMessage: (rawMessage: string) => void, onClose: () => void): void {
    let closeNotified = false;
    const notifyClose = (): void => {
      if (closeNotified) return;
      closeNotified = true;
      this.closed = true;
      this.chunks = [];
      this.bufferedBytes = 0;
      this.fragments = [];
      this.fragmentBytes = 0;
      onClose();
    };
    this.socket.on("data", (chunk: Buffer) => {
      if (this.closed || chunk.length === 0) return;
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
      this.drainFrames(onMessage, notifyClose);
    });
    this.socket.on("close", notifyClose);
    this.socket.on("error", notifyClose);
  }

  private peekHeader(count: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= count) {
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    for (let i = 0; i < this.chunks.length && copied < count; i += 1) {
      const chunk = this.chunks[i]!;
      const take = Math.min(chunk.length, count - copied);
      chunk.copy(out, copied, 0, take);
      copied += take;
    }
    return out;
  }

  private consumeFrame(count: number): { frame: Buffer; owned: boolean } {
    const first = this.chunks[0]!;
    if (first.length >= count) {
      const frame = first.subarray(0, count);
      if (first.length === count) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(count);
      }
      this.bufferedBytes -= count;
      return { frame, owned: false };
    }
    const frame = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, count - written);
      chunk.copy(frame, written, 0, take);
      written += take;
      if (take === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }
    this.bufferedBytes -= count;
    return { frame, owned: true };
  }

  private drainFrames(onMessage: (rawMessage: string) => void, onClose: () => void): void {
    while (this.bufferedBytes >= 2 && !this.closed) {
      const head2 = this.peekHeader(2);
      const b0 = head2[0]!;
      const b1 = head2[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.bufferedBytes < 4) return;
        payloadLen = this.peekHeader(4).readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.bufferedBytes < 10) return;
        const bigLen = this.peekHeader(10).readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxMessageBytes)) {
          void this.close(1009);
          onClose();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxMessageBytes) {
        void this.close(1009);
        onClose();
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameBytes = offset + maskLen + payloadLen;
      if (this.bufferedBytes < totalFrameBytes) {
        return;
      }

      const { frame, owned } = this.consumeFrame(totalFrameBytes);
      const maskKey = masked ? frame.subarray(offset, offset + 4) : null;
      const rawPayload = frame.subarray(offset + maskLen, totalFrameBytes);
      const payload = maskKey && !owned ? Buffer.from(rawPayload) : rawPayload;

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
          this.socket.write(encodeWsFrame(0x0a, payload));
        }
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }
      if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (this.fragmentBytes + payload.length > this.maxMessageBytes) {
          void this.close(1009);
          onClose();
          return;
        }
        this.fragments.push(owned || maskKey ? payload : Buffer.from(payload));
        this.fragmentBytes += payload.length;
        if (fin) {
          const full =
            this.fragments.length === 1
              ? this.fragments[0]!.toString("utf8")
              : Buffer.concat(this.fragments, this.fragmentBytes).toString("utf8");
          this.fragments = [];
          this.fragmentBytes = 0;
          onMessage(full);
        }
      }
    }
  }
}

export function upgradeWebSocket(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  options?: { maxMessageBytes?: number },
): ServerWebSocket | null {
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
  return new ServerWebSocket(socket, req, options);
}
