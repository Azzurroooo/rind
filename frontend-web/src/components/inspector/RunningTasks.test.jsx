import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RunningTasks, listedTasks } from "./RunningTasks.jsx";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const task = (id = "a", extra = {}) => ({ task_id: id, command: `command ${id}`, handoff: true, status: "running", ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await act(async () => {}); };

it("normalizes task and bg IDs before filtering terminal updates", () => {
  expect(listedTasks([task(), task(), task("b"), task("b", { status: "completed" })])).toEqual([task()]);
  expect(listedTasks([{ bg_id: "b", status: "running" }], true)).toHaveLength(1);
});

it("serializes slow polls and keeps existing rows and output during revalidation", async () => {
  vi.useFakeTimers();
  const list = deferred(), output = deferred();
  let calls = 0, reads = 0;
  const request = vi.fn((method) => {
    if (method === "rind/task/list") return ++calls === 1 ? Promise.resolve({ tasks: [task(), task()] }) : list.promise;
    if (method === "rind/task/read") return ++reads === 1 ? Promise.resolve({ stdout: "previous output" }) : output.promise;
  });
  render(<RunningTasks sessionId="one" request={request} />);
  await flush();
  expect(document.querySelectorAll("[data-task-id]")).toHaveLength(1);
  fireEvent.click(screen.getByText("command a")); await flush();
  const pre = document.querySelector("pre"), row = document.querySelector(".task-row");
  pre.scrollTop = 150; row.focus();
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(calls).toBe(2);
  expect(pre.textContent).toBe("previous output");
  await act(async () => list.resolve({ tasks: [task("a", { elapsed_ms: 9000 })] }));
  expect(document.querySelector("pre")).toBe(pre);
  expect(document.activeElement).toBe(row);
  expect(pre.scrollTop).toBe(150);
  expect(pre.textContent).toBe("previous output");
  await act(async () => output.resolve({ stdout: "updated output" }));
  expect(pre.textContent).toBe("updated output");
});

it("ignores output and lists from a previous session", async () => {
  const old = deferred();
  const request = vi.fn((method, params) => {
    if (method === "rind/task/list") return Promise.resolve({ tasks: [task(params.session_id)] });
    return old.promise;
  });
  const { rerender } = render(<RunningTasks sessionId="one" request={request} />);
  await flush(); fireEvent.click(screen.getByText("command one"));
  rerender(<RunningTasks sessionId="two" request={request} />); await flush();
  await act(async () => old.resolve({ stdout: "old session output" }));
  expect(screen.queryByText("command one")).toBeNull();
  expect(screen.queryByText("old session output")).toBeNull();
  expect(screen.getByText("command two")).not.toBeNull();
});

it("pauses when disabled or hidden and resumes after an interrupted output request", async () => {
  vi.useFakeTimers();
  const old = deferred(); let reads = 0;
  const request = vi.fn((method) => method === "rind/task/list"
    ? Promise.resolve({ tasks: [task()] })
    : ++reads === 1 ? old.promise : Promise.resolve({ stdout: "resumed" }));
  const { rerender } = render(<RunningTasks sessionId="one" request={request} enabled={false} />);
  await flush(); expect(request).not.toHaveBeenCalled();
  rerender(<RunningTasks sessionId="one" request={request} enabled />); await flush();
  fireEvent.click(screen.getByText("command a"));
  rerender(<RunningTasks sessionId="one" request={request} enabled={false} />); await flush();
  const count = request.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(12000));
  expect(request).toHaveBeenCalledTimes(count);
  rerender(<RunningTasks sessionId="one" request={request} enabled />); await flush();
  expect(screen.getByText("resumed")).not.toBeNull();
  await act(async () => old.resolve({ stdout: "stale" }));
  expect(screen.queryByText("stale")).toBeNull();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const beforeHidden = request.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(12000));
  expect(request).toHaveBeenCalledTimes(beforeHidden);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange")); await flush();
  expect(request.mock.calls.length).toBeGreaterThan(beforeHidden);
});

it("keeps a selected history cursor across background refreshes", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (method, params) => method === "rind/task/list"
    ? { tasks: [task()] }
    : { stdout: params.cursor ? "older output" : "latest output", start_cursor: "start" });
  render(<RunningTasks sessionId="one" request={request} />); await flush();
  fireEvent.click(screen.getByText("command a")); await flush();
  fireEvent.click(screen.getByText("Read from start")); await flush();
  const reads = request.mock.calls.filter(([method]) => method === "rind/task/read").length;
  await act(() => vi.advanceTimersByTimeAsync(8000));
  expect(screen.getByText("older output")).not.toBeNull();
  expect(request.mock.calls.filter(([method]) => method === "rind/task/read")).toHaveLength(reads);
});
