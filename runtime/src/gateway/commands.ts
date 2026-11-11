import { userErrorLine } from "./errors.js";
import type { InboundMessage, ReplyPosition, SendTarget } from "./types.js";

export const COMMAND_PREFIX = "/";
export const SESSION_CANCEL_METHOD = "session/cancel";
export const SESSION_COMPACT_METHOD = "rind/session/compact";

export const STOPPED_REPLY = "Stopped";
export const COMPACT_ACK = "Context compaction requested";
export const UNKNOWN_REPLY = "Unknown command; reply /help for the list.";
export const OFFLINE_NOTICE = "Worker offline; command queued";
export const SESSION_CREATE_FAILED_REPLY =
  "Cannot create a session right now; try again shortly";
export const NO_SESSION_REPLY = "No session yet — send a message first, then compact";

export interface CommandContext {
  readonly channel_id: string;
  readonly target: SendTarget;
  readonly message: InboundMessage;
  readonly key: string;
}

export interface HubLinks {
  readonly activeSession: (key: string) => string | null;
  readonly finishTurn: (key: string) => Promise<void>;
  readonly queueDepth: () => number;
  readonly bindTarget: (sessionId: string, position: ReplyPosition) => void;
}

export interface CommandWorkerLike {
  readonly connected?: boolean;
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutSeconds?: number,
  ): Promise<Record<string, unknown>>;
  subscribe(sessionId: string): Promise<void>;
}

export interface CommandRouterLike {
  lookup(key: string): { session_id: string; cursor: number } | undefined;
  allSessions(): Record<string, { session_id: string; cursor: number }>;
  createSession(
    key: string,
    worker: CommandWorkerLike,
    workspaceRoot: string,
  ): Promise<{ session_id: string; cursor: number }>;
}

export interface CommandSpec {
  readonly name: string;
  readonly tier: "essential" | "standard";
  readonly description: string;
  readonly handler: (hub: CommandHub, ctx: CommandContext) => Promise<string | null>;
}

export function isCommand(text: string): boolean {
  return text.startsWith(COMMAND_PREFIX);
}

export function commandName(text: string): string {
  if (!text.startsWith(COMMAND_PREFIX)) {
    return "";
  }
  const rest = text.slice(COMMAND_PREFIX.length).trim();
  if (!rest) {
    return "";
  }
  return (rest.split(/\s+/, 1)[0] ?? "").toLowerCase();
}

export class CommandHub {
  private readonly workerGetter: () => CommandWorkerLike;
  private readonly router: CommandRouterLike;
  private readonly links: HubLinks;
  private readonly workspaceRoot: string;
  private readonly requestTimeout: number;
  private readonly model: string;

  constructor(options: {
    workerGetter: () => CommandWorkerLike;
    router: CommandRouterLike;
    links: HubLinks;
    workspaceRoot?: string;
    requestTimeout?: number;
    model?: string;
  }) {
    this.workerGetter = options.workerGetter;
    this.router = options.router;
    this.links = options.links;
    this.workspaceRoot = options.workspaceRoot ?? "";
    this.requestTimeout = options.requestTimeout ?? 120.0;
    this.model = options.model ?? "default (worker built-in)";
  }

  private get worker(): CommandWorkerLike {
    return this.workerGetter();
  }

  async dispatch(text: string, ctx: CommandContext): Promise<string | null> {
    const spec = COMMANDS[commandName(text)];
    if (!spec) {
      return UNKNOWN_REPLY;
    }
    try {
      return await spec.handler(this, ctx);
    } catch (exc) {
      return userErrorLine(exc);
    }
  }

  async cmdStop(ctx: CommandContext): Promise<string | null> {
    const session = this.links.activeSession(ctx.key);
    if (!session) {
      return null;
    }
    try {
      await this.worker.request(
        SESSION_CANCEL_METHOD,
        { session_id: session },
        this.requestTimeout,
      );
    } catch {
      // stop still finishes local turn state
    }
    await this.links.finishTurn(ctx.key);
    return STOPPED_REPLY;
  }

  async cmdNew(ctx: CommandContext): Promise<string | null> {
    const session = this.links.activeSession(ctx.key);
    if (session) {
      try {
        await this.worker.request(
          SESSION_CANCEL_METHOD,
          { session_id: session },
          this.requestTimeout,
        );
      } catch {
        // best effort
      }
      await this.links.finishTurn(ctx.key);
    }
    let record: { session_id: string; cursor: number };
    try {
      record = await this.router.createSession(ctx.key, this.worker, this.workspaceRoot);
      await this.worker.subscribe(record.session_id);
    } catch {
      return SESSION_CREATE_FAILED_REPLY;
    }
    this.links.bindTarget(record.session_id, [ctx.channel_id, ctx.target]);
    return `New session started (session ${record.session_id.slice(0, 8)})`;
  }

  async cmdStatus(ctx: CommandContext): Promise<string | null> {
    const active = this.links.activeSession(ctx.key);
    const queued = this.links.queueDepth();
    const connected = this.worker.connected ?? true;
    const sessionCount = Object.keys(this.router.allSessions()).length;
    const parts = [
      `model: ${this.model}`,
      `task: ${active ? "running" : "idle"}${queued > 0 ? ` (${queued} queued)` : ""}`,
      `sessions: ${sessionCount}`,
      `worker: ${connected ? "connected" : "offline"}`,
    ];
    return parts.join(" | ");
  }

  async cmdCompact(ctx: CommandContext): Promise<string | null> {
    let session = this.links.activeSession(ctx.key);
    if (!session) {
      session = this.router.lookup(ctx.key)?.session_id ?? null;
    }
    if (!session) {
      return NO_SESSION_REPLY;
    }
    await this.worker.request(
      SESSION_COMPACT_METHOD,
      { session_id: session },
      this.requestTimeout,
    );
    return COMPACT_ACK;
  }

  async cmdHelp(_ctx: CommandContext): Promise<string | null> {
    const specs = Object.values(COMMANDS);
    const essential = specs.filter(s => s.tier === "essential");
    const standard = specs.filter(s => s.tier !== "essential");
    const lines = [
      "Essentials:",
      ...essential.map(formatHelpLine),
      "All:",
      ...standard.map(formatHelpLine),
    ];
    return lines.join("\n");
  }
}

function formatHelpLine(spec: CommandSpec): string {
  return `/${spec.name} ${spec.description}`;
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  stop: {
    name: "stop",
    tier: "essential",
    description: "stop the current task",
    handler: (hub, ctx) => hub.cmdStop(ctx),
  },
  new: {
    name: "new",
    tier: "essential",
    description: "start a new session",
    handler: (hub, ctx) => hub.cmdNew(ctx),
  },
  status: {
    name: "status",
    tier: "essential",
    description: "show status",
    handler: (hub, ctx) => hub.cmdStatus(ctx),
  },
  compact: {
    name: "compact",
    tier: "essential",
    description: "compact the context",
    handler: (hub, ctx) => hub.cmdCompact(ctx),
  },
  help: {
    name: "help",
    tier: "standard",
    description: "show this help",
    handler: (hub, ctx) => hub.cmdHelp(ctx),
  },
};
