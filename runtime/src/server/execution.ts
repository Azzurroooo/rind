import { randomUUID } from "node:crypto";
import { TaskNotifications, pendingNotification } from "../application/context-manager.js";
import {
  type AgentContainer,
  type SharedRuntimeResources,
  buildAgentContainer,
} from "../core/turn-runner.js";
import {
  type CancellationToken,
  CancellationTokenSource,
} from "../domain/cancellation.js";
import { CancelledError, ProviderError } from "../domain/errors.js";
import type { userQuestionRequestedEvent } from "../domain/events.js";
type UserQuestionRequestedEvent = ReturnType<typeof userQuestionRequestedEvent>;
import {
  type ChatClient,
  type ModelDefinition,
  type ModelSelection,
  TERMINAL_STATES,
  publicTask,
} from "../domain/models.js";
import type { ProviderServiceImpl } from "../infrastructure/llm/provider-service.js";
import { validateSessionId, validateWorkspaceRoot } from "../infrastructure/paths.js";
import { type AppSettings, loadSettings } from "../infrastructure/settings.js";
import { ExternalTool } from "../infrastructure/tools/control-tools.js";
import type { ShellTools } from "../infrastructure/tools/shell-tools.js";
import type { WebSessions } from "../infrastructure/tools/web-tools.js";
import { buildGoalCheckpointPrompt } from "../prompts.js";
import type { SessionService } from "./session-service.js";

// A selection whose connection cannot be used still builds an execution; its
// turns then fail with the reason instead of the worker failing to start.
export const UNUSABLE_CONNECTION_CODES: ReadonlySet<string> = new Set([
  "provider_not_configured",
  "connection_missing",
]);

class AsyncLock {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

interface PendingAnswerFuture {
  promise: Promise<string>;
  resolve: (value: string) => void;
  done: boolean;
}

function createPendingAnswerFuture(): PendingAnswerFuture {
  let resolveFn!: (value: string) => void;
  const future: PendingAnswerFuture = {
    promise: Promise.resolve(""),
    resolve: (value: string) => {
      if (!future.done) {
        future.done = true;
        resolveFn(value);
      }
    },
    done: false,
  };
  future.promise = new Promise<string>(resolve => {
    resolveFn = resolve;
  });
  return future;
}

class AsyncEvent {
  private setFlag = false;
  private waiters: Array<() => void> = [];

  set(): void {
    this.setFlag = true;
    const current = this.waiters.splice(0, this.waiters.length);
    for (const waiter of current) {
      waiter();
    }
  }

  clear(): void {
    this.setFlag = false;
  }

  async wait(): Promise<void> {
    if (this.setFlag) return;
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }
}

interface ActiveExecution {
  container: AgentContainer;
  chatClient: ChatClient | null;
  selection: ModelSelection | null;
  turnSlot: AsyncLock;
  currentCancel: CancellationTokenSource | null;
  pendingAnswers: Map<string, PendingAnswerFuture>;
  queuedTurnStarts: number;
}

interface RequestScope {
  requestId: string;
  changed: AsyncEvent;
  answer: string;
  error: string;
}

type EventSink = (event: Record<string, unknown>) => Promise<void> | void;

export class ExecutionCoordinator {
  private readonly sharedResources: SharedRuntimeResources;
  private readonly shellTools: ShellTools;
  private readonly webSessions: WebSessions;
  private readonly repository: SessionService;
  private readonly debug: boolean;
  private readonly enableGoal: boolean;
  private readonly enableUserQuestion: boolean;
  readonly sessionDir: string | null;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly starting = new Map<string, Promise<AgentContainer>>();
  private readonly live = new Map<string, Record<string, unknown>>();
  private readonly continuations = new Map<string, Promise<void>>();
  private readonly deliveries = new Map<string, string[]>();
  private readonly deliveryRuns = new Map<string, Promise<void>>();
  private readonly suppressed = new Set<string>();
  private readonly pendingInterrupts = new Map<string, string>();
  private readonly pendingWakes = new Set<string>();
  private readonly scopes = new Map<string, RequestScope>();
  private readonly taskEvents = new Map<string, Record<string, unknown>>();
  private readonly taskResyncSessions = new Set<string>();
  private taskEventPump: Promise<void> | null = null;
  private readonly taskNotifications: TaskNotifications;
  private readonly eventSinks: EventSink[] = [];
  private closed = false;
  private readonly closedSessions = new Set<string>();
  private readonly providerService: ProviderServiceImpl;
  private readonly defaultExternalTool: ExternalTool | null;
  private readonly sessionOptions = new Map<string, [ExternalTool | null, boolean]>();
  private readonly lock = new AsyncLock();

  constructor(options: {
    sharedResources: SharedRuntimeResources;
    shellTools: ShellTools;
    webSessions: WebSessions;
    repository: SessionService;
    debug: boolean;
    enableGoal: boolean;
    enableUserQuestion: boolean;
    sessionDir: string | null;
    providerService: ProviderServiceImpl;
    externalTool?: ExternalTool | null;
  }) {
    this.sharedResources = options.sharedResources;
    this.shellTools = options.shellTools;
    this.webSessions = options.webSessions;
    this.repository = options.repository;
    this.debug = options.debug;
    this.enableGoal = options.enableGoal;
    this.enableUserQuestion = options.enableUserQuestion;
    this.sessionDir = options.sessionDir;
    this.providerService = options.providerService;
    this.defaultExternalTool = options.externalTool ?? null;
    this.taskNotifications = new TaskNotifications(
      this.shellTools.supervisor.journal!,
      snapshot => this.taskChanged(snapshot),
      sid => this.scopes.get(sid)?.requestId ?? null,
    );
    this.shellTools.supervisor.setObserver(snapshot => this.taskChanged(snapshot));
  }

  async configureSession(
    sessionId: string,
    externalTool: ExternalTool | null,
    enableUserQuestion: boolean,
  ): Promise<void> {
    const clean = validateSessionId(sessionId);
    await this.lock.runExclusive(async () => {
      const previous = this.sessionOptions.get(clean);
      if (
        previous &&
        previous[0] === externalTool &&
        previous[1] === enableUserQuestion
      ) {
        return;
      }
      if (
        previous &&
        previous[0] &&
        externalTool &&
        previous[0].command === externalTool.command &&
        JSON.stringify(previous[0].args) === JSON.stringify(externalTool.args)
      ) {
        const merged = new ExternalTool({
          command: externalTool.command,
          args: externalTool.args,
          env: externalTool.env,
          tools: externalTool.tools,
          instructions: externalTool.instructions || previous[0].instructions,
          lifecycle: externalTool.lifecycle,
          skillFiles: externalTool.skill_files,
        });
        const keepQuestion =
          this.active.has(clean) || this.starting.has(clean)
            ? previous[1]
            : enableUserQuestion;
        this.sessionOptions.set(clean, [merged, keepQuestion]);
        this.syncExternalTool(clean, previous[0], merged);
        return;
      }
      if (this.active.has(clean) || this.starting.has(clean)) {
        throw new Error("Cannot change a running session's execution configuration.");
      }
      this.sessionOptions.set(clean, [externalTool, enableUserQuestion]);
    });
  }

  private syncExternalTool(
    sessionId: string,
    previous: ExternalTool | null,
    current: ExternalTool | null,
  ): void {
    const container = this.active.get(sessionId)?.container;
    if (!container || !current) {
      return;
    }
    const previousNames = previous ? previous.tools.map(t => t.name) : [];
    container.tool_registry.replaceExternalSpecs(previousNames, current.specs(sessionId));
    if (current.instructions) {
      container.runtime.setExternalInstructions(current.instructions);
    }
  }

  userQuestionEnabled(sessionId: string): boolean {
    const opts = this.sessionOptions.get(sessionId);
    return opts ? opts[1] : this.enableUserQuestion;
  }

  externalTool(sessionId: string): ExternalTool | null {
    const opts = this.sessionOptions.get(sessionId);
    return opts ? opts[0] : this.defaultExternalTool;
  }

  ownsSession(sessionId: string): boolean {
    return (
      this.sessionOptions.has(sessionId) ||
      this.active.has(sessionId) ||
      this.starting.has(sessionId)
    );
  }

  forgetOptions(sessionId: string): void {
    const clean = validateSessionId(sessionId);
    if (!this.active.has(clean) && !this.starting.has(clean)) {
      this.sessionOptions.delete(clean);
    }
  }

  addEventSink(sink: EventSink): () => void {
    this.eventSinks.push(sink);
    return () => {
      const idx = this.eventSinks.indexOf(sink);
      if (idx !== -1) {
        this.eventSinks.splice(idx, 1);
      }
    };
  }

  private async emitToEventSinks(event: Record<string, unknown>): Promise<void> {
    for (const sink of [...this.eventSinks]) {
      try {
        await sink(event);
      } catch {
        const idx = this.eventSinks.indexOf(sink);
        if (idx !== -1) {
          this.eventSinks.splice(idx, 1);
        }
      }
    }
  }

  taskChanged(snapshot: Record<string, unknown>): void {
    if (this.closed) return;
    const sessionId = String(snapshot.owner_session_id || "");
    const eventType = String(snapshot.type || "task_updated");
    const taskId = String(snapshot.task_id || "");
    const key = `${taskId}:${eventType}`;
    if (TERMINAL_STATES.has(String(snapshot.status || ""))) {
      this.taskEvents.delete(`${taskId}:task_output`);
    }
    this.queueTaskEvent(key, {
      type: eventType,
      session_id: sessionId,
      turn_id: "",
      origin_turn_id: String(snapshot.origin_turn_id || ""),
      task: publicTask(snapshot),
    });
    const scope = this.scopes.get(sessionId);
    if (scope) {
      scope.changed.set();
    }
    if (pendingNotification(snapshot)) {
      this.scheduleContinuation(sessionId);
    }
  }

  async backgroundWait(sessionId: string): Promise<Record<string, unknown> | null> {
    if (this.closed || this.suppressed.has(sessionId) || this.closedSessions.has(sessionId)) {
      return null;
    }
    const records = await this.taskNotifications.store.relevant(sessionId);
    const scope = this.scopes.get(sessionId);
    const workerId = this.shellTools.supervisor.journal?.worker_instance_id ?? "";
    const tasks = Object.values(records).filter(
      record =>
        record.notify === "on_exit" &&
        record.status === "running" &&
        Boolean(record.committed) &&
        Boolean(record.handoff) &&
        record.worker_instance_id === workerId &&
        (!scope || record.request_id === scope.requestId),
    );
    if (tasks.length === 0) {
      return null;
    }
    const goal = this.enableGoal ? await this.repository.getGoal(sessionId) : null;
    if (goal && ["paused", "blocked", "budget_exhausted"].includes(String(goal.status || ""))) {
      return null;
    }
    const ordered = [...tasks].sort((a, b) =>
      String(a.started_at || "").localeCompare(String(b.started_at || "")),
    );
    const commands = ordered.slice(0, 3).map(record =>
      String(record.command || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .slice(0, 120),
    );
    return {
      count: tasks.length,
      started_at: ordered[0]!.started_at,
      commands,
    };
  }

  refreshBackgroundWait(sessionId: string): void {
    if (this.closed) return;
    this.queueTaskEvent(`${sessionId}:background_wait_changed`, {
      type: "background_wait_changed",
      session_id: sessionId,
      turn_id: "",
    });
  }

  private queueTaskEvent(key: string, event: Record<string, unknown>): void {
    if (this.taskEvents.size >= 128 && !this.taskEvents.has(key)) {
      let oldest: string | undefined;
      for (const item of this.taskEvents.keys()) {
        if (item.endsWith(":task_output")) {
          oldest = item;
          break;
        }
      }
      if (oldest === undefined) {
        oldest = this.taskEvents.keys().next().value;
      }
      if (oldest !== undefined) {
        const dropped = this.taskEvents.get(oldest);
        this.taskEvents.delete(oldest);
        if (dropped && dropped.type !== "task_output" && typeof dropped.session_id === "string") {
          this.taskResyncSessions.add(dropped.session_id);
        }
      }
    }
    this.taskEvents.set(key, event);
    if (this.taskEventPump === null) {
      this.taskEventPump = this.publishTaskEvents();
    }
  }

  private async publishTaskEvents(): Promise<void> {
    try {
      while (this.taskEvents.size > 0 || this.taskResyncSessions.size > 0) {
        if (this.taskEvents.size > 0) {
          const firstKey = this.taskEvents.keys().next().value!;
          const event = this.taskEvents.get(firstKey)!;
          this.taskEvents.delete(firstKey);
          const sessionId = String(event.session_id || "");
          if (event.type === "background_wait_changed") {
            event.background_wait = await this.backgroundWait(sessionId);
          }
          await this.emitToEventSinks(event);
          if (event.type === "task_updated") {
            this.refreshBackgroundWait(sessionId);
          }
        } else {
          const sessionId = this.taskResyncSessions.values().next().value!;
          this.taskResyncSessions.delete(sessionId);
          const records = await this.taskNotifications.store.records(sessionId);
          for (const record of Object.values(records)) {
            await this.emitToEventSinks({
              type: "task_updated",
              session_id: sessionId,
              turn_id: "",
              origin_turn_id: String(record.origin_turn_id || ""),
              task: publicTask(record),
            });
          }
          this.refreshBackgroundWait(sessionId);
        }
      }
    } finally {
      this.taskEventPump = null;
    }
  }

  private scheduleContinuation(sessionId: string): boolean {
    if (this.closed || this.suppressed.has(sessionId) || this.closedSessions.has(sessionId)) {
      return false;
    }
    this.pendingWakes.add(sessionId);
    if (this.continuations.has(sessionId)) {
      return false;
    }
    const task = this.runContinuation(sessionId);
    this.continuations.set(sessionId, task);
    return true;
  }

  async startGoalContinuation(sessionId: string): Promise<boolean> {
    const clean = validateSessionId(sessionId);
    this.refreshBackgroundWait(clean);
    return this.scheduleContinuation(clean);
  }

  private async runContinuation(sessionId: string): Promise<void> {
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      while (!this.closed && !this.suppressed.has(sessionId)) {
        this.pendingWakes.delete(sessionId);
        let active = this.active.get(sessionId);
        if (active && (active.queuedTurnStarts > 0 || active.container.runtime.turnActive)) {
          return;
        }
        const records = await this.taskNotifications.store.relevant(sessionId);
        const scope = this.scopes.get(sessionId);
        const relevant = Object.values(records).filter(
          r => !scope || r.request_id === scope.requestId,
        );
        const pending = relevant.some(r => pendingNotification(r));
        const waiting = relevant.some(
          r => r.notify === "on_exit" && !TERMINAL_STATES.has(String(r.status || "")),
        );
        const goal = this.enableGoal ? await this.repository.getGoal(sessionId) : null;
        if (goal && ["paused", "blocked", "budget_exhausted"].includes(String(goal.status || ""))) {
          if (scope) {
            scope.error = `Goal does not allow continuation (${goal.status}).`;
          }
          return;
        }
        if (!pending && (waiting || !goal || goal.status !== "active")) {
          return;
        }
        active = this.active.get(sessionId);
        if (active && (active.queuedTurnStarts > 0 || active.container.runtime.turnActive)) {
          return;
        }
        let terminal = "";
        for await (const event of this.runTurn(sessionId, {
          query: null,
          continuation: true,
          checkpoint: !pending && goal ? String(goal.objective || "") : null,
        })) {
          terminal = String(event.type || terminal);
        }
        if (!terminal) {
          return;
        }
        if (terminal !== "turn_completed") {
          this.suppressed.add(sessionId);
          return;
        }
      }
    } catch (exc) {
      if (exc instanceof CancelledError) {
        return;
      }
      const errMsg = exc instanceof Error ? exc.message : String(exc);
      this.suppressed.add(sessionId);
      this.refreshBackgroundWait(sessionId);
      const scope = this.scopes.get(sessionId);
      if (scope) {
        scope.error = errMsg;
      }
      await this.emitToEventSinks({
        type: "task_continuation_failed",
        session_id: sessionId,
        turn_id: "",
        error: errMsg,
      });
    } finally {
      this.continuations.delete(sessionId);
      const scope = this.scopes.get(sessionId);
      if (scope) {
        scope.changed.set();
      }
      if (this.pendingWakes.has(sessionId)) {
        this.pendingWakes.delete(sessionId);
        this.scheduleContinuation(sessionId);
      }
      if (!this.continuations.has(sessionId)) {
        const active = this.active.get(sessionId);
        if (active) {
          await this.releaseIfIdle(sessionId, active);
        }
      }
    }
  }

  deliver(sessionId: string, text: string): void {
    const clean = validateSessionId(sessionId);
    if (this.closed || this.closedSessions.has(clean)) {
      throw new Error("This conversation is closed.");
    }
    const list = this.deliveries.get(clean) ?? [];
    list.push(text);
    this.deliveries.set(clean, list);
    if (!this.deliveryRuns.has(clean)) {
      this.deliveryRuns.set(clean, this.runDeliveries(clean));
    }
  }

  private async runDeliveries(sessionId: string): Promise<void> {
    try {
      while (!this.closed) {
        const texts = this.deliveries.get(sessionId);
        if (!texts || texts.length === 0) break;
        this.deliveries.delete(sessionId);
        for await (const _ of this.runTurn(sessionId, {
          query: texts.join("\n\n"),
          delivery: true,
        })) {
          // consume
        }
      }
    } catch (exc) {
      if (exc instanceof CancelledError) return;
      const errMsg = exc instanceof Error ? exc.message : String(exc);
      await this.emitToEventSinks({
        type: "task_continuation_failed",
        session_id: sessionId,
        turn_id: "",
        error: errMsg,
      });
    } finally {
      this.deliveryRuns.delete(sessionId);
      const active = this.active.get(sessionId);
      if (active) {
        await this.releaseIfIdle(sessionId, active);
      }
    }
  }

  beginRequest(sessionId: string): string {
    const clean = validateSessionId(sessionId);
    if (this.scopes.has(clean)) {
      throw new Error("A request is already active for this session.");
    }
    this.suppressed.delete(clean);
    const scope: RequestScope = {
      requestId: randomUUID().replace(/-/g, ""),
      changed: new AsyncEvent(),
      answer: "",
      error: "",
    };
    this.scopes.set(clean, scope);
    return scope.requestId;
  }

  async waitRequest(sessionId: string): Promise<Record<string, unknown>> {
    const scope = this.scopes.get(sessionId);
    if (!scope) {
      throw new Error("Request interrupted.");
    }
    try {
      while (true) {
        scope.changed.clear();
        if (this.closed || this.suppressed.has(sessionId) || scope.error) {
          throw new Error(scope.error || "Request interrupted.");
        }
        const records = await this.taskNotifications.store.relevant(sessionId);
        const relevant = Object.values(records).filter(r => r.request_id === scope.requestId);
        const waiting = relevant.some(
          r =>
            (r.notify === "on_exit" && !TERMINAL_STATES.has(String(r.status || ""))) ||
            pendingNotification(r),
        );
        const active = this.active.get(sessionId);
        const busy = Boolean(
          active && (active.queuedTurnStarts > 0 || active.container.runtime.turnActive),
        );
        if (!waiting && !busy && !this.continuations.has(sessionId)) {
          return { request_id: scope.requestId, answer: scope.answer };
        }
        await scope.changed.wait();
      }
    } catch (err) {
      await this.abandonRequest(sessionId);
      throw err;
    } finally {
      this.scopes.delete(sessionId);
    }
  }

  async abandonRequest(sessionId: string): Promise<void> {
    const scope = this.scopes.get(sessionId);
    this.scopes.delete(sessionId);
    const reason = (scope ? scope.error : "") || "Request disconnected";
    this.interrupt(sessionId, reason);
    const continuation = this.continuations.get(sessionId);
    if (continuation) {
      try {
        await continuation;
      } catch {
        // ignore
      }
    }
    if (scope) {
      await this.shellTools.supervisor.closeRequest(sessionId, scope.requestId, reason);
    }
  }

  activeSessionIds(): Set<string> {
    return new Set(this.active.keys());
  }

  turnRunning(sessionId: string): boolean {
    const execution = this.active.get(validateSessionId(sessionId));
    return Boolean(
      execution && (execution.queuedTurnStarts > 0 || execution.container.runtime.turnActive),
    );
  }

  activeContainer(sessionId: string): AgentContainer | null {
    const clean = validateSessionId(sessionId);
    return this.active.get(clean)?.container ?? null;
  }

  activeTurnId(sessionId: string): string {
    const clean = validateSessionId(sessionId);
    const execution = this.active.get(clean);
    if (!execution) return "";
    return String(execution.container.runtime.activeTurnId || "");
  }

  liveTurn(sessionId: string): Record<string, unknown> | null {
    const clean = validateSessionId(sessionId);
    const snapshot = this.live.get(clean);
    return snapshot ? copyLiveTurn(snapshot) : null;
  }

  recordLiveInput(sessionId: string, result: Record<string, unknown>): void {
    const clean = validateSessionId(sessionId);
    const snapshot = this.live.get(clean);
    const inputId = String(result.input_id || "").trim();
    if (!snapshot || !inputId) return;
    const pending = snapshot.pending_inputs as Array<Record<string, unknown>>;
    if (pending.some(item => item.input_id === inputId)) return;
    pending.push({
      input_id: inputId,
      input: String(result.input || ""),
      mode: result.mode === "steering" ? "steering" : "follow_up",
    });
  }

  updateLiveEvent(event: Record<string, unknown>): void {
    const sessionId = String(event.session_id || "").trim();
    const turnId = String(event.turn_id || "").trim();
    const eventType = String(event.type || "");
    if (!sessionId || !turnId) return;
    let current = this.live.get(sessionId);
    if (eventType === "turn_started" || !current || current.turn_id !== turnId) {
      if (eventType !== "turn_started") return;
      current = newLiveTurn(turnId);
      current.operation = String(event.operation || "");
      this.live.set(sessionId, current);
    }
    if (eventType === "assistant_delta") {
      current.assistant_text = boundedLiveText(
        String(current.assistant_text || "") + String(event.text || ""),
      );
    } else if (eventType === "turn_step_retry" || eventType === "assistant_message_completed") {
      current.assistant_text = "";
    } else if (eventType === "tool_requested") {
      const tool = liveTool(current, event);
      Object.assign(tool, {
        tool_name: String(event.tool_name || ""),
        args_preview: boundedLiveText(String(event.args_preview || ""), 120),
        arguments:
          event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments)
            ? event.arguments
            : {},
        status: "pending",
      });
    } else if (eventType === "tool_input_started") {
      const tool = liveTool(current, event);
      Object.assign(tool, {
        tool_name: String(event.tool_name || ""),
        status: "pending",
      });
    } else if (eventType === "tool_input_delta") {
      const tool = liveTool(current, event);
      tool.args_preview = boundedLiveText(
        String(tool.args_preview || "") + String(event.delta || ""),
        120,
      );
    } else if (eventType === "tool_call_started") {
      liveTool(current, event).status = "running";
    } else if (eventType === "tool_progress") {
      const tool = liveTool(current, event);
      const payload = event.payload;
      const progress =
        typeof payload === "string"
          ? payload
          : payload !== undefined && payload !== null
            ? JSON.stringify(payload)
            : "";
      tool.output = boundedLiveText(String(tool.output || "") + progress);
    } else if (eventType === "tool_result") {
      const tool = liveTool(current, event);
      const result = String(event.result || "");
      const resultStatus = String(event.status || "");
      Object.assign(tool, {
        status:
          event.error_type || resultStatus === "error" || resultStatus === "failed"
            ? "error"
            : "completed",
        output: boundedLiveText(result),
        error_type: String(event.error_type || ""),
        duration_ms: Number(event.duration_ms || 0),
      });
      const question = current.question as Record<string, unknown> | null;
      if (question && question.tool_call_id === tool.tool_call_id) {
        current.question = null;
      }
    } else if (eventType === "plan_updated") {
      current.plan = Array.isArray(event.plan) ? event.plan : [];
    } else if (eventType === "user_question_requested") {
      current.question = {
        tool_call_id: String(event.tool_call_id || ""),
        question: String(event.question || ""),
        options: Array.isArray(event.options) ? event.options : [],
      };
    } else if (eventType === "queued_input_delivered") {
      const inputId = String(event.input_id || "");
      const pending = current.pending_inputs as Array<Record<string, unknown>>;
      current.pending_inputs = pending.filter(item => item.input_id !== inputId);
    } else if (eventType === "file_change") {
      const filePath = String(event.file_path || "");
      const files = current.files as string[];
      if (filePath && !files.includes(filePath)) {
        files.push(filePath);
      }
    } else if (eventType === "token_stats_updated") {
      const stats = event.stats as Record<string, unknown> | undefined;
      if (stats && typeof stats.context_usage_percent === "number") {
        current.context_usage_percent = stats.context_usage_percent;
      }
    } else if (
      eventType === "turn_completed" ||
      eventType === "turn_failed" ||
      eventType === "turn_cancelled"
    ) {
      current.status = eventType.replace(/^turn_/, "");
      current.question = null;
    }
  }

  async *runTurn(
    sessionId: string,
    options: {
      query: string | null;
      transientSystemMessages?: Array<Record<string, unknown>> | null;
      cancellationToken?: CancellationToken | null;
      resume?: boolean;
      continuation?: boolean;
      compact?: boolean;
      checkpoint?: string | null;
      delivery?: boolean;
    },
  ): AsyncGenerator<Record<string, unknown>, void, void> {
    const clean = validateSessionId(sessionId);
    const continuation = options.continuation ?? false;
    const compact = options.compact ?? false;
    const resume = options.resume ?? false;
    const delivery = options.delivery ?? false;
    const checkpoint = options.checkpoint ?? null;
    const query = options.query;
    const transientSystemMessages = options.transientSystemMessages ?? null;

    if (!continuation) {
      this.pendingInterrupts.delete(clean);
    }
    if (!continuation && !compact) {
      this.suppressed.delete(clean);
    }
    await this.start(clean);
    const execution = this.active.get(clean)!;
    if (compact && (execution.queuedTurnStarts > 0 || execution.container.runtime.turnActive)) {
      throw new Error("Cannot compact context while a turn is active.");
    }
    execution.queuedTurnStarts += 1;
    let terminalType = "";
    let terminalEvent: Record<string, unknown> | null = null;
    let businessStarted = !compact;
    try {
      await execution.turnSlot.acquire();
      try {
        if (
          this.closed ||
          this.pendingInterrupts.has(clean) ||
          (this.suppressed.has(clean) && !compact) ||
          (continuation && execution.queuedTurnStarts > 1)
        ) {
          this.pendingInterrupts.delete(clean);
          return;
        }
        const cancelSource = new CancellationTokenSource(options.cancellationToken ?? null);
        execution.currentCancel = cancelSource;
        this.pendingInterrupts.delete(clean);

        try {
          if (continuation) {
            const records = await this.taskNotifications.store.relevant(clean);
            const scope = this.scopes.get(clean);
            const pending = Object.values(records).some(
              r => (!scope || r.request_id === scope.requestId) && pendingNotification(r),
            );
            const goal = this.enableGoal ? await this.repository.getGoal(clean) : null;
            if (
              execution.queuedTurnStarts > 1 ||
              this.suppressed.has(clean) ||
              cancelSource.token.isCancelled
            ) {
              return;
            }
            if (goal && ["paused", "blocked", "budget_exhausted"].includes(String(goal.status || ""))) {
              return;
            }
            const sessionStore = execution.container.session_store;
            const delivered =
              pending && sessionStore
                ? await this.taskNotifications.deliver(sessionStore)
                : Number(pending);
            if (!delivered && (!checkpoint || !goal || goal.status !== "active")) {
              return;
            }
          }
          await this.applySelection(execution);
          if (cancelSource.token.isCancelled || (this.suppressed.has(clean) && !compact)) {
            return;
          }
          if (checkpoint) {
            await execution.container.session_store.persist_message(
              "user",
              buildGoalCheckpointPrompt(checkpoint),
              null,
              null,
              { kind: "goal_checkpoint" },
            );
          }
          execution.container.runtime.setUserQuestionResponder(event =>
            this.answerUserQuestionInternal(clean, event),
          );

          const extTool = this.externalTool(clean);
          if (extTool && !compact) {
            try {
              await extTool.notify("before", clean, {}, cancelSource.token);
            } catch (exc) {
              if (exc instanceof CancelledError || cancelSource.token.isCancelled) {
                return;
              }
              throw exc;
            }
          }
          for await (const event of execution.container.runtime.runTurn({
            query,
            cancellationToken: cancelSource.token,
            transientSystemMessages,
            resume,
            compact: compact ? "manual" : null,
            delivery,
          })) {
            const eventData: Record<string, unknown> = { ...event };
            if (delivery && eventData.type === "turn_started") {
              eventData.delivery = true;
              eventData.delivery_text = String(query || "");
            }
            if (eventData.type === "queued_input_delivered") {
              businessStarted = true;
            }
            const scope = this.scopes.get(clean);
            if (scope && eventData.type === "assistant_message_completed") {
              scope.answer = String(eventData.content || "");
            }
            if (
              eventData.type === "turn_completed" ||
              eventData.type === "turn_failed" ||
              eventData.type === "turn_cancelled"
            ) {
              terminalType = String(eventData.type);
              terminalEvent = eventData;
              continue;
            }
            this.updateLiveEvent(eventData);
            if (eventData.type === "user_question_requested") {
              this.prepareUserQuestion(clean, String(eventData.tool_call_id || ""));
            }
            if (continuation || delivery) {
              await this.emitToEventSinks(eventData);
            }
            yield eventData;
          }
        } finally {
          if (terminalType === "turn_failed" || terminalType === "turn_cancelled") {
            this.suppressed.add(clean);
            this.refreshBackgroundWait(clean);
            const failureReason = String(
              terminalEvent?.error || terminalEvent?.reason || "Request failed.",
            );
            await this.taskNotifications.continuationFailed(clean, failureReason);
            const scope = this.scopes.get(clean);
            if (scope) {
              scope.error = failureReason;
              await this.shellTools.supervisor.closeRequest(clean, scope.requestId, failureReason);
            }
          }
          const extTool = this.externalTool(clean);
          if (extTool && terminalType && !compact) {
            const records = await this.taskNotifications.store.relevant(clean);
            const pending =
              terminalType === "turn_completed" &&
              ((await this.backgroundWait(clean)) !== null ||
                Object.values(records).some(r => pendingNotification(r)));
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                await extTool.notify("after", clean, {
                  outcome: terminalType,
                  pending,
                });
                break;
              } catch {
                if (attempt === 0 && !this.closed && this.externalTool(clean)) {
                  await new Promise<void>(r => setTimeout(r, 250));
                } else {
                  this.suppressed.add(clean);
                }
              }
            }
          }
          if (execution.currentCancel === cancelSource) {
            execution.currentCancel = null;
          }
          cancelSource.dispose();
          if (terminalEvent !== null) {
            if (terminalType === "turn_completed") {
              terminalEvent.background_wait = await this.backgroundWait(clean);
            }
            this.updateLiveEvent(terminalEvent);
            if (continuation || delivery) {
              await this.emitToEventSinks(terminalEvent);
            }
          }
        }
        if (terminalEvent !== null) {
          yield terminalEvent;
        }
      } finally {
        execution.turnSlot.release();
      }
    } finally {
      execution.queuedTurnStarts = Math.max(0, execution.queuedTurnStarts - 1);
      await this.releaseIfIdle(clean, execution);
      const scope = this.scopes.get(clean);
      if (scope) {
        scope.changed.set();
      }
      if (!continuation && businessStarted && terminalType === "turn_completed") {
        await this.startGoalContinuation(clean);
      }
    }
  }

  async compactContext(sessionId: string): Promise<Record<string, unknown>> {
    let record: Record<string, unknown> | null = null;
    let failure: string | null = null;
    for await (const event of this.runTurn(sessionId, { query: null, compact: true })) {
      await this.emitToEventSinks(event);
      const eventRecord = event.record as Record<string, unknown> | undefined;
      if (
        event.type === "context_compacted" &&
        eventRecord &&
        (eventRecord.reason ?? "manual") === "manual"
      ) {
        record = eventRecord;
      } else if (event.type === "turn_failed" || event.type === "turn_cancelled") {
        failure = String(event.error || event.reason || "Compaction cancelled.");
      }
    }
    if (record === null) {
      throw new Error(failure || "Compaction did not complete.");
    }
    return record;
  }

  interrupt(sessionId: string, reason = "User interrupted"): boolean {
    const clean = validateSessionId(sessionId);
    this.suppressed.add(clean);
    this.pendingInterrupts.set(clean, reason);
    this.refreshBackgroundWait(clean);
    const scope = this.scopes.get(clean);
    if (scope) {
      scope.error = reason;
      scope.changed.set();
    }
    const snapshot = this.live.get(clean);
    if (snapshot) {
      snapshot.pending_inputs = [];
    }
    const execution = this.active.get(clean);
    if (!execution) {
      return true;
    }
    execution.container.runtime.discardPendingInputs();
    if (execution.currentCancel && !execution.currentCancel.token.isCancelled) {
      execution.currentCancel.cancel(reason);
    }
    for (const future of execution.pendingAnswers.values()) {
      if (!future.done) {
        future.resolve("");
      }
    }
    execution.pendingAnswers.clear();
    return true;
  }

  releaseWait(sessionId: string, taskId?: string | null, toolCallId?: string | null): boolean {
    const clean = validateSessionId(sessionId);
    const released = this.shellTools.supervisor.releaseWait(clean, taskId, toolCallId);
    if (!this.closed) {
      this.queueTaskEvent(`${clean}:wait_released`, {
        type: "wait_released",
        session_id: clean,
        turn_id: "",
      });
    }
    return released;
  }

  submitInput(sessionId: string, mode: string, text: string): Record<string, unknown> {
    const clean = validateSessionId(sessionId);
    const execution = this.active.get(clean);
    if (!execution) {
      throw new Error("Session execution is not active.");
    }
    const result =
      mode === "steering"
        ? execution.container.runtime.submitSteering(text)
        : execution.container.runtime.submitFollowUp(text);
    this.releaseWait(clean);
    this.recordLiveInput(clean, { ...result, session_id: clean, mode });
    return result;
  }

  retrieveInput(
    sessionId: string,
    mode: string,
    inputId?: string | null,
  ): Record<string, unknown> {
    const clean = validateSessionId(sessionId);
    const execution = this.active.get(clean);
    if (!execution) {
      throw new Error("Session execution is not active.");
    }
    const result =
      mode === "steering"
        ? execution.container.runtime.unsteer(inputId)
        : execution.container.runtime.dequeueFollowUp(inputId);
    const snapshot = this.live.get(clean);
    const retrievedId = String(result.input_id || "").trim();
    if (snapshot && retrievedId) {
      const pending = snapshot.pending_inputs as Array<Record<string, unknown>>;
      snapshot.pending_inputs = pending.filter(item => item.input_id !== retrievedId);
    }
    return result;
  }

  promoteFollowUp(sessionId: string, inputId: string): Record<string, unknown> {
    const clean = validateSessionId(sessionId);
    const execution = this.active.get(clean);
    if (!execution) {
      throw new Error("Session execution is not active.");
    }
    const result = execution.container.runtime.promoteFollowUp(inputId);
    const snapshot = this.live.get(clean);
    const promotedId = String(result.input_id || "").trim();
    if (snapshot && promotedId) {
      const pending = snapshot.pending_inputs as Array<Record<string, unknown>>;
      for (const item of pending) {
        if (item.input_id === promotedId) {
          item.mode = "steering";
        }
      }
    }
    return result;
  }

  async answerUserQuestion(sessionId: string, toolCallId: string, answer: string): Promise<void> {
    const clean = validateSessionId(sessionId);
    const execution = this.active.get(clean);
    if (!execution) {
      const err = new Error("No pending user question.");
      err.name = "LookupError";
      throw err;
    }
    const future = execution.pendingAnswers.get(toolCallId);
    if (!future || future.done) {
      const err = new Error("No pending user question.");
      err.name = "LookupError";
      throw err;
    }
    future.resolve(answer);
    const snapshot = this.live.get(clean);
    const question = snapshot?.question as Record<string, unknown> | undefined;
    if (snapshot && question && question.tool_call_id === toolCallId) {
      snapshot.question = null;
    }
    await this.emitToEventSinks({
      type: "user_question_answered",
      session_id: clean,
      tool_call_id: toolCallId,
      answer,
    });
  }

  private prepareUserQuestion(sessionId: string, toolCallId: string): void {
    const value = String(toolCallId || "").trim();
    if (!value) return;
    const execution = this.active.get(validateSessionId(sessionId));
    if (execution && !execution.pendingAnswers.has(value)) {
      execution.pendingAnswers.set(value, createPendingAnswerFuture());
    }
  }

  private async answerUserQuestionInternal(
    sessionId: string,
    event: UserQuestionRequestedEvent,
  ): Promise<string> {
    const execution = this.active.get(sessionId);
    if (!execution) return "";
    let future = execution.pendingAnswers.get(event.tool_call_id);
    if (!future) {
      future = createPendingAnswerFuture();
      execution.pendingAnswers.set(event.tool_call_id, future);
    }
    try {
      return await future.promise;
    } finally {
      execution.pendingAnswers.delete(event.tool_call_id);
    }
  }

  async start(sessionId: string): Promise<AgentContainer> {
    const clean = validateSessionId(sessionId);
    let task: Promise<AgentContainer> | undefined;
    const existing = await this.lock.runExclusive(async () => {
      const activeExec = this.active.get(clean);
      if (activeExec) return activeExec.container;
      if (this.closed || this.closedSessions.has(clean)) {
        throw new Error("Worker is shutting down.");
      }
      task = this.starting.get(clean);
      if (!task) {
        task = this.buildExecution(clean);
        this.starting.set(clean, task);
      }
      return null;
    });
    if (existing) return existing;
    try {
      return await task!;
    } finally {
      if (this.starting.get(clean) === task) {
        this.starting.delete(clean);
      }
    }
  }

  private async buildExecution(clean: string): Promise<AgentContainer> {
    const [externalTool, questionEnabled] = this.sessionOptions.get(clean) ?? [
      this.defaultExternalTool,
      this.enableUserQuestion,
    ];
    const metadata = await this.repository.metadata(clean);
    const root = validateWorkspaceRoot(String(metadata.workspace_root || metadata.cwd || ""));
    const settings = loadSettings();
    const selection: ModelSelection = {
      provider_id: String(metadata.provider || settings.provider),
      model_id: String(metadata.model || settings.model),
      reasoning_effort: String(metadata.reasoning_effort || settings.reasoning_effort),
    };
    const chatClient = await this.chatClientFor(settings, selection);
    const definition = this.definition(selection);

    let container: AgentContainer;
    try {
      container = buildAgentContainer({
        settings: {
          ...settings,
          provider: selection.provider_id,
          model: selection.model_id,
          reasoning_effort: selection.reasoning_effort,
        },
        chatClient,
        imageInput: definition ? definition.image_input : null,
        contextWindow: definition ? definition.context_window : null,
        sessionDir: this.sessionDir,
        sessionId: clean,
        sessionStore: this.repository.draftStore(clean),
        enableGoal: this.enableGoal,
        enableUserQuestion: questionEnabled,
        workspaceRoot: root,
        projectId: typeof metadata.project_id === "string" ? metadata.project_id : null,
        ownerAgentId: typeof metadata.owner_agent_id === "string" ? metadata.owner_agent_id : null,
        sessionType: typeof metadata.session_type === "string" ? metadata.session_type : null,
        parentSessionId:
          typeof metadata.parent_session_id === "string" ? metadata.parent_session_id : null,
        sharedResources: this.sharedResources,
        shellTools: this.shellTools,
        webSessions: this.webSessions,
        taskNotifications: this.taskNotifications,
        externalTool,
      });
      await container.runtime.initialize();
    } catch (err) {
      await chatClient.close();
      throw err;
    }

    if (this.closed || this.closedSessions.has(clean)) {
      await closeContainer(container);
      throw new Error("Worker is shutting down.");
    }

    this.active.set(clean, {
      container,
      chatClient,
      selection,
      turnSlot: new AsyncLock(),
      currentCancel: null,
      pendingAnswers: new Map(),
      queuedTurnStarts: 0,
    });

    const latestTool = this.externalTool(clean);
    if (latestTool !== externalTool) {
      this.syncExternalTool(clean, externalTool, latestTool);
    }
    return container;
  }

  private async chatClientFor(
    settings: AppSettings,
    selection: ModelSelection,
  ): Promise<ChatClient> {
    try {
      return await this.providerService.createChatClient(settings, selection);
    } catch (exc) {
      if (exc instanceof ProviderError && UNUSABLE_CONNECTION_CODES.has(exc.code)) {
        return this.providerService.unavailableClient(selection, exc);
      }
      throw exc;
    }
  }

  private definition(selection: ModelSelection): ModelDefinition | null {
    try {
      return this.providerService.resolveSelection(selection);
    } catch (exc) {
      if (exc instanceof ProviderError && UNUSABLE_CONNECTION_CODES.has(exc.code)) {
        return null;
      }
      throw exc;
    }
  }

  private async applySelection(execution: ActiveExecution): Promise<void> {
    const store = execution.container.session_store;
    if (!store || !execution.selection) return;
    const selection: ModelSelection = {
      provider_id: String(store.provider || ""),
      model_id: String(store.model || ""),
      reasoning_effort: String(store.reasoning_effort || ""),
    };
    if (
      !selection.model_id ||
      (selection.provider_id === execution.selection.provider_id &&
        selection.model_id === execution.selection.model_id &&
        selection.reasoning_effort === execution.selection.reasoning_effort)
    ) {
      return;
    }
    const definition = this.definition(selection);
    const settings = execution.container.settings || loadSettings();
    const replacement = await this.chatClientFor(settings, selection);
    const previous = execution.chatClient;
    execution.container.turn_runner.replaceChatClient(replacement, {
      imageInput: definition ? definition.image_input : null,
    });
    execution.container.context_manager.contextWindow = definition
      ? definition.context_window
      : null;
    execution.chatClient = replacement;
    execution.selection = selection;
    if (previous) {
      await previous.close();
    }
  }

  private async releaseIfIdle(sessionId: string, execution: ActiveExecution): Promise<void> {
    if (
      execution.currentCancel !== null ||
      execution.queuedTurnStarts > 0 ||
      execution.container.runtime.turnActive ||
      this.continuations.has(sessionId) ||
      this.pendingWakes.has(sessionId) ||
      Boolean(this.deliveries.get(sessionId)?.length)
    ) {
      return;
    }
    let released: ActiveExecution | null = null;
    await this.lock.runExclusive(async () => {
      if (this.active.get(sessionId) === execution) {
        this.active.delete(sessionId);
        this.live.delete(sessionId);
        released = execution;
      }
    });
    if (released !== null) {
      this.repository.releasePersistedDraft();
      this.shellTools.pool.close(sessionId);
      await closeExecution(released);
    }
  }

  async release(sessionId: string, options?: { permanent?: boolean }): Promise<void> {
    const clean = validateSessionId(sessionId);
    if (options?.permanent) {
      this.closedSessions.add(clean);
      await this.shellTools.closeSession(clean);
      this.sessionOptions.delete(clean);
      this.suppressed.delete(clean);
      this.pendingInterrupts.delete(clean);
      this.pendingWakes.delete(clean);
      this.deliveries.delete(clean);
    }
    const starting = this.starting.get(clean);
    if (starting) {
      try {
        await starting;
      } catch {
        // ignore
      }
    }
    let released: ActiveExecution | null = null;
    await this.lock.runExclusive(async () => {
      const execution = this.active.get(clean);
      if (execution) {
        this.interrupt(clean, "Execution released");
        this.active.delete(clean);
        this.live.delete(clean);
        released = execution;
      }
    });
    if (released !== null) {
      this.repository.releasePersistedDraft();
      this.shellTools.pool.close(sessionId);
      await closeExecution(released);
    }
  }

  async close(): Promise<void> {
    let goalTasks: Array<Promise<void>> = [];
    await this.lock.runExclusive(async () => {
      this.closed = true;
      goalTasks = [...this.continuations.values(), ...this.deliveryRuns.values()];
      this.shellTools.supervisor.setObserver(null);
    });
    if (this.starting.size > 0) {
      await Promise.allSettled(this.starting.values());
      this.starting.clear();
    }
    if (goalTasks.length > 0) {
      await Promise.allSettled(goalTasks);
    }
    this.continuations.clear();
    this.deliveryRuns.clear();
    this.deliveries.clear();
    if (this.taskEventPump) {
      await Promise.allSettled([this.taskEventPump]);
    }
    this.taskEvents.clear();
    this.taskResyncSessions.clear();
    for (const scope of this.scopes.values()) {
      scope.error = "Worker shutting down.";
      scope.changed.set();
    }
    let executions: ActiveExecution[] = [];
    await this.lock.runExclusive(async () => {
      executions = Array.from(this.active.values());
      for (const sessionId of Array.from(this.active.keys())) {
        this.interrupt(sessionId, "Worker shutting down");
      }
      this.active.clear();
      this.live.clear();
    });
    if (executions.length > 0) {
      await Promise.all(executions.map(item => closeExecution(item)));
    }
    this.repository.releasePersistedDraft();
    this.eventSinks.length = 0;
  }
}

async function closeContainer(container: AgentContainer): Promise<void> {
  container.tool_processor.close();
  await container.chat_client.close();
}

async function closeExecution(execution: ActiveExecution): Promise<void> {
  execution.container.tool_processor.close();
  await (execution.chatClient ?? execution.container.chat_client).close();
}

function newLiveTurn(turnId: string): Record<string, unknown> {
  return {
    turn_id: turnId,
    status: "running",
    assistant_text: "",
    tools: {} as Record<string, Record<string, unknown>>,
    question: null,
    pending_inputs: [] as Array<Record<string, unknown>>,
    plan: null,
    files: [] as string[],
    context_usage_percent: null,
  };
}

function liveTool(
  snapshot: Record<string, unknown>,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const toolCallId = String(event.tool_call_id || "").trim();
  if (!toolCallId) return {};
  const tools = snapshot.tools as Record<string, Record<string, unknown>>;
  if (!tools[toolCallId]) {
    tools[toolCallId] = {
      tool_call_id: toolCallId,
      status: "pending",
      output: "",
    };
  }
  return tools[toolCallId]!;
}

function copyLiveTurn(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(snapshot);
  const tools = result.tools as Record<string, Record<string, unknown>>;
  result.tools = Object.values(tools);
  return result;
}

function boundedLiveText(value: string, limit = 30_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[Output truncated]`;
}
