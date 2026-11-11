import { type Deferred, createDeferred } from "../domain/cancellation.js";
import type { Transport } from "./transports.js";

export const WORKER_CAPABILITY = "rind/session-subscriptions";

export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_started",
  "assistant_message_completed",
  "tool_requested",
  "tool_result",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
]);

export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
]);

export class FakeSession {
  readonly session_id: string;
  readonly events: Record<string, unknown>[] = [];
  turn_id = "";
  turns = 0;
  terminal: Deferred<Record<string, unknown>> | null = null;

  constructor(sessionId: string) {
    this.session_id = sessionId;
  }

  nextTurn(): string {
    this.turns += 1;
    this.turn_id = `turn-${this.turns}`;
    return this.turn_id;
  }
}

export class FakeConnection {
  private readonly worker: FakeWorker;
  readonly subscriptions = new Set<string>();
  private sequence = 0;
  private readonly outbound: Record<string, unknown>[] = [];
  private readonly waiters: Array<(frame: Record<string, unknown> | null) => void> = [];
  private closed = false;

  constructor(worker: FakeWorker) {
    this.worker = worker;
  }

  receive(payload: Record<string, unknown>): void {
    if (this.closed) return;
    queueMicrotask(() => {
      void this.worker.dispatch(this, payload);
    });
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(payload);
    } else {
      this.outbound.push(payload);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }

  drain(): Record<string, unknown>[] {
    const items = [...this.outbound];
    this.outbound.length = 0;
    return items;
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  async recv(): Promise<Record<string, unknown> | null> {
    if (this.outbound.length > 0) {
      return this.outbound.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return await new Promise<Record<string, unknown> | null>(resolve => {
      this.waiters.push(resolve);
    });
  }
}

export class FakeWorker {
  readonly capabilities: string[];
  readonly stallMethods: Set<string>;
  readonly stalled = new Map<string, Deferred<void>>();
  readonly created: Record<string, unknown>[] = [];
  readonly prompts: Array<[string, string]> = [];
  readonly followUps: Array<[string | null, string]> = [];
  readonly answers: Array<[string | null, string, string]> = [];
  readonly cancels: Array<string | null> = [];
  readonly compacts: Array<string | null> = [];
  readonly sessions = new Map<string, FakeSession>();
  private readonly connections: FakeConnection[] = [];
  private counter = 0;

  constructor(options?: {
    capabilities?: readonly string[];
    stallMethods?: readonly string[];
  }) {
    this.capabilities = options?.capabilities
      ? [...options.capabilities]
      : [WORKER_CAPABILITY, "sessions", "models"];
    this.stallMethods = new Set(options?.stallMethods ?? []);
  }

  openConnection(): FakeConnection {
    const conn = new FakeConnection(this);
    this.connections.push(conn);
    return conn;
  }

  dropConnections(): void {
    for (const conn of this.connections) {
      conn.close();
    }
  }

  newSession(): string {
    this.counter += 1;
    const sessionId = `fake-${String(this.counter).padStart(4, "0")}`;
    this.sessions.set(sessionId, new FakeSession(sessionId));
    return sessionId;
  }

  pushEvent(sessionId: string, event: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    const etype = String(event.type ?? "");
    if (DURABLE_EVENT_TYPES.has(etype)) {
      session.events.push({ ...event });
    }
    for (const conn of this.connections) {
      if (conn.subscriptions.has(sessionId)) {
        conn.send(this.envelope(conn, session, event));
      }
    }
    if (TERMINAL_EVENT_TYPES.has(etype) && session.terminal && !session.terminal.done) {
      session.terminal.resolve(event);
    }
  }

  async runTurn(
    sessionId: string,
    events: readonly Record<string, unknown>[],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    session.nextTurn();
    for (const event of events) {
      this.pushEvent(sessionId, event);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async dispatch(
    connection: FakeConnection,
    request: Record<string, unknown>,
  ): Promise<void> {
    const method = String(request.method ?? "");
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    try {
      if (this.stallMethods.has(method)) {
        const d = createDeferred<void>();
        this.stalled.set(method, d);
        await d.promise;
      }
      const result = await this.handle(connection, method, params);
      connection.send({
        kind: "response",
        request_id: request.request_id,
        result,
      });
    } catch (exc) {
      const err = exc instanceof Error ? exc : new Error(String(exc));
      connection.send({
        kind: "response",
        request_id: request.request_id,
        error: { type: err.name || "Error", message: err.message },
      });
    }
  }

  private async handle(
    connection: FakeConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "initialize") {
      const first = this.sessions.keys().next().value ?? null;
      return {
        protocol_version: "2",
        version: "fake-worker",
        capabilities: this.capabilities,
        session_id: first,
      };
    }
    if (method === "session/new") {
      this.created.push({ ...params });
      const sessionId = this.newSession();
      connection.subscriptions.add(sessionId);
      return {
        session_id: sessionId,
        draft: false,
        workspace_root: params.workspace_root,
      };
    }
    if (method === "session/subscribe") {
      connection.subscriptions.add(String(params.session_id ?? ""));
      return { ok: true, subscribed: [...connection.subscriptions].sort() };
    }
    if (method === "session/unsubscribe") {
      connection.subscriptions.delete(String(params.session_id ?? ""));
      return { ok: true, subscribed: [...connection.subscriptions].sort() };
    }
    if (method === "session/prompt") {
      return await this.handlePrompt(connection, params);
    }
    if (method === "session/cancel") {
      const sid = params.session_id !== undefined ? String(params.session_id) : null;
      this.cancels.push(sid);
      const session = sid ? this.sessions.get(sid) : undefined;
      if (session && session.terminal && !session.terminal.done) {
        this.pushEvent(session.session_id, { type: "turn_cancelled", reason: "user" });
      }
      return { ok: true };
    }
    if (method === "rind/session/follow_up") {
      const sid = params.session_id !== undefined ? String(params.session_id) : null;
      this.followUps.push([sid, String(params.input ?? "")]);
      return { ok: true, input_id: `fu-${this.followUps.length}` };
    }
    if (method === "rind/user-question/respond") {
      const sid = params.session_id !== undefined ? String(params.session_id) : null;
      this.answers.push([
        sid,
        String(params.tool_call_id ?? ""),
        String(params.answer ?? ""),
      ]);
      return { ok: true };
    }
    if (method === "rind/session/compact") {
      const sid = params.session_id !== undefined ? String(params.session_id) : null;
      this.compacts.push(sid);
      return { ok: true };
    }
    if (method === "session/replay") {
      const sid = String(params.session_id ?? "");
      const session = this.sessions.get(sid);
      if (!session) {
        throw new Error(`Unknown session: ${sid}`);
      }
      const after = Math.max(0, Number(params.after_cursor ?? 0) || 0);
      const envelopes = session.events.slice(after).map((ev, idx) => ({
        kind: "event",
        method: "session/update",
        sequence: after + idx + 1,
        durability: "durable",
        session_id: session.session_id,
        turn_id: session.turn_id,
        event: { ...ev },
      }));
      return { events: envelopes, cursor: session.events.length };
    }
    return { ok: true };
  }

  private async handlePrompt(
    connection: FakeConnection,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sid = String(params.session_id ?? this.sessions.keys().next().value ?? "");
    const session = this.sessions.get(sid);
    if (!session) {
      throw new Error(`Unknown session: ${sid}`);
    }
    this.prompts.push([sid, String(params.input ?? params.query ?? "")]);
    connection.subscriptions.add(sid);
    session.nextTurn();
    const d = createDeferred<Record<string, unknown>>();
    session.terminal = d;
    await d.promise;
    session.terminal = null;
    return { ok: true, session_id: sid, turn_id: session.turn_id };
  }

  private envelope(
    connection: FakeConnection,
    session: FakeSession,
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const etype = String(event.type ?? "");
    return {
      kind: "event",
      method: "session/update",
      sequence: connection.nextSequence(),
      durability: DURABLE_EVENT_TYPES.has(etype) ? "durable" : "incremental",
      session_id: session.session_id,
      turn_id: session.turn_id,
      event: { ...event },
    };
  }
}

export class MemoryTransport implements Transport {
  private readonly worker: FakeWorker;
  private connection: FakeConnection | null = null;

  constructor(worker: FakeWorker) {
    this.worker = worker;
  }

  async open(): Promise<void> {
    this.connection = this.worker.openConnection();
  }

  async read(): Promise<Record<string, unknown> | null> {
    if (!this.connection) return null;
    return await this.connection.recv();
  }

  async write(payload: Record<string, unknown>): Promise<void> {
    if (!this.connection) {
      throw new Error("MemoryTransport is closed");
    }
    this.connection.receive(payload);
  }

  async close(): Promise<void> {
    this.connection?.close();
    this.connection = null;
  }
}
