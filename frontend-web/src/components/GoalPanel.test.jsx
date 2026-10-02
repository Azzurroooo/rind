import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoalPanel } from "./GoalPanel.jsx";
afterEach(cleanup);

it("renders nothing when no goal exists, without a creation form", () => {
  const { container } = render(<GoalPanel onAction={vi.fn()} />);
  expect(container.childElementCount).toBe(0);
});

it("retains pause, resume and clear for an existing goal", async () => {
  const onAction = vi.fn(async () => {});
  const { rerender } = render(<GoalPanel goal={{ objective: "Ship the release", status: "active" }} onAction={onAction} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: "pause" }));
  rerender(<GoalPanel goal={{ objective: "Ship the release", status: "paused" }} onAction={onAction} />);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: "resume" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Clear goal" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: "clear" }));
});

it("shows management errors without losing the existing goal", async () => {
  render(<GoalPanel goal={{ objective: "Review tests", status: "active" }} onAction={async () => { throw new Error("Offline"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Offline");
  expect(screen.getByText("Review tests")).not.toBeNull();
});
