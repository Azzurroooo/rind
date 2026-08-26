import { runtimeEventType } from "./runtime-protocol.js";
import {
  cancelledText,
  contextBuiltLine,
  errorLine,
  goalContinuedLine,
  planUpdatedLine,
  turnCompletedLine,
} from "./rendering.js";

export function createEventController({
  state = {},
  input = {},
  output = {},
  monitor = {},
}) {
  const pendingFileChanges = new Map();
  const pendingPlanInputs = new Map();
  const turnFiles = new Map();
  let toolStats = { completed: 0, failed: 0 };
  let tokenStart = null;
  let tokenLast = null;

  async function handle(message) {
    if (state.runtimeClosing) {
      return;
    }
    const event = message?.event;
    const eventType = runtimeEventType(message);
    if (!event || typeof event !== "object") {
      if (state.debug) {
        output.debug?.(`Ignoring runtime event without payload: ${eventType || "unknown"}`);
      }
      return;
    }
    switch (eventType) {
      case "turn_started":
        tokenStart = null;
        return;
      case "assistant_delta":
        output.assistantAppend?.(event.text || "");
        return;
      case "context_built": {
        if (output.handleContextBuilt?.(event)) {
          output.resetContextUsage?.();
        }
        const line = contextBuiltLine(event);
        if (line) {
          output.closeAssistant?.();
          output.log?.(() => line);
        }
        return;
      }
      case "tool_input_started":
        output.closeAssistant?.();
        rememberPlanInputStart(event);
        output.beginTool?.(event);
        return;
      case "tool_input_delta":
        appendPlanInput(event);
        return;
      case "tool_input_ended":
        return;
      case "tool_requested":
        output.closeAssistant?.();
        rememberPlanInputPreview(event);
        monitor.recordCommand?.(event);
        monitor.recordDelegateRequest?.(event);
        output.beginTool?.(event);
        return;
      case "tool_call_started":
        output.closeAssistant?.();
        output.beginTool?.(event);
        return;
      case "tool_result": {
        output.closeAssistant?.();
        const fileChange = pendingFileChanges.get(event.tool_call_id);
        pendingFileChanges.delete(event.tool_call_id);
        const planInput = takePlanInput(event);
        monitor.recordResult?.(event);
        monitor.recordDelegateResult?.(event);
        recordToolResult(event);
        const plan = event.tool_name === "update_plan" && event.status === "completed"
          ? parsePlanInput(planInput)
          : null;
        const goal = event.tool_name === "update_goal" && event.status === "completed"
          ? parseToolData(event.result)
          : null;
        if (goal?.status) {
          output.updateGoal?.(goal);
        }
        if (plan) {
          output.log?.(() => planUpdatedLine(plan));
        }
        output.finishTool?.(event, fileChange);
        return;
      }
      case "file_change":
        if (event.tool_call_id) {
          pendingFileChanges.set(event.tool_call_id, event);
        }
        recordFileChange(event);
        return;
      case "plan_updated":
        output.updatePlan?.(Array.isArray(event.plan) ? event.plan : []);
        return;
      case "tool_progress": {
        const message = progressMessage(event.payload);
        if (message) {
          output.closeAssistant?.();
          output.updateToolProgress?.(event.tool_call_id, message);
        }
        return;
      }
      case "token_stats_updated":
        output.closeAssistant?.();
        output.setStats?.(event.stats && typeof event.stats === "object" ? event.stats : {});
        tokenLast = Number(event.stats?.input_tokens);
        if (!Number.isFinite(tokenLast)) {
          tokenLast = null;
        } else if (tokenStart === null && state.activeTurn) {
          tokenStart = tokenLast;
        }
        if (!state.activeTurn) {
          output.redraw?.();
        }
        return;
      case "user_question_requested":
        await input.answerQuestion?.(event);
        return;
      case "queued_input_delivered":
        output.setGoalChasing?.(false);
        output.deliverQueuedInput?.(event.input || "", event.mode || "steering", event.input_id || "");
        return;
      case "goal_continued":
        output.closeAssistant?.();
        output.setGoalChasing?.(true);
        output.log?.(() => goalContinuedLine(event.round));
        return;
      case "turn_failed":
        output.clearQueuedInputs?.();
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.setGoalChasing?.(false);
        output.log?.(() => errorLine(event.error));
        resetTurnState();
        return;
      case "turn_cancelled":
        output.clearQueuedInputs?.();
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.setGoalChasing?.(false);
        output.log?.(() => cancelledText());
        resetTurnState();
        return;
      case "turn_completed":
        output.clearQueuedInputs?.();
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.setGoalChasing?.(false);
        output.log?.(turnCompletedLine(event, toolStats, turnSummary()));
        resetTurnState();
        return;
      default:
        if (state.debug) {
          output.debug?.(`Ignoring unknown runtime event: ${eventType || "unknown"}`);
        }
    }
  }

  function progressMessage(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    for (const key of ["message", "status", "text"]) {
      const value = String(payload[key] || "").trim();
      if (value) {
        return value;
      }
    }
    return "";
  }

  function resetTurnState() {
    toolStats = { completed: 0, failed: 0 };
    pendingFileChanges.clear();
    pendingPlanInputs.clear();
    turnFiles.clear();
    tokenStart = null;
    tokenLast = null;
    monitor.clearDelegates?.();
  }

  function recordFileChange(event) {
    const filePath = String(event?.file_path || "");
    if (!filePath) {
      return;
    }
    const entry = turnFiles.get(filePath) || { added: 0, removed: 0 };
    for (const line of Array.isArray(event?.lines) ? event.lines : []) {
      if (line?.kind === "added") {
        entry.added += 1;
      } else if (line?.kind === "removed") {
        entry.removed += 1;
      }
    }
    turnFiles.set(filePath, entry);
  }

  function turnSummary() {
    let added = 0;
    let removed = 0;
    for (const entry of turnFiles.values()) {
      added += entry.added;
      removed += entry.removed;
    }
    const tokens = tokenStart !== null && tokenLast !== null ? Math.max(0, tokenLast - tokenStart) : 0;
    return { files: turnFiles.size, added, removed, tokens };
  }

  function recordToolResult(event) {
    if (event.status === "failed") {
      toolStats.failed += 1;
      return;
    }
    toolStats.completed += 1;
  }

  function rememberPlanInputStart(event) {
    if (event.tool_name === "update_plan" && event.tool_call_id) {
      pendingPlanInputs.set(event.tool_call_id, "");
    }
  }

  function appendPlanInput(event) {
    if (event.tool_name !== "update_plan" || !event.tool_call_id) {
      return;
    }
    const current = pendingPlanInputs.get(event.tool_call_id);
    if (current !== undefined) {
      pendingPlanInputs.set(event.tool_call_id, current + String(event.delta || ""));
    }
  }

  function rememberPlanInputPreview(event) {
    if (event.tool_name !== "update_plan" || !event.tool_call_id) {
      return;
    }
    const current = pendingPlanInputs.get(event.tool_call_id);
    if (!current) {
      pendingPlanInputs.set(event.tool_call_id, String(event.args_preview || ""));
    }
  }

  function takePlanInput(event) {
    if (event.tool_name !== "update_plan" || !event.tool_call_id) {
      return "";
    }
    const value = pendingPlanInputs.get(event.tool_call_id) || "";
    pendingPlanInputs.delete(event.tool_call_id);
    return value;
  }

  return {
    handle,
  };
}

function parsePlanInput(value) {
  const args = parseObject(value);
  return Array.isArray(args.plan) ? args.plan : null;
}

function parseToolData(value) {
  const parsed = parseObject(value);
  return parsed.data && typeof parsed.data === "object" ? parsed.data : {};
}

function parseObject(value) {
  if (value && typeof value === "object") {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
