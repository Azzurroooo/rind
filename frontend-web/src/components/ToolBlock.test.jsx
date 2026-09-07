import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolBlock } from "./ToolBlock.jsx";

afterEach(cleanup);

const runningTool = { role: "tool", tool_call_id: "c1", name: "bash", args: '{"command":"pytest -q"}', status: "running" };

const completedShell = {
  role: "tool",
  tool_call_id: "c1",
  name: "bash",
  args: '{"command":"pytest -q"}',
  status: "completed",
  duration_ms: 1500,
  result: JSON.stringify({ ok: true, data: { exit_code: 0, stdout: "3 passed\n", stderr: "" } }),
};

const completedEdit = {
  role: "tool",
  tool_call_id: "c2",
  name: "edit_file",
  args: '{"file_path":"src/app.py"}',
  status: "completed",
  file: "src/app.py",
  result: JSON.stringify({ ok: true, meta: { files: [{ path: "src/app.py", added_lines: 1, removed_lines: 1, diff: "--- a/src/app.py\n+++ b/src/app.py\n@@\n-old line\n+new line" }] } }),
};

const failedTool = {
  role: "tool",
  tool_call_id: "c3",
  name: "bash",
  args: '{"command":"exit 3"}',
  status: "failed",
  error_type: "BashError",
  result: JSON.stringify({ ok: false, error: "exit 3" }),
};

describe("ToolBlock — level 1 summary row is default collapsed (§2.2)", () => {
  it("renders status icon, tool label, param summary and no body", () => {
    const { container } = render(<ToolBlock tool={completedShell} />);
    expect(screen.getByText("Shell command")).not.toBeNull();
    expect(screen.getByText("$ pytest -q")).not.toBeNull();
    expect(screen.getByText("complete")).not.toBeNull();
    expect(container.querySelector(".tool-body")).toBeNull();
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("running blocks show the spinner and no output body", () => {
    const { container } = render(<ToolBlock tool={runningTool} />);
    expect(screen.getByText("running")).not.toBeNull();
    expect(container.querySelector(".tool-icon.is-running")).not.toBeNull();
    expect(container.querySelector(".tool-body")).toBeNull();
  });
});

describe("ToolBlock — level 2 expanded detail", () => {
  it("toggles open to show args/output detail and closes again", () => {
    render(<ToolBlock tool={completedShell} />);
    fireEvent.click(screen.getByRole("button", { name: /Shell command/ }));
    expect(screen.getByText("exit")).not.toBeNull();
    expect(screen.getByText("3 passed")).not.toBeNull();
    expect(screen.getByText("1.50s")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Shell command/ }));
    expect(screen.queryByText("3 passed")).toBeNull();
  });

  it("renders edit_file diffs line-level red/green inside the block", () => {
    render(<ToolBlock tool={completedEdit} />);
    expect(document.querySelector(".diff-view")).toBeNull(); // collapsed by default
    fireEvent.click(screen.getByRole("button", { name: /Edit file/ }));
    expect(document.querySelector(".diff-view")).not.toBeNull();
    expect(document.querySelector(".diff-line.added")?.textContent).toContain("new line");
    expect(document.querySelector(".diff-line.removed")?.textContent).toContain("old line");
  });

  it("caps long output with an expand-all affordance", () => {
    const longOutput = Array.from({ length: 90 }, (_, index) => `line-${index}`).join("\n");
    render(<ToolBlock tool={{ ...completedShell, result: JSON.stringify({ ok: true, data: { stdout: longOutput } }) }} />);
    fireEvent.click(screen.getByRole("button", { name: /Shell command/ }));
    const outputPre = document.querySelector(".tool-output pre");
    expect(outputPre.textContent).not.toContain("line-89"); // preview capped before the last lines
    expect(screen.getByText(/展开全部（共 90 行）/)).not.toBeNull();

    fireEvent.click(screen.getByText(/展开全部（共 90 行）/));
    expect(document.querySelector(".tool-output pre").textContent).toContain("line-89");
  });
});

describe("ToolBlock — level 3 raw JSON", () => {
  it("exposes request and result payloads behind a details toggle", () => {
    render(<ToolBlock tool={completedShell} />);
    fireEvent.click(screen.getByRole("button", { name: /Shell command/ }));
    const raw = document.querySelector("details.tool-raw");
    expect(raw).not.toBeNull();
    expect(raw.open).toBe(false); // opt-in, not forced on every expand

    fireEvent.click(raw.querySelector("summary"));
    expect(raw.open).toBe(true);
    expect(document.querySelector('[data-raw="args"]').textContent).toContain("pytest -q");
    expect(document.querySelector('[data-raw="result"]').textContent).toContain("3 passed");
  });
});

describe("ToolBlock — failed auto-expands exactly once (§2.2)", () => {
  it("a block that transitions to failed expands itself", () => {
    const { rerender } = render(<ToolBlock tool={runningTool} />);
    expect(document.querySelector(".tool-body")).toBeNull();

    rerender(<ToolBlock tool={{ ...runningTool, ...failedTool, name: "bash" }} />);
    expect(document.querySelector(".tool-block.failed")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("exit 3");
    expect(document.querySelector(".tool-body")).not.toBeNull();
  });

  it("stays collapsed after the user closes it (no re-expanding loop)", () => {
    const { rerender } = render(<ToolBlock tool={{ ...failedTool }} />);
    expect(document.querySelector(".tool-body")).not.toBeNull(); // auto-expanded on mount-failure

    fireEvent.click(screen.getByRole("button", { name: /Shell command/ }));
    expect(document.querySelector(".tool-body")).toBeNull();

    rerender(<ToolBlock tool={{ ...failedTool, result: JSON.stringify({ ok: false, error: "exit 3 again" }) }} />);
    expect(document.querySelector(".tool-body")).toBeNull(); // collapsed is respected
  });

  it("completed blocks never auto-expand", () => {
    render(<ToolBlock tool={completedShell} />);
    expect(document.querySelector(".tool-body")).toBeNull();
  });
});
