import { type Transport, buildTransport } from "./transports.js";

export const RuntimeMethod = {
  INITIALIZE: "initialize",
  SESSION_PROMPT: "session/prompt",
  SESSION_REPLAY: "session/replay",
  SESSION_SUBSCRIBE: "session/subscribe",
  RIND_SESSION_FOLLOW_UP: "rind/session/follow_up",
  // BUG FIX 1: hyphenated protocol method matching server/protocol.ts!
  RIND_USER_QUESTION_RESPOND: "rind/user-question/respond",
} as const;

export const WORKER_CAPABILITY = "rind/session-subscriptions";
export const REQUEST_TIMEOUT_SECONDS = 120.0;
export const RECONNECT_INITIAL_SECONDS = 0.25;
export const RECONNECT_MAX_SECONDS = 4.0;

export type EventCallback = (
  envelope: Record<string, unknown>,
  replayed: boolean,
) => Promise<void>;
export type CursorProvider = (sessionId: string) => number;

export class WorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerError";
  }
}

export class WorkerTimeout extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTimeout";
  }
}

export class WorkerConnectionError extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConnectionError";
  }
}

export class WorkerRequestError extends WorkerError {
  readonly method: string;
  readonly error: Record<string, unknown>;

  constructor(method: string, error: Record<string, unknown>) {
    const detail =
      error && typeof error.message === "string"
        ? error.message
        : JSON.stringify(error);
    super(`${method} failed: ${detail}`);
    this.name = "WorkerRequestError";
    this.method = method;
    this.error = error;
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedEvent {
  envelope: Record<string, unknown>;
  replayed: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class WorkerClient {
  private readonly transport: Transport;
  private readonly cursorProvider: CursorProvider | null;
  private readonly reconnectInitialSeconds: number;
  private readonly reconnectMaxSeconds: number;
  private callback: EventCallback | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Set<string>();
  private readonly eventQueue: QueuedEvent[] = [];
  private eventWaiter: (() => void) | null = null;
  private readerPromise: Promise<void> | null = null;
  private consumerPromise: Promise<void> | null = null;
  private supervisorPromise: Promise<void> | null = null;
  private stopController = new AbortController();
  private stopping = false;
  private up = false;
  private catchingUp = false;
  private held: QueuedEvent[] = [];
  private readonly seen = new Set<string>();

  constructor(
    url: string,
    token: string | null = null,
    options?: {
      transport?: Transport;
      cursorProvider?: CursorProvider | null;
      reconnectInitialSeconds?: number;
      reconnectMaxSeconds?: number;
    },
  ) {
    this.transport = options?.transport ?? buildTransport(url, token);
    this.cursorProvider = options?.cursorProvider ?? null;
    this.reconnectInitialSeconds =
      options?.reconnectInitialSeconds ?? RECONNECT_INITIAL_SECONDS;
    this.reconnectMaxSeconds = options?.reconnectMaxSeconds ?? RECONNECT_MAX_SECONDS;
  }

  get connected(): boolean {
    return this.up && !this.stopping;
  }

  onEvent(callback: EventCallback): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.stopController = new AbortController();
    await this.bringUp();
    this.consumerPromise = this.consumeEvents();
    this.supervisorPromise = this.supervise();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.up = false;
    this.stopController.abort();
    this.wakeConsumer();
    try {
      await this.transport.close();
    } finally {
      this.failPending(new WorkerConnectionError("worker client stopped"));
    }
    const tasks = [
      this.readerPromise,
      this.consumerPromise,
      this.supervisorPromise,
    ].filter((t): t is Promise<void> => t !== null);
    await Promise.allSettled(tasks);
    this.readerPromise = null;
    this.consumerPromise = null;
    this.supervisorPromise = null;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutSeconds: number = REQUEST_TIMEOUT_SECONDS,
  ): Promise<Record<string, unknown>> {
    if (!this.connected) {
      throw new WorkerConnectionError("worker is not connected");
    }
    const requestId = this.nextRequestId++;
    let resolveFn!: (value: Record<string, unknown>) => void;
    let rejectFn!: (err: Error) => void;
    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timeoutMs = Math.max(1, timeoutSeconds * 1000);
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      rejectFn(new WorkerTimeout(`worker request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();

    this.pending.set(requestId, {
      resolve: resolveFn,
      reject: rejectFn,
      method,
      timer,
    });

    const frame = {
      kind: "request",
      request_id: requestId,
      method,
      params,
    };

    try {
      await this.transport.write(frame);
    } catch (exc) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new WorkerConnectionError(`worker write failed: ${msg}`);
    }

    try {
      const result = await resultPromise;
      return result && typeof result === "object" && !Array.isArray(result) ? result : {};
    } finally {
      clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }

  async subscribe(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      return;
    }
    await this.request(RuntimeMethod.SESSION_SUBSCRIBE, { session_id: sessionId });
    this.sessions.add(sessionId);
  }

  private async bringUp(): Promise<void> {
    let delay = this.reconnectInitialSeconds;
    while (true) {
      try {
        await this.transport.open();
        break;
      } catch {
        if (this.stopping) {
          throw new WorkerConnectionError("worker connection failed");
        }
        await sleep(delay * 1000, this.stopController.signal);
        if (this.stopping) {
          throw new WorkerConnectionError("worker connection failed");
        }
        delay = Math.min(delay * 2, this.reconnectMaxSeconds);
      }
    }

    this.up = true;
    this.seen.clear();
    this.readerPromise = this.readLoop();

    let result: Record<string, unknown>;
    try {
      result = await this.request(RuntimeMethod.INITIALIZE, {});
    } catch (exc) {
      await this.teardown();
      throw exc;
    }

    const capabilities = result.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes(WORKER_CAPABILITY)) {
      await this.teardown();
      throw new Error(
        `worker lacks the ${WORKER_CAPABILITY} capability: upgrade the worker (app-server) before starting the gateway.`,
      );
    }
  }

  private async teardown(): Promise<void> {
    this.up = false;
    const reader = this.readerPromise;
    this.readerPromise = null;
    try {
      await this.transport.close();
    } finally {
      this.failPending(new WorkerConnectionError("worker connection lost"));
    }
    if (reader) {
      await Promise.allSettled([reader]);
    }
  }

  private async supervise(): Promise<void> {
    while (!this.stopping) {
      const reader = this.readerPromise;
      if (reader) {
        await reader;
      }
      if (this.stopping) {
        return;
      }
      await this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    let delay = this.reconnectInitialSeconds;
    while (!this.stopping) {
      await sleep(delay * 1000, this.stopController.signal);
      if (this.stopping) return;
      delay = Math.min(delay * 2, this.reconnectMaxSeconds);
      try {
        await this.bringUp();
        await this.catchUp();
        return;
      } catch {
        // retry on next iteration
      }
    }
  }

  private async catchUp(): Promise<void> {
    this.catchingUp = true;
    try {
      const sortedSessions = [...this.sessions].sort();
      for (const sessionId of sortedSessions) {
        await this.request(RuntimeMethod.SESSION_SUBSCRIBE, { session_id: sessionId });
      }
      for (const sessionId of sortedSessions) {
        const cursor = this.cursorProvider ? Math.trunc(this.cursorProvider(sessionId)) : 0;
        const result = await this.request(RuntimeMethod.SESSION_REPLAY, {
          session_id: sessionId,
          after_cursor: Math.max(0, cursor),
        });
        const events = Array.isArray(result.events) ? result.events : [];
        for (const envelope of events) {
          if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
            this.enqueueEvent({ ...(envelope as Record<string, unknown>) }, true);
          }
        }
      }
    } finally {
      const held = this.held;
      this.held = [];
      this.catchingUp = false;
      for (const item of held) {
        this.receiveEvent(item.envelope, item.replayed);
      }
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.stopping) {
        const message = await this.transport.read();
        if (message === null) {
          break;
        }
        if (message.kind === "response") {
          this.resolveResponse(message);
        } else if (message.kind === "event") {
          this.receiveEvent(message, false);
        }
      }
    } catch {
      // connection ended
    } finally {
      this.up = false;
      this.failPending(new WorkerConnectionError("worker connection lost"));
    }
  }

  private resolveResponse(message: Record<string, unknown>): void {
    const reqId = message.request_id;
    if (typeof reqId !== "number") return;
    const entry = this.pending.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(reqId);
    if ("error" in message && message.error && typeof message.error === "object") {
      entry.reject(
        new WorkerRequestError(entry.method, message.error as Record<string, unknown>),
      );
    } else {
      const res = message.result;
      entry.resolve(
        res && typeof res === "object" && !Array.isArray(res)
          ? (res as Record<string, unknown>)
          : {},
      );
    }
  }

  private receiveEvent(envelope: Record<string, unknown>, replayed: boolean): void {
    if (this.catchingUp) {
      this.held.push({ envelope, replayed });
      return;
    }
    if (!replayed) {
      const sessionId = String(envelope.session_id ?? "");
      const seq = Number(envelope.sequence ?? 0) || 0;
      const key = `${sessionId}\0${seq}`;
      if (this.seen.has(key)) {
        return;
      }
      if (this.seen.size >= 4096) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) {
          this.seen.delete(oldest);
        }
      }
      this.seen.add(key);
    }
    this.enqueueEvent(envelope, replayed);
  }

  private enqueueEvent(envelope: Record<string, unknown>, replayed: boolean): void {
    this.eventQueue.push({ envelope, replayed });
    this.wakeConsumer();
  }

  private wakeConsumer(): void {
    const waiter = this.eventWaiter;
    this.eventWaiter = null;
    waiter?.();
  }

  private async consumeEvents(): Promise<void> {
    while (!this.stopping) {
      const item = this.eventQueue.shift();
      if (!item) {
        await new Promise<void>(resolve => {
          this.eventWaiter = resolve;
        });
        continue;
      }
      if (!this.callback) continue;
      try {
        await this.callback(item.envelope, item.replayed);
      } catch {
        // event callback errors never terminate consumer loop
      }
    }
  }

  private failPending(error: WorkerError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
