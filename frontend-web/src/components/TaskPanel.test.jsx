import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskPanel } from "./TaskPanel.jsx";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const task = (id) => ({ task_id: id, command: `Task ${id}`, status: "running" });

it("reads nested truncation metadata and follows the output cursor", async () => {
  const request = vi.fn(async (method) => method.endsWith("/list") ? { tasks: [task("a")] } : { stdout: "chunk", next_cursor: "cursor-2", meta: { truncated: true } });
  render(<TaskPanel sessionId="s1" request={request} />);
  fireEvent.click(await screen.findByRole("button", { name: /Task a/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Next output" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("rind/task/read", expect.objectContaining({ cursor: "cursor-2", session_id: "s1", task_id: "a" })));
});

it("does not replace a newly selected task with a late output response", async () => {
  let resolveA;
  const request = vi.fn(async (method, params) => {
    if (method.endsWith("/list")) return { tasks: [task("a"), task("b")] };
    if (params.task_id === "a") return new Promise((resolve) => { resolveA = resolve; });
    return { stdout: "B output" };
  });
  render(<TaskPanel sessionId="s1" request={request} />);
  fireEvent.click(await screen.findByRole("button", { name: /Task a/ }));
  fireEvent.click(screen.getByRole("button", { name: /Task b/ }));
  await screen.findByText("B output");
  await act(async () => resolveA({ stdout: "A output" }));
  expect(screen.queryByText("A output")).toBeNull();
  expect(screen.getByText("B output")).not.toBeNull();
});

it("keeps loaded task pages after periodic refresh", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (_method, params) => params.page_token ? { tasks: [task("b")] } : { tasks: [task("a")], next_page_token: "page-2" });
  render(<TaskPanel sessionId="s1" request={request} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByRole("button", { name: /Task b/ })).not.toBeNull();
});

it("reads stored output from its start cursor instead of skipping the truncated history", async () => {
  const request = vi.fn(async (method, params) => method.endsWith("/list") ? { tasks: [task("a")] }
    : { stdout: params.cursor ? "old output" : "latest preview", start_cursor: "start", next_cursor: "next", meta: { truncated: true } });
  render(<TaskPanel sessionId="s1" request={request} />);
  fireEvent.click(await screen.findByRole("button", { name: /Task a/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Read from start" }));
  await screen.findByText("old output");
  expect(request).toHaveBeenCalledWith("rind/task/read", expect.objectContaining({ cursor: "start" }));
  fireEvent.click(screen.getByRole("button", { name: "Next output" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("rind/task/read", expect.objectContaining({ cursor: "next" })));
});
