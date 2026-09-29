import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Download, GitBranch, Menu, PanelRight, Search, Settings2 } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette.jsx";
import { ConnectionBar } from "./components/ConnectionBar.jsx";
import { Composer } from "./components/Composer.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { SettingsDialog } from "./components/SettingsDialog.jsx";
import { LoginGate } from "./components/LoginGate.jsx";
import { SessionRail } from "./components/SessionRail.jsx";
import { methods, parseSlashCommand, sessionIdOf } from "./methods.js";
import { createRuntimeClient, initialRuntimeUrl, isAuthError } from "./runtimeClient.js";
import { buildCommands, findCommandBySlash } from "./lib/commands.js";
import { createEventCoalescer } from "./lib/streamController.js";
import { applyTheme, initialTheme, storeTheme, toggleTheme } from "./lib/theme.js";
import { currentNotificationPermission, finalAssistantText, requestNotificationPermission, showNotification, truncateFirstLine } from "./lib/notifications.js";
import { exportConversation, readPreference, writePreference } from "./lib/sessionPreferences.js";
import { fileToBase64, uploadTargetPath } from "./lib/files.js";
import { createConnectionController, initialConnectionState, reduceConnection } from "./state/connection.js";
import { conversationView, emptyConversationState, questionKey, reduceConversation } from "./state/conversationReducer.js";
import { consumePairingCode, dropCredentials, fetchTicket, hasStoredCredential, loginErrorMessage, readStoredTicket, readStoredToken, storeToken, unauthorizedMessage } from "./ticket.js";

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SESSION_PAGE = 30; // session/list page size; the server caps limit at 100
const SESSION_LIMIT_MAX = 100;
const INTERRUPT_ARM_MS = 3000; // opencode pattern: second Esc within 3s cancels
// ≤900px the three desktop columns collapse into one; SessionRail and
// Inspector become edge slide-out drawers (master plan §6.2, mobile).
const NARROW_QUERY = "(max-width: 900px)";

function readNarrowViewport() {
  try {
    return Boolean(window.matchMedia?.(NARROW_QUERY)?.matches);
  } catch {
    return false;
  }
}

export default function App() {
  const [endpoint] = useState(() => {
    const address = typeof initialRuntimeUrl === "function" ? initialRuntimeUrl() : initialRuntimeUrl;
    const code = consumePairingCode();
    if (code) storeToken(code, address);
    return address;
  });
  const [connection, dispatchConnection] = useReducer(reduceConnection, undefined, () => initialConnectionState({ authenticated: hasStoredCredential(endpoint) }));
  const [conversation, dispatchConversation] = useReducer(reduceConversation, undefined, emptyConversationState);
  const [authBusy, setAuthBusy] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [info, setInfo] = useState({});
  const [sessions, setSessions] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
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
  const [queueMode, setQueueMode] = useState("follow_up"); // "follow_up" | "steering" — queued while a turn runs (audit #1)
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(initialTheme);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [contextInfo, setContextInfo] = useState({ lastTurnDurationMs: 0, messageCount: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const draftsRef = useRef({});
  const inputRef = useRef(input);
  inputRef.current = input;
  const sessionLoadRef = useRef(0);
  const connectionRunRef = useRef(0);
  const listRequestRef = useRef(0);
  const startupWorkspaceRef = useRef("");
  const switchingRef = useRef(false);
  const loadingEventsRef = useRef([]);
  const railPanelRef = useRef(null);
  const inspectorPanelRef = useRef(null);
  const railToggleRef = useRef(null);
  const inspectorToggleRef = useRef(null);
  const composerRef = useRef(null);
  const conversationRef = useRef(null);
  const workspaceRef = useRef("");
  const infoRef = useRef({});
  const currentModelRef = useRef("");
  const convRef = useRef(conversation);
  const clientRef = useRef(null);
  const queueModeRef = useRef(queueMode);
  const interruptTimerRef = useRef(null);
  const narrowRef = useRef(narrow);
  const railOpenRef = useRef(railOpen);
  const inspectorOpenRef = useRef(inspectorOpen);
  const paletteOpenRef = useRef(paletteOpen);
  const sessionsRef = useRef(sessions);
  const subscribedRef = useRef(new Set()); // session/subscribe bookkeeping (audit #13)
  workspaceRef.current = selectedWorkspace;
  infoRef.current = info;
  currentModelRef.current = currentModel;
  convRef.current = conversation;
  queueModeRef.current = queueMode;
  narrowRef.current = narrow;
  railOpenRef.current = railOpen;
  inspectorOpenRef.current = inspectorOpen;
  paletteOpenRef.current = paletteOpen;
  sessionsRef.current = sessions;

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

  // ---- theme (audit #11) ----
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = toggleTheme(current);
      storeTheme(next);
      return next;
    });
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

  // ---- event intake: deltas coalesce through the stream controller ----
  const coalescer = useMemo(() => createEventCoalescer({ dispatch: dispatchConversation }), []);

  const handleEvent = useCallback((message) => {
    const event = message?.event;
    if (!event || typeof event !== "object") return;
    const envelopeSession = String(message.session_id || event.session_id || "");
    const currentSession = String(infoRef.current.session_id || "");
    if (switchingRef.current) { loadingEventsRef.current.push(message); return; }
    if (envelopeSession && currentSession && envelopeSession !== currentSession) {
      if (String(message.durability) === "durable") markUnread(envelopeSession);
      return;
    }
    if (event.type === "goal_updated") setGoal(event.goal || null);
    if (event.type === "context_built" || event.type === "token_stats_updated") {
      if (event.type === "context_built") {
        const count = Number(event.message_count || 0);
        if (count > 0) setContextInfo((current) => ({ ...current, messageCount: count }));
      }
      setStats(event.stats && typeof event.stats === "object" ? event.stats : {});
      return;
    }
    // Events from other sessions never enter this conversation (J7): a durable
    // event lights the unread dot instead; the catch-up replay rebuilds the
    // stream when that session is opened.
    if (event.type === "turn_completed") {
      const duration = Number(event.duration_ms || 0);
      if (duration > 0) setContextInfo((current) => ({ ...current, lastTurnDurationMs: duration }));
      // Browser notifications: only when the tab is hidden AND permission was
      // granted via the rail footer button (never a load-time prompt).
      showNotification({ title: "Rind reply ready", body: truncateFirstLine(finalAssistantText(convRef.current)) });
      // First turn of a brand-new session lands it in the session index —
      // refresh the rail so the user actually sees their session.
      void refreshSessions(workspaceRef.current || infoRef.current.workspace_root);
    }
    coalescer.push(message);
  }, [markUnread, coalescer]);

  const requestRuntime = useCallback((method, params = {}) => clientRef.current?.request(method, params), []);

  const client = useMemo(() => createRuntimeClient({
    url: endpoint,
    credentialProvider: acquireCredential,
    onEvent: handleEvent,
    onStatus: handleStatus,
    onOpen: handleOpen,
  }), []);
  clientRef.current = client;

  useEffect(() => {
    if (!hasStoredCredential(endpoint)) return undefined;
    client.connect().catch(() => {
      // Statuses carry the outcome; auth failures route back to the login card.
    });
    return () => client.disconnect();
  }, [client]);

  useEffect(() => () => coalescer.dispose(), [coalescer]);

  function ticketEndpoint(url = clientRef.current?.url || endpoint) {
    const address = new URL(url, window.location.href);
    address.protocol = address.protocol === "wss:" ? "https:" : "http:";
    address.pathname = "/ticket"; address.search = ""; address.hash = "";
    return address.href;
  }

  async function acquireCredential(url) {
    const token = readStoredToken(url || clientRef.current?.url || endpoint);
    if (token) {
      // Tickets are one-time: mint a fresh one for every (re)connect.
      const ticket = await fetchTicket(token, { endpoint: ticketEndpoint(url) });
      return `ticket=${encodeURIComponent(ticket)}`;
    }
    const stored = readStoredTicket(url || clientRef.current?.url || endpoint);
    if (stored) return `ticket=${encodeURIComponent(stored)}`;
    const error = new Error("credentials required");
    error.code = "auth_required";
    throw error;
  }

  function handleStatus(status) {
    if (["connecting", "disconnected", "unauthorized"].includes(status?.state)) {
      ++connectionRunRef.current;
      ++sessionLoadRef.current;
    }
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
    const run = connectionRunRef.current;
    subscribedRef.current.clear();
    await initializeRuntime();
    if (run === connectionRunRef.current) dispatchConnection({ type: "sync_complete" });
  }

  async function handleLogin(token) {
    if (authBusy) return;
    setAuthBusy(true);
    setLoginToken(token);
    try {
      storeToken(token, clientRef.current?.url || endpoint);
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
    ++connectionRunRef.current;
    ++listRequestRef.current;
    ++sessionLoadRef.current;
    coalescer.flush();
    switchingRef.current = false;
    loadingEventsRef.current = [];
    draftsRef.current = {}; setInput(""); setCurrentModel("");
    dropCredentials();
    setLoginToken("");
    clientRef.current.disconnect();
    dispatchConnection({ type: "sign_out" });
    setInfo({}); infoRef.current = {};
    dispatchConversation({ kind: "reset" });
    setSessions([]); setGoal(null); setStats({}); setBusySession(false); setCompacting(false);
  }

  function reconnect() {
    if (connection.phase === "login") return;
    dispatchConnection({ type: "retry" });
    clientRef.current.setUrl(endpoint);
    clientRef.current.connect().catch(() => {});
  }

  function restoreTasks(tasks, sessionId) {
    for (const task of tasks || []) {
      dispatchConversation({ kind: "event", session_id: sessionId, turn_id: "",
        event: { type: "task_updated", task } });
    }
  }

  async function initializeRuntime() {
    const run = connectionRunRef.current;
    try {
      const previous = infoRef.current.session_id || readPreference(`session:${clientRef.current.url || endpoint}`);
      if (previous) draftsRef.current[previous] = inputRef.current;
      const result = await clientRef.current.request(methods.initialize);
      if (run !== connectionRunRef.current) return;
      startupWorkspaceRef.current = String(result?.workspace_root || "");
      // Keep the viewed id until loadSession commits its snapshot. Otherwise
      // reconnect can save this draft under the Worker's startup session.
      infoRef.current = { ...infoRef.current, ...result, session_id: previous || result?.session_id };
      setInfo((current) => ({
        ...current,
        ...(result || {}),
        session_id: previous || result?.session_id,
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
      if (previous && previous !== currentId) {
        try { await loadSession(previous, true, true); }
        catch (error) { if (error.type === "SessionNotFound" && currentId) await loadSession(currentId, true, true); else throw error; }
      } else if (currentId) await loadSession(currentId, true, true);
      if (run !== connectionRunRef.current) return;
      await refreshSessions(infoRef.current.workspace_root || workspace);
      if (run !== connectionRunRef.current) return;
      const allSessions = await clientRef.current.request(methods.sessionList, { limit: SESSION_LIMIT_MAX });
      if (run === connectionRunRef.current) setWorkspaces([...new Set([workspace, infoRef.current.workspace_root, ...(allSessions?.sessions || []).map((session) => session.workspace_root)].filter(Boolean))]);
      void refreshModels(infoRef.current.session_id);
    } catch (error) {
      if (run === connectionRunRef.current) dispatchMessage("system", error instanceof Error ? error.message : String(error), "error");
      throw error;
    }
  }

  // session/list (audit #9/#13): the server has no offset — pagination steps
  // the `limit` (max 100) instead; listed sessions + the current one are
  // subscribed so unread dots are first-class, not incidental.
  async function refreshSessions(workspace = selectedWorkspace || info.workspace_root, { limit = sessionLimit } = {}) {
    if (!clientRef.current) return;
    const run = connectionRunRef.current;
    const requestId = ++listRequestRef.current;
    try {
      const params = { limit };
      if (workspace) params.workspace_root = workspace;
      const result = await clientRef.current.request(methods.sessionList, params);
      if (run !== connectionRunRef.current || requestId !== listRequestRef.current) return;
      const list = Array.isArray(result?.sessions) ? result.sessions : [];
      setSessions(list);
      setHasMoreSessions(list.length >= limit && limit < SESSION_LIMIT_MAX);
      void syncSubscriptions(list);
    } catch {
      // Session list refresh is advisory; keep the current list on failure.
    }
  }

  async function loadMoreSessions() {
    const next = Math.min(SESSION_LIMIT_MAX, sessionLimit + SESSION_PAGE);
    setSessionLimit(next);
    await refreshSessions(workspaceRef.current || infoRef.current.workspace_root, { limit: next });
  }

  async function syncSubscriptions(list = sessions) {
    const client = clientRef.current;
    if (!client) return;
    const targets = new Set(list.map((session) => sessionIdOf(session)).filter(Boolean));
    const currentId = String(infoRef.current.session_id || "");
    if (currentId) targets.add(currentId);
    const run = connectionRunRef.current;
    for (const id of [...subscribedRef.current]) {
      if (run !== connectionRunRef.current) return;
      if (!targets.has(id)) {
        subscribedRef.current.delete(id);
        try { await client.request(methods.sessionUnsubscribe, { session_id: id }); } catch { /* Advisory. */ }
      }
    }
    for (const id of targets) {
      if (run !== connectionRunRef.current) return;
      if (subscribedRef.current.has(id)) continue;
      try {
        await client.request(methods.sessionSubscribe, { session_id: id });
        if (run === connectionRunRef.current) subscribedRef.current.add(id);
      } catch {
        // Subscriptions are advisory (unread dots); failures stay silent.
      }
    }
  }

  async function refreshModels(sessionId = info.session_id) {
    const loadId = sessionLoadRef.current;
    try {
      const result = await clientRef.current.request(methods.modelList, { session_id: sessionId });
      if (loadId !== sessionLoadRef.current || sessionId !== infoRef.current.session_id) return;
      const nextCurrentModel = String(result?.current_model || infoRef.current.model || infoRef.current.default_model || currentModelRef.current || "").trim();
      const values = [nextCurrentModel, ...(Array.isArray(result?.models) ? result.models : [])].filter(Boolean);
      setCurrentModel(nextCurrentModel);
      setInfo((current) => ({ ...current, models: [...new Set(values)], model: nextCurrentModel || current.model }));
    } catch {
      if (loadId !== sessionLoadRef.current || sessionId !== infoRef.current.session_id) return;
      const fallback = String(infoRef.current.model || infoRef.current.default_model || currentModelRef.current || "").trim();
      setInfo((current) => ({ ...current, models: fallback ? [fallback] : [] }));
    }
  }

  async function loadSession(sessionId, switchSession = true, throwOnError = false) {
    const target = String(sessionId || "").trim();
    if (!target || !clientRef.current) return;
    const loadId = ++sessionLoadRef.current;
    const previousId = infoRef.current.session_id;
    if (previousId && previousId !== target) draftsRef.current[previousId] = inputRef.current;
    coalescer.flush();
    switchingRef.current = true;
    loadingEventsRef.current = [];
    clearUnread(target);
    setBusySession(true);
    try {
      const switched = switchSession ? await clientRef.current.request(methods.sessionSwitch, { session_id: target }) : infoRef.current;
      if (loadId !== sessionLoadRef.current) return;
      let replay = await clientRef.current.request(methods.sessionReplay, { session_id: target });
      // A completed turn can overtake the history read. Read once more when a
      // durable boundary arrived during it; never append overlapping deltas.
      for (let retry = 0; retry < 3 && loadingEventsRef.current.some((item) => item.session_id === target && item.durability === "durable" && item.event?.type !== "task_updated"); retry++) {
        if (loadId !== sessionLoadRef.current) return;
        loadingEventsRef.current = [];
        replay = await clientRef.current.request(methods.sessionReplay, { session_id: target });
      }
      if (loadId !== sessionLoadRef.current) return;
      const workspace = String(switched?.workspace_root || selectedWorkspace || "").trim();
      if (previousId && previousId !== target) draftsRef.current[previousId] = inputRef.current;
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
      infoRef.current = { ...infoRef.current, ...switched, session_id: target, workspace_root: workspace, model: sessionModel };
      writePreference(`session:${clientRef.current.url || endpoint}`, target);
      if (previousId !== target) setInput(draftsRef.current[target] || "");
      void refreshModels(target);
      if (workspace) {
        setSelectedWorkspace(workspace);
        setWorkspaceDraft(workspace);
      }
      dispatchConversation({ kind: "history", messages: replay?.messages });
      dispatchConversation({ kind: "live_turn", liveTurn: replay?.live_turn || null, sessionId: target });
      restoreTasks(replay?.tasks, target);
      setGoal(switched?.goal || null);
      setStats(switched?.usage || {});
      setContextInfo({ lastTurnDurationMs: 0, messageCount: replay?.messages?.length || 0 });
      clearUnread(target); // late events during the switch may have re-marked it
      void syncSubscriptions([...(sessionsRef.current || []), { id: target }]);
    } catch (error) {
      if (loadId !== sessionLoadRef.current) return;
      if (throwOnError) throw error;
      dispatchMessage("system", `Unable to open session: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (loadId === sessionLoadRef.current) {
        switchingRef.current = false;
        loadingEventsRef.current = [];
        setBusySession(false);
      }
    }
  }

  async function createSession() {
    const run = connectionRunRef.current;
    const loadId = sessionLoadRef.current;
    try {
      const workspace = workspaceDraft.trim() || selectedWorkspace || info.workspace_root;
      const result = await clientRef.current.request(methods.sessionNew, { workspace_root: workspace });
      if (run !== connectionRunRef.current || loadId !== sessionLoadRef.current) return;
      setSelectedWorkspace(workspace);
      await loadSession(result?.session_id, true);
      await refreshSessions(workspace);
    } catch (error) {
      dispatchMessage("system", `Unable to create session: ${error.message}`, "error");
    }
  }

  async function selectWorkspace(path) {
    const workspace = typeof path === "string" ? path.trim() : workspaceDraft.trim();
    if (!workspace) {
      setWorkspaceMessage("Enter a workspace path.");
      return;
    }
    setWorkspaceBusy(true);
    const run = connectionRunRef.current;
    const requestId = ++listRequestRef.current;
    setWorkspaceMessage("");
    try {
      const result = await clientRef.current.request(methods.sessionList, { limit: sessionLimit, workspace_root: workspace });
      if (run !== connectionRunRef.current || requestId !== listRequestRef.current) return;
      const nextSessions = Array.isArray(result?.sessions) ? result.sessions : [];
      setSelectedWorkspace(workspace);
      setWorkspaceDraft(workspace);
      setWorkspaces((current) => [...new Set([...current, workspace])]);
      setSessions(nextSessions);
      setHasMoreSessions(nextSessions.length >= sessionLimit && sessionLimit < SESSION_LIMIT_MAX);
      void syncSubscriptions(nextSessions);
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
    ++sessionLoadRef.current;
    if (infoRef.current.session_id) draftsRef.current[infoRef.current.session_id] = inputRef.current;
    infoRef.current = { ...infoRef.current, session_id: "", workspace_root: workspace };
    setInput("");
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
    if (!text || !clientRef.current || switchingRef.current) return;
    const submittedSession = infoRef.current.session_id || "";
    const run = connectionRunRef.current;
    const loadId = sessionLoadRef.current;
    setInput("");
    inputRef.current = "";
    draftsRef.current[submittedSession] = "";
    if (text.startsWith("/")) {
      await runSlashCommand(text);
      return;
    }
    if (convRef.current.active) {
      // Queue by default (audit #1): follow_up unless the user flipped the
      // Composer switch to steering. The returned input_id keeps the chip
      // addressable for retrieve / steer.
      const mode = queueModeRef.current === "steering" ? "steering" : "follow_up";
      const method = mode === "steering" ? methods.sessionSteer : methods.sessionFollowUp;
      try {
        // Steer is turn-scoped: the kernel rejects it without the active turn_id.
        const result = await clientRef.current.request(method, {
          session_id: submittedSession,
          input: text,
          ...(mode === "steering" && convRef.current.activeTurnId ? { turn_id: convRef.current.activeTurnId } : {}),
        });
        if (run !== connectionRunRef.current || submittedSession !== infoRef.current.session_id) return;
        const inputId = String(result?.input_id || "").trim();
        if (inputId) {
          dispatchConversation({ kind: "queue_input", inputId, input: text, mode });
        } else {
          dispatchMessage("system", `Queued input accepted: ${text}`);
        }
      } catch (error) {
        if (run !== connectionRunRef.current) return;
        restoreDraft(text, submittedSession);
        if (submittedSession === infoRef.current.session_id) dispatchMessage("system", `Unable to queue input: ${error.message}`, "error");
      }
      return;
    }
    // First-message auto-session: a brand-new workspace has no session yet —
    // create one instead of failing the user's very first message.
    let sessionId = sessionIdOf(infoRef.current);
    if (!sessionId) {
      const workspace = workspaceDraft.trim() || selectedWorkspace || info.workspace_root;
      try {
        const result = await clientRef.current.request(methods.sessionNew, { workspace_root: workspace });
        if (run !== connectionRunRef.current) return;
        sessionId = String(result?.session_id || "");
        if (loadId === sessionLoadRef.current) {
          setSelectedWorkspace(workspace);
          await loadSession(sessionId, true);
          await refreshSessions(workspace);
        }
      } catch (error) {
        if (run !== connectionRunRef.current) return;
        restoreDraft(text, submittedSession);
        if (loadId === sessionLoadRef.current) dispatchMessage("system", `Unable to create session: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
    }
    if (sessionId === infoRef.current.session_id) dispatchMessage("user", text);
    try {
      await clientRef.current.request(methods.sessionPrompt, { session_id: sessionId, input: text });
    } catch (error) {
      if (run !== connectionRunRef.current) return;
      restoreDraft(text, sessionId);
      if (sessionId === infoRef.current.session_id) dispatchMessage("system", `Prompt failed: ${error.message}`, "error");
    }
  }

  // A failed submit never eats the user's text: the draft comes back
  // (prepended to whatever they typed since) instead of vanishing.
  function restoreDraft(text, sessionId = infoRef.current.session_id || "") {
    const clean = String(text || "");
    if (!clean) return;
    const current = sessionId === (infoRef.current.session_id || "");
    const restored = [clean, current ? inputRef.current : draftsRef.current[sessionId]].filter(Boolean).join("\n");
    draftsRef.current[sessionId] = restored;
    if (current) { inputRef.current = restored; setInput(restored); }
  }

  // Queued chip actions (audit #1). Retrieve pulls the text back into the
  // draft (unsteer / dequeue_follow_up return the removed item); steer promotes
  // a follow_up into the steering queue.
  async function retrieveQueued(entry) {
    const sessionId = infoRef.current.session_id;
    const run = connectionRunRef.current;
    const method = entry.mode === "steering" ? methods.sessionUnsteer : methods.sessionDequeueFollowUp;
    try {
      const result = await clientRef.current.request(method, { session_id: sessionId, input_id: entry.inputId });
      if (run !== connectionRunRef.current) return;
      const text = String(result?.input || entry.input || "");
      restoreDraft(text, sessionId);
      if (sessionId === infoRef.current.session_id) {
        dispatchConversation({ kind: "unqueue", inputId: entry.inputId });
        composerRef.current?.focus();
      }
    } catch (error) {
      if (run === connectionRunRef.current && sessionId === infoRef.current.session_id) dispatchMessage("system", `Failed to retrieve: ${error.message}`, "error");
    }
  }

  async function promoteQueued(entry) {
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    try {
      await clientRef.current.request(methods.sessionPromoteFollowUp, { session_id: sessionId, input_id: entry.inputId });
      if (loadId === sessionLoadRef.current) dispatchConversation({ kind: "requeue", inputId: entry.inputId, mode: "steering" });
    } catch (error) {
      if (loadId === sessionLoadRef.current) dispatchMessage("system", `Failed to redirect: ${error.message}`, "error");
    }
  }

  // Retry (audit: message actions): resend the last user prompt of that turn.
  async function retryTurn(message) {
    const entries = convRef.current.entries;
    const index = entries.findIndex((entry) => entry.id === message.id);
    let prompt = "";
    for (let cursor = (index < 0 ? entries.length : index) - 1; cursor >= 0; cursor -= 1) {
      if (entries[cursor]?.role === "user" && entries[cursor]?.content) {
        prompt = entries[cursor].content;
        break;
      }
    }
    if (!prompt || !clientRef.current) return;
    dispatchMessage("user", prompt);
    try {
      await clientRef.current.request(methods.sessionPrompt, { session_id: infoRef.current.session_id, input: prompt });
    } catch (error) {
      dispatchMessage("system", `Prompt failed: ${error.message}`, "error");
    }
  }

  async function runSlashCommand(text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) return;
    let argument = parsed.argument;
    // CLI-compat quirk: `/model set gpt-x` normalizes to the plain model name.
    if (parsed.name === "model" && argument.toLowerCase().startsWith("set ")) argument = argument.slice(4).trim();
    const command = findCommandBySlash(commandList, parsed.name);
    if (command) {
      try {
        await command.run(commandCtxRef.current, argument);
      } catch (error) {
        dispatchMessage("system", `Command failed: ${error.message}`, "error");
      }
      return;
    }
    try {
      const result = await clientRef.current.request(methods.commandExecute, { session_id: infoRef.current.session_id, input: text });
      dispatchMessage("system", result?.text || formatResult(result));
    } catch (error) {
      dispatchMessage("system", `Command failed: ${error.message}`, "error");
    }
  }

  async function setModel(model) {
    const clean = String(model || "").trim();
    if (!clean) return;
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    const result = await clientRef.current.request(methods.modelSet, { session_id: sessionId, model: clean });
    if (loadId !== sessionLoadRef.current || sessionId !== infoRef.current.session_id) return;
    const next = String(result?.session_model || result?.model || clean).trim();
    setCurrentModel(next);
    setInfo((current) => ({ ...current, model: next }));
    dispatchMessage("system", `Model updated to ${next}.`);
  }

  async function setEffort(effort) {
    const clean = String(effort || "").trim().toLowerCase();
    if (!REASONING_EFFORTS.includes(clean)) {
      dispatchMessage("system", `Unknown reasoning effort: ${effort}`, "error");
      return;
    }
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    const result = await clientRef.current.request(methods.modelEffort, { session_id: sessionId, reasoning_effort: clean });
    if (loadId !== sessionLoadRef.current || sessionId !== infoRef.current.session_id) return;
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
    const loadId = sessionLoadRef.current;
    try {
      const result = await clientRef.current.request(methods.sessionCompact, { session_id: infoRef.current.session_id });
      if (loadId === sessionLoadRef.current) dispatchMessage("system", `Context compacted${result?.source ? ` · messages ${result.source.message_start_index ?? "?"}-${result.source.message_end_index_exclusive ?? "?"}` : ""}.`);
    } catch (error) {
      if (loadId === sessionLoadRef.current) dispatchMessage("system", `Compaction failed: ${error.message}`, "error");
    } finally {
      setCompacting(false);
    }
  }

  async function cancelTurn() {
    try {
      await clientRef.current.request(methods.sessionCancel, { session_id: infoRef.current.session_id, ...(convRef.current.activeTurnId ? { turn_id: convRef.current.activeTurnId } : {}) });
    } catch (error) {
      dispatchMessage("system", error.message, "error");
    }
  }

  // Goal command with an argument: set / clear / pause / resume (CLI parity).
  async function runGoalCommand(argument) {
    const action = argument.trim().toLowerCase();
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    if (!action) {
      const result = await clientRef.current.request(methods.goalGet, { session_id: sessionId });
      if (loadId !== sessionLoadRef.current) return;
      setGoal(result?.goal || null);
      dispatchMessage("system", result?.goal?.objective ? `Active goal: ${result.goal.objective}` : "No active goal.");
      return;
    }
    if (action === "clear") {
      await clientRef.current.request(methods.goalClear, { session_id: sessionId });
      if (loadId !== sessionLoadRef.current) return;
      setGoal(null);
      dispatchMessage("system", "Goal cleared.");
      return;
    }
    if (action === "pause" || action === "resume") {
      const result = await clientRef.current.request(methods.goalStatus, { session_id: sessionId, status: action === "resume" ? "active" : "paused" });
      if (loadId !== sessionLoadRef.current) return;
      setGoal(result?.goal || null);
      dispatchMessage("system", `Goal ${action}d.`);
      return;
    }
    const result = await clientRef.current.request(methods.goalSet, { session_id: sessionId, objective: argument });
    if (loadId !== sessionLoadRef.current) return;
    setGoal(result?.goal || null);
    dispatchMessage("system", `Goal set: ${argument}`);
  }

  async function forkSession() {
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    try {
      const result = await clientRef.current.request("session/fork", { session_id: sessionId });
      if (loadId !== sessionLoadRef.current) return;
      await loadSession(result?.session_id || result?.id, true);
      await refreshSessions();
    } catch (error) { if (sessionId === infoRef.current.session_id) dispatchMessage("system", `Unable to fork: ${error.message}`, "error"); }
  }

  async function handleGoalAction(action) {
    const sessionId = infoRef.current.session_id;
    const loadId = sessionLoadRef.current;
    if (!sessionId) throw new Error("Create a session before setting a goal.");
    const method = action.type === "clear" ? methods.goalClear : action.type === "start" ? methods.goalSet : methods.goalStatus;
    const params = action.type === "start" ? { objective: action.objective } : { status: action.type === "resume" ? "active" : "paused" };
    const result = await clientRef.current.request(method, { session_id: sessionId, ...params });
    if (loadId === sessionLoadRef.current && sessionId === infoRef.current.session_id) setGoal(action.type === "clear" ? null : result?.goal || null);
  }

  async function exportSession() {
    const sessionId = infoRef.current.session_id;
    try {
      const result = await clientRef.current.request(methods.sessionReplay, { session_id: sessionId });
      exportConversation(result?.messages || [], sessionsRef.current.find((item) => sessionIdOf(item) === sessionId)?.title || "Rind conversation");
    } catch (error) { if (sessionId === infoRef.current.session_id) dispatchMessage("system", `Export failed: ${error.message}`, "error"); }
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
    subscribedRef.current.delete(sessionId);
    try {
      await clientRef.current.request(methods.sessionUnsubscribe, { session_id: sessionId });
    } catch {
      // Unsubscribe is advisory; the deleted id is already dropped locally.
    }
  }

  // Attachment upload path (web-ui.md §2.4): base64 → file/write into the
  // uploads/ subtree; resolves with the stored path for the chip.
  async function uploadAttachment(file) {
    const sessionId = infoRef.current.session_id;
    assertFileWorkspace();
    const content_base64 = await fileToBase64(file);
    const path = uploadTargetPath(file?.name || "pasted-image", new Date());
    const result = await clientRef.current?.request(methods.fileWrite, { path, content_base64, session_id: sessionId });
    return String(result?.path || path);
  }

  function assertFileWorkspace() {
    if (!infoRef.current.gateway?.files_follow_session && infoRef.current.workspace_root !== startupWorkspaceRef.current) {
      throw new Error("This worker exposes only its startup folder. Use desktop remote access for files in other workspaces.");
    }
  }
  const listFiles = useCallback(async (path) => { assertFileWorkspace(); return clientRef.current.request(methods.fileList, { path: path || "", session_id: infoRef.current.session_id }); }, []);
  const readFile = useCallback(async (path) => { assertFileWorkspace(); return clientRef.current.request(methods.fileRead, { path, session_id: infoRef.current.session_id }); }, []);

  async function answerQuestion(question, answer) {
    if (!question || question.status !== "pending") return false;
    const text = String(answer || "").trim();
    try {
      await clientRef.current.request(methods.userQuestionRespond, {
        session_id: question.sessionId || infoRef.current.session_id,
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

  // ---- command registry (audit #9/#10) ----
  const commandList = useMemo(() => buildCommands({}), []); // slash/title metadata for the Composer
  const commandCtx = {
    newSession: () => createSession(),
    focusSessions: () => {
      if (narrowRef.current) openDrawer("rail");
      const search = document.getElementById("rail-search-input");
      if (search) {
        search.focus();
        search.select();
      }
    },
    focusModel: () => focusInspectorSelect(0),
    focusEffort: () => focusInspectorSelect(1),
    focusGoal: () => { setDetailsOpen(true); if (narrowRef.current) openDrawer("inspector"); requestAnimationFrame(() => document.querySelector(".inspector .goal-section")?.focus()); },
    compact: () => compact(),
    stopTurn: () => cancelTurn(),
    scrollToLatest: () => conversationRef.current?.scrollToLatest(),
    toggleTheme: () => handleToggleTheme(),
    clearInput: () => setInput(""),
    focusComposer: () => composerRef.current?.focus(),
    showHelp: () => showHelp(),
    setModel: (model) => setModel(model),
    setEffort: (effort) => setEffort(effort),
    runGoal: (argument) => runGoalCommand(argument),
    runServerSlash: (name, argument) => runServerSlash(name, argument),
  };
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;

  async function runServerSlash(name, argument) {
    const text = argument ? `/${name} ${argument}` : `/${name}`;
    const result = await clientRef.current.request(methods.commandExecute, { session_id: infoRef.current.session_id, input: text });
    dispatchMessage("system", result?.text || formatResult(result));
  }

  function showHelp() {
    const lines = commandList
      .map((command) => `/${command.slash || command.id} — ${command.title}${command.keybind ? ` (${command.keybind})` : ""}`)
      .join("\n");
    dispatchMessage("system", `Available commands (Ctrl+K opens the command palette):\n${lines}`);
  }

  function focusInspectorSelect(index) {
    setDetailsOpen(true);
    if (narrowRef.current) openDrawer("inspector");
    requestAnimationFrame(() => document.querySelectorAll(".inspector select")[index]?.focus());
  }

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    // Focus returns to the Composer (audit #10).
    composerRef.current?.focus();
  }, []);

  const runCommand = useCallback(async (command) => {
    setPaletteOpen(false);
    try {
      await command.run(commandCtxRef.current, "");
    } catch (error) {
      dispatchMessage("system", `Command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      composerRef.current?.focus();
    }
  }, [dispatchMessage]);

  // ---- global keys: palette toggle + double-Esc interrupt (audit #1/#10) ----
  const disarmInterrupt = useCallback(() => {
    if (interruptTimerRef.current) {
      window.clearTimeout(interruptTimerRef.current);
      interruptTimerRef.current = null;
    }
    setInterruptArmed(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettingsOpen(true); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpenRef.current) closePalette();
        else setPaletteOpen(true);
        return;
      }
      if (event.key !== "Escape") return;
      if (document.querySelector("dialog[open]")) return;
      if (paletteOpenRef.current) return; // palette handles its own Esc
      // Esc still closes the mobile drawers first — that behavior wins.
      if (narrowRef.current && (railOpenRef.current || inspectorOpenRef.current)) return;
      if (!convRef.current.active) return;
      event.preventDefault();
      if (interruptTimerRef.current) {
        // second Esc within the window → cancel
        disarmInterrupt();
        void cancelTurn();
      } else {
        setInterruptArmed(true);
        interruptTimerRef.current = window.setTimeout(() => {
          interruptTimerRef.current = null;
          setInterruptArmed(false); // single Esc after timeout resets silently
        }, INTERRUPT_ARM_MS);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePalette, disarmInterrupt]);

  // Turn end (or leaving the session) disarms a pending interrupt silently.
  const view = conversationView(conversation);
  useEffect(() => {
    if (!view.active) disarmInterrupt();
  }, [view.active, disarmInterrupt]);

  // Unmount: never leave the arm timer firing into a dead component.
  useEffect(() => () => {
    if (interruptTimerRef.current) window.clearTimeout(interruptTimerRef.current);
  }, []);

  const inspectorConnection = connection.phase === "online" || connection.phase === "syncing" ? "connected" : "offline";
  // Off-canvas panels are hidden from AT and untabbable only below the
  // breakpoint; on desktop the columns are plain always-visible panels.
  const railHidden = narrow && !railOpen;
  const inspectorHidden = narrow ? !inspectorOpen : !detailsOpen;
  const railPanelAttrs = {
    id: "session-rail-panel",
    className: narrow ? (railOpen ? "drawer-open" : "drawer-closed") : "",
    "aria-hidden": railHidden || undefined,
    inert: railHidden ? "" : undefined,
  };
  const inspectorPanelAttrs = {
    id: "inspector-panel",
    className: narrow ? (inspectorOpen ? "drawer-open" : "drawer-closed") : (detailsOpen ? "" : "details-hidden"),
    "aria-hidden": inspectorHidden || undefined,
    inert: inspectorHidden ? "" : undefined,
  };

  if (connection.phase === "login") {
    return <LoginGate onSubmit={handleLogin} busy={authBusy} error={connection.message} initialToken={loginToken} />;
  }

  return <div className="app-shell">
    <ConnectionBar phase={connection.phase} syncRemaining={connection.syncRemaining} syncTotal={connection.syncTotal} onReconnect={reconnect} onLogout={logout} onSettings={() => setSettingsOpen(true)} />
    {/* Compact nav row — display:none on desktop (styles.css), the only
        place the two drawer toggles exist. */}
    <div className="mobile-header">
      <button ref={railToggleRef} type="button" className="icon-button" aria-label="Sessions" aria-expanded={railOpen} aria-controls="session-rail-panel" onClick={() => openDrawer("rail")}><Menu size={19} /></button>
      <span className="mobile-header-title">Rind</span>
      <button type="button" className="icon-button" aria-label="Mobile settings" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /></button>
      <button ref={inspectorToggleRef} type="button" className="icon-button" aria-label="Session state" aria-expanded={inspectorOpen} aria-controls="inspector-panel" onClick={() => openDrawer("inspector")}><PanelRight size={19} /></button>
    </div>
    {narrow && (railOpen || inspectorOpen) && <div className="drawer-backdrop" onClick={closeDrawers} aria-hidden="true" />}
    <div className={`workspace-grid ${detailsOpen ? "with-details" : ""}`}>
      <SessionRail
        sessions={sessions}
        activeId={info.session_id}
        workspace={selectedWorkspace}
        workspaces={workspaces}
        onWorkspaceSelect={selectWorkspace}
        workspaceDraft={workspaceDraft}
        workspaceBusy={workspaceBusy}
        workspaceMessage={workspaceMessage}
        loading={busySession || workspaceBusy}
        unreadIds={unreadIds}
        notificationPermission={notificationPermission}
        fileTree={{ listFiles, readFile }}
        hasMore={hasMoreSessions}
        onLoadMore={loadMoreSessions}
        onWorkspaceDraftChange={setWorkspaceDraft}
        onWorkspaceApply={selectWorkspace}
        onNew={createSession}
        onSelect={handleSelectSession}
        onDelete={deleteSession}
        onEnableNotifications={enableNotifications}
        panelRef={railPanelRef}
        panelAttrs={railPanelAttrs}
      />
      <main className="main-column" aria-busy={busySession}>
        <div className="session-toolbar"><div><strong>{sessions.find((session) => sessionIdOf(session) === info.session_id)?.title || "New conversation"}</strong><span>{currentModel || "Choose a model in session details"}</span></div><div className="toolbar-actions"><button className="icon-button subtle" title="Commands (Ctrl+K)" onClick={() => setPaletteOpen(true)}><Search size={17} /></button><button className="icon-button subtle" title="Export conversation" disabled={!view.messages.length} onClick={() => void exportSession()}><Download size={17} /></button><button className="icon-button subtle" title="Fork conversation" disabled={view.active || !info.session_id || !info.methods?.includes?.("session/fork")} onClick={() => void forkSession()}><GitBranch size={17} /></button><button className="icon-button subtle desktop-details-toggle" aria-label="Toggle session details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}><PanelRight size={18} /></button></div></div>
        <Conversation
          ref={conversationRef}
          messages={view.messages}
          draft={view.draft}
          plan={view.plan}
          active={view.active}
          collapsedCount={view.collapsedCount}
          turnChanges={view.turnChanges}
          onAnswer={answerQuestion}
          onExpire={expireQuestion}
          onRetrieve={retrieveQueued}
          onPromote={promoteQueued}
          onRetry={retryTurn}
          onSuggestion={(value) => { setInput(value); composerRef.current?.focus(); }}
        />
        {/* Invariant: composer input is never disabled by connection state. */}
        <Composer
          key={info.session_id || "new"}
          ref={composerRef}
          value={input}
          loading={busySession}
          onChange={setInput}
          onSubmit={submit}
          active={view.active}
          onCancel={cancelTurn}
          onUpload={uploadAttachment}
          queueMode={queueMode}
          onQueueModeChange={setQueueMode}
          interruptArmed={interruptArmed}
          commands={commandList}
        />
      </main>
      <Inspector info={info} stats={stats} goal={goal} plan={view.plan} models={info.models || []} effort={info.reasoning_effort || ""} connection={inspectorConnection} onModel={setModel} onEffort={setEffort} onRefreshModels={() => refreshModels(info.session_id)} onCompact={compact} compacting={compacting} currentModel={currentModel} contextInfo={contextInfo} panelRef={inspectorPanelRef} panelAttrs={inspectorPanelAttrs} onClose={() => { closeDrawers(); setDetailsOpen(false); }} request={requestRuntime} onGoalAction={handleGoalAction} />
    </div>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onLogout={() => { setSettingsOpen(false); logout(); }} theme={theme} onTheme={handleToggleTheme} />
    <CommandPalette open={paletteOpen} commands={commandList} onClose={closePalette} onRun={runCommand} />
  </div>;
}

function formatResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  return JSON.stringify(result, null, 2);
}
