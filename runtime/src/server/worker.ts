import fs from "node:fs";
import path from "node:path";
import { CompactionService, positiveInt } from "../application/context-manager.js";
import {
  type AgentContainer,
  MessageStreamParser,
  SharedRuntimeResources,
} from "../core/turn-runner.js";
import type { AuthInteraction } from "../infrastructure/chatgpt-oauth.js";
import { ProviderServiceImpl } from "../infrastructure/llm/provider-service.js";
import {
  expandTilde,
  resolveRindHome,
  validateSessionId,
  validateWorkspaceRoot,
} from "../infrastructure/paths.js";
import { ToolOutputStore } from "../infrastructure/persistence/atomic-files.js";
import { ToolResultNormalizer } from "../infrastructure/persistence/result-normalizer.js";
import { buildPlanSnapshot } from "../infrastructure/persistence/session-store.js";
import {
  appendUsageRecord,
  defaultUsageLedgerPath,
  loadUsageRecords,
  summarizeUsage,
} from "../infrastructure/persistence/usage-ledger.js";
import { installSystemSkills } from "../infrastructure/skills.js";
import { ExternalTool } from "../infrastructure/tools/control-tools.js";
import { ShellTools } from "../infrastructure/tools/shell-tools.js";
import { WebSessions } from "../infrastructure/tools/web-tools.js";
import { ExecutionCoordinator } from "./execution.js";
import { SessionService } from "./session-service.js";

function normalizePathCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

const heldWorkerLocks = new Set<string>();

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen !== -1) {
        const state = stat.slice(closeParen + 1).trim().charAt(0);
        if (state === "Z" || state === "X") {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

export class WorkerLock {
  readonly path: string;
  private readonly key: string;
  private fd: number | null;

  constructor(lockPath: string, key: string, fd: number | null) {
    this.path = lockPath;
    this.key = key;
    this.fd = fd;
  }

  release(): void {
    const fd = this.fd;
    if (fd === null && !heldWorkerLocks.has(this.key)) {
      return;
    }
    this.fd = null;
    heldWorkerLocks.delete(this.key);
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      const holder = fs.readFileSync(this.path, "utf8").trim();
      if (holder === String(process.pid)) {
        fs.unlinkSync(this.path);
      }
    } catch {
      // ignore
    }
  }
}

export function acquireWorkerLock(
  sessionDir?: string | null,
  options?: { waitSeconds?: number },
): WorkerLock {
  const waitSeconds = options?.waitSeconds ?? 0;
  const rindHome = resolveRindHome();
  const defaultSessions = path.resolve(rindHome, "sessions");
  const resolvedSessionDir = sessionDir
    ? path.resolve(expandTilde(sessionDir))
    : defaultSessions;
  let lockPath: string;
  let target: string;
  if (normalizePathCase(resolvedSessionDir) === normalizePathCase(defaultSessions)) {
    lockPath = path.join(rindHome, "runtime", "worker.lock");
    target = rindHome;
  } else {
    lockPath = path.join(resolvedSessionDir, ".worker.lock");
    target = resolvedSessionDir;
  }

  const key = normalizePathCase(path.resolve(lockPath));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = performance.now() + Math.max(0, waitSeconds) * 1000;

  while (true) {
    if (!heldWorkerLocks.has(key)) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, ` ${process.pid}\n`, "ascii");
        heldWorkerLocks.add(key);
        return new WorkerLock(lockPath, key, fd);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EACCES") {
          throw err;
        }
      }
    }

    let holder = "unknown";
    if (heldWorkerLocks.has(key)) {
      holder = String(process.pid);
    } else {
      try {
        const text = fs.readFileSync(lockPath, "utf8").trim();
        const pid = Number.parseInt(text, 10);
        if (Number.isInteger(pid) && pid > 0) {
          if (pid !== process.pid && isProcessAlive(pid)) {
            holder = String(pid);
          } else if (pid !== process.pid) {
            try {
              fs.unlinkSync(lockPath);
              continue;
            } catch {
              // ignore race
            }
          }
        } else {
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 100) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch {
            continue;
          }
        }
      } catch {
        // ignore
      }
    }

    if (performance.now() >= deadline) {
      throw new Error(
        `Another Rind runtime worker is already running for ${target} (pid ${holder}).`,
      );
    }
    sleepSync(50);
  }
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

export class RuntimeWorker {
  readonly workspaceRoot: string;
  sessionId: string | null;
  private readonly resumeLatest: boolean;
  private readonly sharedResources: SharedRuntimeResources;
  readonly shellTools: ShellTools;
  readonly webSessions: WebSessions;
  readonly providerService: ProviderServiceImpl;
  readonly repository: SessionService;
  readonly execution: ExecutionCoordinator;
  private initialized = false;
  private modelRefreshTask: Promise<void> | null = null;
  private readonly initializeLock = new AsyncLock();
  private readonly toolOutputStore: ToolOutputStore;

  constructor(options: {
    workspaceRoot: string;
    sessionId?: string | null;
    resumeLatest?: boolean;
    sessionDir?: string | null;
    debug?: boolean;
    enableGoal?: boolean;
    enableUserQuestion?: boolean;
    externalTool?: ExternalTool | null;
  }) {
    this.workspaceRoot = validateWorkspaceRoot(options.workspaceRoot);
    this.sessionId = options.sessionId ?? null;
    this.resumeLatest = options.resumeLatest ?? false;
    const toolOutputStore = new ToolOutputStore(options.sessionDir ?? null);
    const usageRecorder = (record: Record<string, unknown>): void => {
      appendUsageRecord(defaultUsageLedgerPath(), record);
    };
    this.sharedResources = new SharedRuntimeResources({
      toolResultNormalizer: new ToolResultNormalizer(),
      streamParser: new MessageStreamParser(),
      compactionService: new CompactionService({
        planSnapshotProvider: buildPlanSnapshot,
        usageRecorder,
      }),
      toolOutputStore,
    });
    this.shellTools = new ShellTools(toolOutputStore);
    this.webSessions = new WebSessions();
    this.providerService = new ProviderServiceImpl();
    this.repository = new SessionService({
      sessionDir: options.sessionDir ?? null,
      providerService: this.providerService,
    });
    this.execution = new ExecutionCoordinator({
      sharedResources: this.sharedResources,
      shellTools: this.shellTools,
      webSessions: this.webSessions,
      repository: this.repository,
      debug: options.debug ?? false,
      enableGoal: options.enableGoal ?? true,
      enableUserQuestion: options.enableUserQuestion ?? true,
      sessionDir: options.sessionDir ?? null,
      providerService: this.providerService,
      externalTool: options.externalTool ?? null,
    });
    this.toolOutputStore = toolOutputStore;
  }

  async initialize(): Promise<Record<string, unknown>> {
    await this.initializeLock.runExclusive(async () => {
      if (!this.initialized) {
        await this.toolOutputStore.cleanup();
        try {
          installSystemSkills(resolveRindHome());
        } catch {
          // Startup goes on with whatever .system holds; /skill reports missing built-ins.
        }
        const info = await this.repository.initial(
          this.workspaceRoot,
          this.sessionId,
          this.resumeLatest,
        );
        this.sessionId = String(info.session_id || "") || null;
        this.initialized = true;
        this.modelRefreshTask = this.providerService
          .refreshStaleModels()
          .catch(() => undefined);
      }
    });
    if (this.sessionId) {
      const info = await this.repository.info(this.sessionId);
      info.live_turn = this.execution.liveTurn(this.sessionId);
      return info;
    }
    return await this.blankInfo();
  }

  async blankInfo(workspaceRoot?: string | null): Promise<Record<string, unknown>> {
    const root = workspaceRoot || this.workspaceRoot;
    const info = await this.repository.blank(root);
    info.live_turn = null;
    return info;
  }

  async session(sessionId: string): Promise<Record<string, unknown>> {
    const info = await this.repository.info(sessionId);
    info.live_turn = this.execution.liveTurn(sessionId);
    return info;
  }

  async createSession(workspaceRoot?: string | null): Promise<Record<string, unknown>> {
    return await this.repository.create(workspaceRoot || this.workspaceRoot);
  }

  async openSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const root = validateWorkspaceRoot(String(params.workspace_root || this.workspaceRoot));
    const info = await this.repository.initial(
      root,
      typeof params.session_id === "string" ? params.session_id : null,
      params.resume_latest === true,
    );
    if (normalizePathCase(String(info.workspace_root || "")) !== normalizePathCase(root)) {
      throw new Error("Session workspace does not match the requested workspace.");
    }
    const sessionId = String(info.session_id || "");
    if (!sessionId) {
      return await this.blankInfo(root);
    }
    const tool = params.external_tools
      ? ExternalTool.fromJson(JSON.stringify(params.external_tools))
      : null;
    await this.execution.configureSession(
      sessionId,
      tool,
      params.enable_user_question !== false,
    );
    return await this.session(sessionId);
  }

  async configureIfUnowned(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const clean = validateSessionId(sessionId);
    if (
      !("external_tools" in params) ||
      (this.execution.ownsSession(clean) && !params.external_tools)
    ) {
      return;
    }
    if (
      !this.execution.ownsSession(clean) &&
      this.repository.draftStore(clean) === null &&
      !(await this.repository.exists(clean))
    ) {
      return;
    }
    const tool = params.external_tools
      ? ExternalTool.fromJson(JSON.stringify(params.external_tools))
      : null;
    const enableQuestion =
      "enable_user_question" in params
        ? params.enable_user_question !== false
        : this.execution.userQuestionEnabled(clean);
    await this.execution.configureSession(clean, tool, enableQuestion);
  }

  async startExecution(sessionId: string): Promise<AgentContainer> {
    return await this.execution.start(sessionId);
  }

  async releaseExecution(sessionId: string): Promise<void> {
    await this.execution.release(sessionId);
  }

  async createConversation(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (const abandoned of this.repository.abandoned()) {
      await this.discardUnsaved(abandoned);
    }
    const root = validateWorkspaceRoot(String(params.workspace_root || this.workspaceRoot));
    const [selection, source] = this.repository.chooseSelection(
      root,
      String(params.provider_id || ""),
      String(params.model_id || ""),
      params.reasoning_effort !== undefined && params.reasoning_effort !== null
        ? String(params.reasoning_effort)
        : null,
    );
    const proposed = params.session_id
      ? validateSessionId(String(params.session_id))
      : null;
    if (
      proposed &&
      (this.repository.draftStore(proposed) !== null ||
        (await this.repository.exists(proposed)))
    ) {
      throw new Error("This conversation already exists.");
    }
    const info = await this.repository.create(root, {
      selection,
      selectionSource: source,
      deferPersistence: true,
      sessionId: proposed,
    });
    const sessionId = String(info.session_id || "");
    if (params.name) {
      const store = await this.repository.openStore(sessionId);
      await store.set_name(String(params.name));
    }
    if (
      params.skill_sources &&
      typeof params.skill_sources === "object" &&
      !Array.isArray(params.skill_sources)
    ) {
      const store = await this.repository.openStore(sessionId);
      await store.set_skill_sources(params.skill_sources as Record<string, boolean>);
    }
    if ("external_tools" in params || "enable_user_question" in params) {
      const tool = params.external_tools
        ? ExternalTool.fromJson(JSON.stringify(params.external_tools))
        : null;
      await this.execution.configureSession(
        sessionId,
        tool,
        params.enable_user_question !== false,
      );
    }
    return await this.session(sessionId);
  }

  async discardUnsaved(sessionId: string): Promise<boolean> {
    const clean = validateSessionId(sessionId);
    if (
      this.repository.draftStore(clean) === null ||
      this.execution.activeSessionIds().has(clean)
    ) {
      return false;
    }
    await this.execution.release(clean);
    this.execution.forgetOptions(clean);
    return this.repository.discardUnsaved(clean);
  }

  async replay(
    sessionId: string,
    options?: {
      start?: number | null;
      end?: number | null;
      tail?: number | null;
    },
  ): Promise<Record<string, unknown>> {
    const end = options?.end ?? null;
    const tail = options?.tail ?? null;
    const metadataOnly = end === 0 && !tail;
    if (!metadataOnly) {
      await this.shellTools.maintainTasks(sessionId);
    }
    const result = await this.repository.replay(sessionId, options);
    result.live_turn = this.execution.liveTurn(sessionId);
    result.hosted = this.execution.ownsSession(sessionId);
    result.tasks = metadataOnly
      ? []
      : (await this.shellTools.monitorTasks(sessionId)).tasks;
    result.background_wait = await this.execution.backgroundWait(sessionId);
    return result;
  }

  async replayEventPages(sessionId: string): Promise<Record<string, unknown>> {
    return await this.repository.replayEventPages(sessionId);
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    const clean = validateSessionId(sessionId);
    this.execution.interrupt(clean, "Session deleted");
    await this.execution.release(clean, { permanent: true });
    this.execution.forgetOptions(clean);
    await this.shellTools.closeSession(clean);
    return await this.repository.delete(clean);
  }

  async forkSession(
    sessionId: string,
    beforeMessageId?: string | null,
  ): Promise<Record<string, unknown>> {
    const clean = validateSessionId(sessionId);
    return await this.repository.fork(clean, beforeMessageId);
  }

  async usageSummary(days = 7): Promise<Record<string, unknown>> {
    const window = Math.max(1, Math.min(positiveInt(days, 7), 365));
    const records = loadUsageRecords(defaultUsageLedgerPath());
    return summarizeUsage(records, window);
  }

  listProviders(): Array<Record<string, unknown>> {
    return this.providerService.listProviders().map(status => ({
      id: status.id,
      name: status.name,
      methods: [...status.methods],
      configured: status.configured,
      source: status.source,
    }));
  }

  async login(
    providerId: string,
    method: string,
    interaction: AuthInteraction,
  ): Promise<string> {
    return await this.providerService.login(providerId, method, interaction);
  }

  logout(providerId: string): boolean {
    return this.providerService.logout(providerId);
  }

  async listModels(options?: { refresh?: boolean }): Promise<Record<string, unknown>> {
    const catalog = await this.providerService.listModels({
      refresh: options?.refresh ?? false,
    });
    return {
      models: catalog.models.map(model => ({
        provider_id: model.provider_id,
        id: model.id,
        api: model.api,
        reasoning_efforts: [...model.reasoning_efforts],
        context_window: model.context_window,
        image_input: model.image_input,
      })),
      warning: catalog.warning,
    };
  }

  async close(): Promise<void> {
    this.shellTools.supervisor.stopAccepting();
    if (this.modelRefreshTask !== null) {
      await Promise.allSettled([this.modelRefreshTask]);
      this.modelRefreshTask = null;
    }
    try {
      const results = await Promise.allSettled([
        this.execution.close(),
        this.shellTools.close(),
      ]);
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map(r => r.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Worker shutdown failed: " +
            errors.map(e => (e instanceof Error ? e.message : String(e))).join("; "),
        );
      }
    } finally {
      this.webSessions.close();
    }
  }
}
