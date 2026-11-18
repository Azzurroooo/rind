// Test-only RFC 6455 WebSocket client supporting custom Origin and HTTP headers.
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 9 * 1024 * 1024;

function encodeClientWsFrame(opcode, payloadBuffer) {
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer || "");
  const length = payload.length;
  let headerLength = 6;
  if (length >= 65536) headerLength += 8;
  else if (length >= 126) headerLength += 2;
  const maskBytes = randomBytes(4);

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }

  maskBytes.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < length; i += 1) {
    frame[offset + i] = payload[i] ^ maskBytes[i & 3];
  }
  return frame;
}

export class RemoteWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, options = {}) {
    super();
    this.autoPong = options.autoPong !== false;
    this.readyState = RemoteWebSocket.CONNECTING;
    this.socket = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentLength = 0;
    this._fragmentOpcode = 0;
    this._closeCode = 1005;
    this._closeReason = Buffer.alloc(0);
    this._closeEmitted = false;

    const parsed = new URL(String(url));
    const isSecure = parsed.protocol === "wss:" || parsed.protocol === "https:";
    const key = randomBytes(16).toString("base64");
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
      ...(options.headers || {}),
    };
    if (options.origin) headers.Origin = options.origin;

    const reqFn = isSecure ? httpsRequest : httpRequest;
    const req = reqFn({
      protocol: isSecure ? "https:" : "http:",
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers,
    });
    this._req = req;

    req.on("upgrade", (res, socket, head) => {
      const expectedAccept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        socket.destroy();
        this.emit("error", new Error("Invalid Sec-WebSocket-Accept header"));
        this._finalizeClose();
        return;
      }
      this._attachSocket(socket, head);
      this.emit("open");
    });

    req.on("response", (res) => {
      res.resume();
      this.emit("error", new Error(`Unexpected server response: ${res.statusCode}`));
      this._finalizeClose();
    });

    req.on("error", (err) => {
      if (!this._closeEmitted) {
        this.emit("error", err);
        this._finalizeClose();
      }
    });

    req.end();
  }

  get bufferedAmount() {
    return this.socket?.writableLength ?? 0;
  }

  _attachSocket(socket, head) {
    this.socket = socket;
    socket.setNoDelay?.(true);
    this.readyState = RemoteWebSocket.OPEN;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
      this.terminate();
    });
    socket.on("close", () => this._finalizeClose());
    socket.on("end", () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
      this._finalizeClose();
    });

    if (head && head.length > 0) {
      this._onData(head);
    }
  }

  _onData(chunk) {
    if (this.readyState === RemoteWebSocket.CLOSED) return;
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2 && this.readyState !== RemoteWebSocket.CLOSED) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;

      if (rsv !== 0) {
        this.close(1002, "Protocol error");
        this.terminate();
        return;
      }

      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_PAYLOAD)) {
          this.close(1009, "Message too big");
          this.terminate();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_PAYLOAD) {
        this.close(1009, "Message too big");
        this.terminate();
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (this._buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? this._buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      this._buffer = this._buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode >= 0x8) {
        this._handleControlFrame(opcode, payload);
        continue;
      }

      if (opcode !== 0x0) {
        this._fragments = [payload];
        this._fragmentLength = payload.length;
        this._fragmentOpcode = opcode;
      } else {
        if (this._fragmentOpcode === 0) {
          this.close(1002, "Unexpected continuation frame");
          this.terminate();
          return;
        }
        this._fragmentLength += payload.length;
        if (this._fragmentLength > MAX_PAYLOAD) {
          this.close(1009, "Message too big");
          this.terminate();
          return;
        }
        this._fragments.push(payload);
      }

      if (fin) {
        const message =
          this._fragments.length === 1
            ? this._fragments[0]
            : Buffer.concat(this._fragments, this._fragmentLength);
        const isBinary = this._fragmentOpcode === 0x2;
        this._fragments = [];
        this._fragmentLength = 0;
        this._fragmentOpcode = 0;
        this.emit("message", message, isBinary);
      }
    }
  }

  _handleControlFrame(opcode, payload) {
    if (opcode === 0x8) {
      let code = 1005;
      let reason = Buffer.alloc(0);
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2);
      }
      this._closeCode = code;
      this._closeReason = reason;
      if (this.readyState === RemoteWebSocket.OPEN) {
        this.readyState = RemoteWebSocket.CLOSING;
        const echoPayload = Buffer.allocUnsafe(payload.length >= 2 ? 2 : 0);
        if (echoPayload.length === 2) echoPayload.writeUInt16BE(code, 0);
        this._writeFrame(0x8, echoPayload);
      }
      try {
        this.socket?.end();
      } catch {
        // ignore
      }
      this._finalizeClose();
      return;
    }
    if (opcode === 0x9) {
      if (this.autoPong && this.readyState === RemoteWebSocket.OPEN) {
        this._writeFrame(0x0a, payload);
      }
      this.emit("ping", payload);
      return;
    }
    if (opcode === 0x0a) {
      this.emit("pong", payload);
    }
  }

  _writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeClientWsFrame(opcode, payload));
    } catch {
      this.terminate();
    }
  }

  send(data) {
    if (this.readyState !== RemoteWebSocket.OPEN) return;
    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array;
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    this._writeFrame(isBinary ? 0x2 : 0x1, payload);
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== RemoteWebSocket.OPEN) return;
    this._writeFrame(0x9, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
  }

  pong(data = Buffer.alloc(0)) {
    if (this.readyState !== RemoteWebSocket.OPEN) return;
    this._writeFrame(0x0a, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
  }

  close(code = 1000, reason = "") {
    if (
      this.readyState === RemoteWebSocket.CLOSED ||
      this.readyState === RemoteWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = RemoteWebSocket.CLOSING;
    this.closeCode = code;
    const reasonBuf = Buffer.from(String(reason || ""), "utf8");
    this._closeReason = reasonBuf;
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(0x8, payload);
    try {
      this.socket?.end();
    } catch {
      // ignore
    }
  }

  terminate() {
    this.readyState = RemoteWebSocket.CLOSED;
    try {
      this._req?.destroy();
    } catch {
      // ignore
    }
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this._finalizeClose();
  }

  _finalizeClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.readyState = RemoteWebSocket.CLOSED;
    this.emit("close", this._closeCode, this._closeReason);
  }
}
