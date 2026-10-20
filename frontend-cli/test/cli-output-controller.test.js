import assert from "node:assert/strict";
import test from "node:test";
import { createCliState } from "../lib/cli-state.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createTranscript } from "../lib/tui/transcript.js";
import { stripAnsi } from "../lib/text-width.js";
import { createEventController } from "../lib/event-controller.js";

test("clearing the transcript drops every block, and the next one starts at the top", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  output.log("old conversation");
  output.beginTool({ tool_call_id: "c1", tool_name: "bash", args_preview: "{}" });
  output.assistantAppend("partial");
  output.clearTranscript();
  assert.equal(transcript.length, 0);
  output.log("new conversation");
  assert.match(stripAnsi(transcript.render(40)[0]), /new conversation/, "no blank line above the first block");
  output.finishTool({ tool_call_id: "c1", tool_name: "bash", status: "completed", result: "" });
  assert.ok(transcript.length > 1, "a call from the old conversation is not found again");
});

test("restored delegations survive ordinary turns, settle by heading, and clear on cancellation", async () => {
  const state = createCliState();
  state.session.info.session_id = "leader";
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const result = taskId => JSON.stringify({ ok: true, data: { taskId, assignee: taskId } });
  // Construct the event controller first, as the actual CLI does before replay.
  const lines = [];
  const events = createEventController({ state: { sessionInfo: state.session.info, pendingDelegations: state.display.pendingDelegations },
    output: { log: line => lines.push(typeof line === "function" ? line() : line) } });
  output.renderHistory(["a", "b"].flatMap(taskId => [
    { role: "assistant", tool_calls: [{ id: taskId, function: { name: "delegate", arguments: "{}" } }] },
    { role: "tool", tool_call_id: taskId, content: result(taskId) },
  ]));
  await events.handle({ event: { type: "turn_completed", session_id: "leader" } });
  assert.match(lines.at(-1), /Waiting for a, b/);
  await events.handle({ event: { type: "turn_started", session_id: "leader", delivery: true,
    delivery_text: "Delegated work settled:\n- a · task a · delivered: complete\n  Summary: Also reviewed task b." } });
  assert.deepEqual([...state.display.pendingDelegations.keys()], ["b"], "evidence mentioning b does not settle b");
  await events.handle({ event: { type: "tool_result", session_id: "leader", tool_name: "delegate", status: "completed",
    result: JSON.stringify({ ok: true, data: { taskId: "b", status: "cancelled" } }) } });
  await events.handle({ event: { type: "turn_completed", session_id: "leader" } });
  assert.equal(state.display.pendingDelegations.size, 0);
  assert.match(lines.at(-1), /Worked for/);
});

test("replayed history shows deliveries as reports and still-waiting work as waiting", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const delegateResult = JSON.stringify({ ok: true, tool: "delegate", data: { taskId: "8f21ab77c3", assignee: "reviewer", next: "End your turn now." } });
  output.renderHistory([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "delegate", arguments: '{"to":"reviewer","brief":"Check Unicode"}' } }] },
    { role: "tool", tool_call_id: "c1", content: delegateResult },
    { role: "user", content: "Delegated work settled:\n- reviewer · task 8f21ab77c3 · delivered: done\n  Summary: Reviewed.", _rind_meta: { kind: "team_delivery" } },
    { role: "assistant", content: "Reviewed the delivery." },
  ], {});
  const lines = stripAnsi(transcript.render(100).join("\n"));
  assert.match(lines, /delegate → reviewer · task 8f21ab77c3/);
  assert.match(lines, /─ Delivery/);
  assert.match(lines, /Delegated work settled:/);
  assert.doesNotMatch(lines, /▷ You/, "a delivery is not shown as a user message");

  const waiting = createTranscript();
  const waitingOut = createCliOutputController({ state: createCliState(), transcript: waiting, terminalUi: { requestRender() {} }, animateTools: false });
  waitingOut.renderHistory([
    { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "delegate", arguments: '{"to":"reviewer","brief":"Check Unicode"}' } }] },
    { role: "tool", tool_call_id: "c2", content: delegateResult },
  ], {});
  assert.match(stripAnsi(waiting.render(100).join("\n")), /─ Waiting for reviewer/);
});

test("management restores pending work outside the tail and removes settled replay entries", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  output.renderHistory([{ role: "assistant", content: "recent reply" }], {
    pendingDelegations: [{ taskId: "old-task", assignee: "reviewer", sessionId: "leader" }],
  });
  assert.deepEqual([...state.display.pendingDelegations.keys()], ["old-task"]);
  assert.match(stripAnsi(transcript.render(100).join("\n")), /Waiting for reviewer/);
  output.renderHistory([
    { role: "assistant", tool_calls: [{ id: "c", function: { name: "delegate" } }] },
    { role: "tool", tool_call_id: "c", content: JSON.stringify({ ok: true, data: { taskId: "settled" } }) },
  ], { pendingDelegations: [] });
  assert.equal(state.display.pendingDelegations.size, 0);
});

test("replayed history preserves tool failure status, duration, and terminal diff payload", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const askError = JSON.stringify({
    ok: false,
    tool: "ask_user_question",
    error: "ask_user_question requires at least 2 options.",
    error_type: "InvalidUserQuestion",
  });
  const editResult = JSON.stringify({
    ok: true,
    tool: "edit_file",
    data: "File edited: index.html",
    meta: { files: [{ path: "index.html", added_lines: 1, removed_lines: 1, diff: "@@ -1 +1 @@\n-old\n+new" }] },
  });
  const bashResult = JSON.stringify({
    ok: true,
    tool: "bash",
    data: { stdout: "ok\n", stderr: "", exit_code: 0 },
  });
  output.renderHistory([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c-ask", function: { name: "ask_user_question", arguments: '{"question":"Proceed?"}' } },
        { id: "c-edit", function: { name: "edit_file", arguments: '{"path":"index.html"}' } },
        { id: "c-bash", function: { name: "bash", arguments: '{"command":"npm test"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c-ask", content: askError, status: "rejected", error_type: "InvalidUserQuestion", duration_ms: 45 },
    { role: "tool", tool_call_id: "c-edit", content: editResult, status: "completed", duration_ms: 1200 },
    { role: "tool", tool_call_id: "c-bash", content: bashResult, status: "completed", duration_ms: 1200 },
  ]);
  const rendered = stripAnsi(transcript.render(100).join("\n"));
  assert.match(rendered, /⊘ ask user question/);
  assert.match(rendered, /ask_user_question requires at least 2 options/);
  assert.match(rendered, /◉ edit index\.html \(\+1 -1\)/);
  assert.match(rendered, /- old/);
  assert.match(rendered, /\+ new/);
  assert.match(rendered, /◉ \$ npm test · 1\.20s/);
});

test("brief mode collapses consecutive tool calls into one live line, applies to history replay, and toggles via /settings menu", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { applySavedTheme, isBriefMode, loadCliState, saveCliState, setBriefMode } = await import("../lib/cli-state-store.js");
  const { executeLocalSlashCommand } = await import("../lib/local-slash-commands.js");
  const { createCliInputActions } = await import("../lib/cli-input-actions.js");
  const { settingsMenuText, planUpdatedLine } = await import("../lib/rendering.js");

  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rind-brief-mode-"));
  t.after(() => {
    setBriefMode(false);
    rmSync(tempHome, { recursive: true, force: true });
  });

  // 1. /settings menu toggles brief output with space and applies with enter.
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    promptHistory: [],
    onPromptHistory: () => {},
    getTurnController: () => ({}),
    getCommandController: () => ({ handle: async () => true }),
    getTaskMonitor: () => null,
    getLineInput: () => null,
    getEffortLevels: async () => [],
    pausePrompt: () => {},
    resumePrompt: () => {},
    handleSigint: () => {},
  });

  const menuPromise = actions.askSettingsMenu({ brief: false, sources: [] });
  assert.equal(state.input.session.mode, "settings");
  const initialMenu = stripAnsi(settingsMenuText(
    state.input.session.settingsState.items(),
    state.input.session.settingsState.selectedIndex(),
    state.input.session.settingsState.level(),
  ));
  assert.match(initialMenu, /› Brief output .* off/);
  assert.match(initialMenu, /space toggle · enter open\/apply · esc cancel/);
  actions.handleTerminalInput(" ");
  const toggledMenu = stripAnsi(settingsMenuText(
    state.input.session.settingsState.items(),
    state.input.session.settingsState.selectedIndex(),
    state.input.session.settingsState.level(),
  ));
  assert.match(toggledMenu, /› Brief output .* on/);
  actions.handleTerminalInput("\r");
  const chosen = await menuPromise;
  assert.deepEqual(chosen, { brief: true, briefChanged: true, importChoices: {} });
  assert.deepEqual(transcript.render(90).map(stripAnsi), ["▷ You", "  /settings"]);
  output.clearTranscript();

  // 2. /settings brief command persists globally and updates active brief mode.
  const cmdRes = await executeLocalSlashCommand("/settings brief on", {
    persistBrief: (enabled) => saveCliState({ brief: enabled }, tempHome),
  });
  assert.equal(cmdRes.display.type, "brief");
  assert.equal(cmdRes.display.enabled, true);
  assert.equal(isBriefMode(), true);
  assert.equal(loadCliState(tempHome).brief, true);
  setBriefMode(false);
  applySavedTheme(tempHome);
  assert.equal(isBriefMode(), true, "applySavedTheme restores persisted global brief mode");

  // 3. Live turn: while tool group is active/unsettled, leading icon stays ◌ and builds a verb trail;
  //    when assistant content begins (or turn finishes), the leading icon locks into terminal ◉/⊘.
  output.writeUserInput("Fix the build");
  output.beginTool({ tool_call_id: "t1", tool_name: "read_file", args_preview: '{"path":"package.json"}' });
  let lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines, ["▷ You", "  Fix the build", "", "  ◌ read package.json"]);

  output.finishTool({ tool_call_id: "t1", tool_name: "read_file", status: "completed", result: JSON.stringify({ ok: true, data: "{\n  \"name\": \"app\"\n}" }) });
  lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines, ["▷ You", "  Fix the build", "", "  ◌ read package.json"], "finished tool in unsettled group keeps ◌ before content prints");

  output.beginTool({ tool_call_id: "t2", tool_name: "grep", args_preview: '{"pattern":"build","path":"src"}' });
  lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines, ["▷ You", "  Fix the build", "", "  ◌ read → grep /build/ in src · 2 tools"]);

  output.finishTool({ tool_call_id: "t2", tool_name: "grep", status: "completed", result: JSON.stringify({ ok: true, data: [{ file: "src/a.js", line: 1, text: "build" }], meta: { count: 1 } }) });
  output.beginTool({ tool_call_id: "t3", tool_name: "edit_file", args_preview: '{"path":"src/a.js"}' });
  output.finishTool(
    { tool_call_id: "t3", tool_name: "edit_file", status: "completed", result: JSON.stringify({ ok: true, data: "edited" }) },
    { lines: [{ kind: "removed", text: "old" }, { kind: "added", text: "new" }] },
  );
  assert.equal(planUpdatedLine([{ step: "Step 1", status: "completed" }]), "", "plan step body is suppressed in brief mode");
  lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines, ["▷ You", "  Fix the build", "", "  ◌ read → grep → edit src/a.js (+1 -1) · 3 tools"]);

  // Assistant text settles the preceding tool streak to ◉; subsequent tools form a new single-line streak.
  output.assistantAppend("Updated src/a.js, running tests now.");
  output.closeAssistant();
  output.beginTool({ tool_call_id: "t4", tool_name: "bash", args_preview: '{"command":"npm test"}' });
  output.finishTool({ tool_call_id: "t4", tool_name: "bash", status: "completed", duration_ms: 800, result: JSON.stringify({ ok: true, data: { stdout: "PASS\nline 2\n", stderr: "", exit_code: 0 } }) });
  lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines, [
    "▷ You",
    "  Fix the build",
    "",
    "  ◉ read → grep → edit src/a.js (+1 -1) · 3 tools",
    "",
    "◁ Assistant",
    "  Updated src/a.js, running tests now.",
    "",
    "  ◌ $ npm test · 800ms",
  ]);
  output.settleTools();
  lines = transcript.render(90).map(stripAnsi);
  assert.deepEqual(lines.at(-1), "  ◉ $ npm test · 800ms", "settling at turn end transitions trailing tool group to ◉");

  // ctrl+o expands all grouped tools even in brief mode, and collapses back to 1 line.
  output.setToolsExpanded(true);
  const expandedText = stripAnsi(transcript.render(90).join("\n"));
  assert.match(expandedText, /◉ read package\.json/);
  assert.match(expandedText, /◉ grep \/build\/ in src/);
  assert.match(expandedText, /\+ new/);
  output.setToolsExpanded(false);
  assert.equal(transcript.render(90).map(stripAnsi).filter(line => line.includes("3 tools")).length, 1);

  // 4. Replaying an existing session in brief mode renders consecutive tool calls and deliveries concisely.
  output.clearTranscript();
  output.renderHistory([
    { role: "user", content: "Inspect repo" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "h1", function: { name: "glob", arguments: '{"pattern":"**/*.js"}' } },
        { id: "h2", function: { name: "bash", arguments: '{"command":"npm run lint"}' } },
      ],
    },
    { role: "tool", tool_call_id: "h1", content: JSON.stringify({ ok: true, data: [{ path: "a.js" }], meta: { count: 1 } }), status: "completed" },
    { role: "tool", tool_call_id: "h2", content: JSON.stringify({ ok: true, data: { stdout: "lint error\n", stderr: "", exit_code: 1 } }), status: "completed", duration_ms: 350 },
    { role: "user", content: "Delegated work settled:\n- worker · task 123 · delivered: done\n  Summary: All checks complete.", _rind_meta: { kind: "team_delivery" } },
  ]);
  const replayedLines = transcript.render(100).map(stripAnsi);
  assert.deepEqual(replayedLines, [
    "▷ You",
    "  Inspect repo",
    "",
    "  ◉ glob → $ npm run lint exit 1 · 350ms · 2 tools · 1 failed",
    "",
    "─ Delivery · Delegated work settled: - worker · task 123 · delivered: done Summary: All checks c...",
  ]);

  // Switching brief mode off and invalidating transcript restores full multi-block rendering in place.
  await executeLocalSlashCommand("/settings brief off", {
    persistBrief: (enabled) => saveCliState({ brief: enabled }, tempHome),
  });
  transcript.invalidate();
  const fullReplayed = stripAnsi(transcript.render(100).join("\n"));
  assert.match(fullReplayed, /◉ glob \*\*\/\*\.js · 1 matches/);
  assert.match(fullReplayed, /lint error/);
  assert.match(fullReplayed, /Summary: All checks complete\./);
});

