import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Check, LoaderCircle, MessageCircleQuestion, X } from "lucide-react";
import { ConnectionBar } from "./components/ConnectionBar.jsx";
import { Composer } from "./components/Composer.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { LoginGate } from "./components/LoginGate.jsx";
import { SessionRail } from "./components/SessionRail.jsx";
import { methods, parseSlashCommand, sessionIdOf } from "./methods.js";
import { createRuntimeClient, initialRuntimeUrl, isAuthError } from "./runtimeClient.js";
import { createConnectionController, initialConnectionState, reduceConnection } from "./state/connection.js";
import { conversationView, emptyConversationState, questionKey, reduceConversation } from "./state/conversationReducer.js";
import { dropCredentials, fetchTicket, hasStoredCredential, loginErrorMessage, readStoredTicket, readStoredToken, storeTicket, storeToken, unauthorizedMessage } from "./ticket.js";

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CATCH_UP_CHUNK = 50;

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

  const handleEvent = useCallback((message) => {
    const event = message?.event;
    if (!event || typeof event !== "object") return;
    if (event.type === "context_built" || event.type === "token_stats_updated") {
      setStats(event.stats && typeof event.stats === "object" ? event.stats : {});
      return;
    }
    dispatchConversation(message);
  }, []);

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

  async function submit() {
    const text = input.trim();
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

  async function answerQuestion(answer) {
    const question = convRef.current.question;
    if (!question) return false;
    try {
      await clientRef.current.request(methods.userQuestionRespond, {
        session_id: question.sessionId || info.session_id,
        tool_call_id: question.toolCallId,
        answer: String(answer || "").trim(),
      }, 15_000);
      dispatchConversation({ kind: "answered", key: questionKey(question) });
      return true;
    } catch (error) {
      dispatchMessage("system", `Question response failed: ${error.message}`, "error");
      return false;
    }
  }

  const view = conversationView(conversation);
  const inspectorConnection = connection.phase === "online" || connection.phase === "syncing" ? "connected" : "offline";

  if (connection.phase === "login") {
    return <LoginGate onSubmit={handleLogin} busy={authBusy} error={connection.message} initialToken={loginToken} />;
  }

  return <div className="app-shell">
    <ConnectionBar phase={connection.phase} syncRemaining={connection.syncRemaining} syncTotal={connection.syncTotal} url={endpoint} onChangeUrl={setEndpoint} onReconnect={reconnect} onLogout={logout} />
    <div className="workspace-grid">
      <SessionRail sessions={sessions} activeId={info.session_id} workspace={selectedWorkspace} workspaceDraft={workspaceDraft} workspaceBusy={workspaceBusy} workspaceMessage={workspaceMessage} loading={busySession || workspaceBusy} onWorkspaceDraftChange={setWorkspaceDraft} onWorkspaceApply={selectWorkspace} onNew={createSession} onSelect={(id) => loadSession(id, true)} />
      <main className="main-column">
        <Conversation messages={view.messages} draft={view.draft} plan={view.plan} active={view.active} onCancel={cancelTurn} />
        {/* Invariant: composer input is never disabled by connection state. */}
        <Composer value={input} onChange={setInput} onSubmit={submit} active={view.active} onCancel={cancelTurn} />
      </main>
      <Inspector info={info} stats={stats} goal={goal} plan={view.plan} models={info.models || []} effort={info.reasoning_effort || ""} connection={inspectorConnection} onModel={setModel} onEffort={setEffort} onRefreshModels={() => refreshModels(info.session_id)} onCompact={compact} compacting={compacting} currentModel={currentModel} />
    </div>
    {view.question && <QuestionDialog key={questionKey(view.question)} question={view.question} onAnswer={answerQuestion} />}
  </div>;
}

function QuestionDialog({ question, onAnswer }) {
  const options = Array.isArray(question.options) ? question.options : [];
  const [selected, setSelected] = useState(null);
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const customSelected = selected?.type === "custom";
  const canConfirm = selected && (!customSelected || custom.trim());

  async function submit(answer) {
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      if (!await onAnswer(answer)) setError("答案未发送成功，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="modal-backdrop">
    <div className="question-dialog">
      <div className="question-heading">
        <div>
          <span className="eyebrow">WORKER QUESTION</span>
          <h2><MessageCircleQuestion size={18} /> {question.question || "The worker needs an answer"}</h2>
        </div>
      </div>
      <div className="question-options">
        {options.map((option, index) => {
          const value = String(option?.value || option?.label || "");
          const active = selected?.type === "option" && selected.value === value;
          return <button className={active ? "selected" : ""} key={`${value}-${index}`} onClick={() => setSelected({ type: "option", value })} disabled={submitting}>
            <span><strong>{option?.label || value}</strong>{option?.description && <small>{option.description}</small>}</span>
            {active && <Check size={15} />}
          </button>;
        })}
        <button className={customSelected ? "selected custom-option" : "custom-option"} onClick={() => setSelected({ type: "custom" })} disabled={submitting}>
          <span><strong>自定义答案</strong><small>输入自己的回答</small></span>
          {customSelected && <Check size={15} />}
        </button>
      </div>
      {customSelected && <div className="custom-answer"><input autoFocus value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="输入自定义答案" disabled={submitting} onKeyDown={(event) => event.key === "Enter" && canConfirm && submit(custom.trim())} /></div>}
      {error && <div className="question-error">{error}</div>}
      <div className="question-actions">
        <button className="question-close" onClick={() => submit("")} disabled={submitting}><X size={15} /> 关闭</button>
        <button className="question-confirm" onClick={() => submit(customSelected ? custom.trim() : selected.value)} disabled={!canConfirm || submitting}>{submitting ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} 确认</button>
      </div>
    </div>
  </div>;
}

function formatResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  return JSON.stringify(result, null, 2);
}
