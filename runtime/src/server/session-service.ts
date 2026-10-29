import fs from "node:fs";
import type { ModelSelection } from "../domain/models.js";
import type { ProviderServiceImpl } from "../infrastructure/llm/provider-service.js";
import {
  getSystemInfo,
  resolveSessionBase,
  validateSessionId,
  validateWorkspaceRoot,
} from "../infrastructure/paths.js";
import { SessionFiles } from "../infrastructure/persistence/atomic-files.js";
import {
  JsonlSessionStore,
  SessionIndexRepository,
  displayTitle,
  forkSession,
  newSessionId,
} from "../infrastructure/persistence/session-store.js";
import { resolveProjectDocPath } from "../infrastructure/rind-docs.js";
import { type FolderSelection, WorkspaceDefaults } from "../infrastructure/settings.js";
import { buildSystemPrompt } from "../prompts.js";

// A conversation is created when its first message is submitted and saved by
// that message. One created but never prompted (its window went away first)
// is discarded once this old.
export const UNSAVED_LIMIT_SECONDS = 60;

export class SessionService {
  readonly sessionDir: string | null;
  readonly providerService: ProviderServiceImpl;
  readonly workspaceDefaults: WorkspaceDefaults;
  private drafts = new Map<string, JsonlSessionStore>();
  private created = new Map<string, number>();
  now: () => number = () => performance.now() / 1000;

  constructor(options: {
    sessionDir: string | null;
    providerService: ProviderServiceImpl;
    workspaceDefaults?: WorkspaceDefaults | null;
  }) {
    this.sessionDir = options.sessionDir;
    this.providerService = options.providerService;
    this.workspaceDefaults = options.workspaceDefaults ?? new WorkspaceDefaults();
  }

  draftStore(sessionId: string): JsonlSessionStore | null {
    this.releasePersistedDraft();
    return this.drafts.get(sessionId) ?? null;
  }

  releasePersistedDraft(): void {
    for (const [sid, store] of this.drafts.entries()) {
      if (store.is_persisted) {
        this.drafts.delete(sid);
        this.created.delete(sid);
      }
    }
  }

  discardUnsaved(sessionId: string): boolean {
    const clean = validateSessionId(sessionId);
    const store = this.draftStore(clean);
    if (store === null) {
      return false;
    }
    const sid = store.session_id ?? clean;
    this.drafts.delete(sid);
    this.created.delete(sid);
    store.mark_deleted();
    return true;
  }

  abandoned(): string[] {
    this.releasePersistedDraft();
    const cutoff = this.now() - UNSAVED_LIMIT_SECONDS;
    const result: string[] = [];
    for (const [sid, at] of this.created.entries()) {
      if (at < cutoff) {
        result.push(sid);
      }
    }
    return result;
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      JsonlSessionStore.load_session_metadata(validateSessionId(sessionId), this.sessionDir);
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "LookupError") {
        return false;
      }
      throw err;
    }
  }

  listingStore(workspaceRoot: string): JsonlSessionStore {
    return new JsonlSessionStore({
      sessionDir: this.sessionDir,
      workspaceRoot: validateWorkspaceRoot(workspaceRoot),
    });
  }

  folderSelection(workspaceRoot: string, options?: { own?: boolean }): FolderSelection {
    return this.workspaceDefaults.resolve(
      workspaceRoot,
      this.providerService.defaultSelection(),
      options,
    );
  }

  chooseSelection(
    workspaceRoot: string,
    provider = "",
    model = "",
    effort?: string | null,
  ): [ModelSelection, Record<string, string>] {
    const folder = this.folderSelection(workspaceRoot);
    const def = folder.selection;
    const selection: ModelSelection = {
      provider_id: provider || def.provider_id,
      model_id: model || def.model_id,
      reasoning_effort: effort === undefined || effort === null ? def.reasoning_effort : effort,
    };
    const sameModel =
      selection.provider_id === def.provider_id && selection.model_id === def.model_id;
    return [
      selection,
      {
        model: sameModel ? folder.model_source : "session",
        effort:
          selection.reasoning_effort === def.reasoning_effort ? folder.effort_source : "session",
      },
    ];
  }

  async blank(workspaceRoot: string): Promise<Record<string, unknown>> {
    const root = validateWorkspaceRoot(workspaceRoot);
    const selection = this.folderSelection(root).selection;
    const docPath = resolveProjectDocPath(root);
    let hasRindDoc = false;
    try {
      hasRindDoc = fs.existsSync(docPath) && fs.statSync(docPath).isFile();
    } catch {
      hasRindDoc = false;
    }
    return {
      session_id: "",
      model: selection.model_id,
      provider: selection.provider_id,
      reasoning_effort: selection.reasoning_effort,
      workspace_root: String(root),
      team_main: null,
      turn_state: null,
      goal: null,
      usage: null,
      message_count: 0,
      has_rind_doc: hasRindDoc,
    };
  }

  async metadata(sessionId: string): Promise<Record<string, unknown>> {
    const clean = validateSessionId(sessionId);
    const draft = this.draftStore(clean);
    if (draft !== null) {
      return await draft.get_metadata();
    }
    return JsonlSessionStore.load_session_metadata(clean, this.sessionDir);
  }

  async list(options?: {
    limit?: number;
    workspaceRoot?: string | null;
    excludeWorkspaceRoots?: readonly string[] | null;
    excludeSessionIds?: readonly string[] | null;
  }): Promise<Record<string, unknown>[]> {
    return JsonlSessionStore.list_session_metadata({
      sessionDir: this.sessionDir,
      limit: options?.limit ?? 20,
      workspaceRoot: options?.workspaceRoot ?? null,
      excludeWorkspaceRoots: options?.excludeWorkspaceRoots ?? null,
      excludeSessionIds: options?.excludeSessionIds ?? null,
    });
  }

  async listByWorkspace(options?: {
    limit?: number;
    perWorkspaceLimit?: number;
    excludeWorkspaceRoots?: readonly string[] | null;
    excludeSessionIds?: readonly string[] | null;
  }): Promise<[Record<string, unknown>[], { workspace_root: string; count: number }[]]> {
    return JsonlSessionStore.list_session_metadata_by_workspace({
      sessionDir: this.sessionDir,
      limit: options?.limit ?? 500,
      perWorkspaceLimit: options?.perWorkspaceLimit ?? 3,
      excludeWorkspaceRoots: options?.excludeWorkspaceRoots ?? null,
      excludeSessionIds: options?.excludeSessionIds ?? null,
    });
  }

  async delete(sessionId: string): Promise<Record<string, unknown>> {
    const clean = validateSessionId(sessionId);
    const meta = await this.metadata(clean);
    const draft = this.draftStore(clean);
    this.created.delete(clean);
    if (draft !== null) {
      this.drafts.delete(draft.session_id ?? clean);
      draft.mark_deleted();
    }
    const root = JsonlSessionStore.resolve_session_root(this.sessionDir);
    const base = resolveSessionBase(root, clean);
    if (fs.existsSync(base)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
    new SessionIndexRepository(
      new SessionFiles(),
      JsonlSessionStore.index_path_for(this.sessionDir),
    ).removeSession(clean);
    return {
      session_id: clean,
      workspace_root: String(meta.workspace_root || ""),
    };
  }

  async fork(sessionId: string, beforeMessageId?: string | null): Promise<Record<string, unknown>> {
    const clean = validateSessionId(sessionId);
    if (this.draftStore(clean) !== null) {
      throw new Error("Nothing to fork: the session has no user messages.");
    }
    const meta = JsonlSessionStore.load_session_metadata(clean, this.sessionDir);
    if (meta.session_type === "delegated_task") {
      throw new Error("Delegated task sessions cannot be forked.");
    }
    const newId = forkSession(this.sessionDir, clean, { beforeMessageId });
    return {
      session_id: newId,
      forked_from: clean,
    };
  }

  async create(
    workspaceRoot: string,
    options?: {
      projectId?: string | null;
      ownerAgentId?: string | null;
      sessionType?: string | null;
      parentSessionId?: string | null;
      selection?: ModelSelection | null;
      selectionSource?: Record<string, string> | null;
      deferPersistence?: boolean;
      sessionId?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const root = validateWorkspaceRoot(workspaceRoot);
    let selection = options?.selection ?? null;
    let selectionSource = options?.selectionSource ?? null;
    if (selection === null) {
      [selection, selectionSource] = this.chooseSelection(root);
    }
    const {
      model_id: model,
      reasoning_effort: reasoningEffort,
      provider_id: provider,
    } = selection;
    const systemPrompt = buildSystemPrompt({ environment: getSystemInfo(root) });
    const store = new JsonlSessionStore({
      sessionDir: this.sessionDir,
      sessionId: options?.sessionId || newSessionId(),
      model,
      systemPrompt,
      workspaceRoot: root,
      projectId: options?.projectId ?? null,
      ownerAgentId: options?.ownerAgentId ?? null,
      sessionType: options?.sessionType ?? null,
      parentSessionId: options?.parentSessionId ?? null,
      reasoningEffort,
      provider,
      selectionSource,
    });
    if (options?.deferPersistence) {
      await store.create_session({ sessionId: store.session_id });
      const sid = store.session_id!;
      this.drafts.set(sid, store);
      this.created.set(sid, this.now());
    } else {
      await store.initialize();
    }
    return {
      session_id: store.session_id,
      model: store.model,
      provider: store.provider,
      reasoning_effort: store.reasoning_effort,
      workspace_root: root,
      turn_state: null,
      team_main: null,
    };
  }

  async initial(
    workspaceRoot: string,
    sessionId?: string | null,
    resumeLatest = false,
  ): Promise<Record<string, unknown>> {
    if (sessionId) {
      return await this.info(sessionId);
    }
    if (resumeLatest) {
      const sessions = await this.list({ limit: 1, workspaceRoot });
      if (sessions.length === 0) {
        throw new Error("No existing session found to resume.");
      }
      return await this.info(String(sessions[0]!.id));
    }
    return await this.blank(workspaceRoot);
  }

  async info(sessionId: string): Promise<Record<string, unknown>> {
    const meta = await this.metadata(sessionId);
    const workspaceRoot = String(meta.workspace_root || meta.cwd || "");
    const def = this.providerService.defaultSelection();
    const isPlainObj = (v: unknown): v is Record<string, unknown> =>
      Boolean(v && typeof v === "object" && !Array.isArray(v));
    return {
      session_id: String(meta.session_id || sessionId),
      model: String(meta.model || def.model_id),
      provider: String(meta.provider || def.provider_id),
      reasoning_effort: String(meta.reasoning_effort || def.reasoning_effort),
      workspace_root: workspaceRoot,
      team_main: null,
      project_id: meta.project_id ?? null,
      owner_agent_id: meta.owner_agent_id ?? null,
      session_type: meta.session_type ?? null,
      parent_session_id: meta.parent_session_id ?? null,
      turn_state: isPlainObj(meta.turn_state) ? meta.turn_state : null,
      goal: isPlainObj(meta.goal) ? meta.goal : null,
      usage: isPlainObj(meta.latest_sampling_usage) ? meta.latest_sampling_usage : null,
      message_count: Number(meta.message_count || 0),
      title: displayTitle(meta),
      updated_at: String(meta.updated_at || ""),
    };
  }

  async replay(
    sessionId: string,
    options?: {
      start?: number | null;
      end?: number | null;
      tail?: number | null;
    },
  ): Promise<Record<string, unknown>> {
    const start = options?.start ?? null;
    const end = options?.end ?? null;
    const tail = options?.tail ?? null;
    const info = await this.info(sessionId);
    if (end === 0 && !tail) {
      return {
        messages: [],
        message_total: Number(info.message_count || 0),
        turn_state: info.turn_state || {},
        session_id: sessionId,
        model: String(info.model || ""),
      };
    }
    const store = await this.openStoreFromInfo(sessionId, info, {
      persistSystemPrompt: false,
    });
    let messages = await store.get_messages_slice({
      includeIds: true,
      compacted: false,
    });
    const total = messages.length;
    messages = messages.slice(start ?? undefined, end ?? undefined);
    if (tail !== null) {
      messages = messages.slice(Math.max(0, messages.length - tail));
    }
    return {
      messages,
      message_total: total,
      turn_state: await store.get_turn_state(),
      session_id: sessionId,
      model: store.model,
    };
  }

  async replayEventPages(sessionId: string): Promise<Record<string, unknown>> {
    const info = await this.info(sessionId);
    const store = await this.openStoreFromInfo(sessionId, info, {
      persistSystemPrompt: false,
    });
    return {
      messages: await store.get_messages_slice({ includeIds: true, compacted: false }),
      tool_records: await store.get_tool_records(),
      turn_state: await store.get_turn_state(),
      session_id: sessionId,
    };
  }

  async openStore(
    sessionId: string,
    workspaceRoot?: string | null,
    options?: { persistSystemPrompt?: boolean },
  ): Promise<JsonlSessionStore> {
    const clean = validateSessionId(sessionId);
    const info = await this.info(clean);
    return await this.openStoreFromInfo(clean, info, {
      workspaceRoot,
      persistSystemPrompt: options?.persistSystemPrompt ?? true,
    });
  }

  private async openStoreFromInfo(
    sessionId: string,
    info: Record<string, unknown>,
    options?: {
      workspaceRoot?: string | null;
      persistSystemPrompt?: boolean;
    },
  ): Promise<JsonlSessionStore> {
    const clean = validateSessionId(sessionId);
    const root = validateWorkspaceRoot(
      String(options?.workspaceRoot || info.workspace_root || ""),
    );
    const draft = this.draftStore(clean);
    if (draft !== null) {
      if (root !== draft.workspace_root) {
        throw new Error(
          "Session workspace_root is immutable and does not match the requested agent context.",
        );
      }
      return draft;
    }
    const store = new JsonlSessionStore({
      sessionDir: this.sessionDir,
      sessionId: clean,
      model: String(info.model || ""),
      provider: String(info.provider || "openai"),
      systemPrompt: buildSystemPrompt({ environment: getSystemInfo(root) }),
      workspaceRoot: root,
      reasoningEffort: String(info.reasoning_effort || ""),
      createMissing: false,
    });
    await store.initialize({ persistSystemPrompt: options?.persistSystemPrompt ?? true });
    return store;
  }

  async getGoal(sessionId: string): Promise<Record<string, string> | null> {
    const info = await this.info(sessionId);
    return (info.goal as Record<string, string> | null) ?? null;
  }

  async setGoal(sessionId: string, objective: string): Promise<Record<string, string>> {
    const store = await this.openStore(sessionId);
    return (await store.set_goal(objective)) as unknown as Record<string, string>;
  }

  async setGoalStatus(sessionId: string, status: string): Promise<Record<string, string>> {
    const store = await this.openStore(sessionId);
    return (await store.set_goal_status(status)) as unknown as Record<string, string>;
  }

  async clearGoal(sessionId: string): Promise<void> {
    const store = await this.openStore(sessionId);
    await store.clear_goal();
  }
}
