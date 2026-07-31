import assert from "node:assert/strict";
import test from "node:test";

import { AssistantRenderer } from "../lib/assistant-renderer.js";
import {
  answerPromptText,
  answerPlaceholderText,
  backgroundMonitorText,
  cancelledText,
  commandResultText,
  contextBuiltLine,
  errorLine,
  helpText,
  assistantHeaderText,
  inputHintText,
  interruptText,
  modelListErrorText,
  modelMenuText,
  planUpdatedLine,
  sessionMenuText,
  sessionSwitchedText,
  modelUsageText,
  outputBlockText,
  promptText,
  promptPlaceholderText,
  questionText,
  choiceMenuText,
  queuedInputText,
  skillLine,
  slashDisplayText,
  slashMenuText,
  slashResultText,
  startupText,
  toolProgressLine,
  toolRequestedLine,
  toolResultLine,
  toolStartedLine,
  turnCompletedLine,
  unknownCommandText,
  userInputText,
} from "../lib/rendering.js";
import { textWidth } from "../lib/text-width.js";

test("startupText includes resume preview when provided", () => {
  assert.equal(
    startupText({
      model: "m1",
      session_id: "s1",
      cwd: "E:\\project",
      resume_preview: "Resumed session s1\n- user: hello\n- assistant: hi",
    }),
    [
      `┌${"─".repeat(78)}┐`,
      "│ Rind workbench online                                                        │",
      "│ model m1 · session s1                                                        │",
      "│ E:\\project                                                                   │",
      `└${"─".repeat(78)}┘`,
      "",
      "• Recent context",
      "  Resumed session s1",
      "▷ You · hello",
      "◁ Assistant · hi",
    ].join("\n"),
  );
});

test("startupText clips long resume preview lines", () => {
  const text = startupText({
    resume_preview: `user: ${"x".repeat(120)}`,
  });

  assert.match(text, /▷ You · x{69}\.\.\./);
});

test("startupText clips resume preview without splitting keycap emoji", () => {
  const text = startupText({
    resume_preview: `user: ${"x".repeat(68)}9️⃣ tail`,
  });

  assert.match(text, /▷ You · x{68}\.\.\./);
  assert.doesNotMatch(text, /9\uFE0F\.\.\./);
  assert.doesNotMatch(text, /9\u20E3/);
});

test("startupText clips long cwd in the middle", () => {
  const cwd = `E:\\${"deep\\".repeat(20)}project`;
  const text = startupText({
    model: "m1",
    session_id: "s1",
    cwd,
  });
  const cwdLine = text.split("\n")[3].slice(2, -2).trim();

  assert.ok(cwdLine.length <= 78);
  assert.ok(cwdLine.startsWith("E:\\deep"));
  assert.ok(cwdLine.endsWith("\\project"));
  assert.ok(cwdLine.includes("..."));
  assert.notEqual(cwdLine, cwd);
});

test("startupText keeps banner away from terminal edge", () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 80;
  try {
    const firstLine = startupText({ model: "m1", session_id: "s1", cwd: "E:\\project" }).split("\n")[0];

    assert.equal(firstLine.length, 78);
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test("prompt and turn status copy match the compact terminal UI", () => {
  assert.equal(
    promptText(),
    [
      "",
      `  ${"─".repeat(78)}`,
      "  ▷ ",
    ].join("\n"),
  );
  assert.equal(promptPlaceholderText(), "Ask Rind to do anything");
  assert.equal(answerPromptText(), "\n  ▷ ");
  assert.equal(answerPlaceholderText(), "Type your answer");
  assert.equal(inputHintText("Ask Rind to do anything"), "Ask Rind to do anything");
  assert.equal(queuedInputText(), "• Queued follow-up\n  ↳ runs after the current turn");
  assert.equal(
    queuedInputText("next question"),
    "• Queued follow-up\n  ↳ next question\n  ↳ runs after the current turn",
  );
  assert.match(queuedInputText(`${"x".repeat(100)}\nsecond line`), /\n  ↳ x{93}\.\.\.\n/);
  assert.equal(interruptText(), "• Interrupt requested\n  ↳ ctrl+c again to quit");
  assert.equal(cancelledText(), "• Interrupted\n  ↳ session preserved; resume with -c");
  assert.equal(userInputText("hello"), "▷ You\n  hello");
  assert.equal(userInputText("first\r\nsecond"), "▷ You\n  first\n  second");
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 12;
  try {
    assert.equal(userInputText("abcdefghijklmnop"), "▷ You\n  abcdefghij\n  klmnop");
  } finally {
    process.stdout.columns = originalColumns;
  }
  assert.equal(userInputText(""), "");
  assert.equal(assistantHeaderText(), "◁ Assistant");
  assert.equal(outputBlockText("• Working"), "• Working\n");
  assert.equal(outputBlockText("• Working", true), "\n• Working\n");
  assert.equal(outputBlockText(""), "");
});

test("promptText includes only model and working directory above the input", () => {
  assert.equal(
    promptText({ model: "glm-5.1", cwd: "E:\\code\\agent\\rind-ts-cli-process-split" }, {
      context_usage_percent: 0.125,
      cache_hit_rate: 0.75,
      output_tokens: 1200,
    }),
    [
      "",
      "  glm-5.1 · E:\\code\\agent\\rind-ts-cli-process-split",
      `  ${"─".repeat(78)}`,
      "  ▷ ",
    ].join("\n"),
  );
});

test("promptText colors model and working directory with separate hierarchy", () => {
  const originalIsTty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    const line = promptText({ model: "glm-5.1", cwd: "E:\\project" }).split("\n")[1];

    assert.match(line, /^  \x1b\[1;38;5;81mglm-5\.1\x1b\[0m\x1b\[2m · \x1b\[0m\x1b\[38;5;110mE:\\project\x1b\[0m$/);
  } finally {
    process.stdout.isTTY = originalIsTty;
  }
});
test("promptText keeps the activity line separate from the input chrome", () => {
  assert.equal(
    promptText({}, {}, { running: true, frame: 1, elapsedMs: 1250 }),
    [
      "",
      "  ◓ Working (1s) ctrl+c interrupt",
      `  ${"─".repeat(78)}`,
      "  ▷ ",
    ].join("\n"),
  );
});

test("promptText shows compact activity label while compacting", () => {
  assert.equal(
    promptText({}, {}, { running: true, label: "Compacting", frame: 2, elapsedMs: 2500 }).split("\n")[1],
    "  ◑ Compacting (2s) ctrl+c interrupt",
  );
});

test("promptText clips long session status", () => {
  const text = promptText({
    model: "glm-5.1-preview-with-a-very-long-name",
    cwd: `E:\\${"deep\\".repeat(20)}project`,
  }, {
    context_usage_percent: 0.25,
  });
  const statusLine = text.split("\n")[1];

  assert.ok(statusLine.length <= 80);
  assert.match(statusLine, /\.\.\.$/);
});

test("promptText keeps composer away from terminal edge", () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 80;
  try {
    const divider = promptText().split("\n")[1];

    assert.equal(divider.length, 78);
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test("promptText omits footer shortcuts and session metrics", () => {
  const text = promptText({ model: "m1", cwd: "E:\\project" }, {
    context_usage_percent: 0.03,
    cache_hit_rate: 0.8,
    output_tokens: 3200,
  });

  assert.doesNotMatch(text, /shortcuts|commands|enter send|ctrl\+c quit/);
  assert.doesNotMatch(text, /Context|cached|output/);
  assert.equal(text.split("\n").at(-1), "  ▷ ");
});

test("helpText renders compact shortcuts and commands", () => {
  assert.equal(
    helpText(),
    [
      "• Controls",
      "  enter        send message         /              open commands",
      "  ↑ / ↓        history              ← / →          move cursor",
      "  home / end   line edges           del / backspace edit text",
      "  ctrl+c       interrupt or quit    ?              show shortcuts",
      "  ctrl+b       background tasks     esc            close monitor",
      "",
      "• Command deck",
      "  /status  /sessions  /skill  /init  /plan  /compact",
      "  /model set <name>  /draft  /doctor  /config  /login",
      "  /clear  /exit",
    ].join("\n"),
  );
  assert.equal(
    helpText([
      { name: "status" },
      { name: "help" },
      { name: "clear" },
      { name: "exit" },
      { name: "model" },
    ]),
    [
      "• Controls",
      "  enter        send message         /              open commands",
      "  ↑ / ↓        history              ← / →          move cursor",
      "  home / end   line edges           del / backspace edit text",
      "  ctrl+c       interrupt or quit    ?              show shortcuts",
      "  ctrl+b       background tasks     esc            close monitor",
      "",
      "• Command deck",
      "  /status         /help           /clear          /exit",
      "  /model",
    ].join("\n"),
  );
});

test("slashMenuText renders selectable command menu", () => {
  assert.equal(
    slashMenuText([
      { name: "help", description: "Show commands" },
      { name: "status", description: "Show session status" },
    ], 1),
    [
      "  Command deck",
      "  · /help          Show commands",
      "  › /status        Show session status",
      "    ↑↓ select · enter run · esc close · backspace edit",
      "",
    ].join("\n"),
  );
});

test("slashMenuText keeps the selected command visible", () => {
  const commands = Array.from({ length: 10 }, (_, index) => ({
    name: `cmd${index}`,
    description: `Command ${index}`,
  }));

  assert.equal(
    slashMenuText(commands, 9),
    [
      "  Command deck 3-10/10",
      "  · /cmd2          Command 2",
      "  · /cmd3          Command 3",
      "  · /cmd4          Command 4",
      "  · /cmd5          Command 5",
      "  · /cmd6          Command 6",
      "  · /cmd7          Command 7",
      "  · /cmd8          Command 8",
      "  › /cmd9          Command 9",
      "    ↑↓ select · enter run · esc close · backspace edit",
      "",
    ].join("\n"),
  );
});

test("modelMenuText renders current model and selection", () => {
  assert.equal(
    modelMenuText([
      { name: "model-a", current: true },
      { name: "model-b", current: false },
    ], 1),
    [
      "  Model deck",
      "  · model-a                            current",
      "  › model-b",
      "    ↑↓ select · enter use · esc cancel",
      "",
    ].join("\n"),
  );
});

test("modelMenuText keeps the selected model visible", () => {
  const models = Array.from({ length: 10 }, (_, index) => ({
    name: `model-${index}`,
    current: index === 0,
  }));

  assert.equal(
    modelMenuText(models, 9),
    [
      "  Model deck 3-10/10",
      "  · model-2",
      "  · model-3",
      "  · model-4",
      "  · model-5",
      "  · model-6",
      "  · model-7",
      "  · model-8",
      "  › model-9",
      "    ↑↓ select · enter use · esc cancel",
      "",
    ].join("\n"),
  );
});

test("modelListErrorText renders current model and fallback command", () => {
  assert.equal(
    modelListErrorText("request failed", "model-a"),
    [
      "• Model list unavailable",
      "  ↳ current: model-a",
      "  ↳ request failed",
      "  ↳ use /model set <name> to switch manually",
    ].join("\n"),
  );
});

test("unknownCommandText points to shortcuts help", () => {
  assert.equal(unknownCommandText(), "• Unknown command\n  ↳ type / to browse commands or ? for shortcuts");
});

test("modelUsageText renders concrete model command usage", () => {
  assert.equal(modelUsageText(), "• Model command\n  ↳ /model set <name>");
});

test("commandResultText renders a compact success line", () => {
  assert.equal(commandResultText("Model updated: glm-5.1"), "✓ Model updated: glm-5.1");
  assert.equal(
    commandResultText("Compact complete", "id abc123"),
    "✓ Compact complete\n  ↳ id abc123",
  );
  assert.match(
    commandResultText("x".repeat(120), "y".repeat(120)),
    /^✓ x{93}\.\.\.\n  ↳ y{93}\.\.\.$/,
  );
});

test("slashDisplayText renders command help payloads", () => {
  assert.equal(
    slashDisplayText({
      type: "help",
      commands: [
        { name: "status", description: "Show session status", usage: "/status" },
        { name: "doctor", description: "Run diagnostics", usage: "/doctor" },
      ],
    }),
    [
      "• Commands",
      "  /status          Show session status",
      "  /doctor          Run diagnostics",
      "  ↳ use /help <command> for usage",
    ].join("\n"),
  );
  assert.equal(
    slashDisplayText({
      type: "help",
      command: {
        name: "model",
        description: "Show or change the active model",
        usage: "/model | /model set <model>",
        aliases: ["m"],
      },
    }),
    [
      "• /model",
      "  ↳ Show or change the active model",
      "  ↳ usage: /model | /model set <model>",
      "  ↳ aliases: /m",
    ].join("\n"),
  );
});

test("slashDisplayText renders status payloads", () => {
  assert.equal(
    slashDisplayText({
      type: "status",
      session: "session_1",
      model: "model_a",
      debug: true,
      messages: "2",
      git: { branch: "main", dirty: true },
      usage: [{
        label: "Last sampling:",
        input_tokens: 121300,
        context_window_tokens: 258400,
        context_usage_percent: 121300 / 258400,
        cached_input_tokens: 98700,
        cache_hit_rate: 98700 / 121300,
        output_tokens: 2100,
      }],
    }),
    [
      "• Status",
      "  ↳ session session_1",
      "  ↳ model model_a",
      "  ↳ messages 2 · debug on",
      "  ↳ git main · dirty",
      "",
      "• Last sampling:",
      "  ↳ input 121.3k / 258.4k · 46.9%",
      "  ↳ cached 98.7k · 81.4%",
      "  ↳ output 2.1k",
    ].join("\n"),
  );
});

test("slashDisplayText renders doctor payloads with textual state", () => {
  assert.equal(
    slashDisplayText({
      type: "doctor",
      failures: 1,
      warnings: 1,
      checks: [
        { status: "ok", name: "Python", detail: "3.12.0" },
        { status: "warn", name: "Git", detail: "not found on PATH" },
        { status: "fail", name: "API key", detail: "unset" },
      ],
      next_steps: ["Set apiKey in settings.json."],
    }),
    [
      "• Doctor · 1 fail · 1 warn",
      "  ✓ ok    Python · 3.12.0",
      "  ! warn  Git · not found on PATH",
      "  ⊘ fail  API key · unset",
      "",
      "• Next steps",
      "  ↳ Set apiKey in settings.json.",
    ].join("\n"),
  );
});

test("slashDisplayText renders sessions, skills, and config payloads", () => {
  assert.equal(
    slashDisplayText({
      type: "sessions",
      sessions: [{
        id: "session_2",
        current: true,
        updated_at: "2026-06-02T01:02:03+00:00",
        title: "Current task",
        messages: 4,
        tool_calls: 1,
        preview: "latest answer",
      }],
      resume_command: "python main.py --session <id>",
    }),
    [
      "• Recent sessions",
      "  › session_2 current · 2026-06-02T01:02:03+00:00",
      "  ↳ Current task · 4 msg, 1 tool",
      "  ↳ latest answer",
      "  ↳ resume: python main.py --session <id>",
    ].join("\n"),
  );
  assert.equal(
    slashDisplayText({
      type: "skills",
      skills: [{
        name: "demo",
        source: "project",
        description: "Demo skill",
        path: "E:\\project\\.rind\\skills\\demo\\SKILL.md",
      }],
    }),
    [
      "• Skills",
      "  · demo [project] Demo skill",
      "  ↳ E:\\project\\.rind\\skills\\demo\\SKILL.md",
    ].join("\n"),
  );
  assert.equal(
    slashDisplayText({
      type: "config",
      entries: [
        { label: "settings", value: "E:\\project\\settings.json", state: "found" },
        { label: "apiKey", value: "set" },
      ],
    }),
    [
      "• Config",
      "  ↳ settings: E:\\project\\settings.json (found)",
      "  ↳ apiKey: set",
    ].join("\n"),
  );
});

test("slashDisplayText clips long slash command fields", () => {
  const text = slashDisplayText({
    type: "skills",
    skills: [{
      name: "debugging",
      source: "project",
      description: "x".repeat(140),
      path: `E:\\${"deep\\".repeat(20)}SKILL.md`,
    }],
  });

  assert.match(text, /x{73}\.\.\./);
  assert.match(text, /E:\\deep\\deep\\deep.*\.\.\..*SKILL\.md$/);
});

test("slashResultText prefers structured display and falls back to raw text", () => {
  assert.equal(
    slashResultText({
      text: "Raw markdown",
      display: { type: "config", entries: [{ label: "apiKey", value: "unset" }] },
    }),
    "• Config\n  ↳ apiKey: unset",
  );
  assert.equal(slashResultText({ text: "Raw text", display: { type: "unknown" } }), "Raw text");
  assert.equal(slashResultText(null), "");
});

test("contextBuiltLine warns only when Rind docs are truncated", () => {
  assert.equal(contextBuiltLine({ decisions: {} }), "");
  assert.equal(
    contextBuiltLine({
      decisions: {
        rind_docs_truncated: true,
        rind_docs_truncated_scopes: ["user", "project"],
      },
    }),
    "• Context trimmed\n  ↳ RIND.md: user, project",
  );
  assert.match(
    contextBuiltLine({
      decisions: {
        rind_docs_truncated: true,
        rind_docs_truncated_scopes: ["x".repeat(120)],
      },
    }),
    /\n  ↳ RIND\.md: x{93}\.\.\.$/,
  );
});

test("toolRequestedLine shows bash command", () => {
  assert.equal(
    toolRequestedLine({
      tool_name: "bash",
      args_preview: '{"command":"date"}',
    }),
    "◌ Tool · Running command\n  $ date",
  );
});

test("toolRequestedLine clips long details", () => {
  const line = toolRequestedLine({
    tool_name: "bash",
    args_preview: JSON.stringify({ command: `echo ${"x".repeat(140)}` }),
  });

  assert.equal(line.split("\n")[1].length, "  $ ".length + 96);
  assert.match(line, /\.\.\.$/);
});

test("toolRequestedLine shows non-shell details as metadata", () => {
  assert.equal(
    toolRequestedLine({
      tool_name: "read_file",
      args_preview: '{"path":"frontend-cli/lib/rendering.js"}',
    }),
    "◌ Tool · Calling file read\n  ↳ frontend-cli/lib/rendering.js",
  );
});

test("prompt shows background task count after cwd with monitor hint", () => {
  const text = promptText({ model: "m1", cwd: "E:\\project", background_count: 2 });
  assert.match(text, /m1 · E:\\project · \[bg:2\] \(ctrl\+b monitor\)/);
});

test("background monitor renders selection and latest output", () => {
  const text = backgroundMonitorText(
    [
      { bg_id: "bg_1", status: "running", command: "server", stdout: "tick-1\ntick-2" },
      { bg_id: "bg_2", status: "completed", command: "build", stdout: "done" },
    ],
    0,
  );
  assert.match(text, /› bg_1/);
  assert.match(text, /tick-2/);
  assert.match(text, /bg_2/);
});

test("toolRequestedLine keeps large file content out of the status", () => {
  const line = toolRequestedLine({
    tool_name: "write_file",
    args_preview: JSON.stringify({
      file_path: "notes.txt",
      content: "secret content that must stay out of the status",
    }),
  });

  assert.equal(line, "◌ Tool · Calling write file\n  ↳ notes.txt");
  assert.doesNotMatch(line, /secret content/);
});

test("toolRequestedLine keeps edit text out of the status", () => {
  const line = toolRequestedLine({
    tool_name: "edit_file",
    args_preview: JSON.stringify({
      file_path: "notes.txt",
      old_str: "old secret",
      new_str: "new secret",
    }),
  });

  assert.equal(line, "◌ Tool · Calling file edit\n  ↳ notes.txt");
  assert.doesNotMatch(line, /secret/);
});

test("toolRequestedLine does not expose generic command arguments", () => {
  assert.equal(
    toolRequestedLine({
      tool_name: "custom_tool",
      args_preview: JSON.stringify({ command: "hidden command" }),
    }),
    "◌ Tool · Calling custom tool",
  );
});

test("toolRequestedLine keeps the tool name when arguments are incomplete", () => {
  assert.equal(
    toolRequestedLine({
      tool_name: "write_file",
      args_preview: '{"file_path":"notes.txt","content":"unfinished',
    }),
    "◌ Tool · Calling write file",
  );
});

test("toolStartedLine renders fallback running state", () => {
  assert.equal(toolStartedLine({ tool_name: "bash" }), "◌ Tool · Running command");
  assert.equal(toolStartedLine({ tool_name: "bash_output" }), "◌ Tool · Reading command output");
  assert.equal(toolStartedLine({ tool_name: "web_search" }), "◌ Tool · Calling web search");
  assert.equal(toolStartedLine({ tool_name: "custom_tool" }), "◌ Tool · Calling custom tool");
});

test("toolResultLine renders compact success state", () => {
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "completed",
      duration_ms: 1250,
      result: JSON.stringify({ ok: true, data: { stdout: "hello\nworld", stderr: "", exit_code: 0 } }),
    }),
    "◉ Tool · Ran command in 1.25s\n  ↳ hello world",
  );
  assert.equal(
    toolResultLine({
      tool_name: "view_image",
      status: "completed",
      duration_ms: 20,
    }),
    "◉ Tool · Called image in 20ms",
  );
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "completed",
      duration_ms: 25,
      result: JSON.stringify({ ok: true, data: { stdout: "", stderr: "warning" } }),
    }),
    "◉ Tool · Ran command in 25ms\n  ↳ warning",
  );
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "completed",
      duration_ms: 35,
      result: JSON.stringify({ ok: true, data: { message: "Background process started: npm run dev" } }),
    }),
    "◉ Tool · Ran command in 35ms\n  ↳ Background process started: npm run dev",
  );
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "completed",
      duration_ms: 1050,
      result: JSON.stringify({
        ok: true,
        data: { status: "running", stdout: "tick-0", exit_code: -1, bg_id: "bg_123" },
      }),
    }),
    "◌ Tool · command running in background in 1.05s\n  ↳ tick-0",
  );
  assert.equal(
    toolResultLine({
      tool_name: "bash_output",
      status: "completed",
      duration_ms: 5050,
      result: JSON.stringify({
        ok: true,
        data: { status: "running", stdout: "tick-1\ntick-2", exit_code: -1, bg_id: "bg_123" },
      }),
    }),
    "◌ Tool · command output read; command still running in background in 5.05s\n  ↳ tick-1 tick-2",
  );
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "completed",
      duration_ms: 25,
      result: JSON.stringify({ ok: true, data: { stdout: "", stderr: "not found", exit_code: 1 } }),
    }),
    "⊘ Tool · command exited 1 in 25ms\n  ↳ not found",
  );
});

test("planUpdatedLine renders each plan status with its dedicated icon", () => {
  assert.equal(
    planUpdatedLine([
      { step: "pending step", status: "pending" },
      { step: "active step", status: "in_progress" },
      { step: "done step", status: "completed" },
      { step: "cancelled step", status: "cancelled" },
    ]),
    [
      "◉ Plan updated",
      "  ○ pending step",
      "  ◐ active step",
      "  ● done step",
      "  ⊖ cancelled step",
    ].join("\n"),
  );
});

test("planUpdatedLine renders an empty plan and clips long steps", () => {
  assert.equal(planUpdatedLine([]), "◉ Plan cleared");
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 30;
  try {
    assert.equal(
      planUpdatedLine([{ step: "x".repeat(80), status: "pending" }]),
      `◉ Plan updated\n  ○ ${"x".repeat(21)}...`,
    );
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test("toolResultLine appends inline file change diff for successful file tools", () => {
  assert.equal(
    toolResultLine({
      tool_name: "edit_file",
      status: "completed",
      duration_ms: 35,
    }, {
      file_path: "frontend-cli/lib/rendering.js",
      lines: [
        { kind: "removed", text: "const oldValue = 1;" },
        { kind: "added", text: "const newValue = 2;" },
      ],
    }),
    [
      "◉ Tool · Called file edit in 35ms",
      "  ↳ frontend-cli/lib/rendering.js",
      "    - const oldValue = 1;",
      "    + const newValue = 2;",
    ].join("\n"),
  );
});

test("toolResultLine clips long file change lines", () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 40;
  try {
    assert.equal(
      toolResultLine({
        tool_name: "write_file",
        status: "completed",
        duration_ms: 10,
      }, {
        file_path: "E:\\deep\\path\\created-file.md",
        lines: [{ kind: "added", text: "x".repeat(60) }],
      }),
      [
        "◉ Tool · Called write file in 10ms",
        "  ↳ E:\\deep\\...file.md",
        `    + ${"x".repeat(31)}...`,
      ].join("\n"),
    );
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test("toolResultLine truncates long file change blocks", () => {
  const lines = Array.from({ length: 22 }, (_, index) => ({
    kind: "added",
    text: `line ${index + 1}`,
  }));
  const output = toolResultLine({
    tool_name: "write_file",
    status: "completed",
    duration_ms: 10,
  }, {
    file_path: "demo.txt",
    lines,
  });

  assert.match(output, /\n  ↳ demo\.txt\n/);
  assert.match(output, /\n    \+ line 20\n    … 2 more changed lines$/);
  assert.doesNotMatch(output, /line 21/);
});

test("promptText stays within a narrow terminal", () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 40;
  try {
    const text = promptText({
      model: "a-very-long-model-name",
      cwd: "E:\\a\\very\\long\\working\\directory\\for\\the\\test",
    });

    assert.ok(text.split("\n").every((line) => textWidth(line) <= 40));
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test("toolResultLine ignores file change details for failed tools", () => {
  assert.equal(
    toolResultLine({
      tool_name: "edit_file",
      status: "failed",
      error_type: "OldStrNotFound",
      duration_ms: 20,
      result: '{"ok":false,"error":"not found"}',
    }, {
      file_path: "demo.txt",
      lines: [
        { kind: "removed", text: "old" },
        { kind: "added", text: "new" },
      ],
    }),
    "⊘ Tool · file edit failed in 20ms (OldStrNotFound)\n  ↳ not found",
  );
});

test("toolResultLine includes compact failure detail", () => {
  assert.equal(
    toolResultLine({
      tool_name: "bash",
      status: "failed",
      error_type: "Timeout",
      duration_ms: 50,
      result: '{"ok":false,"error":"command timed out\\ntry again"}',
    }),
    "⊘ Tool · command failed in 50ms (Timeout)\n  ↳ command timed out try again",
  );
});

test("toolProgressLine renders compact progress messages", () => {
  assert.equal(
    toolProgressLine({
      tool_name: "bash",
      payload: { message: "waiting\nfor output" },
    }),
    "◌ Tool · command\n  ↳ waiting for output",
  );
  assert.equal(toolProgressLine({ tool_name: "bash", payload: { stdout: "ignored" } }), "");
});

test("turnCompletedLine renders duration and tool summary", () => {
  assert.equal(
    turnCompletedLine({ duration_ms: 2000 }, { completed: 2, failed: 1 }),
    "─ Worked for 2.00s · 2 completed, 1 failed",
  );
  assert.equal(turnCompletedLine({ duration_ms: 125000 }), "─ Worked for 2m 05s");
  assert.equal(turnCompletedLine({ duration_ms: 0 }), "─ Worked for 0ms");
});

test("status helpers render question, skill, and errors", () => {
  assert.equal(
    questionText({ question: "Pick one", options: ["A", "B"], recommended: "A" }),
    ["• Choice required", "", "  Pick one"].join("\n"),
  );
  assert.equal(
    questionText({ question: "Explain" }),
    ["• Choice required", "", "  Explain"].join("\n"),
  );
  assert.match(questionText({ question: "q".repeat(120) }), /\n  q{73}\.\.\.$/);
  assert.equal(skillLine({ skill_name: "debugging" }), "• Using skill debugging");
  assert.equal(errorLine("failed"), "⊘ Turn failed\n  ↳ failed");
  assert.equal(errorLine(""), "⊘ Turn failed");
});

test("choiceMenuText marks the selected option and the recommendation", () => {
  assert.equal(
    choiceMenuText(["A", "B"], 1, "A"),
    [
      "  Choices",
      `  · A${" ".repeat(34)}recommended`,
      "  › B",
      "    ↑↓ select · enter confirm · esc cancel",
      "",
    ].join("\n"),
  );
});

test("choiceMenuText keeps the selected option visible", () => {
  const options = Array.from({ length: 10 }, (_, index) => `option-${index}`);
  assert.equal(
    choiceMenuText(options, 9),
    [
      "  Choices 3-10/10",
      "  · option-2",
      "  · option-3",
      "  · option-4",
      "  · option-5",
      "  · option-6",
      "  · option-7",
      "  · option-8",
      "  › option-9",
      "    ↑↓ select · enter confirm · esc cancel",
      "",
    ].join("\n"),
  );
});

test("sessionMenuText renders a selectable session deck", () => {
  const text = sessionMenuText(["s1 · Current · now", "s2 · Older · yesterday"], 1);
  assert.match(text, /Sessions/);
  assert.match(text, /s2 · Older · yesterday/);
  assert.match(text, /enter confirm/);
});

test("sessionSwitchedText renders target context and model", () => {
  const text = sessionSwitchedText({
    session_id: "s2",
    model: "model-b",
    cwd: "E:\\project",
    resume_preview: "Resumed session s2\n- user: target task",
  });
  assert.match(text, /Rind workbench online/);
  assert.match(text, /model model-b · session s2/);
  assert.match(text, /Session switched/);
  assert.match(text, /s2/);
  assert.match(text, /model-b/);
  assert.match(text, /You/);
});

test("AssistantRenderer removes markdown markers at message boundary", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: false });

  renderer.append("现在是 **2026年6月11日**，路径是 `frontend-cli`。");
  renderer.finish();

  assert.equal(output, "  现在是 2026年6月11日，路径是 frontend-cli。\n");
});

test("AssistantRenderer renders headings and lists without raw markdown prefixes", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: false });

  renderer.append("## 🔟 标题\n- **重点** 9️⃣ 项\n");
  renderer.finish();

  assert.equal(output, "  🔟 标题\n  • 重点 9️⃣ 项\n");
});

test("AssistantRenderer renders code fences as compact labels", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: false });

  renderer.append("```sh\necho hi\n```\n");
  renderer.finish();

  assert.equal(output, "  ┌ code sh\n  echo hi\n  └ end\n");
});

test("AssistantRenderer renders markdown links as readable text", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: false });

  renderer.append("See [docs](https://example.com) and [**guide**](file.md).\n");
  renderer.finish();

  assert.equal(output, "  See docs (https://example.com) and guide (file.md).\n");
});

test("AssistantRenderer prefixes visual continuation lines", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: false, columns: 12 });

  renderer.append("abcdefghijklmnop");
  renderer.finish();

  assert.equal(output, "  abcdefghij\n  klmnop\n");
});

test("AssistantRenderer applies ansi styles when color is enabled", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: true });

  renderer.append("## 标题\n**重点** 和 `code`\n```js\nconst x = 1;\n```\n");
  renderer.finish();

  assert.match(output, /\x1b\[1;38;5;81m标题\x1b\[0m/);
  assert.match(output, /\x1b\[1;38;5;221m重点\x1b\[0m/);
  assert.match(output, /\x1b\[38;5;215mcode\x1b\[0m/);
  assert.match(output, /\x1b\[38;5;110mconst x = 1;\x1b\[0m/);
});

test("AssistantRenderer keeps markdown structure markers dim", () => {
  let output = "";
  const renderer = new AssistantRenderer((text) => {
    output += text;
  }, { color: true });

  renderer.append("> quote\n- item\n");
  renderer.finish();

  assert.match(output, /\x1b\[2m│ \x1b\[0mquote/);
  assert.match(output, /\x1b\[2m• \x1b\[0mitem/);
  assert.doesNotMatch(output, /\x1b\[(1;33|32)m/);
});
