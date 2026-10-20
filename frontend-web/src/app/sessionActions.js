import { methods, sessionIdOf } from "../methods.js";
import { exportConversation, writePreference } from "../lib/sessionPreferences.js";
import { normalizePathKey } from "../lib/agentsModel.js";
import { normalizeModelList } from "../lib/models.js";
import { SESSION_LIMIT_MAX, SESSION_PAGE, errorText } from "./constants.js";
import { applyInteractions, rememberInteraction } from "../lib/sessionActivity.js";

// Session index, switching, subscriptions and per-session metadata (models,
// context). The server has no list offset: pagination steps `limit` (max 100).
export function createSessionActions(ctx) {
  const { refs, endpoint, coalescer, dispatchConversation } = ctx;
  const call = () => ctx.call.current;

  function resolveSelectedWorkspace(explicitWorkspace) {
    const hasHostWorkspaces = Array.isArray(refs.info.current?.workspaces);
    if (hasHostWorkspaces) {
      const hostWorkspaces = refs.info.current.workspaces;
      const candidate = String(
        explicitWorkspace ?? refs.workspace.current ?? ctx.selectedWorkspace ?? "",
      ).trim();
      const matched = candidate
        ? hostWorkspaces.find((w) => normalizePathKey(w) === normalizePathKey(candidate))
        : "";
      return matched || hostWorkspaces[0] || "";
    }
    return String(
      explicitWorkspace ??
        refs.workspace.current ??
        ctx.selectedWorkspace ??
        refs.info.current.workspace_root ??
        "",
    ).trim();
  }

  async function refreshSessions(workspace, { limit = ctx.sessionLimit } = {}) {
    const client = refs.client.current;
    if (!client) return;
    const targetWs = resolveSelectedWorkspace(workspace);
    const run = refs.connectionRun.current;
    const requestId = ++refs.listRequest.current;
    try {
      const params = targetWs ? { limit, workspace_root: targetWs } : { limit };
      const result = await client.request(methods.sessionList, params);
      if (run !== refs.connectionRun.current || requestId !== refs.listRequest.current) return;
      let resolvedWs = targetWs;
      if (Array.isArray(result?.workspaces)) {
        const nextWorkspaces = [...new Set(result.workspaces.map((w) => String(w || "").trim()).filter(Boolean))];
        ctx.setWorkspaces(nextWorkspaces);
        if (refs.info.current) {
          refs.info.current = { ...refs.info.current, workspaces: nextWorkspaces };
        }
        resolvedWs = resolveSelectedWorkspace(workspace);
        if (resolvedWs && resolvedWs !== targetWs) {
          refs.workspace.current = resolvedWs;
          ctx.setSelectedWorkspace(resolvedWs);
          ctx.setWorkspaceDraft(resolvedWs);
        }
      }
      const rawList = Array.isArray(result?.sessions) ? result.sessions : [];
      const targetKey = normalizePathKey(resolvedWs);
      const list = targetKey
        ? rawList.filter((s) => {
            const ws = String(s?.workspace_root || s?.workspaceRoot || "").trim();
            return !ws || normalizePathKey(ws) === targetKey;
          })
        : rawList;
      ctx.setSessions(applyInteractions(list, client.url || endpoint));
      ctx.setHasMoreSessions(rawList.length >= limit && limit < SESSION_LIMIT_MAX);
      void syncSubscriptions(list);
    } catch {
      // Session list refresh is advisory; keep the current list on failure.
    }
  }

  async function loadMoreSessions() {
    const next = Math.min(SESSION_LIMIT_MAX, ctx.sessionLimit + SESSION_PAGE);
    ctx.setSessionLimit(next);
    await refreshSessions(undefined, { limit: next });
  }

  // Listed sessions plus the current one are subscribed so unread dots and
  // running spinners are first-class.
  async function syncSubscriptions(list = ctx.sessions) {
    const client = refs.client.current;
    if (!client) return;
    const targets = new Set(list.map((session) => sessionIdOf(session)).filter(Boolean));
    const currentId = String(refs.info.current.session_id || "");
    if (currentId) targets.add(currentId);
    const run = refs.connectionRun.current;
    for (const id of [...refs.subscribed.current]) {
      if (run !== refs.connectionRun.current) return;
      if (targets.has(id)) continue;
      refs.subscribed.current.delete(id);
      try { await client.request(methods.sessionUnsubscribe, { session_id: id }); } catch { /* Advisory. */ }
    }
    for (const id of targets) {
      if (run !== refs.connectionRun.current) return;
      if (refs.subscribed.current.has(id)) continue;
      try {
        await client.request(methods.sessionSubscribe, { session_id: id });
        if (run === refs.connectionRun.current) refs.subscribed.current.add(id);
      } catch {
        // Subscriptions are advisory (unread dots); failures stay silent.
      }
    }
  }

  async function refreshModels(sessionId = ctx.info.session_id) {
    const loadId = refs.sessionLoad.current;
    const stale = () => loadId !== refs.sessionLoad.current || sessionId !== refs.info.current.session_id;
    try {
      const result = await refs.client.current.request(methods.modelList, sessionId ? { session_id: sessionId } : {});
      if (stale()) return;
      const listing = normalizeModelList(result);
      const nextModel = listing.current?.modelId
        || String(refs.info.current.model || refs.info.current.default_model || refs.currentModel.current || "").trim();
      const nextProvider = listing.current?.providerId || "";
      const models = listing.current && !listing.models.some((model) => model.providerId === listing.current.providerId && model.id === listing.current.modelId)
        ? [{ id: listing.current.modelId, providerId: nextProvider, contextWindow: null, imageInput: null }, ...listing.models]
        : listing.models;
      if (!sessionId) {
        ctx.setInfo((current) => ({ ...current, models }));
        return;
      }
      ctx.setCurrentModel(nextModel);
      ctx.setCurrentProvider(nextProvider);
      ctx.setInfo((current) => ({ ...current, models, model: nextModel || current.model }));
    } catch {
      if (stale()) return;
      const fallback = String(refs.info.current.model || refs.info.current.default_model || refs.currentModel.current || "").trim();
      ctx.setInfo((current) => ({ ...current, models: current.models?.length ? current.models : fallback ? [{ id: fallback, providerId: refs.currentProvider.current || "", contextWindow: null, imageInput: null }] : [] }));
    }
  }

  // Provider display names for the model picker (rind/auth/list). Read-only:
  // credentials stay managed on the host.
  async function refreshProviders() {
    if (!refs.info.current.methods?.includes?.(methods.authList)) return;
    try {
      const result = await refs.client.current.request(methods.authList, {});
      const names = {};
      for (const provider of Array.isArray(result?.providers) ? result.providers : []) {
        if (provider?.id) names[String(provider.id)] = String(provider?.name || "");
      }
      ctx.setProviderNames(names);
    } catch {
      // Names are cosmetic; the picker falls back to formatted provider ids.
    }
  }

  // rind/context/inspect feeds the Context tab and the composer meter. Only
  // requested when the runtime advertises it.
  async function refreshContext(sessionId = refs.info.current.session_id) {
    const client = refs.client.current;
    if (!client || !sessionId || !refs.info.current.methods?.includes?.(methods.contextInspect)) return;
    const requestId = ++refs.contextRequest.current;
    try {
      const result = await client.request(methods.contextInspect, { session_id: sessionId });
      if (requestId !== refs.contextRequest.current || sessionId !== refs.info.current.session_id) return;
      ctx.setContextSnapshot(result && typeof result === "object" ? result : null);
    } catch {
      if (requestId === refs.contextRequest.current) ctx.setContextSnapshot(null);
    }
  }

  function saveDraft(sessionId) {
    if (sessionId) refs.drafts.current = { ...refs.drafts.current, [sessionId]: refs.input.current };
  }

  async function replayWithRetry(client, target, loadId, externalTools = null) {
    const replayParams = externalTools
      ? { session_id: target, external_tools: externalTools }
      : { session_id: target };
    let replay = await client.request(methods.sessionReplay, replayParams);
    // A completed turn can overtake the history read. Read once more when a
    // durable boundary arrived during it; never append overlapping deltas.
    const overtaken = () => refs.loadingEvents.current.some((item) => item.session_id === target && item.durability === "durable" && item.event?.type !== "task_updated");
    for (let retry = 0; retry < 3 && overtaken(); retry++) {
      if (loadId !== refs.sessionLoad.current) return null;
      refs.loadingEvents.current = [];
      replay = await client.request(methods.sessionReplay, replayParams);
    }
    return replay;
  }

  async function loadSession(sessionId, switchSession = true, throwOnError = false, options = {}) {
    const target = String(sessionId || "").trim();
    const client = refs.client.current;
    if (!target || !client) return;
    const externalTools = options?.externalTools || null;
    const loadId = ++refs.sessionLoad.current;
    const previousId = refs.info.current.session_id;
    if (previousId && previousId !== target) saveDraft(previousId);
    coalescer.flush();
    refs.switching.current = true;
    refs.loadingEvents.current = [];
    call().clearUnread(target);
    ctx.setBusySession(true);
    try {
      const switchParams = externalTools
        ? { session_id: target, external_tools: externalTools }
        : { session_id: target };
      const switched = switchSession ? await client.request(methods.sessionSwitch, switchParams) : refs.info.current;
      if (loadId !== refs.sessionLoad.current) return;
      const replay = await replayWithRetry(client, target, loadId, externalTools);
      if (loadId !== refs.sessionLoad.current) return;
      const workspace = String(switched?.workspace_root || ctx.selectedWorkspace || "").trim();
      if (previousId && previousId !== target) saveDraft(previousId);
      const base = refs.info.current;
      const sessionModel = String(switched?.model || replay?.model || base.model || base.default_model || refs.currentModel.current || "").trim();
      const sessionEffort = String(switched?.reasoning_effort || replay?.reasoning_effort || base.reasoning_effort || "").trim();
      const sessionName = typeof switched?.name === "string" ? switched.name : (typeof replay?.name === "string" ? replay.name : "");
      const sessionTitleText = typeof switched?.title === "string" ? switched.title : (typeof replay?.title === "string" ? replay.title : "");
      ctx.setInfo((current) => ({
        ...current,
        ...(switched || {}),
        session_id: target,
        name: sessionName,
        title: sessionTitleText,
        workspace_root: workspace || current.workspace_root,
        model: sessionModel || current.model || current.default_model || "",
        reasoning_effort: sessionEffort || current.reasoning_effort || "",
      }));
      ctx.setCurrentModel(sessionModel);
      refs.info.current = {
        ...refs.info.current,
        ...switched,
        session_id: target,
        name: sessionName,
        title: sessionTitleText,
        workspace_root: workspace,
        model: sessionModel,
      };
      writePreference(`session:${client.url || endpoint}`, target);
      if (previousId !== target) ctx.setInput(refs.drafts.current[target] || "");
      void refreshModels(target);
      void refreshContext(target);
      const hasRegisteredList = Array.isArray(refs.info.current?.workspaces);
      const registeredList = hasRegisteredList ? refs.info.current.workspaces : ctx.workspaces;
      const canSelectWorkspace =
        !options?.preserveSelectedWorkspace &&
        Boolean(workspace) &&
        (!hasRegisteredList || registeredList.some((w) => normalizePathKey(w) === normalizePathKey(workspace)));
      if (canSelectWorkspace) {
        refs.workspace.current = workspace;
        ctx.setSelectedWorkspace(workspace);
        ctx.setWorkspaceDraft(workspace);
      }
      dispatchConversation({ kind: "history", messages: replay?.messages });
      dispatchConversation({ kind: "live_turn", liveTurn: replay?.live_turn || null, sessionId: target });
      ctx.setGoal(switched?.goal || null);
      ctx.setStats(switched?.usage || {});
      ctx.setContextInfo({ lastTurnDurationMs: 0, messageCount: replay?.messages?.length || 0 });
      call().clearUnread(target); // late events during the switch may have re-marked it
      void syncSubscriptions([...(refs.sessions.current || []), { id: target }]);
    } catch (error) {
      if (loadId !== refs.sessionLoad.current) return;
      if (throwOnError) throw error;
      call().dispatchMessage("system", `Unable to open session: ${errorText(error)}`, "error");
    } finally {
      if (loadId === refs.sessionLoad.current) {
        refs.switching.current = false;
        refs.loadingEvents.current = [];
        ctx.setBusySession(false);
      }
    }
  }

  function targetWorkspace() {
    return ctx.selectedWorkspace || refs.info.current.workspace_root;
  }

  async function createSession() {
    const run = refs.connectionRun.current;
    const loadId = refs.sessionLoad.current;
    try {
      const workspace = targetWorkspace();
      const result = await refs.client.current.request(methods.sessionNew, { workspace_root: workspace });
      if (run !== refs.connectionRun.current || loadId !== refs.sessionLoad.current) return;
      ctx.setSelectedWorkspace(workspace);
      await loadSession(result?.session_id, true);
      await refreshSessions(workspace);
      refs.composer.current?.focus();
    } catch (error) {
      call().dispatchMessage("system", `Unable to create session: ${errorText(error)}`, "error");
    }
  }

  async function selectWorkspace(path) {
    const workspace = typeof path === "string" ? path.trim() : ctx.workspaceDraft.trim();
    if (!workspace) {
      ctx.setWorkspaceMessage("Enter a workspace path.");
      return;
    }
    ctx.setWorkspaceBusy(true);
    const run = refs.connectionRun.current;
    const requestId = ++refs.listRequest.current;
    const limit = ctx.sessionLimit;
    ctx.setWorkspaceMessage("");
    try {
      const result = await refs.client.current.request(methods.sessionList, { limit, workspace_root: workspace });
      if (run !== refs.connectionRun.current || requestId !== refs.listRequest.current) return;
      const rawSessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const workspaceKey = normalizePathKey(workspace);
      const nextSessions = workspaceKey
        ? rawSessions.filter((s) => {
            const ws = String(s?.workspace_root || s?.workspaceRoot || "").trim();
            return !ws || normalizePathKey(ws) === workspaceKey;
          })
        : rawSessions;
      refs.workspace.current = workspace;
      ctx.setSelectedWorkspace(workspace);
      ctx.setWorkspaceDraft(workspace);
      if (Array.isArray(result?.workspaces)) {
        const nextWorkspaces = [...new Set(result.workspaces.map((w) => String(w || "").trim()).filter(Boolean))];
        ctx.setWorkspaces(nextWorkspaces);
        if (refs.info.current) {
          refs.info.current = { ...refs.info.current, workspaces: nextWorkspaces };
        }
      } else if (!Array.isArray(refs.info.current?.workspaces)) {
        ctx.setWorkspaces((current) => [...new Set([...current, workspace])]);
      }
      ctx.setSessions(applyInteractions(nextSessions, refs.client.current.url || endpoint));
      ctx.setHasMoreSessions(nextSessions.length >= limit && limit < SESSION_LIMIT_MAX);
      void syncSubscriptions(nextSessions);
      const currentId = sessionIdOf(ctx.info);
      const nextSession = nextSessions.find((session) => sessionIdOf(session) === currentId) || nextSessions[0];
      if (nextSession) {
        await loadSession(sessionIdOf(nextSession), true);
      } else {
        clearActiveSession(workspace);
        ctx.setStats({});
        ctx.setGoal(null);
        call().dispatchMessage("system", `No sessions in ${workspace}. Create a new session to begin.`);
      }
    } catch (error) {
      ctx.setWorkspaceMessage(errorText(error));
    } finally {
      ctx.setWorkspaceBusy(false);
    }
  }

  function clearActiveSession(workspace) {
    ++refs.sessionLoad.current;
    saveDraft(refs.info.current.session_id);
    refs.info.current = { ...refs.info.current, session_id: "", name: "", title: "", workspace_root: workspace };
    ctx.setInput("");
    ctx.setContextSnapshot(null);
    ctx.setInfo((current) => ({ ...current, session_id: "", name: "", title: "", turn_state: null, live_turn: null, workspace_root: workspace }));
    dispatchConversation({ kind: "reset" });
    void refreshModels("");
  }

  // Fork at a user message (before_message_id) or the whole session. The
  // runtime rejects assistant ids, so callers resolve the next user entry.
  async function forkSession(sessionId = refs.info.current.session_id, beforeMessageId = "") {
    const loadId = refs.sessionLoad.current;
    const params = beforeMessageId ? { session_id: sessionId, before_message_id: beforeMessageId } : { session_id: sessionId };
    try {
      const result = await refs.client.current.request(methods.sessionFork, params);
      if (loadId !== refs.sessionLoad.current) return;
      await loadSession(result?.session_id || result?.id, true);
      await refreshSessions();
      ctx.toast?.show("Forked into a new session.");
    } catch (error) {
      call().dispatchMessage("system", `Unable to fork: ${errorText(error)}`, "error");
    }
  }

  async function exportSession(sessionId = refs.info.current.session_id) {
    try {
      const result = await refs.client.current.request(methods.sessionReplay, { session_id: sessionId });
      const title = refs.sessions.current.find((item) => sessionIdOf(item) === sessionId)?.title || "Rind conversation";
      await (ctx.platform?.exportConversation || exportConversation)(result?.messages || [], title);
    } catch (error) {
      call().dispatchMessage("system", `Export failed: ${errorText(error)}`, "error");
    }
  }

  // Selecting a session closes a narrow drawer while the session loads.
  async function handleSelectSession(sessionId) {
    ctx.layout.closeDrawersSilently();
    await loadSession(sessionId, true);
    if (sessionId === refs.info.current.session_id) touchSession(sessionId);
  }

  function touchSession(sessionId) {
    const key = refs.client.current?.url || endpoint;
    rememberInteraction(key, sessionId);
    ctx.setSessions((sessions) => applyInteractions(sessions, key));
  }

  // Server errors (InvalidRequest for the current session, TurnActive,
  // SessionNotFound) propagate to the confirm dialog, which shows them inline.
  async function deleteSession(sessionId) {
    const client = refs.client.current;
    await client.request(methods.sessionDelete, { session_id: sessionId });
    ctx.setSessions((current) => current.filter((session) => sessionIdOf(session) !== sessionId));
    refs.subscribed.current.delete(sessionId);
    try {
      await client.request(methods.sessionUnsubscribe, { session_id: sessionId });
    } catch {
      // Unsubscribe is advisory; the deleted id is already dropped locally.
    }
  }

  return {
    refreshSessions, loadMoreSessions, syncSubscriptions, refreshModels, refreshProviders, refreshContext, loadSession, touchSession,
    createSession, selectWorkspace, clearActiveSession, forkSession, exportSession, handleSelectSession, deleteSession,
  };
}
