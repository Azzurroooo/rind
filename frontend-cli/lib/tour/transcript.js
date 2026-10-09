import { createCliOutputController } from "../cli-output-controller.js";
import { createCliState } from "../cli-state.js";
import { createTranscript } from "../tui/transcript.js";
import { commandResultText, slashResultText, turnCompletedLine } from "../rendering.js";
import { graphemes } from "../text-width.js";

// Assemble fictional events through the live CLI's transcript controller.
// This preserves block spacing, trailing-newline handling and unfinished
// Markdown exactly as in a real turn. No terminal writes or tool timers.
export function renderTourTranscript(rind, width, expanded = false) {
  const transcript = createTranscript();
  const output = createCliOutputController({
    state: createCliState(),
    transcript,
    terminalUi: { requestRender() {} },
    animateTools: false,
  });
  output.showStartup(rind.info);
  for (const [index, block] of rind.blocks.entries()) {
    if (block.kind !== "assistant") output.closeAssistant();
    switch (block.kind) {
      case "user":
        output.writeUserInput(block.text, block.source);
        break;
      case "assistant":
        if (block.reveal > 0) output.assistantAppend(graphemes(block.text).slice(0, block.reveal).join(""));
        if (block.complete) output.closeAssistant();
        break;
      case "tool": {
        const request = { tool_call_id: `tour-${index}`, tool_name: block.name, arguments: toolArgs(block) };
        output.beginTool(request);
        if (!block.running) {
          output.finishTool({ ...request, ...toolResult(block) }, block.outcome.fileChange);
        }
        break;
      }
      case "result":
        output.log(() => commandResultText(block.text, block.detail));
        break;
      case "slash-result":
        output.log(() => slashResultText({ text: block.text, display: block.display }, []));
        break;
      case "turn-done":
        output.log(() => turnCompletedLine({ duration_ms: block.durationMs }, { completed: block.completed, failed: block.failed }));
        break;
      case "goodbye":
        output.log("Goodbye.");
        break;
    }
  }
  output.setToolsExpanded(expanded);
  return transcript.render(width);
}

function toolArgs(block) {
  if (block.arguments) return block.arguments;
  if (block.name === "bash") return { command: block.detail };
  return { file_path: block.detail };
}

function toolResult(block) {
  const failed = block.outcome.status === "failed";
  const data = block.outcome.data ?? (block.name === "read_file" ? block.outcome.output : {
    status: "completed", exit_code: failed ? 1 : 0, stdout: block.outcome.output || "",
  });
  return {
    status: failed ? "failed" : "completed",
    error_type: failed ? "tool_error" : "",
    duration_ms: block.outcome.durationMs,
    result: JSON.stringify({ data }),
  };
}
