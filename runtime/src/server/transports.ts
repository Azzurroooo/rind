import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";
import { AsyncMutex } from "../domain/cancellation.js";
import { expandTilde, validateSessionId } from "../infrastructure/paths.js";
import { JsonlSessionStore } from "../infrastructure/persistence/session-store.js";
import { ensureUserSettings, loadSettings } from "../infrastructure/settings.js";
import { ExternalTool } from "../infrastructure/tools/control-tools.js";
import { ServerWebSocket, upgradeWebSocket } from "../infrastructure/ws-server.js";
import {
  type BackgroundListFn,
  type BackgroundOutputFn,
  RuntimeDispatcher,
  type TransportWriter,
} from "./dispatcher.js";
import { errorMessage, validateRequest } from "./protocol.js";
import { RuntimeWorker, type WorkerLock, acquireWorkerLock } from "./worker.js";

// --- Stdio Transport (from agent/runtime/server/stdio.py) ---

export class JsonlWriter implements TransportWriter {
  private readonly lock = new AsyncMutex();

  async send(payload: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(payload)}\n`;
    await this.lock.runExclusive(async () => {
      await new Promise<void>(resolve => {
        if (process.stdout.write(line, "utf8")) {
          resolve();
        } else {
          process.stdout.once("drain", resolve);
        }
      });
    });
  }
}

export function configureUtf8Stdio(): void {
  if (typeof process.stdin.setEncoding === "function") {
    process.stdin.setEncoding("utf8");
  }
}

export function configureStdioServerSignals(): void {
  process.on("SIGINT", () => {
    // Ignore SIGINT in stdio worker mode; parent CLI coordinates cancellation/shutdown.
  });
}

export class StdioRuntimeServer {
  static readonly workerMode = true;
  static readonly networkMode = false;

  private readonly writer: JsonlWriter;
  private readonly dispatcher: RuntimeDispatcher;

  constructor(
    worker: RuntimeWorker,
    options?: {
      debug?: boolean;
      backgroundList?: BackgroundListFn | null;
      backgroundOutput?: BackgroundOutputFn | null;
      goalEnabled?: boolean;
    },
  ) {
    this.writer = new JsonlWriter();
    this.dispatcher = new RuntimeDispatcher(worker, {
      debug: options?.debug ?? false,
      writer: this.writer,
      backgroundList: options?.backgroundList ?? null,
      backgroundOutput: options?.backgroundOutput ?? null,
      goalEnabled: options?.goalEnabled ?? true,
      allowSessionConfiguration: true,
    });
  }

  async run(): Promise<number> {
    let closed = false;
    const chunks: string[] = [];
    const decoder = new StringDecoder("utf8");
    let ingestChain = Promise.resolve();

    const enqueueLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) return;
      ingestChain = ingestChain.then(async () => {
        if (!closed) {
          await this.ingestLine(line);
        }
      });
    };

    const onData = (chunk: Buffer | string): void => {
      if (closed) return;
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (!text) return;
      const nl = text.indexOf("\n");
      if (nl === -1) {
        chunks.push(text);
        return;
      }
      const prefix = chunks.length > 0 ? chunks.join("") : "";
      chunks.length = 0;
      let start = 0;
      let idx = nl;
      let first = true;
      while (idx !== -1) {
        const segment = text.slice(start, idx);
        enqueueLine(first ? prefix + segment : segment);
        first = false;
        start = idx + 1;
        idx = text.indexOf("\n", start);
      }
      if (start < text.length) {
        chunks.push(text.slice(start));
      }
    };

    const onEnd = (): void => {
      if (closed) return;
      const rem = decoder.end();
      if (rem) chunks.push(rem);
      const tail = chunks.join("");
      chunks.length = 0;
      ingestChain = ingestChain.then(async () => {
        if (!closed && tail.trim()) {
          await this.ingestLine(tail.endsWith("\r") ? tail.slice(0, -1) : tail);
        }
        if (!closed) {
          await this.dispatcher.submit(null);
        }
      });
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();

    try {
      return await this.dispatcher.serve();
    } finally {
      closed = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      this.dispatcher.close();
    }
  }

  private async ingestLine(line: string): Promise<void> {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      await this.writer.send(
        errorMessage({}, "Invalid JSON request.", "ParseError") as unknown as Record<
          string,
          unknown
        >,
      );
      return;
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      await this.writer.send(
        errorMessage({}, "Request must be an object.", "ParseError") as unknown as Record<
          string,
          unknown
        >,
      );
      return;
    }
    const reqObj = request as Record<string, unknown>;
    const error = validateRequest(reqObj);
    if (error !== null) {
      await this.writer.send(
        errorMessage(reqObj, error, "InvalidRequest") as unknown as Record<
          string,
          unknown
        >,
      );
      return;
    }
    await this.dispatcher.submit(reqObj);
  }
}

// --- WebSocket Transport (from agent/runtime/server/websocket.py) ---

export const AUTH_CLOSE_CODE = 4401;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

export type WebSocketConnection = ServerWebSocket;
export const WebSocketConnection = ServerWebSocket;

export class WebSocketWriter implements TransportWriter {
  private readonly ws: WebSocketConnection;
  private readonly lock = new AsyncMutex();
  private closed = false;

  constructor(ws: WebSocketConnection) {
    this.ws = ws;
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    try {
      await this.lock.runExclusive(async () => {
        if (!this.closed) {
          await this.ws.sendText(JSON.stringify(payload));
        }
      });
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    this.closed = true;
  }
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function isLoopbackHost(host: string): boolean {
  const candidate = String(host || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (candidate === "localhost") {
    return true;
  }
  if (candidate === "127.0.0.1" || candidate === "::1") {
    return true;
  }
  if (net.isIPv4(candidate)) {
    return candidate.startsWith("127.");
  }
  return false;
}

export class WebRuntimeServer {
  static readonly workerMode = true;
  static readonly networkMode = true;

  private readonly worker: RuntimeWorker;
  private readonly debug: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly backgroundList: BackgroundListFn | null;
  private readonly backgroundOutput: BackgroundOutputFn | null;
  private readonly goalEnabled: boolean;
  private readonly serverToken: string;
  private readonly ticketTtlSeconds: number;
  private readonly ticketCapacity: number;
  private readonly tickets = new Map<string, number>();

  constructor(
    worker: RuntimeWorker,
    options?: {
      debug?: boolean;
      host?: string;
      port?: number;
      backgroundList?: BackgroundListFn | null;
      backgroundOutput?: BackgroundOutputFn | null;
      goalEnabled?: boolean;
      serverToken?: string | null;
      ticketTtlSeconds?: number;
      ticketCapacity?: number;
    },
  ) {
    this.worker = worker;
    this.debug = options?.debug ?? false;
    this.host = options?.host ?? "127.0.0.1";
    this.port = options?.port ?? 8765;
    this.backgroundList = options?.backgroundList ?? null;
    this.backgroundOutput = options?.backgroundOutput ?? null;
    this.goalEnabled = options?.goalEnabled ?? true;
    this.serverToken = String(options?.serverToken || "").trim();
    this.ticketTtlSeconds = options?.ticketTtlSeconds ?? 60.0;
    this.ticketCapacity = options?.ticketCapacity ?? 10_000;
  }

  async run(): Promise<number> {
    if (!this.serverToken && !isLoopbackHost(this.host)) {
      process.stderr.write(
        `Refusing to bind ws://${this.host}:${this.port} without a server token; ` +
          "set serverToken in settings.json or RIND_SERVER_TOKEN.\n",
      );
      return 2;
    }

    const httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    httpServer.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket as Socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.port, this.host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });

    const address = httpServer.address();
    const boundPort =
      address && typeof address === "object" ? address.port : this.port;
    process.stdout.write(
      `Rind WebSocket worker listening on ws://${this.host}:${boundPort}\n`,
    );

    try {
      await new Promise<void>(resolve => {
        const onStop = (): void => resolve();
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
      });
    } finally {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      await this.worker.close();
    }
    return 0;
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (parsedUrl.pathname === "/healthz") {
      this.sendJsonResponse(res, 200, { ok: true });
      return;
    }
    if (parsedUrl.pathname === "/ticket") {
      if (!this.serverToken) {
        this.sendJsonResponse(res, 404, null);
        return;
      }
      if (this.bearerMatches(req.headers)) {
        this.sendJsonResponse(res, 200, { ticket: this.issueTicket() });
        return;
      }
      this.sendJsonResponse(res, 401, null);
      return;
    }
    this.sendJsonResponse(res, 404, null);
  }

  private sendJsonResponse(
    res: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown> | null,
  ): void {
    const body = payload === null ? "" : JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    });
    res.end(body);
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const ws = upgradeWebSocket(req, socket, head, {
      maxMessageBytes: MAX_WS_MESSAGE_BYTES,
    });
    if (!ws) {
      return;
    }
    if (!(await this.authorize(ws))) {
      return;
    }

    const writer = new WebSocketWriter(ws);
    const dispatcher = new RuntimeDispatcher(this.worker, {
      debug: this.debug,
      backgroundList: this.backgroundList,
      backgroundOutput: this.backgroundOutput,
      goalEnabled: this.goalEnabled,
      writer,
    });

    let initChain = Promise.resolve();
    ws.listen(
      rawMessage => {
        const request = WebRuntimeServer.parseRequest(rawMessage, writer);
        if (!request) return;
        if (request.method === "initialize") {
          initChain = initChain.then(() => dispatcher.dispatch(request));
        } else {
          initChain = initChain.then(() => {
            dispatcher.schedule(request);
          });
        }
      },
      () => {
        dispatcher.close();
        writer.close();
      },
    );
  }

  private static parseRequest(
    rawMessage: string,
    writer: WebSocketWriter,
  ): Record<string, unknown> | null {
    let request: unknown;
    try {
      request = JSON.parse(rawMessage);
    } catch {
      void writer.send(
        errorMessage({}, "Invalid JSON request.", "ParseError") as unknown as Record<
          string,
          unknown
        >,
      );
      return null;
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      void writer.send(
        errorMessage(
          {},
          "WebSocket request must be an object.",
          "ParseError",
        ) as unknown as Record<string, unknown>,
      );
      return null;
    }
    const reqObj = request as Record<string, unknown>;
    const requestError = validateRequest(reqObj);
    if (requestError !== null) {
      void writer.send(
        errorMessage(reqObj, requestError, "InvalidRequest") as unknown as Record<
          string,
          unknown
        >,
      );
      return null;
    }
    return reqObj;
  }

  private async authorize(ws: WebSocketConnection): Promise<boolean> {
    if (!this.serverToken) {
      return true;
    }
    const headers = ws.request.headers;
    if (!this.originAllowed(headers)) {
      await ws.close(AUTH_CLOSE_CODE);
      return false;
    }
    const parsedUrl = new URL(
      ws.request.url || "/",
      `http://${headers.host || "localhost"}`,
    );
    const token = parsedUrl.searchParams.get("token");
    if (token && safeEquals(token, this.serverToken)) {
      return true;
    }
    const ticket = parsedUrl.searchParams.get("ticket");
    if (ticket && this.consumeTicket(ticket)) {
      return true;
    }
    await ws.close(AUTH_CLOSE_CODE);
    return false;
  }

  private originAllowed(headers: http.IncomingHttpHeaders): boolean {
    const origin = headers.origin;
    if (!origin) return true;
    if (origin === "http://rind.local" || origin === "capacitor://rind.local") {
      return true;
    }
    try {
      const originHost = new URL(origin).hostname;
      const host = new URL(`http://${headers.host || ""}`).hostname;
      return Boolean(originHost && host) && originHost.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  private bearerMatches(headers: http.IncomingHttpHeaders): boolean {
    const auth = String(headers.authorization || "");
    const spaceIdx = auth.indexOf(" ");
    if (spaceIdx === -1) return false;
    const scheme = auth.slice(0, spaceIdx).toLowerCase();
    const credentials = auth.slice(spaceIdx + 1).trim();
    return scheme === "bearer" && safeEquals(credentials, this.serverToken);
  }

  private issueTicket(): string {
    this.dropExpiredTickets();
    while (this.tickets.size >= this.ticketCapacity) {
      let oldestTicket = "";
      let oldestDeadline = Infinity;
      for (const [t, d] of this.tickets.entries()) {
        if (d < oldestDeadline) {
          oldestDeadline = d;
          oldestTicket = t;
        }
      }
      if (!oldestTicket) break;
      this.tickets.delete(oldestTicket);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, performance.now() / 1000 + this.ticketTtlSeconds);
    return ticket;
  }

  private consumeTicket(ticket: string): boolean {
    this.dropExpiredTickets();
    const deadline = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return deadline !== undefined && deadline > performance.now() / 1000;
  }

  private dropExpiredTickets(): void {
    const now = performance.now() / 1000;
    for (const [ticket, deadline] of this.tickets.entries()) {
      if (deadline <= now) {
        this.tickets.delete(ticket);
      }
    }
  }
}

// --- App Server Entrypoint (from agent/runtime/server/app_server.py) ---

export interface AppServerArgs {
  stdio: boolean;
  web: boolean;
  host: string;
  port: number;
  debug: boolean;
  cwd: string | null;
  session: string | null;
  resumeLatest: boolean;
  sessionDir: string | null;
  noUserQuestion: boolean;
  traceLlm: boolean;
}

export function parseAppServerArgs(argv: readonly string[]): AppServerArgs {
  const args: AppServerArgs = {
    stdio: false,
    web: false,
    host: "127.0.0.1",
    port: 8765,
    debug: false,
    cwd: null,
    session: null,
    resumeLatest: false,
    sessionDir: null,
    noUserQuestion: false,
    traceLlm: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--stdio") {
      args.stdio = true;
    } else if (arg === "--web") {
      args.web = true;
    } else if (arg === "--debug") {
      args.debug = true;
    } else if (arg === "-c" || arg === "--resume-latest") {
      args.resumeLatest = true;
    } else if (arg === "--no-user-question") {
      args.noUserQuestion = true;
    } else if (arg === "--trace-llm") {
      args.traceLlm = true;
    } else if (arg === "--host" && i + 1 < argv.length) {
      args.host = argv[++i]!;
    } else if (arg.startsWith("--host=")) {
      args.host = arg.slice("--host=".length);
    } else if (arg === "--port" && i + 1 < argv.length) {
      args.port = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--port=")) {
      args.port = Number.parseInt(arg.slice("--port=".length), 10);
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      args.cwd = argv[++i]!;
    } else if (arg.startsWith("--cwd=")) {
      args.cwd = arg.slice("--cwd=".length);
    } else if (arg === "--session" && i + 1 < argv.length) {
      args.session = argv[++i]!;
    } else if (arg.startsWith("--session=")) {
      args.session = arg.slice("--session=".length);
    } else if (arg === "--session-dir" && i + 1 < argv.length) {
      args.sessionDir = argv[++i]!;
    } else if (arg.startsWith("--session-dir=")) {
      args.sessionDir = arg.slice("--session-dir=".length);
    }
  }
  return args;
}

function normalizePathCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function resolveWorkspaceRoot(
  cwd: string | null,
  session: string | null,
  sessionDir: string | null,
): string {
  let workspaceRoot = cwd ? path.resolve(expandTilde(cwd)) : null;
  if (session) {
    const meta = JsonlSessionStore.load_session_metadata(session, sessionDir);
    const storedWorkspace = String(meta.workspace_root || "").trim();
    if (!storedWorkspace) {
      throw new Error(`Session has no workspace directory: ${session}`);
    }
    const sessionRoot = path.resolve(expandTilde(storedWorkspace));
    if (!fs.existsSync(sessionRoot) || !fs.statSync(sessionRoot).isDirectory()) {
      throw new Error(`Session workspace directory does not exist: ${sessionRoot}`);
    }
    if (
      workspaceRoot !== null &&
      normalizePathCase(workspaceRoot) !== normalizePathCase(sessionRoot)
    ) {
      throw new Error(
        `Session workspace conflicts with --cwd: ${sessionRoot} != ${workspaceRoot}`,
      );
    }
    workspaceRoot = sessionRoot;
  }
  workspaceRoot = workspaceRoot || path.resolve(process.cwd());
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${workspaceRoot}`);
  }
  return workspaceRoot;
}

function writeStartupError(label: string, exc: unknown, debug: boolean): void {
  const msg = exc instanceof Error ? exc.message : String(exc);
  process.stderr.write(`${label}: ${msg}\n`);
  if (debug && exc instanceof Error && exc.stack) {
    process.stderr.write(`${exc.stack}\n`);
  }
}

function workerServerToken(): string {
  try {
    return loadSettings().server_token.trim();
  } catch {
    return "";
  }
}

export async function asyncAppServerMain(
  argv?: readonly string[] | null,
  options?: {
    serverClass?: typeof StdioRuntimeServer | typeof WebRuntimeServer;
  },
): Promise<number> {
  const argsList = argv ? [...argv] : process.argv.slice(2);
  const args = parseAppServerArgs(argsList);
  const ServerClass =
    options?.serverClass ?? (args.web ? WebRuntimeServer : StdioRuntimeServer);

  if (!ServerClass.networkMode && process.stdin && process.stdin.isTTY) {
    writeStartupError(
      "Startup error",
      new Error(
        "'app-server --stdio' is an internal JSON-RPC worker transport and cannot be run interactively in a terminal. Run 'rind' instead.",
      ),
      args.debug,
    );
    return 1;
  }
  if (args.traceLlm) {
    process.env.RIND_TRACE_LLM = "1";
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = resolveWorkspaceRoot(args.cwd, args.session, args.sessionDir);
  } catch (exc) {
    writeStartupError("Startup error", exc, args.debug);
    return 1;
  }

  if (args.session !== null) {
    try {
      args.session = validateSessionId(args.session);
    } catch (exc) {
      writeStartupError("Session error", exc, args.debug);
      return 1;
    }
  }

  try {
    ensureUserSettings();
  } catch (exc) {
    writeStartupError("Settings warning", exc, args.debug);
  }

  if (!ServerClass.workerMode) {
    throw new Error(`${ServerClass.name} must be a worker-mode runtime server.`);
  }

  let workerLock: WorkerLock | null = null;
  let worker: RuntimeWorker | null = null;
  let serverStarted = false;
  try {
    const waitSeconds = process.env.RIND_SHARED_HOST_PID?.trim() ? 5.0 : 0.0;
    workerLock = acquireWorkerLock(args.sessionDir, { waitSeconds });
    const rawExternal = process.env.RIND_EXTERNAL_TOOLS ?? "";
    delete process.env.RIND_EXTERNAL_TOOLS;
    const externalTool = ExternalTool.fromJson(rawExternal);

    worker = new RuntimeWorker({
      workspaceRoot,
      sessionId: args.session,
      resumeLatest: args.resumeLatest,
      sessionDir: args.sessionDir,
      debug: args.debug,
      enableGoal: true,
      enableUserQuestion: !args.noUserQuestion,
      externalTool,
    });

    const backgroundList: BackgroundListFn = sessionId =>
      worker!.shellTools.listBackgrounds(sessionId);
    const backgroundOutput: BackgroundOutputFn = (bgId, opts) =>
      worker!.shellTools.snapshotBackground(bgId, opts.maxOutputChars, opts._sessionId);

    let server: StdioRuntimeServer | WebRuntimeServer;
    if (ServerClass === WebRuntimeServer) {
      const token = (process.env.RIND_SERVER_TOKEN || workerServerToken()).trim();
      server = new WebRuntimeServer(worker, {
        debug: args.debug,
        host: args.host,
        port: args.port,
        backgroundList,
        backgroundOutput,
        goalEnabled: true,
        serverToken: token || null,
      });
    } else {
      server = new StdioRuntimeServer(worker, {
        debug: args.debug,
        backgroundList,
        backgroundOutput,
        goalEnabled: true,
      });
    }

    serverStarted = true;
    try {
      return await server.run();
    } catch (err) {
      serverStarted = false;
      throw err;
    }
  } catch (exc) {
    writeStartupError("Runtime error", exc, args.debug);
    return 1;
  } finally {
    try {
      if (worker !== null && !serverStarted) {
        await worker.close();
      }
    } finally {
      if (workerLock !== null) {
        workerLock.release();
      }
    }
  }
}

export async function appServerMain(argv?: readonly string[] | null): Promise<number> {
  const argsList = argv ? [...argv] : process.argv.slice(2);
  if (!argsList.includes("--web")) {
    configureStdioServerSignals();
    configureUtf8Stdio();
  }
  return await asyncAppServerMain(argsList);
}
