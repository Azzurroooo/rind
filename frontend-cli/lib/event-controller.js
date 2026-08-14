import { runtimeEventType } from "./runtime-protocol.js";
import {
  cancelledText,
  contextBuiltLine,
  errorLine,
  goalText,
  planUpdatedLine,
  toolProgressLine,
  toolRequestedLine,
  toolResultLine,
  toolStartedLine,
  turnCompletedLine,
} from "./rendering.js";

export function createEventController({
  state = {},
  input = {},
  output = {},
  monitor = {},
}) {
  const announcedTools = new Set();
  const pendingFileChanges = new Map();
  const pendingPlanInputs = new Map();
  let toolStats = { completed: 0, failed: 0 };

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
          output.log?.(line);
        }
        return;
      }
      case "tool_input_started":
        output.closeAssistant?.();
        rememberPlanInputStart(event);
        if (isAnnounced(event)) {
          return;
        }
        output.log?.(toolStartedLine(event));
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
        if (isAnnounced(event)) {
          return;
        }
        output.log?.(toolRequestedLine(event));
        return;
      case "tool_call_started":
        output.closeAssistant?.();
        if (alreadyAnnounced(event)) {
          return;
        }
        output.log?.(toolStartedLine(event));
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
        output.log?.(goal?.status ? goalText(goal) : plan ? planUpdatedLine(plan) : toolResultLine(event, fileChange));
        return;
      }
      case "file_change":
        if (event.tool_call_id) {
          pendingFileChanges.set(event.tool_call_id, event);
        }
        return;
      case "tool_progress": {
        output.closeAssistant?.();
        const line = toolProgressLine(event);
        if (line) {
          output.log?.(line);
        }
        return;
      }
      case "token_stats_updated":
        output.closeAssistant?.();
        output.setStats?.(event.stats && typeof event.stats === "object" ? event.stats : {});
        if (!state.activeTurn) {
          output.redraw?.();
        }
        return;
      case "user_question_requested":
        await input.answerQuestion?.(event);
        return;
      case "turn_failed":
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.log?.(errorLine(event.error));
        resetTurnState();
        return;
      case "turn_cancelled":
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.log?.(cancelledText());
        resetTurnState();
        return;
      case "turn_completed":
        output.clearCompactContext?.();
        output.closeAssistant?.();
        output.log?.(turnCompletedLine(event, toolStats));
        resetTurnState();
        return;
      default:
        if (state.debug) {
          output.debug?.(`Ignoring unknown runtime event: ${eventType || "unknown"}`);
        }
    }
  }

  function resetTurnState() {
    toolStats = { completed: 0, failed: 0 };
    announcedTools.clear();
    pendingFileChanges.clear();
    pendingPlanInputs.clear();
    monitor.clearDelegates?.();
    output.resetTurnTools?.();
  }

  function isAnnounced(event) {
    if (!event.tool_call_id) {
      return false;
    }
    if (announcedTools.has(event.tool_call_id)) {
      return true;
    }
    announcedTools.add(event.tool_call_id);
    return false;
  }

  function alreadyAnnounced(event) {
    return Boolean(event.tool_call_id && announcedTools.has(event.tool_call_id));
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
    closeAssistant: () => output.closeAssistant?.(),
    resetTurnState,
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
