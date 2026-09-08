import { describe, expect, it } from "vitest";
import {
  extractDiffText,
  failedMessage,
  groupToolRuns,
  formatDuration,
  parseToolArguments,
  parseToolResult,
  payloadParts,
  rawPayloads,
  toolDetails,
  toolItems,
  toolLabel,
  toolOutput,
  toolSummary,
} from "./toolDisplay.js";

describe("toolDisplay — labels (ported mapping from frontend-cli/lib/tool-display.js)", () => {
  it("maps known tools to stable labels", () => {
    expect(toolLabel("bash")).toBe("Shell command");
    expect(toolLabel("read_file")).toBe("Read file");
    expect(toolLabel("write_file")).toBe("Write file");
    expect(toolLabel("edit_file")).toBe("Edit file");
    expect(toolLabel("glob")).toBe("Find files");
    expect(toolLabel("grep")).toBe("Search files");
    expect(toolLabel("search_web")).toBe("Web search");
    expect(toolLabel("web_search")).toBe("Web search");
    expect(toolLabel("fetch_web_page")).toBe("Fetch web page");
    expect(toolLabel("update_plan")).toBe("Update plan");
    expect(toolLabel("delegate")).toBe("Delegate task");
  });

  it("humanizes unknown tool names", () => {
    expect(toolLabel("mcp__x__do_thing")).toBe("Mcp X Do Thing");
    expect(toolLabel("")).toBe("tool");
  });
});

describe("toolDisplay — parsing helpers", () => {
  it("parses args from JSON strings and objects", () => {
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: "ls" });
    expect(parseToolArguments({ path: "a" })).toEqual({ path: "a" });
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it("wraps plain-string results as { data } and rejects arrays", () => {
    expect(parseToolResult("plain")).toEqual({ data: "plain" });
    expect(parseToolResult('{"ok":true}')).toEqual({ ok: true });
    expect(parseToolResult("")).toEqual({});
    expect(parseToolResult("[1,2]")).toEqual({});
  });

  it("payloadParts splits data/meta objects", () => {
    const parts = payloadParts({ result: '{"data":{"stdout":"hi"},"meta":{"truncated":true}}' });
    expect(parts.data).toEqual({ stdout: "hi" });
    expect(parts.meta).toEqual({ truncated: true });
  });
});

describe("toolDisplay — one-line summaries (level 1)", () => {
  it("summarizes shell commands with a $ prefix", () => {
    expect(toolSummary("bash", { args: '{"command":"pytest -q"}' })).toBe("$ pytest -q");
    expect(toolSummary("bash_output", { args: '{"bg_id":"7"}' })).toBe("bg 7");
  });

  it("summarizes file tools by path/pattern", () => {
    expect(toolSummary("read_file", { args: '{"path":"src/app.py"}' })).toBe("src/app.py");
    expect(toolSummary("write_file", { args: '{"file_path":"out.txt"}' })).toBe("out.txt");
    expect(toolSummary("edit_file", {})).toBe("");
    expect(toolSummary("glob", { args: '{"pattern":"**/*.py"}' })).toBe("**/*.py");
    expect(toolSummary("grep", { args: '{"pattern":"foo"}' })).toBe("foo");
    expect(toolSummary("search_web", { args: '{"query":"rind"}' })).toBe("rind");
    expect(toolSummary("fetch_web_page", { args: '{"url":"https://x.test"}' })).toBe("https://x.test");
  });

  it("recovers the path from the result meta when args are missing", () => {
    expect(toolSummary("read_file", { result: '{"meta":{"path":"recovered.md"},"data":"text"}' })).toBe("recovered.md");
  });

  it("falls back to the first key arg for generic tools", () => {
    expect(toolSummary("unknown_tool", { args: '{"name":"worker"}' })).toBe("worker");
  });
});

describe("toolDisplay — level 2 details/items/output", () => {
  it("builds shell detail rows (exit, cwd) and joins output streams", () => {
    const tool = { args: '{"command":"make"}', result: '{"data":{"exit_code":2,"cwd":"/w","stdout":"out\\n","stderr":"err"}}', duration_ms: 1250 };
    const rows = toolDetails("bash", tool);
    expect(rows).toEqual([
      { label: "command", value: "make" },
      { label: "cwd", value: "/w" },
      { label: "exit", value: "2" },
      { label: "duration", value: "1.25s" },
    ]);
    expect(toolOutput("bash", tool)).toBe("out\nerr");
  });

  it("lists glob results with sizes and grep matches with line numbers", () => {
    const glob = { result: '{"data":[{"path":"a.py","size_bytes":12},{"path":"b.py","size_bytes":2048}]}' };
    expect(toolItems("glob", glob)).toEqual([
      { title: "a.py", detail: "12 B" },
      { title: "b.py", detail: "2.0 KiB" },
    ]);
    const grep = { result: '{"data":[{"file":"a.py","line":3,"text":"foo"}]}' };
    expect(toolItems("grep", grep)).toEqual([{ title: "a.py:3", detail: "foo" }]);
  });

  it("summarizes mutation files with +/- line counts", () => {
    const tool = { result: '{"meta":{"files":[{"path":"a.py","added_lines":4,"removed_lines":1}]}}' };
    expect(toolItems("edit_file", tool)).toEqual([{ title: "a.py", detail: "+4 / -1 行" }]);
    expect(toolDetails("edit_file", tool)).toEqual([
      { label: "file", value: "a.py" },
      { label: "changes", value: "+4 / -1 行" },
    ]);
  });
});

describe("toolDisplay — diff extraction for DiffView", () => {
  it("joins per-file diffs from the mutation meta", () => {
    const tool = { result: '{"meta":{"files":[{"path":"a.py","diff":"--- a.py\\n+++ a.py\\n+one"}]}}' };
    expect(extractDiffText("edit_file", tool)).toBe("--- a.py\n+++ a.py\n+one");
  });

  it("rebuilds diff lines from file_change records as a fallback", () => {
    const tool = { fileChange: { lines: [{ kind: "added", text: "new" }, { kind: "removed", text: "old" }, { kind: "context", text: "ctx" }] } };
    expect(extractDiffText("edit_file", tool)).toBe("+new\n-old\n ctx");
  });

  it("returns empty for non-mutation tools", () => {
    expect(extractDiffText("bash", { result: '{"meta":{"files":[{"diff":"+x"}]}}' })).toBe("");
  });
});

describe("toolDisplay — failures and raw payloads (level 3)", () => {
  it("extracts the failure message", () => {
    expect(failedMessage({ status: "failed", result: '{"ok":false,"error":"exit 1"}' })).toBe("exit 1");
    expect(failedMessage({ status: "completed", result: '{"ok":true}' })).toBe("");
  });

  it("pretty-prints raw args/result JSON", () => {
    const raw = rawPayloads({ args: '{"a":1}', result: "plain text" });
    expect(raw.args).toBe('{\n  "a": 1\n}');
    expect(raw.result).toBe("plain text");
    expect(rawPayloads({}).result).toBe("");
  });
});

describe("toolDisplay — duration formatting", () => {
  it("formats ms, seconds and minutes", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1500)).toBe("1.50s");
    expect(formatDuration(61000)).toBe("1m 01s");
    expect(formatDuration(0)).toBe("");
  });
});

describe("toolDisplay — low-stake run grouping (claude-code collapse)", () => {
  const read = (id) => ({ id: `t-${id}`, role: "tool", tool_call_id: id, name: "read_file", status: "completed" });
  const bash = (id) => ({ id: `t-${id}`, role: "tool", tool_call_id: id, name: "bash", status: "completed" });

  it("merges runs of three or more consecutive completed read/search calls", () => {
    const grouped = groupToolRuns([read("a"), read("b"), read("c")]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe("tool-run");
    expect(grouped[0].tools).toHaveLength(3);
  });

  it("short runs stay inline; a mutating tool breaks the run", () => {
    const grouped = groupToolRuns([read("a"), read("b"), bash("c"), read("d"), read("e"), read("f")]);
    expect(grouped[0]).toEqual(read("a"));
    expect(grouped[1]).toEqual(read("b"));
    expect(grouped[2]).toEqual(bash("c"));
    expect(grouped[3].kind).toBe("tool-run");
    expect(grouped[3].tools.map((tool) => tool.tool_call_id)).toEqual(["d", "e", "f"]);
  });

  it("never groups failed or running tools", () => {
    const failed = { ...read("a"), status: "failed" };
    const running = { ...read("b"), status: "running" };
    expect(groupToolRuns([failed, running, read("c")])).toHaveLength(3);
  });

  it("a completed read whose payload reports failure stays standalone", () => {
    const broken = { ...read("a"), result: JSON.stringify({ ok: false, error: "boom" }) };
    const grouped = groupToolRuns([broken, read("b"), read("c"), read("d")]);
    expect(grouped[0]).toEqual(broken);
    expect(grouped[1].kind).toBe("tool-run");
    expect(grouped[1].tools.map((tool) => tool.tool_call_id)).toEqual(["b", "c", "d"]);
  });
});
