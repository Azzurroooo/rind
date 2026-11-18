import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { runtimeMethods } from "../protocol/runtime-protocol.js";
import { workspaceFileRequest } from "./files.js";
import { localAddresses, outboundAddress } from "./network.js";
import { isRemoteRuntimeMethod } from "./policy.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 9 * 1024 * 1024;

const ALLOWED_REMOTE_METHODS = new Set<string>(
  Object.values(runtimeMethods).filter(isRemoteRuntimeMethod),
);

const GLOBAL_SESSION_EVENTS = new Set([
  "folder_defaults_changed",
  "session_renamed",
  "session_deleted",
  "session_discarded",
  "session_settings_changed",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
]);

const UNSCOPED_REMOTE_METHODS = new Set([
  "session/new",
  "session/create",
  "session/list",
  "rind/usage/summary",
  "rind/auth/list",
  "model/list",
  "rind/folder_defaults/get",
  "rind/folder_defaults/set",
  "rind/folder_defaults/unset",
  "rind/folder_defaults/resolve",
  "agents/get",
  "agents/request",
  "agents/openSession",
  "agents/createSession",
  "workspace/dirs",
]);

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
};

const PRIVATE_LAN_IPV4 =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

const secret = (): string => randomBytes(24).toString("base64url");
// Packaged Rind clients serve only bundled assets at these fixed origins.
// Origin is not authentication: every upgrade still consumes a one-time ticket.
const MOBILE_ORIGINS = new Set(["http://rind.local", "capacitor://rind.local"]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface RemoteOptions {
  scope: "loopback" | "lan";
  port?: number;
  externalOrigin?: string;
}

export interface RemoteState {
  running: boolean;
  scope: "loopback" | "lan";
  port: number;
  addresses: string[];
  accessCode: string;
  clients: number;
}

export interface RemoteEventPayload {
  type?: string;
  sequence: number;
  durability: "durable" | "incremental";
  sessionId?: string;
  session_id?: string;
  turnId?: string;
  turn_id?: string;
  event: Record<string, unknown>;
  generation?: number;
}

export interface RemoteBridge {
  initialize: () => Promise<unknown>;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: any) => void) => () => void;
  workspaceDirs?: (params: Record<string, unknown>) => Promise<unknown>;
  agentsRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  subscribeAgents?: (listener: (state: unknown) => void) => () => void;
  settingsLoad?: () => Promise<unknown>;
  settingsSave?: (value: unknown) => Promise<unknown>;
}

interface RemoteClientSession {
  subscriptions: Set<string>;
  pending: Set<string | number>;
  selected: string;
  workspace: string;
  alive: boolean;
}

function encodeServerWsFrame(opcode: number, payloadBuffer: Buffer): Buffer {
  const length = payloadBuffer.length;
  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length >= 126) headerLength += 2;

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (length < 126) {
    frame[1] = length;
  } else if (length < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  payloadBuffer.copy(frame, offset);
  return frame;
}

class ServerWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = ServerWebSocket.CONNECTING;
  private socket: Duplex | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentLength = 0;
  private fragmentOpcode = 0;
  private closeCode = 1005;
  private closeReason: Buffer = Buffer.alloc(0);
  private closeEmitted = false;

  get bufferedAmount(): number {
    return this.socket?.writableLength ?? 0;
  }

  attachSocket(socket: Duplex, head?: Buffer): void {
    this.socket = socket;
    (socket as { setNoDelay?: (noDelay?: boolean) => void }).setNoDelay?.(true);
    this.readyState = ServerWebSocket.OPEN;

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
      this.terminate();
    });
    socket.on("close", () => this.finalizeClose());
    socket.on("end", () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
      this.finalizeClose();
    });

    if (head && head.length > 0) {
      this.onData(head);
    }
  }

  private onData(chunk: Buffer): void {
    if (this.readyState === ServerWebSocket.CLOSED) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2 && this.readyState !== ServerWebSocket.CLOSED) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;

      if (rsv !== 0 || !masked) {
        this.close(1002, "Protocol error");
        this.terminate();
        return;
      }

      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
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

      if (this.buffer.length < offset + 4 + payloadLen) return;

      const maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i & 3];
      }

      if (opcode >= 0x8) {
        this.handleControlFrame(opcode, payload);
        continue;
      }

      if (opcode !== 0x0) {
        this.fragments = [payload];
        this.fragmentLength = payload.length;
        this.fragmentOpcode = opcode;
      } else {
        if (this.fragmentOpcode === 0) {
          this.close(1002, "Unexpected continuation frame");
          this.terminate();
          return;
        }
        this.fragmentLength += payload.length;
        if (this.fragmentLength > MAX_PAYLOAD) {
          this.close(1009, "Message too big");
          this.terminate();
          return;
        }
        this.fragments.push(payload);
      }

      if (fin) {
        const message =
          this.fragments.length === 1
            ? this.fragments[0]
            : Buffer.concat(this.fragments, this.fragmentLength);
        const isBinary = this.fragmentOpcode === 0x2;
        this.fragments = [];
        this.fragmentLength = 0;
        this.fragmentOpcode = 0;
        this.emit("message", message, isBinary);
      }
    }
  }

  private handleControlFrame(opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      let code = 1005;
      let reason: Buffer = Buffer.alloc(0);
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2);
      }
      this.closeCode = code;
      this.closeReason = reason;
      if (this.readyState === ServerWebSocket.OPEN) {
        this.readyState = ServerWebSocket.CLOSING;
        const echoPayload = Buffer.allocUnsafe(payload.length >= 2 ? 2 : 0);
        if (echoPayload.length === 2) echoPayload.writeUInt16BE(code, 0);
        this.writeFrame(0x8, echoPayload);
      }
      try {
        this.socket?.end();
      } catch {
        // ignore
      }
      this.finalizeClose();
      return;
    }
    if (opcode === 0x9) {
      if (this.readyState === ServerWebSocket.OPEN) {
        this.writeFrame(0x0a, payload);
      }
      this.emit("ping", payload);
      return;
    }
    if (opcode === 0x0a) {
      this.emit("pong", payload);
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeServerWsFrame(opcode, payload));
    } catch {
      this.terminate();
    }
  }

  send(data: string | Buffer | Uint8Array): void {
    if (this.readyState !== ServerWebSocket.OPEN) return;
    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array;
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    this.writeFrame(isBinary ? 0x2 : 0x1, payload);
  }

  ping(data: string | Buffer = Buffer.alloc(0)): void {
    if (this.readyState !== ServerWebSocket.OPEN) return;
    this.writeFrame(0x9, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === ServerWebSocket.CLOSED ||
      this.readyState === ServerWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = ServerWebSocket.CLOSING;
    this.closeCode = code;
    const reasonBuf = Buffer.from(String(reason || ""), "utf8");
    this.closeReason = reasonBuf;
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.writeFrame(0x8, payload);
    try {
      this.socket?.end();
    } catch {
      // ignore
    }
  }

  terminate(): void {
    this.readyState = ServerWebSocket.CLOSED;
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.finalizeClose();
  }

  private finalizeClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = ServerWebSocket.CLOSED;
    this.emit("close", this.closeCode, this.closeReason);
  }
}

export class RemoteServer {
  private readonly bridge: RemoteBridge;
  private readonly webRoot: string;
  private readonly changed: (state: RemoteState) => void;
  private readonly allowMissingWebRoot: boolean;
  private server: Server | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeAgents: (() => void) | undefined;
  private accessCode = "";
  private readonly tickets = new Map<string, number>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  private readonly clients = new Map<ServerWebSocket, RemoteClientSession>();
  private allowedHosts = new Set<string>();
  options: RemoteOptions = { scope: "loopback" };
  private addresses: string[] = [];
  private port = 0;
  private epoch = 0;
  private starting = false;
  private stopping: Promise<void> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    bridge: RemoteBridge,
    webRoot: string,
    changed: (state: RemoteState) => void = () => {},
    { allowMissingWebRoot = false }: { allowMissingWebRoot?: boolean } = {},
  ) {
    this.bridge = bridge;
    this.webRoot = webRoot;
    this.changed = changed;
    this.allowMissingWebRoot = Boolean(allowMissingWebRoot);
  }

  state(): RemoteState {
    return {
      running: Boolean(this.server?.listening),
      scope: this.options.scope,
      port: this.port,
      addresses: [...this.addresses],
      accessCode: this.accessCode,
      clients: this.clients.size,
    };
  }

  private publish(): void {
    this.changed(this.state());
  }

  async start(options: RemoteOptions): Promise<RemoteState> {
    if (this.starting || this.stopping) {
      throw new Error("Remote access is changing. Try again shortly.");
    }
    if (this.server?.listening) return this.state();
    if (!options || !["loopback", "lan"].includes(options.scope)) {
      throw new Error("Choose local network or this computer.");
    }
    if (
      options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    ) {
      throw new Error("Invalid port.");
    }
    let external: URL | undefined;
    if (options.externalOrigin) {
      external = new URL(options.externalOrigin);
      if (
        external.protocol !== "https:" ||
        external.username ||
        external.password ||
        external.pathname !== "/" ||
        external.search ||
        external.hash
      ) {
        throw new Error("Enter an HTTPS origin, without a path or credentials.");
      }
    }
    this.starting = true;
    const startEpoch = ++this.epoch;
    try {
      if (!this.allowMissingWebRoot) {
        try {
          await stat(resolve(this.webRoot, "index.html"));
        } catch {
          throw new Error(
            "Web client is missing. Run npm run build:web in desktop, then try again.",
          );
        }
      }
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.");
      await this.bridge.initialize();
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.");
      this.options = { ...options, externalOrigin: external?.origin };
      this.accessCode = secret();
      const machineHost = hostname().toLowerCase();
      const hosts = new Set([
        "localhost",
        "127.0.0.1",
        "[::1]",
        machineHost,
        `${machineHost}.local`,
      ]);
      const local =
        options.scope === "lan"
          ? localAddresses(undefined, await outboundAddress()).map((entry) => entry.address)
          : [];
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.");
      for (const address of local) hosts.add(address.toLowerCase());
      if (external) hosts.add(external.hostname.toLowerCase());
      this.allowedHosts = hosts;
      const server = createServer((request, response) => {
        void this.http(request, response).catch(() => {
          if (!response.headersSent) {
            this.json(response, 500, { error: "Unable to serve this request." });
          } else {
            response.end();
          }
        });
      });
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.maxConnections = 64;
      this.server = server;

      server.on("upgrade", (request, socket, head) => {
        const address = this.requestUrl(request);
        const ticket = address?.searchParams.get("ticket") || "";
        const expires = this.tickets.get(ticket) || 0;
        this.tickets.delete(ticket);
        const key =
          typeof request.headers["sec-websocket-key"] === "string"
            ? request.headers["sec-websocket-key"].trim()
            : "";
        const isWsUpgrade =
          String(request.headers.upgrade || "").toLowerCase() === "websocket" && Boolean(key);
        if (
          !isWsUpgrade ||
          !address ||
          address.pathname !== "/ws" ||
          !(MOBILE_ORIGINS.has(request.headers.origin || "") || this.validOrigin(request)) ||
          expires <= Date.now() ||
          this.clients.size >= 16
        ) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        const acceptKey = createHash("sha1")
          .update(key + WS_GUID)
          .digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${acceptKey}`,
            "\r\n",
          ].join("\r\n"),
        );
        const ws = new ServerWebSocket();
        ws.attachSocket(socket, head);
        this.accept(ws);
      });

      await new Promise<void>((resolveReady, reject) => {
        server.once("error", reject);
        server.listen(
          options.port ?? 8766,
          options.scope === "lan" ? "0.0.0.0" : "127.0.0.1",
          () => {
            server.removeListener("error", reject);
            resolveReady();
          },
        );
      });
      if (startEpoch !== this.epoch) {
        await new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
        throw new Error("Remote access startup cancelled.");
      }
      server.on("error", () => {
        void this.stop();
      });
      const address = server.address();
      this.port = typeof address === "object" && address ? address.port : 0;
      this.addresses = [
        ...(external ? [external.origin] : []),
        ...[...local].map((host) => `http://${host}:${this.port}`),
        `http://127.0.0.1:${this.port}`,
      ];
      this.heartbeat = setInterval(() => {
        for (const [ws, client] of this.clients) {
          if (!client.alive) {
            ws.terminate();
            continue;
          }
          client.alive = false;
          if (ws.readyState === ServerWebSocket.OPEN) ws.ping();
        }
      }, 30000);
      this.heartbeat.unref();

      this.unsubscribe = this.bridge.subscribe((event) => {
        const sessionId = String(event.sessionId ?? event.session_id ?? "");
        const turnId = String(event.turnId ?? event.turn_id ?? "");
        const type = String(event.type ?? event.event?.type ?? "");
        const globalEvent = !sessionId || GLOBAL_SESSION_EVENTS.has(type);
        for (const [ws, client] of this.clients) {
          if (globalEvent || client.subscriptions.has(sessionId)) {
            this.send(ws, {
              kind: "event",
              method: "session/update",
              sequence: event.sequence,
              durability: event.durability,
              session_id: sessionId,
              turn_id: turnId,
              event: event.event,
            });
          }
        }
      });

      this.unsubscribeAgents = this.bridge.subscribeAgents?.((state) => {
        const eventPayload =
          state && typeof state === "object" && !Array.isArray(state)
            ? { type: "agents_changed", ...(state as Record<string, unknown>) }
            : state;
        for (const ws of this.clients.keys()) {
          this.send(ws, { kind: "event", method: "agents/update", event: eventPayload });
        }
      });

      this.publish();
      return this.state();
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  rotate(): RemoteState {
    if (!this.server?.listening) throw new Error("Enable remote access first.");
    ++this.epoch;
    this.accessCode = secret();
    this.tickets.clear();
    this.attempts.clear();
    for (const ws of this.clients.keys()) ws.close(4401, "Access code changed");
    this.clients.clear();
    this.publish();
    return this.state();
  }

  notifyWorkspacesChanged(): void {
    for (const ws of this.clients.keys()) {
      this.send(ws, {
        kind: "event",
        method: "session/update",
        durability: "ephemeral",
        event: { type: "folder_defaults_changed" },
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.close();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private async close(): Promise<void> {
    ++this.epoch;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.tickets.clear();
    this.attempts.clear();
    this.accessCode = "";
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
    this.port = 0;
    this.addresses = [];
    this.publish();
  }

  private isAllowedHost(host: string): boolean {
    const normalized = host.toLowerCase();
    if (this.allowedHosts.has(normalized)) return true;
    if (this.options.scope === "lan") {
      if (PRIVATE_LAN_IPV4.test(normalized)) {
        this.allowedHosts.add(normalized);
        return true;
      }
      for (const entry of localAddresses()) {
        this.allowedHosts.add(entry.address.toLowerCase());
      }
      if (this.allowedHosts.has(normalized)) return true;
    }
    return false;
  }

  private requestUrl(request: IncomingMessage): URL | null {
    try {
      const path = request.url || "/";
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
      const host = new URL(`http://${request.headers.host}`);
      if (
        host.username ||
        host.password ||
        host.host !== request.headers.host?.toLowerCase() ||
        !this.isAllowedHost(host.hostname)
      ) {
        return null;
      }
      return new URL(path, host);
    } catch {
      return null;
    }
  }

  private validOrigin(request: IncomingMessage): boolean {
    if (!request.headers.origin) return true;
    try {
      const origin = new URL(request.headers.origin);
      if (origin.origin === this.options.externalOrigin) return true;
      return (
        ["http:", "https:"].includes(origin.protocol) &&
        origin.host === request.headers.host?.toLowerCase() &&
        this.isAllowedHost(origin.hostname)
      );
    } catch {
      return false;
    }
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  }

  private readJsonBody(
    request: IncomingMessage,
    maxBytes = 65536,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let total = 0;
      request.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          rejectBody(new Error("Request payload too large."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          resolveBody(text ? asRecord(JSON.parse(text)) : {});
        } catch (err) {
          rejectBody(err);
        }
      });
      request.on("error", rejectBody);
    });
  }

  private async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = this.requestUrl(request);
    if (!address || !this.validOrigin(request)) {
      this.json(response, 403, { error: "Origin not allowed." });
      return;
    }
    if (
      address.pathname === "/api/settings" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      if (this.clients.size === 0) {
        const code = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, "") || "");
        const expected = Buffer.from(this.accessCode);
        if (!expected.length || code.length !== expected.length || !timingSafeEqual(code, expected)) {
          this.json(response, 401, { error: "Unauthorized." });
          return;
        }
      }
      try {
        if (request.method === "POST") {
          if (!this.bridge.settingsSave) {
            this.json(response, 404, { error: "Settings API unavailable." });
            return;
          }
          const body = await this.readJsonBody(request);
          const saved = await this.bridge.settingsSave(body);
          const authList = await this.bridge
            .request("rind/auth/list", {})
            .catch(() => ({ providers: [] }));
          this.json(response, 200, {
            settings: saved,
            providers: asRecord(authList).providers || [],
          });
          return;
        }
        if (!this.bridge.settingsLoad) {
          this.json(response, 404, { error: "Settings API unavailable." });
          return;
        }
        const [settings, authList] = await Promise.all([
          this.bridge.settingsLoad(),
          this.bridge.request("rind/auth/list", {}).catch(() => ({ providers: [] })),
        ]);
        this.json(response, 200, { settings, providers: asRecord(authList).providers || [] });
        return;
      } catch (err) {
        this.json(response, 400, {
          error: err instanceof Error ? err.message : "Failed to process settings.",
        });
        return;
      }
    }
    if (
      address.pathname === "/ticket" &&
      (request.method === "GET" || request.method === "HEAD" || request.method === "POST")
    ) {
      const now = Date.now();
      for (const [key, value] of this.attempts) {
        if (value.expires <= now) this.attempts.delete(key);
      }
      for (const [key, value] of this.tickets) {
        if (value <= now) this.tickets.delete(key);
      }
      const ip = request.socket.remoteAddress || "unknown";
      const attempts = this.attempts.get(ip) || { count: 0, expires: now + 60000 };
      if (++attempts.count > 30 || this.attempts.size > 1024) {
        this.json(response, 429, { error: "Too many attempts. Try again in a minute." });
        return;
      }
      this.attempts.set(ip, attempts);
      const code = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, "") || "");
      const expected = Buffer.from(this.accessCode);
      if (!expected.length || code.length !== expected.length || !timingSafeEqual(code, expected)) {
        this.json(response, 401, { error: "Access code invalid." });
        return;
      }
      if (this.tickets.size >= 128) {
        this.json(response, 429, { error: "Too many pending connections." });
        return;
      }
      const ticket = secret();
      this.tickets.set(ticket, now + 60000);
      this.json(response, 200, { ticket });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.json(response, 405, { error: "Method not allowed." });
      return;
    }
    if (address.pathname === "/healthz") {
      this.json(response, 200, { ok: true });
      return;
    }
    let path: string;
    try {
      const root = await realpath(this.webRoot);
      path = await realpath(
        resolve(
          root,
          `.${decodeURIComponent(address.pathname === "/" ? "/index.html" : address.pathname)}`,
        ),
      );
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || !STATIC_MIME_TYPES[extname(path)]) {
        throw new Error("Not found");
      }
    } catch {
      if (
        this.allowMissingWebRoot &&
        (address.pathname === "/" || address.pathname === "/index.html")
      ) {
        const fallbackHtml =
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rind Remote</title><body style="font-family:system-ui,sans-serif;background:#141714;color:#e6e8e3;padding:2rem;text-align:center"><h2>Rind Remote Access is active</h2><p>Connect using the Rind Mobile App, or run <code>npm --prefix frontend-web run build</code> on the host to enable the browser web client.</p></body>';
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : fallbackHtml);
        return;
      }
      this.json(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": STATIC_MIME_TYPES[extname(path)],
      "Cache-Control": extname(path) === ".html" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    response.end(request.method === "HEAD" ? undefined : await readFile(path));
  }

  private send(ws: ServerWebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== ServerWebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      ws.close(1013, "Slow connection; reconnect to restore history");
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private accept(ws: ServerWebSocket): void {
    const client: RemoteClientSession = {
      subscriptions: new Set(),
      pending: new Set(),
      selected: "",
      workspace: "",
      alive: true,
    };
    const epoch = this.epoch;
    this.clients.set(ws, client);
    this.publish();
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      this.clients.delete(ws);
      this.publish();
    });
    ws.on("message", (raw: Buffer, binary: boolean) => {
      if (binary || epoch !== this.epoch) {
        ws.close(4401);
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(raw.toString()));
      } catch {
        ws.close(1007, "Invalid JSON");
        return;
      }
      const id = message.request_id;
      if (
        message.kind !== "request" ||
        (typeof id !== "string" && typeof id !== "number") ||
        String(id).length > 128 ||
        typeof message.method !== "string"
      ) {
        ws.close(1008, "Invalid request");
        return;
      }
      if (client.pending.has(id) || client.pending.size >= 32) {
        this.send(ws, {
          kind: "response",
          request_id: id,
          error: { type: "Busy", message: "Too many pending requests or duplicate request id." },
        });
        return;
      }
      client.pending.add(id);
      void this.dispatch(client, message.method, asRecord(message.params))
        .then((result) => {
          if (epoch === this.epoch) this.send(ws, { kind: "response", request_id: id, result });
        })
        .catch((error) => {
          if (epoch === this.epoch) {
            const err = error as Error | undefined;
            this.send(ws, {
              kind: "response",
              request_id: id,
              error: { type: err?.name || "Error", message: err?.message || String(error) },
            });
          }
        })
        .finally(() => client.pending.delete(id));
    });
  }

  private async dispatch(
    client: RemoteClientSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "ping") return { ok: true };
    if (method === "initialize") {
      const result = asRecord(await this.bridge.initialize());
      client.selected = String(result.session_id || "");
      client.workspace = String(result.workspace_root || "");
      if (client.selected) client.subscriptions.add(client.selected);
      const agentMethods = this.bridge.agentsRequest
        ? ["agents/get", "agents/request", "agents/openSession", "agents/createSession"]
        : [];
      const workspaceMethods =
        typeof this.bridge.workspaceDirs === "function" ? ["workspace/dirs"] : [];
      const caps = Array.isArray(result.capabilities) ? result.capabilities : [];
      const capabilities = this.bridge.agentsRequest
        ? [...new Set([...caps, "agents_management"])]
        : caps;
      const agentsState = this.bridge.agentsRequest
        ? await this.bridge.agentsRequest("getState", {}).catch(() => null)
        : null;
      return {
        ...result,
        capabilities,
        methods: [
          ...new Set([
            ...ALLOWED_REMOTE_METHODS,
            "initialize",
            "ping",
            "session/subscribe",
            "session/unsubscribe",
            ...agentMethods,
            ...workspaceMethods,
          ]),
        ],
        gateway: {
          desktop: true,
          files_follow_session: true,
          agents: Boolean(this.bridge.agentsRequest),
        },
        ...(agentsState ? { agents_state: agentsState } : {}),
      };
    }
    if (method === "workspace/dirs") {
      if (typeof this.bridge.workspaceDirs !== "function") {
        throw new Error("Directory browsing is not available on this host.");
      }
      return this.bridge.workspaceDirs(params);
    }
    if (
      method === "agents/get" ||
      method === "agents/request" ||
      method === "agents/openSession" ||
      method === "agents/createSession"
    ) {
      if (!this.bridge.agentsRequest) {
        throw new Error("Agents management is not available on this gateway.");
      }
      if (method === "agents/get") {
        return this.bridge.agentsRequest("getState", {});
      }
      if (method === "agents/openSession") {
        const res = asRecord(await this.bridge.agentsRequest("openSession", params));
        client.selected = String(res.runtimeSessionId || "");
        if (typeof res.workspaceRoot === "string" && res.workspaceRoot) {
          client.workspace = res.workspaceRoot;
        }
        if (client.selected && client.subscriptions.size < 128) {
          client.subscriptions.add(client.selected);
        }
        return res;
      }
      if (method === "agents/createSession") {
        const res = asRecord(
          await this.bridge.agentsRequest("createSession", {
            ...params,
            workspace_root: params.workspace_root || client.workspace,
          }),
        );
        client.selected = String(res.session_id || "");
        if (typeof res.workspace_root === "string" && res.workspace_root) {
          client.workspace = res.workspace_root;
        }
        if (client.selected && client.subscriptions.size < 128) {
          client.subscriptions.add(client.selected);
        }
        return res;
      }
      const op = typeof params.operation === "string" ? params.operation.trim() : "";
      if (!op) throw new Error("agents/request requires operation.");
      return this.bridge.agentsRequest(op, asRecord(params.params));
    }
    const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";
    if (method === "session/unsubscribe") {
      client.subscriptions.delete(sessionId);
      return { ok: true };
    }
    if (method === "session/subscribe") {
      if (!sessionId || client.subscriptions.size >= 128) {
        throw new Error("Invalid session or subscription limit reached.");
      }
      await this.bridge.request("session/subscribe", params);
      client.subscriptions.add(sessionId);
      return { ok: true };
    }
    if (method.startsWith("file/")) {
      if (!["file/list", "file/read", "file/write"].includes(method)) {
        throw new Error("Choose a session before browsing files.");
      }
      if (sessionId) {
        const session = asRecord(
          await this.bridge.request("session/switch", { session_id: sessionId }),
        );
        if (typeof session.workspace_root !== "string") {
          throw new Error("Session workspace unavailable.");
        }
        return workspaceFileRequest(session.workspace_root, method, params);
      }
      if (client.workspace && !client.selected) {
        return workspaceFileRequest(client.workspace, method, params);
      }
      throw new Error("Choose a session before browsing files.");
    }
    if (!isRemoteRuntimeMethod(method)) {
      throw new Error("Method is not available through remote access.");
    }
    if (!UNSCOPED_REMOTE_METHODS.has(method) && !sessionId) {
      throw new Error("session_id is required.");
    }
    if (method === "session/new" || method === "session/create") {
      const workspace =
        typeof params.workspace_root === "string"
          ? params.workspace_root.trim()
          : client.workspace;
      if (!workspace) throw new Error("Choose a project folder on the Rind computer first.");
      const {
        external_tools: _ignoredTools,
        enable_user_question: _ignoredQuestion,
        ...safeParams
      } = params;
      params = { ...safeParams, workspace_root: workspace };
    } else if (method === "session/replay") {
      const {
        external_tools: _ignoredTools,
        enable_user_question: _ignoredQuestion,
        ...safeParams
      } = params;
      params = safeParams;
    }
    if (sessionId && client.subscriptions.size < 128) client.subscriptions.add(sessionId);
    const result = await this.bridge.request(method, params);
    if (method === "session/switch" || method === "session/new" || method === "session/create") {
      client.selected = String(asRecord(result).session_id || sessionId);
      client.workspace = String(
        asRecord(result).workspace_root || params.workspace_root || client.workspace,
      );
      if (client.selected && client.subscriptions.size < 128) {
        client.subscriptions.add(client.selected);
      }
    } else if (
      method === "session/list" &&
      typeof params.workspace_root === "string" &&
      params.workspace_root.trim()
    ) {
      const nextWorkspace = String(
        asRecord(result).workspace_root || params.workspace_root.trim(),
      );
      if (nextWorkspace) {
        client.workspace = nextWorkspace;
        const sessions = Array.isArray(asRecord(result).sessions)
          ? (asRecord(result).sessions as unknown[])
          : [];
        if (sessions.length === 0) client.selected = "";
      }
    }
    return result;
  }
}
