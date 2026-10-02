import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { WorkSegment } from "./WorkSegment.jsx";
import { ToolRow } from "./ToolRow.jsx";
import { buildTimeline } from "../../lib/workSegments.js";
import { toolView } from "../../lib/toolDisplay.js";

const ok = (data, meta) => JSON.stringify({ ok: true, data, meta });
const bash = (id, command, extra = {}) => ({ id, role: "tool", tool_call_id: id, name: "bash", status: "completed", args: JSON.stringify({ command }), result: ok({ stdout: `${command} out` }), ...extra });
const segmentOf = (entries, options) => buildTimeline(entries, options).find((item) => item.type === "segment");

describe("WorkSegment", () => {
  it("preserves the first row as calls merge and settles before folding", () => {
    vi.useFakeTimers();
    try {
      const a = bash("a", "one", { status: "running", result: "" });
      const { container, rerender } = render(<WorkSegment segment={segmentOf([a], { active: true })} />);
      const row = container.querySelector('[data-tool-id="a"]');
      const calls = [bash("a", "one"), bash("b", "two")];
      rerender(<WorkSegment segment={segmentOf(calls, { active: true })} />);
      expect(container.querySelector('[data-tool-id="a"]')).toBe(row);
      const head = screen.getByRole("button", { name: /Ran 2 commands/ });
      rerender(<WorkSegment segment={segmentOf(calls)} />);
      act(() => vi.advanceTimersByTime(500));
      expect(head.getAttribute("aria-expanded")).toBe("true");
      act(() => vi.advanceTimersByTime(100));
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector('[data-tool-id="a"]')).toBe(row);
      expect(container.querySelector(".work-segment-shell").hasAttribute("inert")).toBe(true);
      fireEvent.click(head);
      act(() => vi.advanceTimersByTime(1000));
      expect(head.getAttribute("aria-expanded")).toBe("true");
    } finally { vi.useRealTimers(); }
  });
  it("renders a finished segment collapsed to its summary", () => {
    const { container } = render(<WorkSegment segment={segmentOf([bash("a", "ls"), bash("b", "pwd")])} />);
    const head = screen.getByRole("button", { name: /Ran 2 commands/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".tool-row")).toBeNull();
    fireEvent.click(head);
    expect(container.querySelectorAll(".tool-row")).toHaveLength(2);
  });

  it("stays open when a call failed and shows the failure count", () => {
    const failed = bash("b", "false", { status: "failed", result: JSON.stringify({ ok: false, error: "exit 1" }) });
    render(<WorkSegment segment={segmentOf([bash("a", "ls"), failed])} />);
    expect(screen.getByRole("button", { name: /Ran 2 commands, 1 failed/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("exit 1");
  });

  it("live: shows the running call plus the last two with +N earlier", () => {
    const entries = [bash("a", "one"), bash("b", "two"), bash("c", "three"), bash("d", "four"), bash("e", "five", { status: "running", result: "" })];
    const { container } = render(<WorkSegment segment={segmentOf(entries, { active: true })} />);
    const rows = [...container.querySelectorAll(".tool-row-wrap")].map((node) => node.getAttribute("data-tool-id"));
    expect(rows).toEqual(["c", "d", "e"]);
    fireEvent.click(screen.getByRole("button", { name: "+2 earlier" }));
    expect(container.querySelectorAll(".tool-row-wrap")).toHaveLength(5);
  });

  it("renders a single-call segment as just its row", () => {
    const { container } = render(<WorkSegment segment={segmentOf([bash("a", "ls")])} />);
    expect(container.querySelector(".work-segment")).toBeNull();
    expect(container.querySelector("[data-tool-id='a'] .tool-row")).not.toBeNull();
  });
});

describe("ToolRow", () => {
  it("opens the body on click and caps terminal output to the tail", () => {
    const stdout = Array.from({ length: 8 }, (_, index) => `l${index}`).join("\n");
    const call = toolView(bash("a", "npm test", { result: ok({ stdout }) }));
    const { container } = render(<ToolRow call={call} />);
    const row = screen.getByRole("button", { name: /Ran npm test/ });
    fireEvent.click(row);
    expect(container.querySelector(".tool-terminal").textContent).toBe("l3\nl4\nl5\nl6\nl7");
    fireEvent.click(screen.getByRole("button", { name: /Show earlier/ }));
    expect(container.querySelector(".tool-terminal").textContent.split("\n")).toHaveLength(8);
  });

  it("read_file has no chevron and opens the file in the Files tab", () => {
    const onOpenFile = vi.fn();
    const call = toolView({ id: "r", name: "read_file", status: "completed", args: '{"path":"src/a.ts"}', result: ok("body", { path: "src/a.ts" }) });
    const { container } = render(<ToolRow call={call} onOpenFile={onOpenFile} />);
    expect(container.querySelector(".tool-chevron")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Read src\/a.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
    expect(container.textContent).not.toContain("body");
  });

  it("keeps stack traces behind Show details", () => {
    const error = "Failed\nTraceback (most recent call last):\n  File \"x\"";
    const call = toolView({ id: "g", name: "grep", status: "failed", args: '{"pattern":"a"}', result: JSON.stringify({ ok: false, error }) });
    render(<ToolRow call={call} />);
    expect(screen.getByRole("alert").textContent).not.toContain("Traceback");
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByRole("alert").textContent).toContain("Traceback");
  });

  it("unknown tools hide raw JSON until toggled", () => {
    const call = toolView({ id: "u", name: "mystery", status: "completed", args: '{"k":"v"}', result: "out" });
    const { container } = render(<ToolRow call={call} />);
    fireEvent.click(screen.getByRole("button", { name: /mystery/ }));
    expect(container.querySelector(".tool-raw-json")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show raw JSON" }));
    expect(container.querySelector(".tool-raw-json").textContent).toContain("\"k\": \"v\"");
  });
});
