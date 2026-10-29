import { randomUUID } from "node:crypto";
import { InputQueueError } from "../domain/errors.js";
import type { AuthInteraction } from "../infrastructure/chatgpt-oauth.js";
import { validateSessionId } from "../infrastructure/paths.js";
import { SkillRepository } from "../infrastructure/skills.js";
import { VERSION } from "../version.js";
import {
  type SlashCommandContext,
  SlashCommandResult,
  SlashCommandRouter,
  buildCommandInfos,
} from "./commands.js";
import {
  CAPABILITIES,
  CORE_METHODS,
  FileMethodError,
  PROTOCOL_VERSION,
  RuntimeMethod,
  SESSION_SCOPED_METHODS,
  TURN_SCOPED_METHODS,
  describeFolderDefaults,
  errorMessage,
  eventEnvelope,
  explainSelection,
  fileList,
  fileRead,
  fileWrite,
  iterDurableEvents,
  renderResumePreview,
  resolveManyFolderDefaults,
  responseMessage,
  setFolderDefaults,
  unsetFolderDefaults,
} from "./protocol.js";
import type { RuntimeWorker } from "./worker.js";

const FOLDER_DEFAULT_METHODS = new Set<string>([
  RuntimeMethod.RIND_FOLDER_DEFAULTS_GET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_SET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_UNSET,
  RuntimeMethod.RIND_FOLDER_DEFAULTS_RESOLVE,
]);

export function protocolCapabilities(
  backgroundEnabledFlag: boolean,
  goalEnabled: boolean,
): string[] {
  const capabilities = [...CAPABILITIES];
  if (backgroundEnabledFlag) {
    capabilities.push("rind/backgrounds");
  }
  if (goalEnabled) {
    capabilities.push("rind/goals");
  }
  return capabilities;
}

export function protocolMethods(
  backgroundEnabledFlag: boolean,
  goalEnabled: boolean,
): string[] {
  const methods: string[] = [...CORE_METHODS];
  if (backgroundEnabledFlag) {
    methods.push(RuntimeMethod.RIND_BACKGROUND_LIST, RuntimeMethod.RIND_BACKGROUND_OUTPUT);
  }
  if (goalEnabled) {
    methods.push(
      RuntimeMethod.RIND_GOAL_GET,
      RuntimeMethod.RIND_GOAL_SET,
      RuntimeMethod.RIND_GOAL_STATUS,
      RuntimeMethod.RIND_GOAL_CLEAR,
    );
  }
  return methods;
}

export function slashCommandInfos(
  router: SlashCommandRouter,
): Array<Record<string, unknown>> {
  return router.commandInfos().map(info => ({
    name: info.name,
    description: info.description,
    usage: info.usage,
    aliases: [...info.aliases],
  }));
}

export type BackgroundListFn = (
  sessionId: string,
) => Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;

export type BackgroundOutputFn = (
  bgId: string,
  options: { maxOutputChars: number; _sessionId: string },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export function backgroundEnabled(
  backgroundList: BackgroundListFn | null | undefined,
  backgroundOutput: BackgroundOutputFn | null | undefined,
): boolean {
  return Boolean(backgroundList && backgroundOutput);
}

export async function backgroundListResponse(
  backgroundList: BackgroundListFn,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const tasks = await backgroundList(sessionId);
  if (!Array.isArray(tasks)) {
    throw new TypeError("Background list must be a list.");
  }
  return { tasks };
}

export async function backgroundOutputResponse(
  backgroundOutput: BackgroundOutputFn,
  sessionId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bgId = params.bg_id;
  if (typeof bgId !== "string" || !bgId.trim()) {
    throw new Error("rind/background/output requires bg_id.");
  }
  const maxOutputChars = params.max_output_chars ?? 20_000;
  if (
    typeof maxOutputChars === "boolean" ||
    typeof maxOutputChars !== "number" ||
    !Number.isInteger(maxOutputChars)
  ) {
    throw new Error("rind/background/output max_output_chars must be an integer.");
  }
  const task = await backgroundOutput(bgId.trim(), {
    maxOutputChars,
    _sessionId: sessionId,
  });
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("Background output must be an object.");
  }
  return { task };
}

export interface TransportWriter {
  send(payload: Record<string, unknown>): Promise<void>;
  close?(): void;
}

class AsyncLock {
  private locked = false;
  private waiters: Array<() => void> = [];

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) {
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
      });
    } else {
      this.locked = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    }
  }
}

class EventWriter {
  private readonly writer: TransportWriter;
  private readonly lock = new AsyncLock();
  private sequence = 0;

  constructor(writer: TransportWriter) {
    this.writer = writer;
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    await this.lock.runExclusive(async () => {
      let msg = payload;
      if (payload.kind === "event") {
        this.sequence += 1;
        msg = { ...payload, sequence: this.sequence };
      }
      await this.writer.send(msg);
    });
  }

  close(): void {
    if (typeof this.writer.close === "function") {
      this.writer.close();
    }
  }
}

interface AuthWaiter {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  done: boolean;
}

function createAuthWaiter(): AuthWaiter {
  let resolveFn!: (value: string) => void;
  let rejectFn!: (err: Error) => void;
  const waiter: AuthWaiter = {
    promise: Promise.resolve(""),
    resolve: (value: string) => {
      if (!waiter.done) {
        waiter.done = true;
        resolveFn(value);
      }
    },
    reject: (err: Error) => {
      if (!waiter.done) {
        waiter.done = true;
        rejectFn(err);
      }
    },
    done: false,
  };
  waiter.promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return waiter;
}

class ProtocolAuthInteraction implements AuthInteraction {
  private readonly server: RuntimeDispatcher;

  constructor(server: RuntimeDispatcher) {
    this.server = server;
  }

  async prompt(
    kind: string,
    message: string,
    options?: readonly string[] | null,
  ): Promise<string> {
    const requestId = `auth-${randomUUID().replace(/-/g, "")}`;
    const waiter = createAuthWaiter();
    this.server._authWaiters.set(requestId, waiter);
    await this.server._writer.send({
      kind: "request",
      request_id: requestId,
      method: RuntimeMethod.RIND_AUTH_PROMPT,
      params: {
        kind,
        message,
        options: options ? [...options] : [],
      },
    });
    try {
      return await waiter.promise;
    } catch (err) {
      this.notify({ type: "prompt_closed", request_id: requestId });
      throw err;
    } finally {
      this.server._authWaiters.delete(requestId);
    }
  }

  notify(event: Record<string, unknown>): void {
    void this.server._writer.send({
      kind: "event",
      method: RuntimeMethod.RIND_AUTH_UPDATE,
      event: { ...event },
    });
  }
}

class RepositoryGoalOps {
  private readonly repository: RuntimeWorker["repository"];
  private readonly sessionId: string;

  constructor(repository: RuntimeWorker["repository"], sessionId: string) {
    this.repository = repository;
    this.sessionId = sessionId;
  }

  async getGoal(): Promise<Record<string, unknown> | null> {
    return await this.repository.getGoal(this.sessionId);
  }

  async setGoal(objective: string): Promise<Record<string, unknown>> {
    return await this.repository.setGoal(this.sessionId, objective);
  }

  async setGoalStatus(status: string): Promise<Record<string, unknown>> {
    return await this.repository.setGoalStatus(this.sessionId, status);
  }

  async clearGoal(): Promise<void> {
    await this.repository.clearGoal(this.sessionId);
  }
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T) => void> = [];

  putNowait(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  async put(item: T): Promise<void> {
    this.putNowait(item);
  }

  async get(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return await new Promise<T>(resolve => {
      this.waiters.push(resolve);
    });
  }
}

export class RuntimeDispatcher {
  private readonly worker: RuntimeWorker;
  private readonly allowSessionConfiguration: boolean;
  private readonly debug: boolean;
  private readonly backgroundList: BackgroundListFn | null;
  private readonly backgroundOutput: BackgroundOutputFn | null;
  private readonly goalEnabled: boolean;
  readonly _writer: EventWriter;
  private readonly slashRouter: SlashCommandRouter;
  private readonly requests = new AsyncQueue<Record<string, unknown> | null>();
  private readonly dispatchTasks = new Set<Promise<void>>();
  private initialized = false;
  private stopping = false;
  private shutdownRequest: Record<string, unknown> | null = null;
  private shutdownResponseSent = false;
  private readonly subscribed = new Set<string>();
  readonly _authWaiters = new Map<string, AuthWaiter>();
  private removeEventSink: (() => void) | null;

  constructor(
    worker: RuntimeWorker,
    options: {
      debug?: boolean;
      backgroundList?: BackgroundListFn | null;
      backgroundOutput?: BackgroundOutputFn | null;
      goalEnabled?: boolean;
      writer: TransportWriter;
      allowSessionConfiguration?: boolean;
    },
  ) {
    this.worker = worker;
    this.allowSessionConfiguration = options.allowSessionConfiguration ?? false;
    this.debug = options.debug ?? false;
    this.backgroundList = options.backgroundList ?? null;
    this.backgroundOutput = options.backgroundOutput ?? null;
    this.goalEnabled = options.goalEnabled ?? true;
    this._writer = new EventWriter(options.writer);
    this.slashRouter = new SlashCommandRouter(buildCommandInfos());
    this.removeEventSink = this.worker.execution.addEventSink(ev => this.sendEvent(ev));
  }

  close(): void {
    for (const waiter of this._authWaiters.values()) {
      if (!waiter.done) {
        waiter.reject(new Error("Connection closed"));
      }
    }
    this._authWaiters.clear();
    const remover = this.removeEventSink;
    this.removeEventSink = null;
    if (remover) {
      remover();
    }
    this._writer.close();
  }

  async submit(request: Record<string, unknown> | null): Promise<void> {
    await this.requests.put(request);
  }

  async dispatch(request: Record<string, unknown>): Promise<void> {
    await this.dispatchInternal(request);
  }

  schedule(request: Record<string, unknown>): void {
    this.scheduleDispatch(request);
  }

  async serve(): Promise<number> {
    while (true) {
      const request = await this.requests.get();
      if (request === null) {
        if (!this.stopping) {
          this.stopping = true;
          for (const sessionId of this.worker.execution.activeSessionIds()) {
            this.worker.execution.interrupt(sessionId, "Worker shutting down");
          }
        }
        try {
          try {
            await this.drainDispatchTasks();
          } finally {
            await this.worker.close();
          }
        } catch (exc) {
          await this.respondToShutdown(exc instanceof Error ? exc : new Error(String(exc)));
          throw exc;
        }
        await this.respondToShutdown();
        return 0;
      }
      if (String(request.method || "") === RuntimeMethod.SHUTDOWN) {
        if (!this.beginShutdown(request)) {
          await this.respondError(request, "Runtime is shutting down.", "ServerStopping");
        }
        continue;
      }
      if (this.stopping) {
        await this.respondError(request, "Runtime is shutting down.", "ServerStopping");
        continue;
      }
      if (request.method === RuntimeMethod.INITIALIZE) {
        await this.dispatchInternal(request);
      } else {
        this.scheduleDispatch(request);
      }
    }
  }

  private scheduleDispatch(request: Record<string, unknown>): void {
    const task = this.dispatchInternal(request).finally(() => {
      this.dispatchTasks.delete(task);
    });
    this.dispatchTasks.add(task);
  }

  private async drainDispatchTasks(): Promise<void> {
    if (this.dispatchTasks.size === 0) return;
    await Promise.race([
      Promise.allSettled(this.dispatchTasks),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ]);
  }

  private beginShutdown(request?: Record<string, unknown> | null): boolean {
    if (this.stopping) return false;
    this.stopping = true;
    this.shutdownRequest = request ?? null;
    for (const sessionId of this.worker.execution.activeSessionIds()) {
      this.worker.execution.interrupt(sessionId, "Worker shutting down");
    }
    this.requests.putNowait(null);
    return true;
  }

  private async respondToShutdown(error?: Error | null): Promise<void> {
    if (!this.shutdownRequest || this.shutdownResponseSent) return;
    this.shutdownResponseSent = true;
    if (error) {
      await this.respondError(this.shutdownRequest, error.message, "ShutdownFailed");
    } else {
      await this.respond(this.shutdownRequest, { ok: true });
    }
  }

  private async dispatchInternal(request: Record<string, unknown>): Promise<void> {
    const method = String(request.method || "");
    if (method === RuntimeMethod.RIND_AUTH_PROMPT) {
      const waiter = this._authWaiters.get(String(request.request_id || ""));
      const params =
        request.params && typeof request.params === "object" && !Array.isArray(request.params)
          ? (request.params as Record<string, unknown>)
          : {};
      if (waiter && !waiter.done) {
        waiter.resolve(String(params.value || ""));
      }
      return;
    }
    try {
      if (method === RuntimeMethod.INITIALIZE) {
        await this.initialize(request);
        return;
      }
      if (method === RuntimeMethod.PING) {
        await this.respond(request, { ok: true });
        return;
      }
      if (!this.initialized) {
        await this.respondError(request, "Runtime worker is not initialized.", "ServerNotReady");
        return;
      }
      if (method === RuntimeMethod.SESSION_OPEN) {
        if (!this.allowSessionConfiguration) {
          throw new Error("Session configuration requires the local execution host.");
        }
        const params =
          request.params && typeof request.params === "object" && !Array.isArray(request.params)
            ? (request.params as Record<string, unknown>)
            : {};
        const result = await this.worker.openSession(params);
        this.subscribed.add(String(result.session_id || ""));
        await this.respond(request, result);
        return;
      }
      if (method === RuntimeMethod.SESSION_LIST) {
        await this.listSessions(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_NEW) {
        await this.newSession(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_SWITCH) {
        await this.switchSession(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_DELETE) {
        await this.deleteSession(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_CREATE) {
        await this.createConversation(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_FORK) {
        await this.forkSession(request);
        return;
      }
      if (method === RuntimeMethod.RIND_CONTEXT_INSPECT) {
        await this.contextInspect(request);
        return;
      }
      if (method === RuntimeMethod.RIND_USAGE_SUMMARY) {
        await this.usageSummary(request);
        return;
      }
      if (
        method === RuntimeMethod.SESSION_SUBSCRIBE ||
        method === RuntimeMethod.SESSION_UNSUBSCRIBE
      ) {
        await this.subscriptionRequest(request);
        return;
      }
      if (method === RuntimeMethod.MODEL_LIST) {
        await this.listModels(request);
        return;
      }
      if (method === RuntimeMethod.RIND_AUTH_LIST) {
        await this.authList(request);
        return;
      }
      if (method === RuntimeMethod.RIND_AUTH_LOGIN) {
        await this.authLogin(request);
        return;
      }
      if (method === RuntimeMethod.RIND_AUTH_LOGOUT) {
        await this.authLogout(request);
        return;
      }
      if (method === RuntimeMethod.SESSION_REPLAY) {
        await this.replay(request);
        return;
      }
      if (method === RuntimeMethod.RIND_COMMAND_EXECUTE) {
        await this.executeCommand(request);
        return;
      }
      if (method === RuntimeMethod.MODEL_SET) {
        await this.setModel(request);
        return;
      }
      if (method === RuntimeMethod.MODEL_EFFORT) {
        await this.setReasoningEffort(request);
        return;
      }
      if (FOLDER_DEFAULT_METHODS.has(method)) {
        await this.folderDefaults(method, request);
        return;
      }
      if (method === RuntimeMethod.RIND_FOLDER_DEFAULTS_APPLY) {
        await this.applyFolderDefaults(request);
        return;
      }
      if (method === RuntimeMethod.RIND_SESSION_DELIVER) {
        await this.deliver(request);
        return;
      }
      if (
        method === RuntimeMethod.RIND_GOAL_GET ||
        method === RuntimeMethod.RIND_GOAL_SET ||
        method === RuntimeMethod.RIND_GOAL_STATUS ||
        method === RuntimeMethod.RIND_GOAL_CLEAR
      ) {
        await this.goalRequest(request);
        return;
      }
      if (
        method === RuntimeMethod.RIND_BACKGROUND_LIST ||
        method === RuntimeMethod.RIND_BACKGROUND_OUTPUT
      ) {
        await this.backgroundRequest(request);
        return;
      }
      if (
        method === RuntimeMethod.RIND_TASK_LIST ||
        method === RuntimeMethod.RIND_TASK_READ ||
        method === RuntimeMethod.RIND_TASK_WAIT ||
        method === RuntimeMethod.RIND_TASK_CANCEL ||
        method === RuntimeMethod.RIND_TASK_RELEASE_WAIT
      ) {
        await this.taskRequest(request);
        return;
      }
      if (
        method === RuntimeMethod.FILE_LIST ||
        method === RuntimeMethod.FILE_READ ||
        method === RuntimeMethod.FILE_WRITE
      ) {
        await this.fileRequest(request);
        return;
      }
      if (SESSION_SCOPED_METHODS.has(method)) {
        const sessionId = await this.requiredSessionId(request);
        if (sessionId === null) return;
        if (TURN_SCOPED_METHODS.has(method) && !(await this.validTurn(sessionId, request))) {
          return;
        }
        if (method === RuntimeMethod.SESSION_PROMPT) {
          await this.runTurn(sessionId, request);
          return;
        }
        if (method === RuntimeMethod.RIND_SESSION_COMPACT) {
          await this.compact(sessionId, request);
          return;
        }
        await this.handleActiveControl(sessionId, request);
        return;
      }
      await this.respondError(request, `Unknown method: ${method}`, "MethodNotFound");
    } catch (exc) {
      if (exc instanceof Error && exc.name === "LookupError") {
        await this.respondError(request, exc.message, "SessionNotFound");
        return;
      }
      const err = exc instanceof Error ? exc : new Error(String(exc));
      const errType = err.name && err.name !== "Error" ? err.name : "ValueError";
      await this.respondError(request, err.message, errType);
    }
  }

  private async executeWithoutConversation(
    request: Record<string, unknown>,
    command: string,
    rawInput: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (
      !command ||
      (!["sessions", "status", "skill", "import"].includes(command) &&
        this.slashRouter.knows(command))
    ) {
      await this.respondSlashResult(
        request,
        new SlashCommandResult(
          command
            ? `/${command} needs a conversation. Send your first message to start one.`
            : "Send your first message to start a conversation.",
        ),
      );
      return;
    }
    const root = String(params.workspace_root || this.worker.workspaceRoot);
    const store = this.worker.repository.listingStore(root);
    const rawDraft = params.draft;
    let draft: Record<string, unknown> | null = null;
    if (rawDraft && typeof rawDraft === "object" && !Array.isArray(rawDraft)) {
      const rd = rawDraft as Record<string, unknown>;
      draft = {};
      for (const key of ["name", "provider", "model", "reasoning_effort"]) {
        if (rd[key]) {
          draft[key] = String(rd[key]);
        }
      }
      if (
        rd.skill_sources &&
        typeof rd.skill_sources === "object" &&
        !Array.isArray(rd.skill_sources)
      ) {
        draft.skill_sources = rd.skill_sources;
      }
    }
    const result = await this.slashRouter.execute(rawInput, {
      runtime: null,
      session: store,
      debug: this.debug,
      workspace_root: root,
      compact_context: null,
      draft,
      explain_selection: (selection, source) =>
        explainSelection(this.worker, root, selection, source),
      skills: new SkillRepository(root),
    });
    await this.respondSlashResult(request, result);
  }

  private async authList(request: Record<string, unknown>): Promise<void> {
    await this.respond(request, { providers: this.worker.listProviders() });
  }

  private async authLogin(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const sessionId = params.session_id ? await this.requiredSessionId(request) : "";
    if (sessionId === null) return;
    let providerId = String(params.provider_id || "").trim();
    const method = String(params.method || "api_key").trim();
    if (!providerId && method !== "connection") {
      await this.respondError(request, "provider_id is required.", "InvalidRequest");
      return;
    }
    providerId = await this.worker.login(
      providerId,
      method,
      new ProtocolAuthInteraction(this),
    );
    const info = sessionId
      ? await this.worker.session(sessionId)
      : await this.worker.blankInfo(
          typeof params.workspace_root === "string" ? params.workspace_root : null,
        );
    const listing = await this.worker.listModels();
    const models = Array.isArray(listing.models)
      ? (listing.models as Array<Record<string, unknown>>)
      : [];
    const selection = await this.adoptLoginDefault(sessionId, info, providerId, models);
    await this.respond(request, {
      ok: true,
      provider_id: providerId,
      models_count: models.length,
      selection,
    });
  }

  private async adoptLoginDefault(
    sessionId: string,
    info: Record<string, unknown>,
    providerId: string,
    models: Array<Record<string, unknown>>,
  ): Promise<Record<string, string> | null> {
    const currentProvider = String(info.provider || "");
    const currentModel = String(info.model || "");
    if (models.some(m => m.provider_id === currentProvider && m.id === currentModel)) {
      return null;
    }
    const providerModels = models.filter(m => m.provider_id === providerId);
    if (providerModels.length === 0) {
      return null;
    }
    const chosen =
      providerModels.find(m => m.id === currentModel) ?? providerModels[0]!;
    if (sessionId) {
      const store = await this.sessionStore(sessionId);
      await store.update_selection(providerId, String(chosen.id));
      await this.settingsChanged(sessionId, store);
    }
    return { provider_id: providerId, model_id: String(chosen.id) };
  }

  private async authLogout(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const providerId = String(params.provider_id || "").trim();
    if (!providerId) {
      await this.respondError(request, "provider_id is required.", "InvalidRequest");
      return;
    }
    const deleted = this.worker.logout(providerId);
    const status = this.worker
      .listProviders()
      .find(item => item.id === providerId);
    await this.respond(request, {
      ok: true,
      provider_id: providerId,
      deleted,
      source: status ? status.source : "none",
    });
  }

  private async initialize(request: Record<string, unknown>): Promise<void> {
    const info = await this.worker.initialize();
    const sessionId = String(info.session_id || "");
    if (sessionId) {
      this.subscribed.add(sessionId);
    }
    const msgCount = Number(info.message_count || 0);
    const result: Record<string, unknown> = {
      session_id: sessionId,
      model: info.model,
      provider: info.provider,
      reasoning_effort: info.reasoning_effort,
      workspace_root: info.workspace_root,
      team_main: info.team_main,
      version: VERSION,
      protocol_version: PROTOCOL_VERSION,
      capabilities: this.capabilities(),
      methods: this.methods(),
      resume_preview:
        msgCount <= 1 ? "" : await this.resumePreview(String(info.session_id || "")),
      has_rind_doc: Boolean(info.has_rind_doc),
      title: info.title ?? "",
      updated_at: info.updated_at ?? "",
      message_count: msgCount,
      turn_state: info.turn_state,
      live_turn: info.live_turn,
      commands: slashCommandInfos(this.slashRouter),
      providers: this.worker.listProviders(),
    };
    if (this.goalEnabled) {
      result.goal = info.goal;
    }
    await this.respond(request, result);
    this.initialized = true;
  }

  private capabilities(): string[] {
    return protocolCapabilities(
      backgroundEnabled(this.backgroundList, this.backgroundOutput),
      this.goalEnabled,
    );
  }

  private methods(): string[] {
    const methods = protocolMethods(
      backgroundEnabled(this.backgroundList, this.backgroundOutput),
      this.goalEnabled,
    );
    if (this.allowSessionConfiguration) {
      methods.push(RuntimeMethod.SESSION_OPEN);
    }
    return methods;
  }

  private async runTurn(
    sessionId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const rawQuery = params.input !== undefined ? params.input : params.query;
    const query = String(rawQuery || "");
    const resume = params.resume === true;
    const delivery = params.delivery === true;
    if (!query.trim() && !resume) {
      await this.respondError(request, "session/prompt requires input.", "InvalidRequest");
      return;
    }
    if (resume && query.trim()) {
      await this.respondError(request, "resume cannot include input.", "InvalidRequest");
      return;
    }
    const rawClientInputId = params.client_input_id;
    const clientInputId =
      typeof rawClientInputId === "string" ? rawClientInputId.trim() : "";
    const transientSystemMessages = Array.isArray(params.transient_system_messages)
      ? (params.transient_system_messages as Array<Record<string, unknown>>)
      : null;

    this.subscribed.add(sessionId);
    let turnSessionId = "";
    let turnId = "";
    const completionScope = params.completion_scope ?? "turn";
    if (completionScope !== "turn" && completionScope !== "request") {
      throw new Error("completion_scope must be turn or request.");
    }
    if (
      completionScope === "turn" &&
      query.trim() &&
      !resume &&
      !delivery &&
      this.worker.execution.activeTurnId(sessionId)
    ) {
      try {
        const steered = this.worker.execution.submitInput(
          sessionId,
          "steering",
          query,
        );
        await this.respond(request, {
          ok: true,
          session_id: sessionId,
          steered: true,
          ...steered,
        });
        return;
      } catch (err) {
        if (!(err instanceof InputQueueError) && !(err instanceof Error)) {
          throw err;
        }
      }
    }

    let requestResult: Record<string, unknown> = {};
    if (completionScope === "request") {
      this.worker.execution.beginRequest(sessionId);
    }
    try {
      for await (const rawEvent of this.worker.execution.runTurn(sessionId, {
        query,
        transientSystemMessages,
        resume,
        delivery,
      })) {
        let event = rawEvent;
        if (event.type === "turn_started" && query && !resume && !delivery) {
          event = {
            ...event,
            input: query,
            ...(clientInputId ? { client_input_id: clientInputId } : {}),
          };
        }
        turnSessionId = turnSessionId || String(event.session_id || "");
        turnId = turnId || String(event.turn_id || "");
        await this.sendEvent(event);
      }
      if (completionScope === "request") {
        requestResult = await this.worker.execution.waitRequest(sessionId);
      }
      if (!turnId) {
        await this.discardIfUnsaved(sessionId);
      }
    } catch (err) {
      if (completionScope === "request") {
        await this.worker.execution.abandonRequest(sessionId);
      }
      await this.discardIfUnsaved(sessionId);
      throw err;
    }
    await this.respond(request, {
      ok: true,
      session_id: turnSessionId || sessionId,
      turn_id: turnId,
      ...requestResult,
    });
  }

  private async compact(
    sessionId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const container = this.worker.execution.activeContainer(sessionId);
    if (container !== null && container.runtime.turnActive) {
      await this.respondError(
        request,
        "Cannot compact context while a turn is active.",
        "TurnActive",
      );
      return;
    }
    this.subscribed.add(sessionId);
    await this.respond(request, await this.worker.execution.compactContext(sessionId));
  }

  private async handleActiveControl(
    sessionId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const method = request.method;
    if (method === RuntimeMethod.SESSION_CANCEL) {
      if (!this.worker.execution.interrupt(sessionId)) {
        await this.respondError(
          request,
          "No active turn to interrupt.",
          "TurnNotActive",
        );
        return;
      }
      await this.respond(request, { ok: true });
      return;
    }
    if (method === RuntimeMethod.RIND_USER_QUESTION_RESPOND) {
      const params =
        request.params && typeof request.params === "object" && !Array.isArray(request.params)
          ? (request.params as Record<string, unknown>)
          : {};
      try {
        await this.worker.execution.answerUserQuestion(
          sessionId,
          String(params.tool_call_id || ""),
          String(params.answer || "").trim(),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "LookupError") {
          await this.respondError(request, err.message, "QuestionNotFound");
          return;
        }
        throw err;
      }
      await this.respond(request, { ok: true });
      return;
    }
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    let result: Record<string, unknown>;
    try {
      if (method === RuntimeMethod.RIND_SESSION_STEER) {
        result = this.worker.execution.submitInput(
          sessionId,
          "steering",
          String(params.input || ""),
        );
      } else if (method === RuntimeMethod.RIND_SESSION_FOLLOW_UP) {
        result = this.worker.execution.submitInput(
          sessionId,
          "follow_up",
          String(params.input || ""),
        );
      } else if (method === RuntimeMethod.RIND_SESSION_PROMOTE_FOLLOW_UP) {
        result = this.worker.execution.promoteFollowUp(
          sessionId,
          String(params.input_id || ""),
        );
      } else if (method === RuntimeMethod.RIND_SESSION_UNSTEER) {
        result = this.worker.execution.retrieveInput(
          sessionId,
          "steering",
          typeof params.input_id === "string" ? params.input_id : null,
        );
      } else if (method === RuntimeMethod.RIND_SESSION_DEQUEUE_FOLLOW_UP) {
        result = this.worker.execution.retrieveInput(
          sessionId,
          "follow_up",
          typeof params.input_id === "string" ? params.input_id : null,
        );
      } else {
        await this.respondError(
          request,
          "Session execution is not active.",
          "TurnNotActive",
        );
        return;
      }
    } catch (err) {
      if (err instanceof InputQueueError) {
        await this.respondError(request, err.message, err.errorType);
        return;
      }
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "TurnNotActive",
      );
      return;
    }
    await this.respond(request, result);
  }

  private async resumePreview(sessionId: string): Promise<string> {
    const replay = await this.worker.repository.replay(sessionId, { end: 20 });
    const messages = Array.isArray(replay.messages)
      ? (replay.messages as Array<Record<string, unknown>>)
      : [];
    return renderResumePreview(messages, { sessionId });
  }

  private async listSessions(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const perWorkspaceLimit = params.per_workspace_limit;
    if (
      perWorkspaceLimit !== undefined &&
      perWorkspaceLimit !== null &&
      (typeof perWorkspaceLimit === "boolean" ||
        typeof perWorkspaceLimit !== "number" ||
        !Number.isInteger(perWorkspaceLimit) ||
        perWorkspaceLimit < 1 ||
        perWorkspaceLimit > 20)
    ) {
      await this.respondError(
        request,
        "session/list per_workspace_limit must be an integer from 1 to 20.",
        "InvalidRequest",
      );
      return;
    }
    const limit = params.limit ?? 20;
    const maxLimit =
      perWorkspaceLimit !== undefined && perWorkspaceLimit !== null ? 1000 : 100;
    if (
      typeof limit === "boolean" ||
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > maxLimit
    ) {
      await this.respondError(
        request,
        `session/list limit must be an integer from 1 to ${maxLimit}.`,
        "InvalidRequest",
      );
      return;
    }
    const workspaceRoot = params.workspace_root;
    if (
      workspaceRoot !== undefined &&
      workspaceRoot !== null &&
      perWorkspaceLimit !== undefined &&
      perWorkspaceLimit !== null
    ) {
      await this.respondError(
        request,
        "A grouped session/list cannot also select one workspace_root.",
        "InvalidRequest",
      );
      return;
    }
    if (workspaceRoot !== undefined && workspaceRoot !== null) {
      if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
        await this.respondError(
          request,
          "workspace_root must be a non-empty string.",
          "InvalidRequest",
        );
        return;
      }
    }
    const excluded = params.exclude_workspace_roots;
    if (
      excluded !== undefined &&
      excluded !== null &&
      (!Array.isArray(excluded) || !excluded.every(item => typeof item === "string"))
    ) {
      await this.respondError(
        request,
        "exclude_workspace_roots must be a list of strings.",
        "InvalidRequest",
      );
      return;
    }
    const skipped = params.exclude_session_ids;
    if (
      skipped !== undefined &&
      skipped !== null &&
      (!Array.isArray(skipped) || !skipped.every(item => typeof item === "string"))
    ) {
      await this.respondError(
        request,
        "exclude_session_ids must be a list of strings.",
        "InvalidRequest",
      );
      return;
    }

    let sessions: Array<Record<string, unknown>>;
    let totals: Array<{ workspace_root: string; count: number }> | null = null;
    if (perWorkspaceLimit !== undefined && perWorkspaceLimit !== null) {
      [sessions, totals] = await this.worker.repository.listByWorkspace({
        limit,
        perWorkspaceLimit,
        excludeWorkspaceRoots: (excluded as string[] | undefined) ?? null,
        excludeSessionIds: (skipped as string[] | undefined) ?? null,
      });
    } else {
      sessions = await this.worker.repository.list({
        limit,
        workspaceRoot: (workspaceRoot as string | undefined) ?? null,
        excludeWorkspaceRoots: (excluded as string[] | undefined) ?? null,
        excludeSessionIds: (skipped as string[] | undefined) ?? null,
      });
    }
    const ready = this.readyConnections();
    await this.respond(request, {
      sessions: sessions.map(session => ({
        ...session,
        connection_ready: ready.has(String(session.provider || "")),
      })),
      ...(totals !== null ? { totals } : {}),
      current_session_id: this.worker.sessionId || "",
    });
  }

  private readyConnections(): Set<string> {
    return new Set(
      this.worker
        .listProviders()
        .filter(p => Boolean(p.configured))
        .map(p => String(p.id || "")),
    );
  }

  private async newSession(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const workspaceRoot = params.workspace_root ?? this.worker.workspaceRoot;
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
      await this.respondError(
        request,
        "workspace_root must be a non-empty string.",
        "InvalidRequest",
      );
      return;
    }
    const info = await this.worker.createSession(workspaceRoot);
    const createdSessionId = String(info.session_id || "");
    if (createdSessionId) {
      this.subscribed.add(createdSessionId);
    }
    await this.respond(request, info);
  }

  private async switchSession(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const info = await this.worker.session(sessionId);
    this.subscribed.add(sessionId);
    await this.respond(request, info);
  }

  private async deleteSession(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    if (sessionId === this.worker.sessionId) {
      await this.respondError(
        request,
        "Cannot delete the current session. Switch to another session first.",
        "InvalidRequest",
      );
      return;
    }
    if (this.worker.execution.activeSessionIds().has(sessionId)) {
      await this.respondError(
        request,
        "Cannot delete a session with an active turn.",
        "TurnActive",
      );
      return;
    }
    await this.worker.deleteSession(sessionId);
    await this.sendEvent({
      type: "session_deleted",
      session_id: sessionId,
      turn_id: "",
    });
    this.subscribed.delete(sessionId);
    await this.respond(request, { ok: true, deleted: sessionId });
  }

  private async createConversation(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    if (
      ("external_tools" in params || "enable_user_question" in params) &&
      !this.allowSessionConfiguration
    ) {
      throw new Error("Session configuration requires the local execution host.");
    }
    const info = await this.worker.createConversation(params);
    this.subscribed.add(String(info.session_id || ""));
    await this.respond(request, info);
  }

  private async discardIfUnsaved(sessionId: string): Promise<void> {
    if (await this.worker.discardUnsaved(sessionId)) {
      await this.sendEvent({
        type: "session_discarded",
        session_id: sessionId,
        turn_id: "",
      });
      this.subscribed.delete(sessionId);
    }
  }

  private async forkSession(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    if (this.worker.execution.activeSessionIds().has(sessionId)) {
      await this.respondError(
        request,
        "Cannot fork a session with an active turn.",
        "TurnActive",
      );
      return;
    }
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const beforeMessageId = params.before_message_id;
    if (
      beforeMessageId !== undefined &&
      beforeMessageId !== null &&
      typeof beforeMessageId !== "string"
    ) {
      await this.respondError(
        request,
        "before_message_id must be a string.",
        "InvalidRequest",
      );
      return;
    }
    try {
      const result = await this.worker.forkSession(
        sessionId,
        (beforeMessageId as string | null | undefined) ?? null,
      );
      await this.respond(request, result);
    } catch (err) {
      if (err instanceof Error && err.name === "LookupError") {
        throw err;
      }
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "InvalidRequest",
      );
    }
  }

  private async contextInspect(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const meta = await this.worker.repository.metadata(sessionId);
    const breakdown = meta.latest_context_breakdown;
    const usage = meta.latest_assistant_sampling_usage;
    await this.respond(request, {
      session_id: sessionId,
      breakdown:
        breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)
          ? structuredClone(breakdown)
          : null,
      latest_usage:
        usage && typeof usage === "object" && !Array.isArray(usage)
          ? structuredClone(usage)
          : null,
    });
  }

  private async usageSummary(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const days = params.days ?? 7;
    if (
      typeof days === "boolean" ||
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    ) {
      await this.respondError(
        request,
        "rind/usage/summary days must be an integer from 1 to 365.",
        "InvalidRequest",
      );
      return;
    }
    await this.respond(request, await this.worker.usageSummary(days));
  }

  private async subscriptionRequest(request: Record<string, unknown>): Promise<void> {
    const method = String(request.method || "");
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const rawSessionId = params.session_id;
    if (typeof rawSessionId !== "string" || !rawSessionId.trim()) {
      await this.respondError(
        request,
        `${method} requires session_id.`,
        "InvalidRequest",
      );
      return;
    }
    let sessionId: string;
    try {
      sessionId = validateSessionId(rawSessionId);
    } catch (err) {
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "InvalidRequest",
      );
      return;
    }
    await this.worker.session(sessionId);
    if (method === RuntimeMethod.SESSION_SUBSCRIBE) {
      this.subscribed.add(sessionId);
    } else {
      this.subscribed.delete(sessionId);
    }
    await this.respond(request, {
      ok: true,
      subscribed: Array.from(this.subscribed).sort(),
    });
  }

  private async listModels(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    let sessionId = params.session_id;
    if (sessionId !== undefined && sessionId !== null) {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        await this.respondError(
          request,
          "session_id must be a non-empty string.",
          "InvalidRequest",
        );
        return;
      }
    } else {
      sessionId = (await this.worker.initialize()).session_id;
    }
    const info = sessionId
      ? await this.worker.session(String(sessionId))
      : await this.worker.blankInfo(
          typeof params.workspace_root === "string" ? params.workspace_root : null,
        );
    const refresh = Boolean(params.refresh);
    const listing = await this.worker.listModels({ refresh });
    const currentModel = String(info.model || "");
    const currentProvider = String(info.provider || "");
    await this.respond(request, {
      ...listing,
      current: { provider_id: currentProvider, model_id: currentModel },
      current_model: currentModel,
      default_model: currentModel,
    });
  }

  private async replay(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    if ("after_cursor" in params) {
      const afterCursor = params.after_cursor;
      if (
        typeof afterCursor === "boolean" ||
        typeof afterCursor !== "number" ||
        !Number.isInteger(afterCursor) ||
        afterCursor < 0
      ) {
        await this.respondError(
          request,
          "session/replay after_cursor must be a non-negative integer.",
          "InvalidRequest",
        );
        return;
      }
      await this.replayEventPages(request, afterCursor);
      return;
    }
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const start =
      typeof params.start === "number" && Number.isInteger(params.start)
        ? params.start
        : null;
    const end =
      typeof params.end === "number" && Number.isInteger(params.end)
        ? params.end
        : null;
    const tail = params.tail;
    if (tail !== undefined && tail !== null) {
      if (
        typeof tail === "boolean" ||
        typeof tail !== "number" ||
        !Number.isInteger(tail) ||
        tail < 1 ||
        tail > 5000
      ) {
        await this.respondError(
          request,
          "session/replay tail must be an integer from 1 to 5000.",
          "InvalidRequest",
        );
        return;
      }
      if (start !== null || end !== null) {
        await this.respondError(
          request,
          "session/replay tail cannot be combined with start or end.",
          "InvalidRequest",
        );
        return;
      }
    }
    if (this.allowSessionConfiguration) {
      await this.worker.configureIfUnowned(sessionId, params);
    }
    const result = await this.worker.replay(sessionId, {
      start,
      end,
      tail: (tail as number | null | undefined) ?? null,
    });
    await this.respond(request, result);
  }

  private async replayEventPages(
    request: Record<string, unknown>,
    afterCursor: number,
  ): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const materials = await this.worker.replayEventPages(sessionId);
    const messages = Array.isArray(materials.messages)
      ? (materials.messages as Array<Record<string, unknown>>)
      : [];
    const toolRecords = Array.isArray(materials.tool_records)
      ? (materials.tool_records as Array<Record<string, unknown>>)
      : [];
    const turnState =
      materials.turn_state &&
      typeof materials.turn_state === "object" &&
      !Array.isArray(materials.turn_state)
        ? (materials.turn_state as Record<string, unknown>)
        : null;
    const events = iterDurableEvents(messages, toolRecords, turnState, sessionId);
    const envelopes = [];
    let cursor = 0;
    for (const event of events) {
      cursor += 1;
      if (cursor > afterCursor) {
        envelopes.push(eventEnvelope(event, cursor));
      }
    }
    const tasks = (await this.worker.shellTools.monitorTasks(sessionId)).tasks;
    await this.respond(request, { events: envelopes, cursor, tasks });
  }

  private async fileRequest(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const method = String(request.method || "");
    try {
      let result: Record<string, unknown>;
      if (method === RuntimeMethod.FILE_LIST) {
        result = fileList(this.worker.workspaceRoot, String(params.path || ""));
      } else if (method === RuntimeMethod.FILE_READ) {
        result = fileRead(this.worker.workspaceRoot, String(params.path || ""));
      } else {
        result = fileWrite(
          this.worker.workspaceRoot,
          String(params.path || ""),
          params.content_base64,
        );
      }
      await this.respond(request, result);
    } catch (err) {
      if (err instanceof FileMethodError) {
        await this.respondError(request, err.message, err.errorType);
        return;
      }
      throw err;
    }
  }

  private async executeCommand(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    let sessionId = params.session_id;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      sessionId = this.worker.sessionId;
    }
    const rawInput = String(params.input || "").trim();
    const command = rawInput
      ? rawInput.split(/\s+/)[0]!.replace(/^\/+/, "").toLowerCase()
      : "";
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      await this.executeWithoutConversation(request, command, rawInput, params);
      return;
    }
    if (command === "compact") {
      this.subscribed.add(sessionId);
    }
    const active = this.worker.execution.activeContainer(sessionId);
    const store = await this.sessionStore(sessionId);
    const modelBefore = store.model;
    const context: SlashCommandContext = {
      runtime: active ? active.runtime : null,
      session: store,
      debug: this.debug,
      workspace_root: store.workspace_root,
      compact_context: () => this.worker.execution.compactContext(sessionId),
      explain_selection: (selection, source) =>
        explainSelection(
          this.worker,
          String(store.workspace_root || this.worker.workspaceRoot),
          selection,
          source,
        ),
      skills: this.skillRepository(sessionId, store),
    };
    const result = await this.slashRouter.execute(rawInput, context);
    await this.respondSlashResult(request, result);
    const renamed =
      result.display &&
      typeof result.display === "object" &&
      result.display.type === "session_renamed"
        ? result.display
        : null;
    if (command === "model" && store.model !== modelBefore) {
      await this.settingsChanged(sessionId, store);
    }
    if (renamed) {
      await this.sendEvent({
        type: "session_renamed",
        session_id: sessionId,
        turn_id: "",
        name: renamed.name,
        title: renamed.title,
      });
    }
  }

  private skillRepository(
    sessionId: string,
    store: { workspace_root: string | null },
  ): SkillRepository {
    const extTool = this.worker.execution.externalTool(sessionId);
    return new SkillRepository(
      String(store.workspace_root || this.worker.workspaceRoot),
      { skillFiles: extTool ? extTool.skill_files : [] },
    );
  }

  private async sessionStore(sessionId: string) {
    const active = this.worker.execution.activeContainer(sessionId);
    if (active) {
      return active.session_store;
    }
    return await this.worker.repository.openStore(sessionId, null, {
      persistSystemPrompt: false,
    });
  }

  private async setModel(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const rawProvider = params.provider_id;
    if (rawProvider !== undefined && rawProvider !== null && typeof rawProvider !== "string") {
      await this.respondError(
        request,
        "model/set provider_id must be a string.",
        "InvalidRequest",
      );
      return;
    }
    let providerId = String(rawProvider || "").trim();
    const rawModel = "model_id" in params ? params.model_id : params.model;
    const model = typeof rawModel === "string" ? rawModel.trim() : "";
    if (!model) {
      await this.respondError(request, "model/set requires model.", "InvalidRequest");
      return;
    }
    const store = await this.sessionStore(sessionId);
    providerId = providerId || String(store.provider || "openai");
    await store.update_selection(providerId, model);
    const applies = await this.settingsChanged(sessionId, store);
    await this.respond(request, {
      provider_id: providerId,
      model_id: model,
      model,
      session: true,
      runtime: false,
      applies,
    });
  }

  private async setReasoningEffort(request: Record<string, unknown>): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const rawEffort = params.reasoning_effort;
    const effort = typeof rawEffort === "string" ? rawEffort.trim().toLowerCase() : "";
    if (!effort) {
      await this.respondError(
        request,
        "model/effort requires reasoning_effort.",
        "InvalidRequest",
      );
      return;
    }
    const store = await this.sessionStore(sessionId);
    await store.update_reasoning_effort(effort);
    const applies = await this.settingsChanged(sessionId, store);
    await this.respond(request, {
      reasoning_effort: effort,
      session: true,
      applies,
    });
  }

  private async folderDefaults(
    method: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    let result: Record<string, unknown>;
    if (method === RuntimeMethod.RIND_FOLDER_DEFAULTS_GET) {
      result = await describeFolderDefaults(
        this.worker,
        String(params.workspace_root || this.worker.workspaceRoot),
      );
    } else if (method === RuntimeMethod.RIND_FOLDER_DEFAULTS_RESOLVE) {
      const roots = params.workspace_roots;
      if (!Array.isArray(roots) || !roots.every(r => typeof r === "string")) {
        throw new Error("workspace_roots must be a list of folder paths.");
      }
      result = {
        folders: await resolveManyFolderDefaults(this.worker, roots as string[]),
      };
    } else {
      const change =
        method === RuntimeMethod.RIND_FOLDER_DEFAULTS_SET
          ? setFolderDefaults
          : unsetFolderDefaults;
      result = await change(this.worker, params);
      await this.sendEvent({
        type: "folder_defaults_changed",
        turn_id: "",
        workspace_root: result.workspace_root,
      });
    }
    await this.respond(request, result);
  }

  private async deliver(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const text = String(params.text || "").trim();
    if (!text) {
      await this.respondError(request, "A delivery needs text.", "InvalidParams");
      return;
    }
    if (!(await this.worker.repository.exists(sessionId))) {
      await this.respondError(request, "Conversation not found.", "SessionNotFound");
      return;
    }
    if (this.allowSessionConfiguration) {
      await this.worker.configureIfUnowned(sessionId, params);
    }
    try {
      this.worker.execution.deliver(sessionId, text);
    } catch (err) {
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "SessionClosed",
      );
      return;
    }
    await this.respond(request, { queued: true });
  }

  private async applyFolderDefaults(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const store = await this.sessionStore(sessionId);
    const folder = this.worker.repository.folderSelection(
      String(store.workspace_root || ""),
    );
    const wanted = folder.selection;
    let changed = false;
    if (store.provider !== wanted.provider_id || store.model !== wanted.model_id) {
      await store.update_selection(wanted.provider_id, wanted.model_id, {
        source: folder.model_source,
      });
      changed = true;
    }
    if (wanted.reasoning_effort && store.reasoning_effort !== wanted.reasoning_effort) {
      await store.update_reasoning_effort(wanted.reasoning_effort, {
        source: folder.effort_source,
      });
      changed = true;
    }
    const applies = changed ? await this.settingsChanged(sessionId, store) : null;
    await this.respond(request, {
      provider_id: store.provider,
      model_id: store.model,
      reasoning_effort: store.reasoning_effort,
      changed,
      applies,
    });
  }

  private async settingsChanged(
    sessionId: string,
    store: {
      provider: string;
      model: string | null;
      reasoning_effort: string;
      selection_source: Record<string, string>;
    },
  ): Promise<string> {
    const applies = this.worker.execution.turnRunning(sessionId) ? "next_turn" : "now";
    const provider = String(store.provider || "");
    await this.sendEvent({
      type: "session_settings_changed",
      session_id: sessionId,
      turn_id: "",
      provider,
      model: String(store.model || ""),
      reasoning_effort: String(store.reasoning_effort || ""),
      applies,
      selection_source: { ...store.selection_source },
      connection_ready: this.readyConnections().has(provider),
    });
    return applies;
  }

  private async goalRequest(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    const active = this.worker.execution.activeContainer(sessionId);
    const store = active
      ? active.runtime
      : new RepositoryGoalOps(this.worker.repository, sessionId);
    const startContinuation = async (): Promise<void> => {
      await this.worker.execution.startGoalContinuation(sessionId);
    };
    const interrupt = (): void => {
      this.worker.execution.interrupt(sessionId);
    };

    const method = request.method;
    if (method === RuntimeMethod.RIND_GOAL_GET) {
      await this.respond(request, { goal: await store.getGoal() });
      return;
    }
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    if (method === RuntimeMethod.RIND_GOAL_SET) {
      const objective = params.objective;
      if (typeof objective !== "string" || !objective.trim()) {
        await this.respondError(
          request,
          "rind/goal/set requires objective.",
          "InvalidRequest",
        );
        return;
      }
      const goal = await store.setGoal(objective);
      await this.respond(request, { goal });
      await startContinuation();
      return;
    }
    if (method === RuntimeMethod.RIND_GOAL_STATUS) {
      const status = params.status;
      if (status !== "active" && status !== "paused") {
        await this.respondError(
          request,
          "rind/goal/status requires active or paused.",
          "InvalidRequest",
        );
        return;
      }
      const goal = await store.setGoalStatus(status);
      await this.respond(request, { goal });
      if (status === "active") {
        await startContinuation();
      }
      if (status === "paused") {
        interrupt();
      }
      return;
    }
    await store.clearGoal();
    interrupt();
    await this.respond(request, { goal: null });
  }

  private async taskRequest(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    await this.worker.session(sessionId);
    const rawParams =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? { ...(request.params as Record<string, unknown>) }
        : {};
    delete rawParams.session_id;
    const methodStr = String(request.method || "");
    const action = methodStr.slice(methodStr.lastIndexOf("/") + 1);

    if (action === "release_wait") {
      const keys = Object.keys(rawParams);
      if (
        keys.some(k => k !== "task_id" && k !== "tool_call_id") ||
        !(rawParams.task_id || rawParams.tool_call_id)
      ) {
        throw new Error("release_wait requires task_id or tool_call_id.");
      }
      if (
        Object.values(rawParams).some(
          v => typeof v !== "string" || !v.trim(),
        )
      ) {
        throw new Error("Task and tool call IDs must be nonempty strings.");
      }
      const released = this.worker.execution.releaseWait(
        sessionId,
        rawParams.task_id as string | undefined,
        rawParams.tool_call_id as string | undefined,
      );
      await this.respond(request, { ok: true, released });
      return;
    }
    if (action === "list") {
      const keys = Object.keys(rawParams);
      if (keys.some(k => k !== "page_token")) {
        throw new Error("Unknown task list parameters.");
      }
      const token = rawParams.page_token;
      if (
        token !== undefined &&
        token !== null &&
        (typeof token !== "string" || !/^\d+$/.test(token))
      ) {
        throw new Error("Invalid page_token.");
      }
      await this.respond(
        request,
        await this.worker.shellTools.monitorTasks(
          sessionId,
          (token as string | null | undefined) ?? null,
        ),
      );
      return;
    }
    const allowedKeys = new Set([
      "task_id",
      "cursor",
      "wait_ms",
      "max_output_chars",
      "page_token",
    ]);
    if (Object.keys(rawParams).some(k => !allowedKeys.has(k))) {
      throw new Error("Unknown task control parameters.");
    }
    const payload = JSON.parse(
      await this.worker.shellTools.taskControl(
        action,
        (rawParams.task_id as string | null | undefined) ?? null,
        (rawParams.cursor as string | null | undefined) ?? null,
        (rawParams.wait_ms as number | null | undefined) ?? null,
        typeof rawParams.max_output_chars === "number"
          ? rawParams.max_output_chars
          : 20_000,
        (rawParams.page_token as string | null | undefined) ?? null,
        { _session_id: sessionId },
      ),
    ) as Record<string, unknown>;
    if (!payload.ok) {
      await this.respondError(
        request,
        String(payload.error || "Task control failed."),
        String(payload.error_type || "TaskError"),
      );
      return;
    }
    const data =
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : {};
    await this.respond(request, {
      ...data,
      meta: payload.meta ?? {},
    });
  }

  private async backgroundRequest(request: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requiredSessionId(request);
    if (sessionId === null) return;
    if (request.method === RuntimeMethod.RIND_BACKGROUND_LIST) {
      await this.listBackgroundsForSession(request, sessionId);
      return;
    }
    await this.backgroundOutputForSession(request, sessionId);
  }

  private async listBackgroundsForSession(
    request: Record<string, unknown>,
    sessionId: string,
  ): Promise<void> {
    if (!this.backgroundList) {
      await this.respondError(
        request,
        "Background monitoring is unavailable.",
        "UnsupportedOperation",
      );
      return;
    }
    try {
      await this.respond(
        request,
        await backgroundListResponse(this.backgroundList, sessionId),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await this.respondError(request, e.message, e.name || "Error");
    }
  }

  private async backgroundOutputForSession(
    request: Record<string, unknown>,
    sessionId: string,
  ): Promise<void> {
    if (!this.backgroundOutput) {
      await this.respondError(
        request,
        "Background monitoring is unavailable.",
        "UnsupportedOperation",
      );
      return;
    }
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    try {
      const response = await backgroundOutputResponse(
        this.backgroundOutput,
        sessionId,
        params,
      );
      await this.respond(request, response);
    } catch (err) {
      if (err instanceof Error && err.name === "LookupError") {
        await this.respondError(request, err.message, "NotFound");
        return;
      }
      if (err instanceof TypeError) {
        await this.respondError(request, err.message, "TypeError");
        return;
      }
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "InvalidRequest",
      );
    }
  }

  private async requiredSessionId(
    request: Record<string, unknown>,
  ): Promise<string | null> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const value = params.session_id;
    if (typeof value !== "string" || !value.trim()) {
      await this.respondError(
        request,
        "session_id is required for this method.",
        "InvalidRequest",
      );
      return null;
    }
    try {
      return validateSessionId(value);
    } catch (err) {
      await this.respondError(
        request,
        err instanceof Error ? err.message : String(err),
        "InvalidRequest",
      );
      return null;
    }
  }

  private async validTurn(
    sessionId: string,
    request: Record<string, unknown>,
  ): Promise<boolean> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const expected = params.turn_id;
    const active = this.worker.execution.activeTurnId(sessionId);
    if (
      request.method === RuntimeMethod.SESSION_CANCEL &&
      (expected === undefined || expected === null || expected === "")
    ) {
      return true;
    }
    if (
      request.method === RuntimeMethod.RIND_SESSION_STEER &&
      (expected === undefined || expected === null || expected === "") &&
      active
    ) {
      return true;
    }
    if (
      typeof expected !== "string" ||
      !expected.trim() ||
      !active ||
      expected !== active
    ) {
      await this.respondError(
        request,
        "The requested turn is no longer active.",
        "TurnNotActive",
      );
      return false;
    }
    return true;
  }

  private async sendEvent(event: Record<string, unknown>): Promise<void> {
    const eventSessionId = String(event.session_id || "");
    if (eventSessionId && !this.subscribed.has(eventSessionId)) {
      return;
    }
    await this._writer.send(eventEnvelope(event, 0) as unknown as Record<string, unknown>);
  }

  private async respond(
    request: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    await this._writer.send(
      responseMessage(request, result) as unknown as Record<string, unknown>,
    );
  }

  private async respondSlashResult(
    request: Record<string, unknown>,
    result: SlashCommandResult,
  ): Promise<void> {
    await this.respond(request, result.toDict());
  }

  private async respondError(
    request: Record<string, unknown>,
    message: string,
    errorType: string,
  ): Promise<void> {
    await this._writer.send(
      errorMessage(request, message, errorType) as unknown as Record<string, unknown>,
    );
  }
}
