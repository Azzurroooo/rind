import { describe, expect, it } from "vitest";
import { buildTimeline, liveWindow, summarizeCalls, summaryText } from "./workSegments.js";
import { toolView } from "./toolDisplay.js";

const ok = (data, meta) => JSON.stringify({ ok: true, data, meta });
let seq = 0;
const call = (name, args, result = ok({}), extra = {}) => {
  seq += 1;
  return { id: `tool-${seq}`, role: "tool", tool_call_id: `c${seq}`, name, status: "completed", args: JSON.stringify(args), result, ...extra };
};
const views = (entries) => entries.map((entry) => toolView(entry));

describe("summarizeCalls", () => {
  it("groups verbs by kind with merged counts, in order of first use", () => {
    const entries = [
      call("read_file", { path: "a.ts" }),
      call("read_file", { path: "b.ts" }),
      call("grep", { pattern: "x" }, ok([], { count: 0 })),
      call("bash", { command: "ls" }),
      call("read_file", { path: "c.ts" }),
      call("glob", { pattern: "*.js" }),
      call("bash", { command: "pwd" }),
      call("read_file", { path: "d.ts" }),
      call("bash", { command: "make" }),
      call("edit_file", { path: "src/app.ts" }, ok(null, { files: [{ path: "src/app.ts", added_lines: 12, removed_lines: 3 }] })),
    ];
    expect(summarizeCalls(views(entries)).full).toBe("Read 4 files, searched 2 patterns, ran 3 commands, edited app.ts +12 -3");
  });

  it("names a single file and counts distinct files", () => {
    const one = views([call("read_file", { path: "src/a.ts" }), call("read_file", { path: "src/a.ts" })]);
    expect(summarizeCalls(one).text).toBe("Read a.ts");
    const edits = views([
      call("edit_file", { path: "a" }, ok(null, { files: [{ path: "a", added_lines: 1, removed_lines: 0 }] })),
      call("edit_file", { path: "b" }, ok(null, { files: [{ path: "b", added_lines: 2, removed_lines: 5 }] })),
    ]);
    expect(summarizeCalls(edits).text).toBe("Edited 2 files +3 -5");
  });

  it("appends failures and cancellations", () => {
    const entries = views([
      call("bash", { command: "a" }),
      call("bash", { command: "b" }, JSON.stringify({ ok: false, error: "no" }), { status: "failed" }),
    ]);
    const summary = summarizeCalls(entries);
    expect(summary).toMatchObject({ text: "Ran 2 commands", failed: 1, cancelled: 0 });
    expect(summary.full).toBe("Ran 2 commands, 1 failed");
    expect(summaryText({ text: "Ran 1 command", cancelled: 1 })).toBe("Ran 1 command, 1 cancelled");
  });

  it("phrases the remaining kinds", () => {
    const entries = views([
      call("search_web", { query: "q" }),
      call("fetch_web_page", { url: "https://docs.rs/x" }),
      call("delegate", { agent: "scout", task: "t" }),
      call("agent_create", { name: "scout" }),
      call("update_goal", { goal: "g" }),
      call("task_control", { action: "stop", task_id: "b1" }),
      call("mcp__thing", { a: 1 }),
    ]);
    expect(summarizeCalls(entries).text).toBe(
      "Searched the web, read docs.rs, delegated to scout, created agent scout, updated goal, stopped 1 task, used mcp__thing",
    );
  });
});

describe("buildTimeline", () => {
  it("folds every tool call between two pieces of prose into one segment", () => {
    const entries = [
      { id: "u1", role: "user", content: "go" },
      call("read_file", { path: "a" }),
      { id: "n1", role: "system", tone: "notice", content: "Retrying step" },
      call("bash", { command: "ls" }),
      { id: "a1", role: "assistant", content: "done" },
      call("grep", { pattern: "x" }),
    ];
    const timeline = buildTimeline(entries);
    expect(timeline.map((item) => item.type)).toEqual(["message", "segment", "system", "message", "segment"]);
    expect(timeline[1].calls.map((view) => view.name)).toEqual(["read_file", "bash"]);
  });

  it("drops hidden-only segments and keeps waiting segments open", () => {
    const hidden = buildTimeline([{ id: "u", role: "user" }, call("update_plan", {})]);
    expect(hidden.map((item) => item.type)).toEqual(["message"]);
    const waiting = buildTimeline([
      call("bash", { command: "ls" }),
      call("read_file", { path: "a" }),
      { id: "q", role: "tool", name: "ask_user_question", status: "running" },
    ], { active: true });
    expect(waiting[0]).toMatchObject({ waiting: true, autoOpen: true, status: "waiting" });
  });

  it("only the trailing segment of an active turn is live", () => {
    const entries = [call("bash", { command: "a" }), { id: "a", role: "assistant", content: "x" }, call("bash", { command: "b" }, "", { status: "running" })];
    const [first, , last] = buildTimeline(entries, { active: true });
    expect(first.live).toBe(false);
    expect(last).toMatchObject({ live: true, status: "running", autoOpen: true });
  });

  it("ended segments collapse unless a call failed; stale running calls become cancelled", () => {
    const [clean] = buildTimeline([call("bash", { command: "a" }), call("bash", { command: "b" })]);
    expect(clean.autoOpen).toBe(false);
    const [failed] = buildTimeline([call("bash", { command: "a" }), call("bash", { command: "b" }, JSON.stringify({ ok: false, error: "x" }))]);
    expect(failed).toMatchObject({ autoOpen: true, status: "error" });
    const [stale] = buildTimeline([call("bash", { command: "a" }, "", { status: "running" })], { active: false });
    expect(stale.calls[0].status).toBe("cancelled");
  });

  it("totals the durations of its calls", () => {
    const [segment] = buildTimeline([call("bash", { command: "a" }, ok({}), { duration_ms: 400 }), call("bash", { command: "b" }, ok({}), { duration_ms: 600 })]);
    expect(segment.duration_ms).toBe(1000);
  });
});

describe("liveWindow", () => {
  it("keeps the running call plus the last two finished", () => {
    const calls = ["success", "success", "success", "success", "running"].map((status, index) => ({ id: String(index), status }));
    const { visible, earlier } = liveWindow(calls);
    expect(visible.map((item) => item.id)).toEqual(["2", "3", "4"]);
    expect(earlier).toBe(2);
  });

  it("shows everything when there are few calls", () => {
    expect(liveWindow([{ id: "a", status: "running" }]).earlier).toBe(0);
  });
});
