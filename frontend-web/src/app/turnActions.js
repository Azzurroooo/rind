import { methods } from "../methods.js";
import { fileToBase64, uploadTargetPath } from "../lib/files.js";
import { findModelOption } from "../lib/models.js";
import { questionKey } from "../state/conversationReducer.js";
import { REASONING_EFFORTS, errorText } from "./constants.js";

export const QUEUE_MODES = Object.freeze({ followUp: "follow_up", steering: "steering" });

// Turn-level actions: prompt / queue / steer, queued-input management, model
// and effort, compaction, cancel, goal, attachments and question answers.
export function createTurnActions(ctx) {
  const { refs, dispatchConversation } = ctx;
  const call = () => ctx.call.current;
  const client = () => refs.client.current;
  const say = (...args) => call().dispatchMessage(...args);

  function clearDraft(sessionId) {
    ctx.setInput("");
    refs.input.current = "";
    refs.drafts.current = { ...refs.drafts.current, [sessionId]: "" };
  }

  // `composed` already carries attachment reference lines. While a turn runs
  // the text is queued: follow_up by default, steering with Alt+Enter.
  async function submit(composed, { mode = QUEUE_MODES.followUp } = {}) {
    if (refs.conv.current.operation === "compact" || refs.compactions.current.has(refs.info.current.session_id)) return;
    const text = String(composed ?? ctx.input).trim();
    if (!text || !client() || refs.switching.current) return;
    const run = refs.connectionRun.current;
    const submittedSession = refs.info.current.session_id || "";
    clearDraft(submittedSession);
    if (text.startsWith("/")) {
      await call().runSlashCommand(text);
      return;
    }
    const starting = refs.promptStarts.current.get(submittedSession);
    if (starting && !starting.turnId) await starting.ready;
    if (run !== refs.connectionRun.current) { restoreDraft(text, submittedSession); return; }
    const turnId = starting?.turnId || (submittedSession === refs.info.current.session_id ? refs.conv.current.activeTurnId : "");
    if (turnId || (submittedSession === refs.info.current.session_id && refs.conv.current.active)) {
      await queueInput(text, submittedSession, mode === QUEUE_MODES.steering ? QUEUE_MODES.steering : QUEUE_MODES.followUp, turnId);
      return;
    }
    await sendPrompt(text, submittedSession);
  }

  async function queueInput(text, sessionId, mode, turnId) {
    const run = refs.connectionRun.current;
    const method = mode === QUEUE_MODES.steering ? methods.sessionSteer : methods.sessionFollowUp;
    try {
      // Steer is turn-scoped: the kernel rejects it without the active turn_id.
      const params = mode === QUEUE_MODES.steering && turnId ? { session_id: sessionId, input: text, turn_id: turnId } : { session_id: sessionId, input: text };
      const result = await client().request(method, params);
      if (run !== refs.connectionRun.current || sessionId !== refs.info.current.session_id) return;
      const inputId = String(result?.input_id || "").trim();
      if (inputId) dispatchConversation({ kind: "queue_input", inputId, input: text, mode });
      else throw new Error("The runtime did not confirm the queued message.");
    } catch (error) {
      if (run !== refs.connectionRun.current) return;
      if (error?.type === "TurnNotActive" || error?.name === "TurnNotActive") {
        // The reply may settle between the click and the queue RPC.
        await sendPrompt(text, sessionId);
        return;
      }
      restoreDraft(text, sessionId);
      if (sessionId === refs.info.current.session_id) say("system", `Unable to queue input: ${errorText(error)}`, "error");
    }
  }

  async function sendPrompt(text, submittedSession) {
    const run = refs.connectionRun.current;
    const loadId = refs.sessionLoad.current;
    // First-message auto-session: a brand-new workspace has no session yet.
    let sessionId = submittedSession;
    if (!sessionId) {
      const workspace = ctx.selectedWorkspace || refs.info.current.workspace_root;
      const selection = { model: refs.currentModel.current || refs.info.current.model, provider: refs.currentProvider.current, effort: refs.info.current.reasoning_effort };
      try {
        const result = await client().request(methods.sessionNew, { workspace_root: workspace });
        if (run !== refs.connectionRun.current) return;
        sessionId = String(result?.session_id || "");
        if (!sessionId) throw new Error("The runtime did not create a session.");
        if (selection.model && (selection.model !== result.model || (selection.provider && selection.provider !== result.provider))) {
          await client().request(methods.modelSet, { session_id: sessionId, model: selection.model, ...(selection.provider ? { provider_id: selection.provider } : {}) });
        }
        if (selection.effort && selection.effort !== result.reasoning_effort) {
          await client().request(methods.modelEffort, { session_id: sessionId, reasoning_effort: selection.effort });
        }
        if (run !== refs.connectionRun.current) return;
        if (loadId === refs.sessionLoad.current) {
          ctx.setSelectedWorkspace(workspace);
          await call().loadSession(sessionId, true);
          await call().refreshSessions(workspace);
        }
      } catch (error) {
        if (run !== refs.connectionRun.current) return;
        restoreDraft(text, submittedSession);
        if (loadId === refs.sessionLoad.current) say("system", `Unable to create session: ${errorText(error)}`, "error");
        return;
      }
    }
    const inputId = newInputId();
    const starting = { turnId: "", resolve: () => {} };
    starting.ready = new Promise((resolve) => { starting.resolve = resolve; });
    refs.promptStarts.current.set(sessionId, starting);
    if (sessionId === refs.info.current.session_id) dispatchConversation({ kind: "message", role: "user", content: text, inputId });
    try {
      await client().request(methods.sessionPrompt, { session_id: sessionId, input: text, client_input_id: inputId });
    } catch (error) {
      if (run !== refs.connectionRun.current) return;
      restoreDraft(text, sessionId);
      if (sessionId === refs.info.current.session_id) say("system", `Prompt failed: ${errorText(error)}`, "error");
    } finally {
      starting.turnId = "";
      starting.resolve();
      if (refs.promptStarts.current.get(sessionId) === starting) refs.promptStarts.current.delete(sessionId);
    }
  }

  // A failed submit never eats the user's text: the draft comes back
  // (prepended to whatever they typed since) instead of vanishing.
  function restoreDraft(text, sessionId = refs.info.current.session_id || "") {
    const clean = String(text || "");
    if (!clean) return;
    const current = sessionId === (refs.info.current.session_id || "");
    const restored = [clean, current ? refs.input.current : refs.drafts.current[sessionId]].filter(Boolean).join("\n");
    refs.drafts.current = { ...refs.drafts.current, [sessionId]: restored };
    if (current) {
      refs.input.current = restored;
      ctx.setInput(restored);
    }
  }

  function dequeueMethod(entry) {
    return entry.mode === QUEUE_MODES.steering ? methods.sessionUnsteer : methods.sessionDequeueFollowUp;
  }

  // Edit: pull the queued text back into the draft.
  async function retrieveQueued(entry) {
    const sessionId = refs.info.current.session_id;
    const run = refs.connectionRun.current;
    try {
      const result = await client().request(dequeueMethod(entry), { session_id: sessionId, input_id: entry.inputId });
      if (run !== refs.connectionRun.current) return;
      restoreDraft(String(result?.input || entry.input || ""), sessionId);
      if (sessionId === refs.info.current.session_id) {
        dispatchConversation({ kind: "unqueue", inputId: entry.inputId });
        refs.composer.current?.focus();
      }
    } catch (error) {
      if (run === refs.connectionRun.current && sessionId === refs.info.current.session_id) say("system", `Failed to retrieve: ${errorText(error)}`, "error");
    }
  }

  // Remove: drop the queued input without touching the draft.
  async function removeQueued(entry) {
    const sessionId = refs.info.current.session_id;
    const loadId = refs.sessionLoad.current;
    try {
      await client().request(dequeueMethod(entry), { session_id: sessionId, input_id: entry.inputId });
      if (loadId === refs.sessionLoad.current) dispatchConversation({ kind: "unqueue", inputId: entry.inputId });
    } catch (error) {
      if (loadId === refs.sessionLoad.current) say("system", `Failed to remove: ${errorText(error)}`, "error");
    }
  }

  async function promoteQueued(entry) {
    const sessionId = refs.info.current.session_id;
    const loadId = refs.sessionLoad.current;
    try {
      await client().request(methods.sessionPromoteFollowUp, { session_id: sessionId, input_id: entry.inputId });
      if (loadId === refs.sessionLoad.current) dispatchConversation({ kind: "requeue", inputId: entry.inputId, mode: QUEUE_MODES.steering });
    } catch (error) {
      if (loadId === refs.sessionLoad.current) say("system", `Failed to redirect: ${errorText(error)}`, "error");
    }
  }

  // Retry: resend the last user prompt before the failed entry.
  async function retryTurn(message) {
    const entries = refs.conv.current.entries;
    const index = entries.findIndex((entry) => entry.id === message?.id);
    const before = entries.slice(0, index < 0 ? entries.length : index);
    const prompt = [...before].reverse().find((entry) => entry?.role === "user" && entry?.content)?.content || "";
    if (!prompt || !client()) return;
    await submit(prompt);
  }

  // Edit & resend: the message text goes back into the composer.
  function editMessage(message) {
    const text = String(message?.content || "");
    if (!text) return;
    refs.input.current = text;
    ctx.setInput(text);
    refs.composer.current?.focus();
  }

  // Accepts the picker's { providerId, modelId } or a plain model name, which
  // resolves against the loaded options so model/set carries provider_id.
  async function setModel(selection) {
    const option = typeof selection === "string" || selection == null
      ? findModelOption(refs.info.current.models || [], selection)
      : selection;
    const modelId = String(option?.modelId ?? option?.id ?? selection ?? "").trim();
    if (!modelId) return;
    const providerId = String(option?.providerId ?? "").trim();
    const sessionId = refs.info.current.session_id;
    if (!sessionId) {
      refs.currentModel.current = modelId;
      refs.currentProvider.current = providerId;
      refs.info.current = { ...refs.info.current, model: modelId, provider: providerId };
      ctx.setCurrentModel(modelId);
      ctx.setCurrentProvider(providerId);
      ctx.setInfo((current) => ({ ...current, model: modelId, provider: providerId }));
      return;
    }
    const loadId = refs.sessionLoad.current;
    const result = await client().request(methods.modelSet, {
      session_id: sessionId,
      model: modelId,
      ...(providerId ? { provider_id: providerId } : {}),
    });
    if (loadId !== refs.sessionLoad.current || sessionId !== refs.info.current.session_id) return;
    const next = String(result?.session_model || result?.model || modelId).trim();
    const nextProvider = String(result?.provider_id ?? providerId ?? "").trim();
    ctx.setCurrentModel(next);
    ctx.setCurrentProvider(nextProvider);
    ctx.setInfo((current) => {
      const known = (current.models || []).some((model) => model.id === next && (model.providerId || "") === nextProvider);
      return {
        ...current,
        model: next,
        models: known ? current.models : [...(current.models || []), { id: next, providerId: nextProvider, contextWindow: null, imageInput: null }],
      };
    });
    say("system", `Model updated to ${next}.`);
  }

  async function setEffort(effort) {
    const clean = String(effort || "").trim().toLowerCase();
    if (!REASONING_EFFORTS.includes(clean)) {
      say("system", `Unknown reasoning effort: ${effort}`, "error");
      return;
    }
    const sessionId = refs.info.current.session_id;
    const loadId = refs.sessionLoad.current;
    if (!sessionId) {
      refs.info.current = { ...refs.info.current, reasoning_effort: clean };
      ctx.setInfo((current) => ({ ...current, reasoning_effort: clean }));
      return;
    }
    const result = await client().request(methods.modelEffort, { session_id: sessionId, reasoning_effort: clean });
    if (loadId !== refs.sessionLoad.current || sessionId !== refs.info.current.session_id) return;
    const next = String(result?.reasoning_effort || clean).trim();
    ctx.setInfo((current) => ({ ...current, reasoning_effort: next }));
    say("system", `Reasoning effort set to ${next}.`);
  }

  async function compact() {
    const sessionId = refs.info.current.session_id;
    if (!sessionId || !client()) return;
    if (refs.compactions.current.has(sessionId) || refs.conv.current.active) {
      say("system", refs.conv.current.active ? "Finish or stop the active turn before compacting." : "Compaction is already running.");
      return;
    }
    const run = refs.connectionRun.current;
    const token = Symbol();
    refs.compactions.current.set(sessionId, token);
    ctx.setCompacting(sessionId);
    const loadId = refs.sessionLoad.current;
    try {
      await client().request(methods.sessionCompact, { session_id: sessionId });
      if (loadId !== refs.sessionLoad.current || run !== refs.connectionRun.current) return;
      // The durable context_compacted event owns the transcript notice on all clients.
      void call().refreshContext();
    } catch (error) {
      if (loadId === refs.sessionLoad.current && run === refs.connectionRun.current) say("system", `Compaction failed: ${errorText(error)}`, "error");
    } finally {
      if (refs.compactions.current.get(sessionId) === token) {
        refs.compactions.current.delete(sessionId);
        ctx.setCompacting((current) => current === sessionId ? "" : current);
      }
    }
  }

  async function cancelTurn() {
    const turnId = refs.conv.current.activeTurnId;
    try {
      await client().request(methods.sessionCancel, turnId ? { session_id: refs.info.current.session_id, turn_id: turnId } : { session_id: refs.info.current.session_id });
    } catch (error) {
      say("system", errorText(error), "error");
    }
  }

  // Goal command with an argument: set / clear / pause / resume (CLI parity).
  async function runGoalCommand(argument) {
    const action = argument.trim().toLowerCase();
    const sessionId = refs.info.current.session_id;
    const loadId = refs.sessionLoad.current;
    const fresh = () => loadId === refs.sessionLoad.current;
    if (!action) {
      const result = await client().request(methods.goalGet, { session_id: sessionId });
      if (!fresh()) return;
      ctx.setGoal(result?.goal || null);
      say("system", result?.goal?.objective ? `Active goal: ${result.goal.objective}` : "No active goal.");
      return;
    }
    if (action === "clear") {
      await client().request(methods.goalClear, { session_id: sessionId });
      if (!fresh()) return;
      ctx.setGoal(null);
      say("system", "Goal cleared.");
      return;
    }
    if (action === "pause" || action === "resume") {
      const result = await client().request(methods.goalStatus, { session_id: sessionId, status: action === "resume" ? "active" : "paused" });
      if (!fresh()) return;
      ctx.setGoal(result?.goal || null);
      say("system", `Goal ${action}d.`);
      return;
    }
    const result = await client().request(methods.goalSet, { session_id: sessionId, objective: argument });
    if (!fresh()) return;
    ctx.setGoal(result?.goal || null);
    say("system", `Goal set: ${argument}`);
  }

  async function handleGoalAction(action) {
    const sessionId = refs.info.current.session_id;
    const loadId = refs.sessionLoad.current;
    if (!sessionId) throw new Error("Create a session before setting a goal.");
    const method = action.type === "clear" ? methods.goalClear : action.type === "start" ? methods.goalSet : methods.goalStatus;
    const params = action.type === "start" ? { objective: action.objective } : { status: action.type === "resume" ? "active" : "paused" };
    const result = await client().request(method, { session_id: sessionId, ...params });
    if (loadId === refs.sessionLoad.current && sessionId === refs.info.current.session_id) ctx.setGoal(action.type === "clear" ? null : result?.goal || null);
  }

  function assertFileWorkspace() {
    if (!refs.info.current.gateway?.files_follow_session && refs.info.current.workspace_root !== refs.startupWorkspace.current) {
      throw new Error("This worker exposes only its startup folder. Use desktop remote access for files in other workspaces.");
    }
  }

  // Attachments: base64 then file/write into the uploads/ subtree.
  async function uploadAttachment(file) {
    const sessionId = refs.info.current.session_id;
    assertFileWorkspace();
    const content_base64 = await fileToBase64(file);
    const path = uploadTargetPath(file?.name || "pasted-image", new Date());
    const result = await client()?.request(methods.fileWrite, { path, content_base64, session_id: sessionId });
    return String(result?.path || path);
  }

  async function listFiles(path) {
    assertFileWorkspace();
    return client().request(methods.fileList, { path: path || "", session_id: refs.info.current.session_id });
  }

  async function readFile(path) {
    assertFileWorkspace();
    return client().request(methods.fileRead, { path, session_id: refs.info.current.session_id });
  }

  async function answerQuestion(question, answer) {
    if (!question || question.status !== "pending") return false;
    const text = String(answer || "").trim();
    try {
      await client().request(methods.userQuestionRespond, {
        session_id: question.sessionId || refs.info.current.session_id,
        tool_call_id: question.toolCallId,
        answer: text,
      }, 15_000);
      dispatchConversation({ kind: "answered", key: questionKey(question), answer: text });
      return true;
    } catch (error) {
      say("system", `Question response failed: ${errorText(error)}`, "error");
      return false;
    }
  }

  return {
    submit, restoreDraft, retrieveQueued, removeQueued, promoteQueued, retryTurn, editMessage,
    setModel, setEffort, compact, cancelTurn, runGoalCommand, handleGoalAction,
    uploadAttachment, listFiles, readFile, answerQuestion,
  };
}

// LAN HTTP is not a secure context: randomUUID may not be available on phones.
function newInputId() {
  return `input-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("-")}`;
}
