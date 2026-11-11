import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket as UndiciWebSocket } from "undici";

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

class AsyncMessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T | null) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }

  async shift(): Promise<T | null> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    if (this.ended) {
      return null;
    }
    return await new Promise<T | null>(resolve => {
      this.waiters.push(resolve);
    });
  }
}

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly openTimeoutMs: number;
  private readonly maxPayloadBytes: number;
  private ws: WebSocketLike | null = null;
  private queue: AsyncMessageQueue<Record<string, unknown>> | null = null;

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
    const queue = new AsyncMessageQueue<Record<string, unknown>>();
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
        queue.end();
      };

      const onClose = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("WebSocket closed before opening"));
        }
        queue.end();
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
            queue.end();
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
            queue.end();
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
            queue.end();
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
    this.queue?.end();
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
  private queue: AsyncMessageQueue<Record<string, unknown>> | null = null;
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
    const queue = new AsyncMessageQueue<Record<string, unknown>>();
    this.queue = queue;
    this.exited = false;

    const child = spawn(exe, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    child.stderr.resume();

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseJsonObject(line);
        if (parsed !== null) {
          queue.push(parsed);
        }
      }
    });

    child.stdout.on("end", () => {
      if (buffer.trim()) {
        const parsed = parseJsonObject(buffer);
        buffer = "";
        if (parsed !== null) {
          queue.push(parsed);
        }
      }
      queue.end();
    });

    child.on("error", () => {
      queue.end();
    });

    this.exitPromise = new Promise<number | null>(resolve => {
      child.once("close", code => {
        this.exited = true;
        queue.end();
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
  const authedUrl = token && !url.includes("token=")
    ? `${url}${url.includes("?") ? "&" : "?"}token=${token}`
    : url;
  return new WebSocketTransport(authedUrl, { wsFactory: options?.wsFactory });
}
