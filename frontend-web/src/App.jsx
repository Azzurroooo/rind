import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, MessageCircleQuestion, RefreshCw, X } from "lucide-react";
import { ConnectionBar } from "./components/ConnectionBar.jsx";
import { Composer } from "./components/Composer.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { SessionRail } from "./components/SessionRail.jsx";
import { methods, parseSlashCommand, sessionIdOf } from "./methods.js";
import { createRuntimeClient, initialRuntimeUrl } from "./runtimeClient.js";

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export default function App() {
  const [endpoint, setEndpoint] = useState(initialRuntimeUrl);
  const [connection, setConnection] = useState("connecting");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [info, setInfo] = useState({});
  const [sessions, setSessions] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [plan, setPlan] = useState([]);
  const [stats, setStats] = useState({});
  const [goal, setGoal] = useState(null);
  const [currentModel, setCurrentModel] = useState("");
  const [input, setInput] = useState("");
  const [active, setActive] = useState(false);
  const [turnId, setTurnId] = useState("");
  const [question, setQuestion] = useState(null);
  const [compacting, setCompacting] = useState(false);
  const [busySession, setBusySession] = useState(false);
  const initializingRef = useRef(false);
  const draftRef = useRef("");
  const lastEventAtRef = useRef(0);
  const workspaceRef = useRef("");
  const infoRef = useRef({});
  const currentModelRef = useRef("");
  const clientRef = useRef(null);
  workspaceRef.current = selectedWorkspace;
  infoRef.current = info;
  currentModelRef.current = currentModel;

  const appendMessage = useCallback((message) => {
    setMessages((current) => [...current, { id: `${Date.now()}-${Math.random()}`, ...message }]);
  }, []);

  const handleEvent = useCallback((message) => {
    const event = message?.event;
    if (!event || typeof event !== "object") return;
    lastEventAtRef.current = Date.now();
    switch (event.type) {
      case "turn_started":
        setActive(true);
        setTurnId(String(event.turn_id || ""));
        draftRef.current = "";
        setDraft("");
        return;
      case "assistant_delta":
        setActive(true);
        setDraft((current) => {
          const next = current + String(event.text || "");
          draftRef.current = next;
          return next;
        });
        return;
      case "assistant_message_completed":
        draftRef.current = "";
        setDraft("");
        if (event.content) appendMessage({ role: "assistant", content: String(event.content) });
        return;
      case "tool_requested":
      case "tool_call_started":
        {
          const tool = {
            id: event.tool_call_id,
            name: event.tool_name,
            args: event.args_preview || "",
            status: "running",
          };
          setMessages((current) => upsertToolMessage(current, tool));
        }
        return;
      case "tool_result":
        {
          const tool = {
            id: event.tool_call_id,
            name: event.tool_name,
            result: String(event.result || event.error_source || ""),
            status: event.status === "error" ? "failed" : event.status || "completed",
            duration_ms: event.duration_ms,
            error_type: event.error_type,
          };
          setMessages((current) => upsertToolMessage(current, tool));
        }
        return;
      case "file_change":
        {
          const tool = { id: event.tool_call_id, file: event.file_path };
          setMessages((current) => upsertToolMessage(current, tool));
        }
        return;
      case "plan_updated":
        setPlan(Array.isArray(event.plan) ? event.plan : []);
        return;
      case "context_built":
      case "token_stats_updated":
        setStats(event.stats && typeof event.stats === "object" ? event.stats : {});
        return;
      case "user_question_requested":
        setQuestion({ toolCallId: event.tool_call_id, question: event.question, options: Array.isArray(event.options) ? event.options : [] });
        return;
      case "queued_input_delivered":
        appendMessage({ role: "system", content: `Steering input delivered: ${event.input || ""}` });
        return;
      case "goal_continued":
        appendMessage({ role: "system", content: `Goal continuation · round ${event.round || "?"}` });
        return;
      case "turn_failed":
        finishTurn();
        appendMessage({ role: "system", content: formatTurnFailure(event), tone: "error" });
        return;
      case "turn_cancelled":
        finishTurn();
        appendMessage({ role: "system", content: "Turn cancelled." });
        return;
      case "turn_completed":
        finishTurn();
        return;
      default:
        return;
    }
  }, [appendMessage]);

  function finishTurn() {
    setActive(false);
    setTurnId("");
    const pendingDraft = draftRef.current;
    draftRef.current = "";
    setDraft("");
    if (pendingDraft) appendMessage({ role: "assistant", content: pendingDraft });
    void refreshSessions(workspaceRef.current || infoRef.current.workspace_root);
  }

  const initializeRuntime = useCallback(async () => {
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
      setConnectionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      initializingRef.current = false;
    }
  }, []);

  const client = useMemo(() => createRuntimeClient({
    url: endpoint,
    onEvent: handleEvent,
    onStatus: (status) => {
      setConnection(status.state);
      if (status.message) setConnectionMessage(status.message);
    },
    onOpen: initializeRuntime,
  }), []);
  clientRef.current = client;

  useEffect(() => {
    client.connect().catch((error) => setConnectionMessage(error.message));
    return () => client.disconnect();
  }, [client]);

  useEffect(() => {
    if (connection !== "connected" || !active || !info.session_id) return undefined;
    const timer = window.setInterval(async () => {
      if (Date.now() - lastEventAtRef.current < 1500) return;
      try {
        const replay = await clientRef.current.request(methods.sessionReplay, { session_id: info.session_id });
        if (replay?.live_turn) {
          syncLiveTurn(replay.live_turn);
        } else {
          setMessages(normalizeMessages(replay?.messages));
          syncLiveTurn(null);
        }
      } catch {
        // Reconnect logic owns the next attempt.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [connection, active, info.session_id, turnId]);

  async function refreshSessions(workspace = selectedWorkspace || info.workspace_root) {
    if (!clientRef.current) return;
    try {
      const params = { limit: 30 };
      if (workspace) params.workspace_root = workspace;
      const result = await clientRef.current.request(methods.sessionList, params);
      setSessions(Array.isArray(result?.sessions) ? result.sessions : []);
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : String(error));
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
      const switched = switchSession ? await clientRef.current.request(methods.sessionSwitch, { session_id: target }) : info;
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
      setMessages(normalizeMessages(replay?.messages));
      draftRef.current = "";
      setDraft("");
      syncLiveTurn(replay?.live_turn || null);
      setGoal(switched?.goal || null);
      setStats(switched?.usage || {});
    } catch (error) {
      appendMessage({ role: "system", content: `Unable to open session: ${error instanceof Error ? error.message : String(error)}`, tone: "error" });
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
      appendMessage({ role: "system", content: `Unable to create session: ${error.message}`, tone: "error" });
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
        setMessages([]);
        setPlan([]);
        setStats({});
        setGoal(null);
        appendMessage({ role: "system", content: `No sessions in ${workspace}. Create a new session to begin.` });
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
    setActive(false);
    setTurnId("");
    draftRef.current = "";
    setDraft("");
    setQuestion(null);
  }

  async function submit() {
    const text = input.trim();
    if (!text || !clientRef.current) return;
    setInput("");
    if (text.startsWith("/")) {
      await runSlashCommand(text);
      return;
    }
    if (active) {
      try {
        await clientRef.current.request(methods.sessionSteer, { session_id: info.session_id, turn_id: turnId, input: text });
        appendMessage({ role: "system", content: `Steering input queued: ${text}` });
      } catch (error) {
        appendMessage({ role: "system", content: `Unable to steer turn: ${error.message}`, tone: "error" });
      }
      return;
    }
    appendMessage({ role: "user", content: text });
    setActive(true);
    try {
      await clientRef.current.request(methods.sessionPrompt, { session_id: info.session_id, input: text });
    } catch (error) {
      setActive(false);
      appendMessage({ role: "system", content: `Prompt failed: ${error.message}`, tone: "error" });
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
        appendMessage({ role: "system", content: "Session list refreshed." });
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
      appendMessage({ role: "system", content: result?.text || formatResult(result) });
    } catch (error) {
      appendMessage({ role: "system", content: `Command failed: ${error.message}`, tone: "error" });
    }
  }

  async function runGoalCommand(argument) {
    const action = argument.trim().toLowerCase();
    if (!action) {
      const result = await clientRef.current.request(methods.goalGet, { session_id: info.session_id });
      setGoal(result?.goal || null);
      appendMessage({ role: "system", content: result?.goal?.objective ? `Active goal: ${result.goal.objective}` : "No active goal." });
      return;
    }
    if (action === "clear") {
      await clientRef.current.request(methods.goalClear, { session_id: info.session_id });
      setGoal(null);
      appendMessage({ role: "system", content: "Goal cleared." });
      return;
    }
    if (action === "pause" || action === "resume") {
      const result = await clientRef.current.request(methods.goalStatus, { session_id: info.session_id, status: action === "resume" ? "active" : "paused" });
      setGoal(result?.goal || null);
      appendMessage({ role: "system", content: `Goal ${action}d.` });
      return;
    }
    const result = await clientRef.current.request(methods.goalSet, { session_id: info.session_id, objective: argument });
    setGoal(result?.goal || null);
    appendMessage({ role: "system", content: `Goal set: ${argument}` });
  }

  async function setModel(model) {
    const clean = String(model || "").trim();
    if (!clean) return;
    const result = await clientRef.current.request(methods.modelSet, { session_id: info.session_id, model: clean });
    const next = String(result?.session_model || result?.model || clean).trim();
    setCurrentModel(next);
    setInfo((current) => ({ ...current, model: next }));
    appendMessage({ role: "system", content: `Model updated to ${next}.` });
  }

  async function setEffort(effort) {
    const clean = String(effort || "").trim().toLowerCase();
    if (!REASONING_EFFORTS.includes(clean)) return;
    const result = await clientRef.current.request(methods.modelEffort, { session_id: info.session_id, reasoning_effort: clean });
    const next = String(result?.reasoning_effort || clean).trim();
    setInfo((current) => ({ ...current, reasoning_effort: next }));
    appendMessage({ role: "system", content: `Reasoning effort set to ${next}.` });
  }

  async function compact() {
    if (compacting || active) {
      appendMessage({ role: "system", content: active ? "Finish or stop the active turn before compacting." : "Compaction is already running." });
      return;
    }
    setCompacting(true);
    try {
      const result = await clientRef.current.request(methods.sessionCompact, { session_id: info.session_id });
      appendMessage({ role: "system", content: `Context compacted${result?.source ? ` · messages ${result.source.message_start_index ?? "?"}-${result.source.message_end_index_exclusive ?? "?"}` : ""}.` });
    } catch (error) {
      appendMessage({ role: "system", content: `Compaction failed: ${error.message}`, tone: "error" });
    } finally {
      setCompacting(false);
    }
  }

  async function cancelTurn() {
    try {
      await clientRef.current.request(methods.sessionCancel, { session_id: info.session_id, ...(turnId ? { turn_id: turnId } : {}) });
    } catch (error) {
      setConnectionMessage(error.message);
    }
  }

  function syncLiveTurn(liveTurn) {
    if (!liveTurn) {
      setActive(false);
      setTurnId("");
      draftRef.current = "";
      setDraft("");
      setQuestion(null);
      return;
    }
    const liveDraft = String(liveTurn.assistant_text || "");
    draftRef.current = liveDraft;
    setDraft(liveDraft);
    setMessages((current) => mergeLiveTools(current, liveTurn.tools));
    setPlan(Array.isArray(liveTurn.plan) ? liveTurn.plan : []);
    setQuestion(liveTurn.question || null);
    setActive(liveTurn.status === "running");
    setTurnId(String(liveTurn.turn_id || ""));
  }

  async function answerQuestion(answer) {
    if (!question) return;
    try {
      await clientRef.current.request(methods.userQuestionRespond, { session_id: info.session_id, tool_call_id: question.toolCallId, answer });
      setQuestion(null);
    } catch (error) {
      appendMessage({ role: "system", content: `Question response failed: ${error.message}`, tone: "error" });
    }
  }

  async function reconnect() {
    clientRef.current.setUrl(endpoint);
    await clientRef.current.connect().catch((error) => setConnectionMessage(error.message));
  }

  return <div className="app-shell">
    <ConnectionBar state={connection} url={endpoint} onChangeUrl={setEndpoint} onReconnect={reconnect} onDisconnect={() => clientRef.current.disconnect()} />
    <div className="workspace-grid">
      <SessionRail sessions={sessions} activeId={info.session_id} workspace={selectedWorkspace} workspaceDraft={workspaceDraft} workspaceBusy={workspaceBusy} workspaceMessage={workspaceMessage} loading={busySession || workspaceBusy} onWorkspaceDraftChange={setWorkspaceDraft} onWorkspaceApply={selectWorkspace} onNew={createSession} onSelect={(id) => loadSession(id, true)} />
      <main className="main-column">
      <Conversation messages={messages} draft={draft} plan={plan} active={active} onCancel={cancelTurn} />
        <Composer value={input} onChange={setInput} onSubmit={submit} active={active} onCancel={cancelTurn} disabled={connection !== "connected" || busySession} />
      </main>
      <Inspector info={info} stats={stats} goal={goal} plan={plan} models={info.models || []} effort={info.reasoning_effort || ""} connection={connection} onModel={setModel} onEffort={setEffort} onRefreshModels={() => refreshModels(info.session_id)} onCompact={compact} compacting={compacting} currentModel={currentModel} />
    </div>
    {connection !== "connected" && <div className="connection-banner"><AlertCircle size={16} /><span>{connectionMessage || "Start the Rind worker with --web to connect."}</span><button className="icon-button subtle" title="Retry connection" onClick={reconnect}><RefreshCw size={15} /></button></div>}
    {question && <QuestionDialog question={question} onAnswer={answerQuestion} onDismiss={() => setQuestion(null)} />}
  </div>;
}

function QuestionDialog({ question, onAnswer, onDismiss }) {
  const [custom, setCustom] = useState("");
  return <div className="modal-backdrop"><div className="question-dialog"><div className="question-heading"><div><span className="eyebrow">WORKER QUESTION</span><h2><MessageCircleQuestion size={18} /> {question.question || "The worker needs an answer"}</h2></div><button className="icon-button subtle" title="Dismiss question" onClick={onDismiss}><X size={17} /></button></div><div className="question-options">{question.options.map((option) => <button key={option.label || option.value} onClick={() => onAnswer(option.value || option.label)}><span>{option.label || option.value}</span><Check size={15} /></button>)}</div><div className="custom-answer"><input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Type a custom answer" onKeyDown={(event) => event.key === "Enter" && custom.trim() && onAnswer(custom.trim())} /><button className="send-button" onClick={() => custom.trim() && onAnswer(custom.trim())} disabled={!custom.trim()}><Check size={16} /></button></div></div></div>;
}

function upsertTool(current, patch) {
  if (!patch.id) return current;
  const index = current.findIndex((tool) => tool.id === patch.id);
  if (index < 0) return [...current, patch];
  const next = [...current];
  next[index] = { ...next[index], ...patch };
  return next;
}

function upsertToolMessage(current, patch) {
  if (!patch.id) return current;
  const index = current.findIndex((message) => message.role === "tool" && message.tool_call_id === patch.id);
  if (index < 0) return [...current, { role: "tool", id: `tool-${patch.id}`, tool_call_id: patch.id, ...patch }];
  const next = [...current];
  next[index] = { ...next[index], ...patch };
  return next;
}

function mergeLiveTools(current, values) {
  return (Array.isArray(values) ? values : []).reduce((messages, tool) => upsertToolMessage(messages, {
    id: tool.tool_call_id,
    name: tool.tool_name,
    args: tool.args_preview || "",
    result: tool.output || "",
    status: tool.status === "error" ? "failed" : tool.status === "completed" ? "completed" : "running",
  }), current);
}

function normalizeMessages(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((message) => ["user", "assistant", "tool"].includes(message?.role)).map((message, index) => {
    if (message.role === "tool") {
      const content = contentText(message.content);
      const payload = parseToolPayload(content);
      return {
        id: message.id || `history-tool-${message.tool_call_id || index}`,
        role: "tool",
        tool_call_id: message.tool_call_id || `history-${index}`,
        name: message.name || message.tool_name || payload?.tool || "tool",
        result: content,
        status: payload?.ok === false ? "failed" : "completed",
      };
    }
    return {
      id: message.id || `history-${index}`,
      role: message.role,
      content: contentText(message.content),
      meta: "",
    };
  }).filter((message) => message.role === "tool" || message.content);
}

function parseToolPayload(content) {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text || "").join("");
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function formatResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  return JSON.stringify(result, null, 2);
}

function formatTurnFailure(event) {
  const message = String(event?.error || "Runtime error");
  const details = [event?.error_type, event?.error_source].filter(Boolean).join(" · ");
  return details ? `Turn failed: ${message} (${details})` : `Turn failed: ${message}`;
}
