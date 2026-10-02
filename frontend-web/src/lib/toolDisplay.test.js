import { describe, expect, it } from "vitest";
import { formatDuration, parseToolArguments, parseToolResult, partialJsonStrings, summarizeChanges, taskFinishState, toolChangeStats, toolView } from "./toolDisplay.js";

const ok = (data, meta) => JSON.stringify({ ok: true, data, meta });
const tool = (name, args, result, extra = {}) => ({
  id: `tool-${name}`,
  role: "tool",
  tool_call_id: `call-${name}`,
  name,
  status: "completed",
  args: typeof args === "string" ? args : JSON.stringify(args),
  result,
  ...extra,
});
const metaText = (view) => view.meta.map((part) => part.text).join(" ");

describe("argument and result parsing", () => {
  it("parses complete JSON, objects and plain-text results", () => {
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: "ls" });
    expect(parseToolArguments({ path: "a" })).toEqual({ path: "a" });
    expect(parseToolResult("plain output")).toEqual({ data: "plain output" });
    expect(parseToolResult('[{"a":1}]')).toEqual({ data: [{ a: 1 }] });
  });

  it("reads string fields out of streaming, incomplete JSON", () => {
    expect(partialJsonStrings('{"path":"src/app.ts","content":"line 1\\nline')).toEqual({ path: "src/app.ts", content: "line 1\nline" });
    expect(parseToolArguments('{"command":"npm te')).toEqual({ command: "npm te" });
    expect(partialJsonStrings('{"path":"a\\')).toEqual({ path: "a" });
  });
});

describe("read_file", () => {
  it("labels Read path with a line range and never shows contents", () => {
    const view = toolView(tool("read_file", { path: "src/app.ts", offset: 1 }, ok("secret contents\nmore", { path: "src/app.ts", offset: 1, next_offset: 41 })));
    expect(view).toMatchObject({ verb: "Read", target: "src/app.ts", targetIsPath: true, body: null, openFile: "src/app.ts", status: "success" });
    expect(metaText(view)).toBe("L1-40");
    expect(JSON.stringify(view)).not.toContain("secret contents");
  });

  it("falls back to a line count", () => {
    const view = toolView(tool("read_file", { file_path: "a.md" }, ok("one\ntwo\nthree", { path: "a.md" })));
    expect(metaText(view)).toBe("3 lines");
  });
});

describe("write_file and edit_file", () => {
  it("write_file shows +N and the content capped at 20 lines", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const view = toolView(tool("write_file", { path: "notes.md", content }, ok(null, { files: [{ path: "notes.md", added_lines: 30, removed_lines: 0 }] })));
    expect(view).toMatchObject({ verb: "Wrote", target: "notes.md" });
    expect(view.meta).toEqual([{ text: "+30", tone: "success" }]);
    expect(view.body).toMatchObject({ type: "code", cap: 20 });
    expect(view.body.lines).toHaveLength(30);
  });

  it("write_file streams its content into the body while running", () => {
    const view = toolView({ id: "t", name: "write_file", status: "running", inputStreaming: true, args: '{"path":"a.txt","content":"hello\\nwor' });
    expect(view).toMatchObject({ status: "running", target: "a.txt" });
    expect(view.body.lines).toEqual(["hello", "wor"]);
  });

  it("edit_file shows +A -R and a diff, never old/new JSON", () => {
    const diff = "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new";
    const view = toolView(tool("edit_file", { path: "app.ts", old_string: "OLDSTR", new_string: "NEWSTR" }, ok(null, { files: [{ path: "app.ts", added_lines: 12, removed_lines: 3, diff }] })));
    expect(view).toMatchObject({ verb: "Edited", target: "app.ts", change: { added: 12, removed: 3 } });
    expect(view.meta).toEqual([{ text: "+12", tone: "success" }, { text: "-3", tone: "danger" }]);
    expect(view.body).toMatchObject({ type: "diff", diff, cap: 20 });
    expect(JSON.stringify(view.body)).not.toContain("OLDSTR");
  });

  it("edit_file counts +/- from file_change lines when meta has none", () => {
    const view = toolView(tool("edit_file", { path: "x.js" }, ok(null, {}), { file: "x.js", fileChange: { lines: [{ kind: "added", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "c" }] } }));
    expect(view.change).toEqual({ added: 2, removed: 1 });
  });
});

describe("grep and glob", () => {
  it("grep reports matches across files and groups paths with counts", () => {
    const hits = [{ file: "a.js", line: 1, text: "x" }, { file: "a.js", line: 9, text: "y" }, { file: "b.js", line: 2, text: "z" }];
    const view = toolView(tool("grep", { pattern: "TODO" }, ok(hits, { count: 3 })));
    expect(view).toMatchObject({ verb: "Searched", target: "TODO" });
    expect(metaText(view)).toBe("3 matches in 2 files");
    expect(view.body.items.map((item) => [item.title, item.detail])).toEqual([["a.js", "2 matches"], ["b.js", "1 match"]]);
  });

  it("grep with zero matches says No matches and has no body", () => {
    const view = toolView(tool("grep", { pattern: "nope" }, ok([], { count: 0 })));
    expect(metaText(view)).toBe("No matches");
    expect(view.body).toBeNull();
  });

  it("glob lists paths with an N files meta", () => {
    const view = toolView(tool("glob", { pattern: "**/*.css" }, ok([{ path: "a.css" }, { path: "b.css" }], { count: 2 })));
    expect(view).toMatchObject({ verb: "Found", target: "**/*.css" });
    expect(metaText(view)).toBe("2 files");
    expect(view.body.items.map((item) => item.title)).toEqual(["a.css", "b.css"]);
  });
});

describe("bash, bash_output and task_control", () => {
  it("bash shows the first command line, duration and a terminal tail", () => {
    const view = toolView(tool("bash", { command: "npm test\n# second" }, ok({ stdout: "a\nb\n", stderr: "", exit_code: 0 }), { duration_ms: 1500 }));
    expect(view).toMatchObject({ verb: "Ran", target: "npm test", status: "success" });
    expect(metaText(view)).toBe("1.5s");
    expect(view.body).toMatchObject({ type: "terminal", lines: ["a", "b"], cap: 5, expandedCap: 400 });
  });

  it("bash shows a non-zero exit code and omits empty sections", () => {
    const view = toolView(tool("bash", { command: "false" }, ok({ stdout: "", stderr: "", exit_code: 2 })));
    expect(view.meta[0]).toEqual({ text: "exit 2", tone: "danger" });
    expect(view.body).toBeNull();
  });

  it("tool_progress replaces the meta while running", () => {
    const view = toolView({ id: "t", name: "bash", status: "running", args: '{"command":"make"}', progress: ["compiling", "linking"] });
    expect(view.meta).toEqual([{ text: "linking", tone: "dim" }]);
  });

  it("bash_output reads Checked task with status and a tail", () => {
    const view = toolView(tool("bash_output", { task_id: "bg-1" }, ok({ status: "running", stdout: "tick\ntock" })));
    expect(view).toMatchObject({ verb: "Checked", target: "bg-1", status: "success" });
    expect(metaText(view)).toBe("running");
    expect(view.body.lines).toEqual(["tick", "tock"]);
  });

  it("maps failed background task states to an error row", () => {
    expect(taskFinishState("timed_out")).toBe("error");
    expect(taskFinishState("cancelling")).toBe("running");
    expect(taskFinishState("cancelled")).toBe("cancelled");
    const view = toolView(tool("bash_output", { task_id: "bg-2" }, ok({ status: "lost" })));
    expect(view.status).toBe("error");
  });

  it("task_control stop reads Stopped", () => {
    const view = toolView(tool("task_control", { action: "stop", task_id: "bg-3" }, ok({ status: "cancelled" })));
    expect(view).toMatchObject({ verb: "Stopped", target: "bg-3", kind: "stop" });
  });
});

describe("web tools", () => {
  it("search_web lists titles with domains", () => {
    const view = toolView(tool("search_web", { query: "vite preview" }, ok([{ title: "Vite", url: "https://www.vitejs.dev/guide", snippet: "s" }], { matches: 1 })));
    expect(view).toMatchObject({ verb: "Searched the web", target: "vite preview" });
    expect(metaText(view)).toBe("1 result");
    expect(view.body.items[0]).toEqual({ title: "Vite", detail: "vitejs.dev", href: "https://www.vitejs.dev/guide" });
  });

  it("fetch_web_page shows domain/path, the title and first paragraph only", () => {
    const page = "# Guide\n\nFirst paragraph here.\nStill first.\n\nSecond paragraph FULLTEXT.";
    const view = toolView(tool("fetch_web_page", { url: "https://example.com/docs/" }, ok(page, { url: "https://example.com/docs/" })));
    expect(view).toMatchObject({ verb: "Read", target: "example.com/docs" });
    expect(metaText(view)).toBe("Guide");
    expect(view.body).toMatchObject({ type: "text", title: "Guide", lines: ["First paragraph here.", "Still first."] });
    expect(JSON.stringify(view.body)).not.toContain("FULLTEXT");
  });
});

describe("delegate, creation, goal, hidden and unknown tools", () => {
  it("delegate shows agent and task with the final answer as markdown", () => {
    const view = toolView(tool("delegate", { agent: "reviewer", task: "Review the diff" }, ok({ status: "completed", summary: "Looks good." }), { duration_ms: 65000 }));
    expect(view).toMatchObject({ verb: "Delegated to", target: "reviewer: Review the diff", agent: "reviewer" });
    expect(metaText(view)).toBe("1m 05s");
    expect(view.body).toMatchObject({ type: "markdown", text: "Looks good.", cap: 24 });
  });

  it("agent_create and skill_create show the name and role or description", () => {
    const agent = toolView(tool("agent_create", { name: "scout", role: "Finds files" }, ok({ agent_id: "a1", name: "scout" })));
    expect(agent).toMatchObject({ verb: "Created agent", target: "scout" });
    expect(agent.body.rows).toEqual([{ label: "name", value: "scout" }, { label: "role", value: "Finds files" }]);
    const skill = toolView(tool("skill_create", { name: "deploy", description: "Ship it" }, ok({ name: "deploy" })));
    expect(skill).toMatchObject({ verb: "Created skill", target: "deploy" });
    expect(skill.body.rows[1]).toEqual({ label: "description", value: "Ship it" });
  });

  it("update_goal shows the status and the goal text", () => {
    const view = toolView(tool("update_goal", { goal: "Ship v2", status: "active" }, ok({})));
    expect(view).toMatchObject({ verb: "Updated goal" });
    expect(metaText(view)).toBe("active");
    expect(view.body.lines).toEqual(["Ship v2"]);
  });

  it("ask_user_question and update_plan are hidden; a running question waits", () => {
    expect(toolView(tool("update_plan", {}, ok({}))).hidden).toBe(true);
    expect(toolView({ id: "q", name: "ask_user_question", status: "running" })).toMatchObject({ hidden: true, status: "waiting" });
  });

  it("unknown tools show the raw name, key/value args and raw JSON behind a toggle", () => {
    const view = toolView(tool("mcp__x__lookup", { id: 7, q: "a" }, "result text"));
    expect(view).toMatchObject({ verb: "mcp__x__lookup", target: "7" });
    expect(view.body.rows).toEqual([{ label: "id", value: "7" }, { label: "q", value: "a" }]);
    expect(view.body).toMatchObject({ output: ["result text"], cap: 40 });
    expect(view.body.raw.args).toContain("\"q\": \"a\"");
  });
});

describe("status and errors", () => {
  it("failed calls keep the first 6 lines and put stack traces behind details", () => {
    const error = ["Boom", "line 2", "Traceback (most recent call last):", "  File \"x.py\"", "Err"].join("\n");
    const view = toolView(tool("read_file", { path: "x" }, JSON.stringify({ ok: false, error }), { status: "failed" }));
    expect(view.status).toBe("error");
    expect(view.error.lines).toEqual(["Boom", "line 2"]);
    expect(view.error.details).toContain("Traceback");
  });

  it("caps long error messages at 6 lines", () => {
    const error = Array.from({ length: 9 }, (_, index) => `e${index}`).join("\n");
    const view = toolView(tool("grep", { pattern: "a" }, JSON.stringify({ ok: false, error })));
    expect(view.error.lines).toHaveLength(6);
    expect(view.error.details).toBe("e6\ne7\ne8");
  });

  it("a running call whose turn ended is cancelled", () => {
    expect(toolView({ id: "t", name: "bash", status: "running" }, { settled: true }).status).toBe("cancelled");
  });
});

describe("change stats and durations", () => {
  it("summarizes the trailing turn's file changes", () => {
    const edit = tool("edit_file", { path: "a.ts" }, ok(null, { files: [{ path: "a.ts", added_lines: 2, removed_lines: 1 }] }));
    const write = tool("write_file", { path: "b.ts", content: "x" }, ok(null, {}), { tool_call_id: "w" });
    expect(toolChangeStats("write_file", write)).toEqual([{ path: "b.ts", added: 0, removed: 0 }]);
    expect(summarizeChanges([{ role: "user" }, edit, write])).toEqual({ fileCount: 2, added: 2, removed: 1, firstToolCallId: "call-edit_file" });
    expect(summarizeChanges([edit, { role: "user" }])).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(125000)).toBe("2m 05s");
  });
});
