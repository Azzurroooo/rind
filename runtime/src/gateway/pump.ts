import path from "node:path";
import { firstLineTitle } from "./chunk.js";
import {
  CommandHub,
  OFFLINE_NOTICE,
  SESSION_CREATE_FAILED_REPLY,
  STOPPED_REPLY,
  isCommand,
} from "./commands.js";
import { userErrorLine } from "./errors.js";
import { Outbound } from "./outbound.js";
import { ReactionController } from "./reactions.js";
import { type SessionRecord, type SessionRouter, sessionKey } from "./router.js";
import type { SecurityGate } from "./security.js";
import type {
  Attachment,
  Channel,
  InboundMessage,
  InboundSink,
  ReplyPosition,
  SendTarget,
} from "./types.js";
import {
  REQUEST_TIMEOUT_SECONDS,
  RuntimeMethod,
  type WorkerClient,
  WorkerError,
} from "./worker-client.js";

export const MESSAGE_REF_LRU_SIZE = 512;
export const INBOUND_QUEUE_LIMIT = 100;
export const QUESTION_TTL_SECONDS = 300.0;
export const QUESTION_SCAN_SECONDS = 30.0;
export const TURN_STUCK_SECONDS = 30 * 60.0;

export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
]);

export const QUESTION_EXPIRED_REPLY = "Question expired";
export const WORKER_UNRESPONSIVE_REPLY =
  "Worker temporarily unresponsive; queued for retry";

interface ActiveTurn {
  session_id: string;
  channel_id: string;
  target: SendTarget;
  started_at: number;
  turn_id: string;
  title: string;
  confirmed: boolean;
}

interface PendingQuestion {
  key: string;
  session_id: string;
  channel_id: string;
  target: SendTarget;
  tool_call_id: string;
  options: readonly string[];
  deadline: number;
}

/**
 * BUG FIX 5: Convert attachment file paths inside `<workspace>/uploads/...`
 * into workspace-relative POSIX references (e.g. `uploads/telegram/20261111/photo.png`)
 * so image-only messages with empty `text` still form a valid non-empty prompt
 * and trigger Rind's `uploadReferences` image capture.
 */
export function formatAttachmentPromptRef(attPath: string, workspaceRoot: string): string {
  const posixRaw = attPath.replace(/\\/g, "/");
  if (
    !path.isAbsolute(attPath) &&
    !path.win32.isAbsolute(attPath) &&
    !posixRaw.startsWith("/")
  ) {
    return posixRaw.replace(/^\.\//, "");
  }
  if (workspaceRoot) {
    const normRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normRoot && posixRaw.startsWith(`${normRoot}/`)) {
      return posixRaw.slice(normRoot.length + 1);
    }
    try {
      const absRoot = path.resolve(workspaceRoot);
      const absAtt = path.resolve(attPath);
      const rel = path.relative(absRoot, absAtt).replace(/\\/g, "/");
      if (
        rel &&
        !rel.startsWith("..") &&
        !path.isAbsolute(rel) &&
        !path.win32.isAbsolute(rel)
      ) {
        return rel;
      }
    } catch {
      // fall through
    }
  }
  return posixRaw;
}

export function buildPromptText(
  rawText: string,
  attachments: readonly Attachment[],
  workspaceRoot: string,
): string {
  const trimmed = rawText.trim();
  if (!attachments || attachments.length === 0) {
    return trimmed;
  }
  const refs: string[] = [];
  for (const att of attachments) {
    if (!att?.path) continue;
    const ref = formatAttachmentPromptRef(att.path, workspaceRoot);
    if (ref && !trimmed.includes(ref) && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  if (refs.length === 0) {
    return trimmed;
  }
  return trimmed ? `${trimmed}\n${refs.join("\n")}` : refs.join("\n");
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(true), ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

export class TurnPump implements InboundSink {
  private worker: WorkerClient;
  private readonly router: SessionRouter;
  private readonly security: SecurityGate;
  private readonly workspaceRoot: string;
  private readonly clock: () => number;
  private readonly questionTtl: number;
  private readonly scanInterval: number;
  private readonly requestTimeout: number;
  private readonly channels: Record<string, Channel> = {};
  readonly outbound: Outbound;
  private readonly seenRefs = new Map<string, true>();
  private readonly pendingInbound: InboundMessage[] = [];
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly targets = new Map<string, ReplyPosition>();
  private readonly reactions: ReactionController;
  private readonly commands: CommandHub;

  constructor(options: {
    worker: WorkerClient;
    router: SessionRouter;
    security: SecurityGate;
    workspaceRoot: string;
    clock?: () => number;
    questionTtl?: number;
    scanInterval?: number;
    requestTimeout?: number;
    reactions?: ReactionController;
  }) {
    this.worker = options.worker;
    this.router = options.router;
    this.security = options.security;
    this.workspaceRoot = options.workspaceRoot;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.questionTtl = options.questionTtl ?? QUESTION_TTL_SECONDS;
    this.scanInterval = options.scanInterval ?? QUESTION_SCAN_SECONDS;
    this.requestTimeout = options.requestTimeout ?? REQUEST_TIMEOUT_SECONDS;
    this.outbound = new Outbound(this.channels);
    this.reactions =
      options.reactions ??
      new ReactionController({
        react: (pos, emoji) => this.outbound.reactEmoji(pos, emoji),
        clock: this.clock,
      });

    this.commands = new CommandHub({
      workerGetter: () => this.worker,
      router: this.router,
      links: {
        activeSession: key => this.activeSession(key),
        finishTurn: key => this.finishTurn(key),
        queueDepth: () => this.pendingInbound.length,
        bindTarget: (sessionId, position) => {
          this.targets.set(sessionId, position);
        },
      },
      workspaceRoot: this.workspaceRoot,
      requestTimeout: this.requestTimeout,
    });

    this.worker.onEvent((envelope, replayed) => this.handleEvent(envelope, replayed));
  }

  registerChannel(channel: Channel): void {
    this.channels[channel.id] = channel;
  }

  activeSession(key: string): string | null {
    return this.turns.get(key)?.session_id ?? null;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const ok = await sleepAbortable(Math.max(5, this.scanInterval * 1000), signal);
      if (!ok) {
        return;
      }
      await this.tick();
    }
  }

  async tick(): Promise<void> {
    if (this.pendingInbound.length > 0 && (this.worker.connected ?? true)) {
      await this.flushQueued();
    }
    await this.expireQuestions();
    await this.resetStuckTurns();
  }

  // --- inbound decision table (ordered rows) ----------------------------------

  async inbound(message: InboundMessage): Promise<void> {
    if (!(this.worker.connected ?? true)) {
      this.pendingInbound.push(message);
      while (this.pendingInbound.length > INBOUND_QUEUE_LIMIT) {
        this.pendingInbound.shift();
      }
      if (isCommand(message.text.trim())) {
        await this.outbound.send(message.channel, this.targetOf(message), {
          text: OFFLINE_NOTICE,
        });
      }
      return;
    }
    if (this.pendingInbound.length > 0) {
      await this.flushQueued();
    }
    await this.processMessage(message);
  }

  private async flushQueued(): Promise<void> {
    while (this.pendingInbound.length > 0) {
      const next = this.pendingInbound.shift()!;
      await this.processMessage(next);
    }
  }

  private async processMessage(message: InboundMessage): Promise<void> {
    // Row 1: message_ref LRU dedup
    if (this.isDuplicate(message)) {
      return;
    }
    // Rows 2-3: security admission (pairing / group / cooldown)
    const verdict = this.security.admit(message);
    if (!verdict.allow) {
      if (verdict.notice) {
        await this.outbound.send(message.channel, this.targetOf(message), {
          text: verdict.notice,
        });
      }
      return;
    }

    const key = sessionKey(message);
    const trimmed = message.text.trim();
    const target = this.targetOf(message);

    // Row 4: slash control commands
    if (trimmed.startsWith("/")) {
      const reply = await this.commands.dispatch(trimmed, {
        channel_id: message.channel,
        target,
        message,
        key,
      });
      if (reply) {
        await this.outbound.send(message.channel, target, { text: reply });
      }
      return;
    }

    // Row 5: numbered answer to an active pending question
    const question = this.questions.get(key);
    if (question && this.clock() < question.deadline && message.attachments.length === 0) {
      if (/^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10);
        if (idx >= 1 && idx <= question.options.length) {
          await this.answerQuestion(question, question.options[idx - 1]!);
          return;
        }
      }
    }

    // Rows 6-7: follow_up (if turn active) or session/prompt
    const record = await this.ensureSession(message, key);
    if (!record) {
      return;
    }
    const position: ReplyPosition = [message.channel, target];
    this.targets.set(record.session_id, position);

    const promptText = buildPromptText(trimmed, message.attachments, this.workspaceRoot);
    const turn = this.turns.get(key);
    const method = turn
      ? RuntimeMethod.RIND_SESSION_FOLLOW_UP
      : RuntimeMethod.SESSION_PROMPT;
    await this.dispatchInput(key, message, record, promptText, method, !turn);
  }

  private isDuplicate(message: InboundMessage): boolean {
    const ref = message.message_ref;
    if (!ref) {
      return false;
    }
    if (this.seenRefs.has(ref)) {
      return true;
    }
    this.seenRefs.set(ref, true);
    while (this.seenRefs.size > MESSAGE_REF_LRU_SIZE) {
      const oldest = this.seenRefs.keys().next().value;
      if (oldest === undefined) break;
      this.seenRefs.delete(oldest);
    }
    return false;
  }

  private targetOf(message: InboundMessage): SendTarget {
    return { chat_id: message.chat_id, thread_id: message.thread_id };
  }

  private async answerQuestion(question: PendingQuestion, answer: string): Promise<void> {
    this.questions.delete(question.key);
    try {
      await this.worker.request(
        RuntimeMethod.RIND_USER_QUESTION_RESPOND,
        {
          session_id: question.session_id,
          tool_call_id: question.tool_call_id,
          answer,
        },
        this.requestTimeout,
      );
    } catch {
      // best effort
    }
  }

  private async ensureSession(
    message: InboundMessage,
    key: string,
  ): Promise<SessionRecord | null> {
    try {
      const record = await this.router.ensureSession(
        key,
        this.worker,
        this.workspaceRoot,
      );
      await this.worker.subscribe(record.session_id);
      return record;
    } catch {
      await this.outbound.send(message.channel, this.targetOf(message), {
        text: SESSION_CREATE_FAILED_REPLY,
      });
      return null;
    }
  }

  private async dispatchInput(
    key: string,
    message: InboundMessage,
    record: SessionRecord,
    text: string,
    method: string,
    newTurn: boolean,
  ): Promise<void> {
    const target = this.targetOf(message);
    const position: ReplyPosition = [message.channel, target];
    if (newTurn) {
      this.turns.set(key, {
        session_id: record.session_id,
        channel_id: message.channel,
        target,
        started_at: this.clock(),
        turn_id: "",
        title: firstLineTitle(text),
        confirmed: false,
      });
      await this.reactions.queued(position);
    }
    try {
      await this.worker.request(
        method,
        { session_id: record.session_id, input: text },
        newTurn ? Math.max(this.requestTimeout, TURN_STUCK_SECONDS) : this.requestTimeout,
      );
    } catch (exc) {
      if (exc instanceof WorkerError || exc instanceof Error) {
        const currentTurn = this.turns.get(key);
        if (newTurn && currentTurn?.confirmed) {
          return;
        }
        if (newTurn && currentTurn) {
          this.turns.delete(key);
          await this.reactions.cancel(position);
        }
        await this.outbound.send(message.channel, target, {
          text: WORKER_UNRESPONSIVE_REPLY,
        });
      }
    }
  }

  // --- worker events → outbound mapping ---------------------------------------

  async handleEvent(
    envelope: Readonly<Record<string, unknown>>,
    replayed = false,
  ): Promise<void> {
    const sessionId = String(envelope.session_id ?? "");
    const rawEvent = envelope.event;
    const event: Record<string, unknown> =
      rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
        ? (rawEvent as Record<string, unknown>)
        : {};
    const etype = String(event.type ?? "");
    const key = this.router.keyForSession(sessionId);
    if (!key) {
      return;
    }
    if (etype === "task_updated" || etype === "task_output") {
      return;
    }
    if (envelope.durability === "durable") {
      this.router.updateCursor(key, this.router.cursorFor(key) + 1);
    }
    const position = this.positionFor(key, sessionId);
    await this.reactions.onEvent(position, event, { replayed });
    if (etype === "tool_requested" || etype === "tool_result") {
      return;
    }
    if (etype === "turn_started") {
      this.onTurnStarted(key, sessionId, String(envelope.turn_id ?? ""));
    } else if (etype === "user_question_requested") {
      await this.onQuestion(key, sessionId, event);
    } else if (etype === "assistant_message_completed") {
      await this.onAssistant(key, sessionId, event);
    } else if (TERMINAL_EVENT_TYPES.has(etype)) {
      await this.finishTurn(key);
      if (etype === "turn_failed") {
        const detail = `${userErrorLine(event)} (session ${sessionId.slice(0, 8)})`;
        await this.outbound.reply(position, detail);
      } else if (etype === "turn_cancelled") {
        await this.outbound.reply(position, STOPPED_REPLY);
      }
    }
  }

  private onTurnStarted(key: string, sessionId: string, turnId: string): void {
    let turn = this.turns.get(key);
    if (!turn) {
      const position = this.targets.get(sessionId);
      if (!position) {
        return;
      }
      turn = {
        session_id: sessionId,
        channel_id: position[0],
        target: position[1],
        started_at: this.clock(),
        turn_id: "",
        title: "",
        confirmed: false,
      };
      this.turns.set(key, turn);
    }
    turn.confirmed = true;
    turn.turn_id = turnId;
    this.outbound.startTyping(key, turn.channel_id, turn.target);
  }

  private async onQuestion(
    key: string,
    sessionId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const position = this.positionFor(key, sessionId);
    if (!position) {
      return;
    }
    const rawOptions = Array.isArray(event.options) ? event.options : [];
    const options = rawOptions.map(opt => {
      if (opt && typeof opt === "object" && !Array.isArray(opt)) {
        return String((opt as Record<string, unknown>).label ?? "");
      }
      return String(opt ?? "");
    });
    const questionText = String(event.question || "Choose:");
    await this.outbound.sendQuestion(position, questionText, options);
    this.questions.set(key, {
      key,
      session_id: sessionId,
      channel_id: position[0],
      target: position[1],
      tool_call_id: String(event.tool_call_id ?? ""),
      options,
      deadline: this.clock() + this.questionTtl,
    });
  }

  private async onAssistant(
    key: string,
    sessionId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const position = this.positionFor(key, sessionId);
    const content = String(event.content ?? "");
    if (!position || !content.trim()) {
      return;
    }
    const turn = this.turns.get(key);
    await this.outbound.sendAssistant(position, content, turn?.title ?? "");
  }

  private async finishTurn(key: string): Promise<void> {
    this.turns.delete(key);
    await this.outbound.stopTyping(key);
  }

  private positionFor(key: string, sessionId?: string): ReplyPosition | null {
    const turn = this.turns.get(key);
    if (turn) {
      return [turn.channel_id, turn.target];
    }
    const resolvedSessionId = sessionId ?? this.router.lookup(key)?.session_id;
    if (!resolvedSessionId) {
      return null;
    }
    return this.targets.get(resolvedSessionId) ?? null;
  }

  async expireQuestions(): Promise<void> {
    const now = this.clock();
    const expired = [...this.questions.values()].filter(q => now >= q.deadline);
    for (const question of expired) {
      this.questions.delete(question.key);
      const timeoutOpt = question.options.find(
        o => o.includes("超时") || o.toLowerCase().includes("timeout"),
      );
      if (timeoutOpt !== undefined) {
        await this.answerQuestion(question, timeoutOpt);
      } else {
        await this.outbound.reply(
          [question.channel_id, question.target],
          QUESTION_EXPIRED_REPLY,
        );
      }
    }
  }

  async resetStuckTurns(): Promise<void> {
    const now = this.clock();
    for (const [key, turn] of [...this.turns.entries()]) {
      if (now - turn.started_at <= TURN_STUCK_SECONDS) {
        continue;
      }
      await this.reactions.cancel([turn.channel_id, turn.target]);
      await this.finishTurn(key);
    }
  }
}
