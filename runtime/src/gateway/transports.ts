import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { WebSocket as UndiciWebSocket } from "undici";
import { AsyncQueue } from "../domain/cancellation.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_ROOT = path.resolve(THIS_DIR, "..", "..");
export const PROJECT_ROOT = path.resolve(RUNTIME_ROOT, "..");
export const DEFAULT_CLI_JS_PATH = path.resolve(THIS_DIR, "..", "cli.js");

export const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const WS_OPEN_TIMEOUT_MS = 10_000;
export const SHUTDOWN_TIMEOUT_SECONDS = 30.0;

export interface Transport {
  open(): Promise<void>;
  read(): Promise<Record<string, unknown> | null>;
  write(payload: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeJsonFrame(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly openTimeoutMs: number;
  private readonly maxPayloadBytes: number;
  private ws: WebSocketLike | null = null;
  private queue: AsyncQueue<Record<string, unknown>> | null = null;

  constructor(
    url: string,
    options?: {
      wsFactory?: WebSocketFactory;
      openTimeoutMs?: number;
      maxPayloadBytes?: number;
    },
  ) {
    this.url = url;
    this.wsFactory = options?.wsFactory ?? (u => new UndiciWebSocket(u) as unknown as WebSocketLike);
    this.openTimeoutMs = options?.openTimeoutMs ?? WS_OPEN_TIMEOUT_MS;
    this.maxPayloadBytes = options?.maxPayloadBytes ?? MAX_WS_PAYLOAD_BYTES;
  }

  async open(): Promise<void> {
    const queue = new AsyncQueue<Record<string, unknown>>();
    const ws = this.wsFactory(this.url);
    this.queue = queue;
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`WebSocket open timed out after ${this.openTimeoutMs}ms`));
      }, this.openTimeoutMs);
      timer.unref?.();

      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const onError = (ev: unknown): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const msg =
            ev && typeof ev === "object" && "message" in ev
              ? String((ev as { message?: unknown }).message)
              : "WebSocket connection error";
          reject(new Error(msg));
        }
        queue.close();
      };

      const onClose = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("WebSocket closed before opening"));
        }
        queue.close();
      };

      const onMessage = (ev: { data?: unknown }): void => {
        const data = ev?.data;
        let text: string;
        if (typeof data === "string") {
          if (Buffer.byteLength(data, "utf8") > this.maxPayloadBytes) {
            try {
              ws.close(1009, "Message too big");
            } catch {
              // ignore
            }
            queue.close();
            return;
          }
          text = data;
        } else if (data instanceof ArrayBuffer) {
          if (data.byteLength > this.maxPayloadBytes) {
            try {
              ws.close(1009, "Message too big");
            } catch {
              // ignore
            }
            queue.close();
            return;
          }
          text = Buffer.from(data).toString("utf8");
        } else if (ArrayBuffer.isView(data)) {
          if (data.byteLength > this.maxPayloadBytes) {
            try {
              ws.close(1009, "Message too big");
            } catch {
              // ignore
            }
            queue.close();
            return;
          }
          text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
        } else {
          text = String(data ?? "");
        }
        const parsed = parseJsonObject(text);
        if (parsed !== null) {
          queue.push(parsed);
        }
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    });
  }

  async read(): Promise<Record<string, unknown> | null> {
    if (!this.queue) return null;
    return await this.queue.shift();
  }

  async write(payload: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(serializeJsonFrame(payload));
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    this.queue?.close();
    this.queue = null;
    if (!ws) return;
    if (ws.readyState === 3) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        ws.close(1000);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

export class StdioTransport implements Transport {
  private readonly command: readonly string[];
  private readonly cwd: string;
  private readonly shutdownTimeoutSeconds: number;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: AsyncQueue<Record<string, unknown>> | null = null;
  private exitPromise: Promise<number | null> | null = null;
  private exited = false;

  constructor(
    command?: readonly string[],
    options?: {
      cwd?: string;
      cliJsPath?: string;
      shutdownTimeoutSeconds?: number;
    },
  ) {
    const cliPath = options?.cliJsPath ?? DEFAULT_CLI_JS_PATH;
    this.command = command ?? [process.execPath, cliPath, "app-server", "--stdio"];
    this.cwd = options?.cwd ?? PROJECT_ROOT;
    this.shutdownTimeoutSeconds = options?.shutdownTimeoutSeconds ?? SHUTDOWN_TIMEOUT_SECONDS;
  }

  get process(): ChildProcessWithoutNullStreams | null {
    return this.proc;
  }

  async open(): Promise<void> {
    const [exe, ...args] = this.command;
    if (!exe) {
      throw new Error("StdioTransport command must not be empty");
    }
    const queue = new AsyncQueue<Record<string, unknown>>();
    this.queue = queue;
    this.exited = false;

    const child = spawn(exe, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    child.stderr.resume();

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const pushLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      const parsed = parseJsonObject(line);
      if (parsed !== null) {
        queue.push(parsed);
      }
    };
    const consumeDecoded = (decoded: string): void => {
      if (!decoded) return;
      if (!decoded.includes("\n")) {
        buffer += decoded;
        return;
      }
      let offset = 0;
      let nl = decoded.indexOf("\n");
      while (nl !== -1) {
        const segment = decoded.slice(offset, nl);
        const fullLine = buffer ? buffer + segment : segment;
        buffer = "";
        pushLine(fullLine);
        offset = nl + 1;
        nl = decoded.indexOf("\n", offset);
      }
      if (offset < decoded.length) {
        buffer += decoded.slice(offset);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      consumeDecoded(decoder.write(chunk));
    });

    child.stdout.on("end", () => {
      consumeDecoded(decoder.end());
      if (buffer.trim()) {
        const remainder = buffer;
        buffer = "";
        pushLine(remainder);
      }
      queue.close();
    });

    child.on("error", () => {
      queue.close();
    });

    this.exitPromise = new Promise<number | null>(resolve => {
      child.once("close", code => {
        this.exited = true;
        queue.close();
        resolve(code);
      });
    });
  }

  async read(): Promise<Record<string, unknown> | null> {
    if (!this.queue) return null;
    return await this.queue.shift();
  }

  async write(payload: Record<string, unknown>): Promise<void> {
    const proc = this.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      throw new Error("Stdio worker stdin is closed");
    }
    const line = `${serializeJsonFrame(payload)}\n`;
    await new Promise<void>((resolve, reject) => {
      const ok = proc.stdin.write(line, "utf8", err => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
      } else {
        proc.stdin.once("drain", resolve);
        proc.stdin.once("error", reject);
      }
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    const exitPromise = this.exitPromise;
    if (!proc || !exitPromise) {
      return;
    }
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      proc.stdout?.resume();

      const timeoutMs = Math.max(1, this.shutdownTimeoutSeconds * 1000);
      let timedOut = false;
      const code = await Promise.race([
        exitPromise,
        new Promise<null>(resolve => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);

      if (timedOut && !this.exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        await Promise.race([
          exitPromise,
          new Promise<null>(resolve => {
            const timer = setTimeout(() => resolve(null), 5000);
            timer.unref?.();
          }),
        ]);
        throw new Error("Worker shutdown timed out; forced termination.");
      }

      if (code !== 0) {
        throw new Error(`Worker exited during shutdown with code ${code}.`);
      }
    } finally {
      if (this.exited || proc.exitCode !== null || proc.killed) {
        this.proc = null;
        this.exitPromise = null;
        this.queue = null;
      }
    }
  }
}

export function appendTokenToUrl(url: string, token?: string | null): string {
  if (!token || url.includes("token=")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function buildTransport(
  url: string,
  token?: string | null,
  options?: {
    wsFactory?: WebSocketFactory;
    stdioCommand?: readonly string[];
    shutdownTimeoutSeconds?: number;
  },
): Transport {
  if (url === "stdio") {
    return new StdioTransport(options?.stdioCommand, {
      shutdownTimeoutSeconds: options?.shutdownTimeoutSeconds,
    });
  }
  return new WebSocketTransport(appendTokenToUrl(url, token), { wsFactory: options?.wsFactory });
}
