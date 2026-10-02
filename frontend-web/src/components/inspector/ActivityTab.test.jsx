import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityTab } from "./ActivityTab.jsx";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const flush = async () => { await act(async () => {}); };

it("gives a new session one empty state with slash guidance and no forms", () => {
  const request = vi.fn();
  render(<ActivityTab taskService enabled request={request} />);
  expect(screen.getByRole("heading", { name: "No activity yet" })).not.toBeNull();
  expect(screen.getByText("/goal <objective>")).not.toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Goal" })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("keeps settled empty content during polling and replaces it with live tasks", async () => {
  vi.useFakeTimers();
  let resolve;
  const request = vi.fn().mockResolvedValueOnce({ tasks: [] }).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<ActivityTab sessionId="one" taskService enabled request={request} />);
  await flush();
  const empty = screen.getByRole("heading", { name: "No active work" });
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByRole("heading", { name: "No active work" })).toBe(empty);
  expect(screen.queryByText("Loading activity")).toBeNull();
  await act(async () => resolve({ tasks: [{ task_id: "a", command: "npm test", status: "running", handoff: true }] }));
  expect(screen.getByText("npm test")).not.toBeNull();
  expect(screen.queryByText("No active work")).toBeNull();
});

it("hides unused sections and returns to empty after the last goal clears", async () => {
  const props = { sessionId: "one", taskService: true, enabled: true, request: vi.fn(async () => ({ tasks: [] })) };
  const { rerender } = render(<ActivityTab {...props} goal={{ objective: "Ship the release", status: "active" }} />);
  await flush();
  expect(screen.getByText("Ship the release")).not.toBeNull();
  expect(screen.queryByText("No active work")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
  rerender(<ActivityTab {...props} />);
  expect(screen.getByText("No active work")).not.toBeNull();
  rerender(<ActivityTab {...props} plan={[{ step: "Review changes", status: "pending" }]} />);
  expect(screen.getByText("Review changes")).not.toBeNull();
  expect(screen.queryByText("No active work")).toBeNull();
});

it("does not hide failures or waiting tasks behind the empty state", async () => {
  const { rerender } = render(<ActivityTab sessionId="one" taskService enabled request={async () => { throw new Error("Connection lost"); }} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Connection lost");
  expect(screen.queryByText("No active work")).toBeNull();
  rerender(<ActivityTab sessionId="two" taskService waitingCount={1} enabled={false} />);
  expect(screen.getByText(/Waiting on background commands/)).not.toBeNull();
  expect(screen.queryByText("No active work")).toBeNull();
});
