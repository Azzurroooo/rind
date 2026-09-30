import { methods, sessionIdOf } from "../methods.js";
import { isAuthError } from "../runtimeClient.js";
import { finalAssistantText, showNotification, truncateFirstLine } from "../lib/notifications.js";
import { readPreference } from "../lib/sessionPreferences.js";
import { dropCredentials, fetchTicket, loginErrorMessage, readStoredTicket, readStoredToken, storeToken, unauthorizedMessage } from "../ticket.js";
import { SESSION_LIMIT_MAX, errorText } from "./constants.js";

// Connection lifecycle: credentials, open/status handling, the initialize
// bootstrap and the event intake. Cross-module calls go through ctx.call so
// every module always sees the latest render's closures.
export function createConnectionActions(ctx) {
  const { refs, endpoint, coalescer, controller, dispatchConnection, dispatchConversation } = ctx;
  const call = () => ctx.call.current;

  function handleEvent(message) {
    const event = message?.event;
    if (!event || typeof event !== "object") return;
    const envelopeSession = String(message.session_id || event.session_id || "");
    const currentSession = String(refs.info.current.session_id || "");
    call().trackRunning(envelopeSession || currentSession, event.type, message.turn_id || event.turn_id);
    if (event.type === "turn_started" || event.type === "queued_input_delivered") call().touchSession(envelopeSession || currentSession);
    if (refs.switching.current) { refs.loadingEvents.current.push(message); return; }
    // Events from other sessions never enter this conversation: a durable
    // event lights the unread dot instead; replay rebuilds it on open.
    if (envelopeSession && currentSession && envelopeSession !== currentSession) {
      if (String(message.durability) === "durable") call().markUnread(envelopeSession);
      return;
    }
    if (event.type === "goal_updated") ctx.setGoal(event.goal || null);
    if (event.type === "context_built" || event.type === "token_stats_updated") {
      if (event.type === "context_built") {
        const count = Number(event.message_count || 0);
        if (count > 0) ctx.setContextInfo((current) => ({ ...current, messageCount: count }));
      }
      ctx.setStats(event.stats && typeof event.stats === "object" ? event.stats : {});
      return;
    }
    if (event.type === "turn_completed") {
      const duration = Number(event.duration_ms || 0);
      if (duration > 0) ctx.setContextInfo((current) => ({ ...current, lastTurnDurationMs: duration }));
      // Only when the tab is hidden AND permission was granted explicitly.
      showNotification({ title: "Rind reply ready", body: truncateFirstLine(finalAssistantText(refs.conv.current)) });
      // A brand-new session lands in the index after its first turn.
      void call().refreshSessions(refs.workspace.current || refs.info.current.workspace_root);
      void call().refreshContext();
    }
    if (event.type === "context_compacted") void call().refreshContext();
    coalescer.push(message);
  }

  function ticketEndpoint(url = refs.client.current?.url || endpoint) {
    const address = new URL(url, window.location.href);
    address.protocol = address.protocol === "wss:" ? "https:" : "http:";
    address.pathname = "/ticket"; address.search = ""; address.hash = "";
    return address.href;
  }

  async function acquireCredential(url) {
    const token = readStoredToken(url || refs.client.current?.url || endpoint);
    if (token) {
      // Tickets are one-time: mint a fresh one for every (re)connect.
      const ticket = await fetchTicket(token, { endpoint: ticketEndpoint(url) });
      return `ticket=${encodeURIComponent(ticket)}`;
    }
    const stored = readStoredTicket(url || refs.client.current?.url || endpoint);
    if (stored) return `ticket=${encodeURIComponent(stored)}`;
    const error = new Error("credentials required");
    error.code = "auth_required";
    throw error;
  }

  function handleStatus(status) {
    if (["connecting", "disconnected", "unauthorized"].includes(status?.state)) {
      refs.compactions.current.clear();
      ctx.setCompacting("");
      ++refs.connectionRun.current;
      ++refs.sessionLoad.current;
    }
    if (status?.state === "unauthorized") {
      dropCredentials();
      ctx.setLoginToken("");
      refs.client.current?.disconnect();
      dispatchConnection({ type: "unauthorized", message: unauthorizedMessage() });
      return;
    }
    controller.handleStatus(status);
  }

  async function handleOpen() {
    const run = refs.connectionRun.current;
    refs.subscribed.current.clear();
    await initializeRuntime();
    if (run === refs.connectionRun.current) dispatchConnection({ type: "sync_complete" });
  }

  async function handleLogin(token) {
    if (ctx.authBusy) return;
    ctx.setAuthBusy(true);
    ctx.setLoginToken(token);
    try {
      storeToken(token, refs.client.current?.url || endpoint);
      dispatchConnection({ type: "submit_credentials" });
      await refs.client.current.connect();
    } catch (error) {
      if (isAuthError(error)) dropCredentials();
      dispatchConnection({ type: "unauthorized", message: loginErrorMessage(error) });
    } finally {
      ctx.setAuthBusy(false);
    }
  }

  function logout() {
    ++refs.connectionRun.current;
    ++refs.listRequest.current;
    ++refs.sessionLoad.current;
    coalescer.flush();
    refs.switching.current = false;
    refs.loadingEvents.current = [];
    refs.drafts.current = {};
    ctx.setInput("");
    ctx.setCurrentModel("");
    dropCredentials();
    ctx.setLoginToken("");
    refs.client.current.disconnect();
    dispatchConnection({ type: "sign_out" });
    ctx.setInfo({});
    refs.info.current = {};
    dispatchConversation({ kind: "reset" });
    ctx.setSessions([]); ctx.setGoal(null); ctx.setStats({}); ctx.setBusySession(false); ctx.setCompacting(false);
    ctx.setContextSnapshot(null);
  }

  function reconnect() {
    if (ctx.connection.phase === "login") return;
    dispatchConnection({ type: "retry" });
    refs.client.current.setUrl(endpoint);
    refs.client.current.connect().catch(() => {});
  }

  function restoreTasks(tasks, sessionId) {
    for (const task of tasks || []) {
      dispatchConversation({ kind: "event", session_id: sessionId, turn_id: "", event: { type: "task_updated", task } });
    }
  }

  async function initializeRuntime() {
    const run = refs.connectionRun.current;
    try {
      const client = refs.client.current;
      const previous = refs.info.current.session_id || readPreference(`session:${client.url || endpoint}`);
      if (previous) refs.drafts.current = { ...refs.drafts.current, [previous]: refs.input.current };
      const result = await client.request(methods.initialize);
      if (run !== refs.connectionRun.current) return;
      refs.startupWorkspace.current = String(result?.workspace_root || "");
      // Keep the viewed id until loadSession commits its snapshot, so a
      // reconnect never files this draft under the worker's startup session.
      refs.info.current = { ...refs.info.current, ...result, session_id: previous || result?.session_id };
      ctx.setInfo((current) => ({
        ...current,
        ...(result || {}),
        session_id: previous || result?.session_id,
        model: result?.model || current.model || "",
        reasoning_effort: result?.reasoning_effort || current.reasoning_effort || "",
      }));
      ctx.setCurrentModel(String(result?.model || result?.current_model || "").trim());
      ctx.setStats(result?.usage || {});
      ctx.setGoal(result?.goal || null);
      const currentId = sessionIdOf(result);
      const workspace = String(result?.workspace_root || "").trim();
      ctx.setSelectedWorkspace(workspace);
      ctx.setWorkspaceDraft(workspace);
      if (previous && previous !== currentId) {
        try { await call().loadSession(previous, true, true); }
        catch (error) { if (error.type === "SessionNotFound" && currentId) await call().loadSession(currentId, true, true); else throw error; }
      } else if (currentId) await call().loadSession(currentId, true, true);
      if (run !== refs.connectionRun.current) return;
      await call().refreshSessions(refs.info.current.workspace_root || workspace);
      if (run !== refs.connectionRun.current) return;
      const allSessions = await client.request(methods.sessionList, { limit: SESSION_LIMIT_MAX });
      if (run === refs.connectionRun.current) {
        const roots = (allSessions?.sessions || []).map((session) => session.workspace_root);
        ctx.setWorkspaces([...new Set([workspace, refs.info.current.workspace_root, ...roots].filter(Boolean))]);
      }
      void call().refreshModels(refs.info.current.session_id);
      void call().refreshProviders();
    } catch (error) {
      if (run === refs.connectionRun.current) call().dispatchMessage("system", errorText(error), "error");
      throw error;
    }
  }

  return { handleEvent, acquireCredential, handleStatus, handleOpen, handleLogin, logout, reconnect, restoreTasks, initializeRuntime };
}
