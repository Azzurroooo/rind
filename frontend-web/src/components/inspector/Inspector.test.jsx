import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inspector, visibleTabs } from "./Inspector.jsx";

afterEach(cleanup);

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

describe("visibleTabs", () => {
  it("shows only the always-available tabs for a bare runtime", () => {
    expect(visibleTabs({}).tabs).toEqual(["context", "files"]);
  });

  it("adds Activity and Usage when the runtime advertises their methods", () => {
    const gates = visibleTabs({ methods: ["rind/background/list", "rind/usage/summary"] });
    expect(gates.tabs).toEqual(["context", "activity", "files", "usage"]);
    expect(gates.tasks).toBe(false);
    expect(gates.background).toBe(true);
    expect(gates.auth).toBe(false);
  });
});

describe("Inspector", () => {
  it("renders an accessible tablist with roving arrow keys", () => {
    const onTab = vi.fn();
    render(<Inspector tab="context" onTab={onTab} info={{ methods: ["rind/task/list", "rind/usage/summary"] }} />);
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Inspector sections");
    expect(tabNames()).toEqual(["Context", "Activity", "Files", "Usage"]);
    const context = screen.getByRole("tab", { name: "Context" });
    expect(context.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(context, { key: "ArrowRight" });
    expect(onTab).toHaveBeenLastCalledWith("activity");
    fireEvent.keyDown(context, { key: "ArrowLeft" });
    expect(onTab).toHaveBeenLastCalledWith("usage");
    fireEvent.keyDown(context, { key: "End" });
    expect(onTab).toHaveBeenLastCalledWith("usage");
  });

  it("falls back to the first tab when the requested tab is unavailable", () => {
    render(<Inspector tab="usage" info={{}} />);
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
  });

  it("closes from the header", () => {
    const onClose = vi.fn();
    render(<Inspector tab="context" onClose={onClose} info={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the context gauge, breakdown and compact action", () => {
    const onCompact = vi.fn();
    render(
      <Inspector
        tab="context"
        info={{ session_id: "s-1" }}
        stats={{ context_usage_percent: 0.42, input_tokens: 42000, context_window_tokens: 100000 }}
        contextSnapshot={{ breakdown: { sections: [{ key: "system", label: "System prompt", tokens: 3000 }, { key: "empty", label: "Empty", tokens: 0 }] } }}
        onCompact={onCompact}
      />,
    );
    expect(screen.getByRole("img", { name: "Context 42% used" })).not.toBeNull();
    expect(screen.getByText("42% used")).not.toBeNull();
    expect(screen.getByText("System prompt")).not.toBeNull();
    expect(screen.queryByText("Empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Compact context/ }));
    expect(onCompact).toHaveBeenCalled();
  });

  it("explains the missing breakdown before the first turn", () => {
    render(<Inspector tab="context" info={{}} />);
    expect(screen.getByText("The breakdown appears after the next turn.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Compact context/ })).toBeNull();
  });

  it("loads usage totals and read-only provider status", async () => {
    const request = vi.fn(async (method) => {
      if (method === "rind/usage/summary") {
        return { totals: { total: 12000, input: 9000, cached: 2000, output: 3000, samples: 4, compactions: 1 }, by_day: [], by_model: [] };
      }
      if (method === "rind/auth/list") {
        return { providers: [{ id: "a", name: "Provider A", configured: true, source: "env" }, { id: "b", name: "Provider B", configured: false }] };
      }
      return {};
    });
    render(<Inspector tab="usage" info={{ methods: ["rind/usage/summary", "rind/auth/list"] }} request={request} />);
    await waitFor(() => expect(screen.getByText("Provider A")).not.toBeNull());
    expect(screen.getByText("Signed in (env)")).not.toBeNull();
    expect(screen.getByText("Not signed in")).not.toBeNull();
    expect(screen.getByText("Provider sign-in is managed in Rind Desktop or the CLI.")).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method === "rind/usage/summary")).toBe(true);
  });

  it("shows plan, yielded tasks and goal together on the Activity tab", async () => {
    const request = vi.fn(async (method) => {
      if (method === "rind/task/list") {
        return { tasks: [
          { task_id: "t-1", command: "npm test", status: "running", handoff: true, elapsed_ms: 5000 },
          { task_id: "t-2", command: "npm build", status: "completed", handoff: true, elapsed_ms: 100 },
          { task_id: "t-3", command: "npm dev", status: "running", handoff: false },
        ] };
      }
      if (method === "rind/task/read") return { stdout: "all green", stderr: "", meta: {} };
      return {};
    });
    render(
      <Inspector
        tab="activity"
        info={{ session_id: "s-1", methods: ["rind/task/list"] }}
        request={request}
        plan={[{ step: "Write tests", status: "completed" }, { step: "Run tests", status: "in_progress" }]}
        goal={{ objective: "Ship the release", status: "active" }}
        onGoalAction={() => {}}
        connected
      />,
    );
    expect(screen.getByText("Plan")).not.toBeNull();
    expect(screen.getByText("1 of 2")).not.toBeNull();
    expect(screen.getByText("Write tests")).not.toBeNull();
    expect(screen.getByText("Ship the release")).not.toBeNull();
    const row = await screen.findByText("npm test");
    expect(screen.queryByText("npm build")).toBeNull();
    expect(screen.queryByText("npm dev")).toBeNull();
    fireEvent.click(row.closest("button"));
    await waitFor(() => expect(document.querySelector(".task-output").textContent).toBe("all green"));
    expect(request).toHaveBeenCalledWith("rind/task/read", expect.objectContaining({ session_id: "s-1", task_id: "t-1" }));
  });

  it("falls back to the legacy background list when the task service is absent", async () => {
    const request = vi.fn(async (method) => {
      if (method === "rind/background/list") return { tasks: [{ bg_id: "bg-1", command: "npm test", status: "running", elapsed_ms: 5000 }, { bg_id: "bg-2", command: "npm build", status: "completed" }] };
      if (method === "rind/background/output") return { task: { stdout: "all green" } };
      return {};
    });
    render(<Inspector tab="activity" info={{ session_id: "s-1", methods: ["rind/background/list"] }} request={request} />);
    const job = await screen.findByText("npm test");
    expect(screen.queryByText("npm build")).toBeNull();
    fireEvent.click(job.closest("button"));
    await waitFor(() => expect(document.querySelector(".task-output").textContent).toBe("all green"));
    expect(request).toHaveBeenCalledWith("rind/background/output", expect.objectContaining({ session_id: "s-1", bg_id: "bg-1" }));
  });
});
