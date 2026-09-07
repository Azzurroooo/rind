import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Menu, PanelRight } from "lucide-react";
import { ConnectionBar } from "./components/ConnectionBar.jsx";
import { Composer } from "./components/Composer.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { LoginGate } from "./components/LoginGate.jsx";
import { SessionRail } from "./components/SessionRail.jsx";
import { methods, parseSlashCommand, sessionIdOf } from "./methods.js";
import { createRuntimeClient, initialRuntimeUrl, isAuthError } from "./runtimeClient.js";
import { currentNotificationPermission, finalAssistantText, requestNotificationPermission, showNotification, truncateFirstLine } from "./lib/notifications.js";
import { fileToBase64, uploadTargetPath } from "./lib/files.js";
import { createConnectionController, initialConnectionState, reduceConnection } from "./state/connection.js";
import { conversationView, emptyConversationState, questionKey, reduceConversation } from "./state/conversationReducer.js";
import { dropCredentials, fetchTicket, hasStoredCredential, loginErrorMessage, readStoredTicket, readStoredToken, storeTicket, storeToken, unauthorizedMessage } from "./ticket.js";

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CATCH_UP_CHUNK = 50;
// ≤900px the three desktop columns collapse into one; SessionRail and
// Inspector become edge slide-out drawers (master plan §6.2 移动端).
const NARROW_QUERY = "(max-width: 900px)";

function readNarrowViewport() {
  try {
    return Boolean(window.matchMedia?.(NARROW_QUERY)?.matches);
  } catch {
    return false;
  }
}

export default function App() {
  const [endpoint, setEndpoint] = useState(initialRuntimeUrl);
  const [connection, dispatchConnection] = useReducer(reduceConnection, undefined, () => initialConnectionState({ authenticated: hasStoredCredential() }));
  const [conversation, dispatchConversation] = useReducer(reduceConversation, undefined, emptyConversationState);
  const [authBusy, setAuthBusy] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [info, setInfo] = useState({});
  const [sessions, setSessions] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [input, setInput] = useState("");
  const [stats, setStats] = useState({});
  const [goal, setGoal] = useState(null);
  const [currentModel, setCurrentModel] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [busySession, setBusySession] = useState(false);
  const [unreadIds, setUnreadIds] = useState(() => new Set());
  const [notificationPermission, setNotificationPermission] = useState(() => currentNotificationPermission());
  const [narrow, setNarrow] = useState(readNarrowViewport);
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const railPanelRef = useRef(null);
  const inspectorPanelRef = useRef(null);
  const railToggleRef = useRef(null);
  const inspectorToggleRef = useRef(null);
  const bootstrappedRef = useRef(false);
  const catchUpRef = useRef(false);
  const initializingRef = useRef(false);
  const workspaceRef = useRef("");
  const infoRef = useRef({});
  const currentModelRef = useRef("");
  const convRef = useRef(conversation);
  const clientRef = useRef(null);
  workspaceRef.current = selectedWorkspace;
  infoRef.current = info;
  currentModelRef.current = currentModel;
  convRef.current = conversation;

  const controller = useMemo(() => createConnectionController({ dispatch: dispatchConnection }), []);

  const dispatchMessage = useCallback((role, content, tone = "") => {
    dispatchConversation({ kind: "message", role, content, tone });
  }, []);

  const markUnread = useCallback((sessionId) => {
    setUnreadIds((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }, []);

  const clearUnread = useCallback((sessionId) => {
    setUnreadIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const enableNotifications = useCallback(async () => {
    const result = await requestNotificationPermission();
    setNotificationPermission(result);
  }, []);

  const expireQuestion = useCallback((key) => {
    dispatchConversation({ kind: "question_expired", key: String(key || "") });
  }, []);

  // ---- mobile drawers (master plan §6.2) ----
  // The two drawers are exclusive; toggles exist only in the narrow header
  // row (CSS), and on desktop an open flag would be meaningless — so opening
  // is a no-op above the breakpoint, and leaving the breakpoint clears it.
  const openDrawer = useCallback((name) => {
    if (!narrow) return;
    setRailOpen(name === "rail");
    setInspectorOpen(name === "inspector");
  }, [narrow]);

  const closeDrawers = useCallback(() => {
    setRailOpen(false);
    setInspectorOpen(false);
    const opener = railOpen ? railToggleRef.current : inspectorOpen ? inspectorToggleRef.current : null;
    opener?.focus(); // Esc / backdrop always hand focus back to the toggle
  }, [railOpen, inspectorOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(NARROW_QUERY);
    if (!media) return undefined;
    const apply = (event) => {
      const nextNarrow = Boolean(event?.matches);
      setNarrow(nextNarrow);
      if (!nextNarrow) {
        setRailOpen(false);
        setInspectorOpen(false);
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  // Focus moves into the drawer when it opens; the panel itself is not a
  // dialog (nothing modal here), it just receives the reading focus.
  useEffect(() => {
    if (!narrow) return;
    if (railOpen) railPanelRef.current?.focus();
    else if (inspectorOpen) inspectorPanelRef.current?.focus();
  }, [narrow, railOpen, inspectorOpen]);

  useEffect(() => {
    if (!narrow || (!railOpen && !inspectorOpen)) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDrawers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, railOpen, inspectorOpen, closeDrawers]);

  const handleEvent = useCallback((message) => {
    const event = message?.event;
    if (!event || typeof event !== "object") return;
    if (event.type === "context_built" || event.type === "token_stats_updated") {
      setStats(event.stats && typeof event.stats === "object" ? event.stats : {});
      return;
    }
    // Events from other sessions never enter this conversation (J7): a durable
    // event lights the unread dot instead; the catch-up replay rebuilds the
    // stream when that session is opened.
    const envelopeSession = String(message.session_id || event.session_id || "");
    const currentSession = String(infoRef.current.session_id || "");
    if (envelopeSession && currentSession && envelopeSession !== currentSession) {
      if (String(message.durability) === "durable") markUnread(envelopeSession);
      return;
    }
    // Browser notifications: only when the tab is hidden AND permission was
    // granted via the rail footer button (never a load-time prompt).
    if (event.type === "turn_completed") {
      showNotification({ title: "Rind 回复完成", body: truncateFirstLine(finalAssistantText(convRef.current)) });
    }
    if (event.type === "user_question_requested") {
      showNotification({ title: "Rind 需要你的输入", body: truncateFirstLine(event.question) });
    }
    dispatchConversation(message);
  }, [markUnread]);

  const client = useMemo(() => createRuntimeClient({
    url: endpoint,
    credentialProvider: acquireCredential,
    onEvent: handleEvent,
    onStatus: handleStatus,
    onOpen: handleOpen,
  }), []);
  clientRef.current = client;

  useEffect(() => {
    if (!hasStoredCredential()) return undefined;
    client.connect().catch(() => {
      // Statuses carry the outcome; auth failures route back to the login card.
    });
    return () => client.disconnect();
  }, [client]);

  async function acquireCredential() {
    const token = readStoredToken();
    if (token) {
      // Tickets are one-time: mint a fresh one for every (re)connect.
      const ticket = await fetchTicket(token);
      storeTicket(ticket);
      return `ticket=${encodeURIComponent(ticket)}`;
    }
    const stored = readStoredTicket();
    if (stored) return `ticket=${encodeURIComponent(stored)}`;
    const error = new Error("credentials required");
    error.code = "auth_required";
    throw error;
  }

  function handleStatus(status) {
    if (status?.state === "unauthorized") {
      dropCredentials();
      setLoginToken("");
      clientRef.current?.disconnect();
      dispatchConnection({ type: "unauthorized", message: unauthorizedMessage() });
      return;
    }
    controller.handleStatus(status);
  }

  async function handleOpen() {
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      try {
        await initializeRuntime();
      } finally {
        dispatchConnection({ type: "socket_open" });
      }
      return;
    }
    await runCatchUp();
  }

  async function handleLogin(token) {
    if (authBusy) return;
    setAuthBusy(true);
    setLoginToken(token);
    try {
      const ticket = await fetchTicket(token);
      storeToken(token);
      storeTicket(ticket);
      bootstrappedRef.current = false;
      dispatchConnection({ type: "submit_credentials" });
      await clientRef.current.connect();
    } catch (error) {
      if (isAuthError(error)) dropCredentials();
      dispatchConnection({ type: "unauthorized", message: loginErrorMessage(error) });
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    dropCredentials();
    setLoginToken("");
    clientRef.current.disconnect();
    dispatchConnection({ type: "sign_out" });
  }

  function reconnect() {
    if (connection.phase === "login") return;
    dispatchConnection({ type: "retry" });
    clientRef.current.setUrl(endpoint);
    clientRef.current.connect().catch(() => {});
  }

  async function runCatchUp() {
    if (catchUpRef.current) return;
    catchUpRef.current = true;
    try {
      const sessionId = sessionIdOf(infoRef.current);
      if (!sessionId) return; // nothing selected yet → nothing to catch up
      const cursor = Math.max(0, Number(convRef.current.cursor) || 0);
      const result = await requestCatchUp(sessionId, cursor);
      const events = Array.isArray(result?.events) ? result.events : [];
      dispatchConnection({ type: "sync_start", total: events.length });
      await applyCatchUpEvents(events);
      const serverCursor = Number(result?.cursor);
      dispatchConversation({ kind: "set_cursor", cursor: Number.isFinite(serverCursor) && serverCursor >= 0 ? serverCursor : cursor });
      void refreshSessions(workspaceRef.current || infoRef.current.workspace_root);
    } catch {
      // Both catch-up attempts failed; stay quiet — the next reconnect heals the gap.
    } finally {
      dispatchConnection({ type: "sync_complete" });
      catchUpRef.current = false;
    }
  }

  async function requestCatchUp(sessionId, cursor, attempts = 2) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await clientRef.current.request(methods.sessionReplay, { session_id: sessionId, after_cursor: cursor });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }
    throw lastError;
  }

  async function applyCatchUpEvents(events) {
    for (let index = 0; index < events.length; index += CATCH_UP_CHUNK) {
      const batch = events.slice(index, index + CATCH_UP_CHUNK);
      for (const envelope of batch) dispatchConversation(envelope);
      dispatchConnection({ type: "sync_progress", applied: batch.length });
      if (index + CATCH_UP_CHUNK < events.length) await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  async function initializeRuntime() {
    if (initializingRef.current) return;
    initializingRef.current = true;
    try {
      const result = await clientRef.current.request(methods.initialize);
      setInfo((current) => ({
        ...current,
        ...(result || {}),
        model: result?.model || current.model || "",
        reasoning_effort: result?.reasoning_effort || current.reasoning_effort || "",
      }));
      setCurrentModel(String(result?.model || result?.current_model || "").trim());
      setStats(result?.usage || {});
      setGoal(result?.goal || null);
      const currentId = sessionIdOf(result);
      const workspace = String(result?.workspace_root || "").trim();
      setSelectedWorkspace(workspace);
      setWorkspaceDraft(workspace);
      if (currentId) await loadSession(currentId, false);
      await refreshSessions(workspace);
      void refreshModels(currentId);
    } catch (error) {
      dispatchMessage("system", error instanceof Error ? error.message : String(error), "error");
    } finally {
      initializingRef.current = false;
    }
  }

  async function refreshSessions(workspace = selectedWorkspace || info.workspace_root) {
    if (!clientRef.current) return;
    try {
      const params = { limit: 30 };
      if (workspace) params.workspace_root = workspace;
      const result = await clientRef.current.request(methods.sessionList, params);
      setSessions(Array.isArray(result?.sessions) ? result.sessions : []);
    } catch {
      // Session list refresh is advisory; keep the current list on failure.
    }
  }

  async function refreshModels(sessionId = info.session_id) {
    try {
      const result = await clientRef.current.request(methods.modelList, { session_id: sessionId });
      const nextCurrentModel = String(result?.current_model || infoRef.current.model || infoRef.current.default_model || currentModelRef.current || "").trim();
      const values = [nextCurrentModel, ...(Array.isArray(result?.models) ? result.models : [])].filter(Boolean);
      setCurrentModel(nextCurrentModel);
      setInfo((current) => ({ ...current, models: [...new Set(values)], model: nextCurrentModel || current.model }));
    } catch {
      const fallback = String(infoRef.current.model || infoRef.current.default_model || currentModelRef.current || "").trim();
      setInfo((current) => ({ ...current, models: fallback ? [fallback] : [] }));
    }
  }

  async function loadSession(sessionId, switchSession = true) {
    const target = String(sessionId || "").trim();
    if (!target || !clientRef.current) return;
    clearUnread(target);
    setBusySession(true);
    try {
      const switched = switchSession ? await clientRef.current.request(methods.sessionSwitch, { session_id: target }) : infoRef.current;
      const replay = await clientRef.current.request(methods.sessionReplay, { session_id: target });
      const workspace = String(switched?.workspace_root || selectedWorkspace || "").trim();
      const sessionModel = String(switched?.model || replay?.model || infoRef.current.model || infoRef.current.default_model || currentModelRef.current || "").trim();
      const sessionEffort = String(switched?.reasoning_effort || replay?.reasoning_effort || infoRef.current.reasoning_effort || "").trim();
      setInfo((current) => ({
        ...current,
        ...(switched || {}),
        session_id: target,
        workspace_root: workspace || current.workspace_root,
        model: sessionModel || current.model || current.default_model || "",
        reasoning_effort: sessionEffort || current.reasoning_effort || "",
      }));
      setCurrentModel(sessionModel);
      void refreshModels(target);
      if (workspace) {
        setSelectedWorkspace(workspace);
        setWorkspaceDraft(workspace);
      }
      dispatchConversation({ kind: "history", messages: replay?.messages });
      dispatchConversation({ kind: "live_turn", liveTurn: replay?.live_turn || null, sessionId: target });
      setGoal(switched?.goal || null);
      setStats(switched?.usage || {});
      clearUnread(target); // late events during the switch may have re-marked it
    } catch (error) {
      dispatchMessage("system", `Unable to open session: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusySession(false);
    }
  }

  async function createSession() {
    try {
      const workspace = workspaceDraft.trim() || selectedWorkspace || info.workspace_root;
      const result = await clientRef.current.request(methods.sessionNew, { workspace_root: workspace });
      setSelectedWorkspace(workspace);
      await refreshSessions(workspace);
      await loadSession(result?.session_id, true);
    } catch (error) {
      dispatchMessage("system", `Unable to create session: ${error.message}`, "error");
    }
  }

  async function selectWorkspace() {
    const workspace = workspaceDraft.trim();
    if (!workspace) {
      setWorkspaceMessage("Enter a workspace path.");
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceMessage("");
    try {
      const result = await clientRef.current.request(methods.sessionList, { limit: 30, workspace_root: workspace });
      const nextSessions = Array.isArray(result?.sessions) ? result.sessions : [];
      setSelectedWorkspace(workspace);
      setSessions(nextSessions);
      const currentId = sessionIdOf(info);
      const nextSession = nextSessions.find((session) => sessionIdOf(session) === currentId) || nextSessions[0];
      if (nextSession) {
        await loadSession(sessionIdOf(nextSession), true);
      } else {
        clearActiveSession(workspace);
        setStats({});
        setGoal(null);
        dispatchMessage("system", `No sessions in ${workspace}. Create a new session to begin.`);
      }
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  function clearActiveSession(workspace) {
    setInfo((current) => ({
      ...current,
      session_id: "",
      turn_state: null,
      live_turn: null,
      workspace_root: workspace,
      model: current.model,
    }));
    dispatchConversation({ kind: "reset" });
  }

  // `composed` arrives from the Composer and already carries attachment path
  // reference lines (web-ui.md §2.4); direct calls fall back to the draft.
  async function submit(composed) {
    const text = String(composed ?? input).trim();
    if (!text || !clientRef.current) return;
    setInput("");
    if (text.startsWith("/")) {
      await runSlashCommand(text);
      return;
    }
    if (convRef.current.active) {
      try {
        await clientRef.current.request(methods.sessionSteer, { session_id: info.session_id, turn_id: convRef.current.activeTurnId, input: text });
        dispatchMessage("system", `Steering input queued: ${text}`);
      } catch (error) {
        dispatchMessage("system", `Unable to steer turn: ${error.message}`, "error");
      }
      return;
    }
    dispatchMessage("user", text);
    try {
      await clientRef.current.request(methods.sessionPrompt, { session_id: info.session_id, input: text });
    } catch (error) {
      dispatchMessage("system", `Prompt failed: ${error.message}`, "error");
    }
  }

  async function runSlashCommand(text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) return;
    const argument = parsed.argument;
    try {
      if (parsed.name === "compact" && !argument) {
        await compact();
        return;
      }
      if (parsed.name === "sessions") {
        await refreshSessions();
        dispatchMessage("system", "Session list refreshed.");
        return;
      }
      if (parsed.name === "model" && argument.toLowerCase().startsWith("set ")) {
        await setModel(argument.slice(4).trim());
        return;
      }
      if (parsed.name === "effort" && argument) {
        await setEffort(argument);
        return;
      }
      if (parsed.name === "goal") {
        await runGoalCommand(argument);
        return;
      }
      const result = await clientRef.current.request(methods.commandExecute, { session_id: info.session_id, input: text });
      dispatchMessage("system", result?.text || formatResult(result));
    } catch (error) {
      dispatchMessage("system", `Command failed: ${error.message}`, "error");
    }
  }

  async function runGoalCommand(argument) {
    const action = argument.trim().toLowerCase();
    if (!action) {
      const result = await clientRef.current.request(methods.goalGet, { session_id: info.session_id });
      setGoal(result?.goal || null);
      dispatchMessage("system", result?.goal?.objective ? `Active goal: ${result.goal.objective}` : "No active goal.");
      return;
    }
    if (action === "clear") {
      await clientRef.current.request(methods.goalClear, { session_id: info.session_id });
      setGoal(null);
      dispatchMessage("system", "Goal cleared.");
      return;
    }
    if (action === "pause" || action === "resume") {
      const result = await clientRef.current.request(methods.goalStatus, { session_id: info.session_id, status: action === "resume" ? "active" : "paused" });
      setGoal(result?.goal || null);
      dispatchMessage("system", `Goal ${action}d.`);
      return;
    }
    const result = await clientRef.current.request(methods.goalSet, { session_id: info.session_id, objective: argument });
    setGoal(result?.goal || null);
    dispatchMessage("system", `Goal set: ${argument}`);
  }

  async function setModel(model) {
    const clean = String(model || "").trim();
    if (!clean) return;
    const result = await clientRef.current.request(methods.modelSet, { session_id: info.session_id, model: clean });
    const next = String(result?.session_model || result?.model || clean).trim();
    setCurrentModel(next);
    setInfo((current) => ({ ...current, model: next }));
    dispatchMessage("system", `Model updated to ${next}.`);
  }

  async function setEffort(effort) {
    const clean = String(effort || "").trim().toLowerCase();
    if (!REASONING_EFFORTS.includes(clean)) return;
    const result = await clientRef.current.request(methods.modelEffort, { session_id: info.session_id, reasoning_effort: clean });
    const next = String(result?.reasoning_effort || clean).trim();
    setInfo((current) => ({ ...current, reasoning_effort: next }));
    dispatchMessage("system", `Reasoning effort set to ${next}.`);
  }

  async function compact() {
    if (compacting || convRef.current.active) {
      dispatchMessage("system", convRef.current.active ? "Finish or stop the active turn before compacting." : "Compaction is already running.");
      return;
    }
    setCompacting(true);
    try {
      const result = await clientRef.current.request(methods.sessionCompact, { session_id: info.session_id });
      dispatchMessage("system", `Context compacted${result?.source ? ` · messages ${result.source.message_start_index ?? "?"}-${result.source.message_end_index_exclusive ?? "?"}` : ""}.`);
    } catch (error) {
      dispatchMessage("system", `Compaction failed: ${error.message}`, "error");
    } finally {
      setCompacting(false);
    }
  }

  async function cancelTurn() {
    try {
      await clientRef.current.request(methods.sessionCancel, { session_id: info.session_id, ...(convRef.current.activeTurnId ? { turn_id: convRef.current.activeTurnId } : {}) });
    } catch (error) {
      dispatchMessage("system", error.message, "error");
    }
  }

  // Selecting a session is the rail drawer's route-relevant action: the
  // drawer slides away while the session loads — no modal, no draft reset.
  async function handleSelectSession(sessionId) {
    if (narrow) {
      setRailOpen(false);
      setInspectorOpen(false);
    }
    await loadSession(sessionId, true);
  }

  // Inline delete from the SessionRail (verification J7). Server errors
  // (InvalidRequest for the current session, TurnActive, SessionNotFound)
  // bubble to the rail and render inline next to the item.
  async function deleteSession(sessionId) {
    await clientRef.current.request(methods.sessionDelete, { session_id: sessionId });
    setSessions((current) => current.filter((session) => sessionIdOf(session) !== sessionId));
  }

  // Attachment upload path (web-ui.md §2.4): base64 → file/write into the
  // uploads/ subtree; resolves with the stored path for the chip.
  async function uploadAttachment(file) {
    const content_base64 = await fileToBase64(file);
    const path = uploadTargetPath(file?.name || "pasted-image", new Date());
    const result = await clientRef.current?.request(methods.fileWrite, { path, content_base64 });
    return String(result?.path || path);
  }

  const listFiles = useCallback((path) => clientRef.current.request(methods.fileList, { path: path || "" }), []);
  const readFile = useCallback((path) => clientRef.current.request(methods.fileRead, { path }), []);

  async function answerQuestion(question, answer) {
    if (!question || question.status !== "pending") return false;
    const text = String(answer || "").trim();
    try {
      await clientRef.current.request(methods.userQuestionRespond, {
        session_id: question.sessionId || info.session_id,
        tool_call_id: question.toolCallId,
        answer: text,
      }, 15_000);
      dispatchConversation({ kind: "answered", key: questionKey(question), answer: text });
      return true;
    } catch (error) {
      dispatchMessage("system", `Question response failed: ${error.message}`, "error");
      return false;
    }
  }

  const view = conversationView(conversation);
  const inspectorConnection = connection.phase === "online" || connection.phase === "syncing" ? "connected" : "offline";
  // Off-canvas panels are hidden from AT and untabbable only below the
  // breakpoint; on desktop the columns are plain always-visible panels.
  const railHidden = narrow && !railOpen;
  const inspectorHidden = narrow && !inspectorOpen;
  const railPanelAttrs = {
    id: "session-rail-panel",
    className: narrow ? (railOpen ? "drawer-open" : "drawer-closed") : "",
    "aria-hidden": railHidden || undefined,
    inert: railHidden ? "" : undefined,
  };
  const inspectorPanelAttrs = {
    id: "inspector-panel",
    className: narrow ? (inspectorOpen ? "drawer-open" : "drawer-closed") : "",
    "aria-hidden": inspectorHidden || undefined,
    inert: inspectorHidden ? "" : undefined,
  };

  if (connection.phase === "login") {
    return <LoginGate onSubmit={handleLogin} busy={authBusy} error={connection.message} initialToken={loginToken} />;
  }

  return <div className="app-shell">
    <ConnectionBar phase={connection.phase} syncRemaining={connection.syncRemaining} syncTotal={connection.syncTotal} url={endpoint} onChangeUrl={setEndpoint} onReconnect={reconnect} onLogout={logout} />
    {/* Compact nav row — display:none on desktop (styles.css), the only
        place the two drawer toggles exist. */}
    <div className="mobile-header">
      <button ref={railToggleRef} type="button" className="icon-button" aria-label="会话列表" aria-expanded={railOpen} aria-controls="session-rail-panel" onClick={() => openDrawer("rail")}><Menu size={19} /></button>
      <span className="mobile-header-title">Rind</span>
      <button ref={inspectorToggleRef} type="button" className="icon-button" aria-label="会话状态" aria-expanded={inspectorOpen} aria-controls="inspector-panel" onClick={() => openDrawer("inspector")}><PanelRight size={19} /></button>
    </div>
    {narrow && (railOpen || inspectorOpen) && <div className="drawer-backdrop" onClick={closeDrawers} aria-hidden="true" />}
    <div className="workspace-grid">
      <SessionRail
        sessions={sessions}
        activeId={info.session_id}
        workspace={selectedWorkspace}
        workspaceDraft={workspaceDraft}
        workspaceBusy={workspaceBusy}
        workspaceMessage={workspaceMessage}
        loading={busySession || workspaceBusy}
        unreadIds={unreadIds}
        notificationPermission={notificationPermission}
        fileTree={{ listFiles, readFile }}
        onWorkspaceDraftChange={setWorkspaceDraft}
        onWorkspaceApply={selectWorkspace}
        onNew={createSession}
        onSelect={handleSelectSession}
        onDelete={deleteSession}
        onEnableNotifications={enableNotifications}
        panelRef={railPanelRef}
        panelAttrs={railPanelAttrs}
      />
      <main className="main-column">
        <Conversation messages={view.messages} draft={view.draft} plan={view.plan} active={view.active} onCancel={cancelTurn} onAnswer={answerQuestion} onExpire={expireQuestion} />
        {/* Invariant: composer input is never disabled by connection state. */}
        <Composer value={input} onChange={setInput} onSubmit={submit} active={view.active} onCancel={cancelTurn} onUpload={uploadAttachment} />
      </main>
      <Inspector info={info} stats={stats} goal={goal} plan={view.plan} models={info.models || []} effort={info.reasoning_effort || ""} connection={inspectorConnection} onModel={setModel} onEffort={setEffort} onRefreshModels={() => refreshModels(info.session_id)} onCompact={compact} compacting={compacting} currentModel={currentModel} panelRef={inspectorPanelRef} panelAttrs={inspectorPanelAttrs} />
    </div>
  </div>;
}

function formatResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  return JSON.stringify(result, null, 2);
}
