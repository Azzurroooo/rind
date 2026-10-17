import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskReportDrawer } from "./TaskReportDrawer.jsx";

afterEach(() => {
  cleanup();
  window.localStorage?.clear?.();
});

const sampleTask = {
  id: "task-101",
  teamId: "team-1",
  teamName: "Core Platform",
  assigneeAgentId: "agent-fe",
  assigneeName: "frontend-specialist",
  assigneePosition: "Frontend Engineer",
  brief: "Polish task report drawer ergonomics",
  status: "done",
  statusLabel: "Delivered",
  tone: "completed",
  priority: "high",
  report: {
    outcome: "Delivered",
    summary: "Added drag resize handle, wide reading mode toggle, and Escape close.",
    evidence: ["Tested drag resizing and keyboard dismissal."],
  },
  notes: [],
  runs: [],
};

describe("TaskReportDrawer", () => {
  it("supports wide reading mode toggle, drag resizing with persistence, and Escape to close", () => {
    const onClose = vi.fn();
    render(<TaskReportDrawer task={sampleTask} onClose={onClose} />);

    const drawer = screen.getByRole("complementary", { name: "Task details" });
    expect(drawer.className).toContain("task-drawer");
    expect(drawer.className).not.toContain("is-expanded");

    // Toggle wide reading mode via expand button
    const expandBtn = screen.getByRole("button", { name: "Expand for wide reading" });
    fireEvent.click(expandBtn);
    expect(drawer.className).toContain("is-expanded");

    const restoreBtn = screen.getByRole("button", { name: "Restore panel width" });
    fireEvent.click(restoreBtn);
    expect(drawer.className).not.toContain("is-expanded");

    // Drag the resize handle to widen the drawer
    const handle = screen.getByRole("separator", { name: "Resize task report panel" });
    fireEvent.pointerDown(handle, { clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 560 });
    fireEvent.pointerUp(window);
    expect(drawer.style.width).toBe("620px");
    expect(window.localStorage.getItem("rind:taskDrawerWidth")).toBe("620");

    // Double-click resize handle toggles expanded mode
    fireEvent.doubleClick(handle);
    expect(drawer.className).toContain("is-expanded");

    // Escape key closes the drawer
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
