import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  ServerWebSocket,
  encodeWsFrame,
  upgradeWebSocket,
} from "../../infrastructure/ws-server.js";

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

const MAX_WS_FRAME_BYTES = 24 * 1024 * 1024;

export const encodeServerWsFrame = encodeWsFrame;
export type ServerWsConnection = ServerWebSocket;
export const ServerWsConnection = ServerWebSocket;

export function upgradeToServerWs(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
): ServerWsConnection | null {
  return upgradeWebSocket(req, socket, head, { maxMessageBytes: MAX_WS_FRAME_BYTES });
}
