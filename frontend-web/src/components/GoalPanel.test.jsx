import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoalPanel } from "./GoalPanel.jsx";
afterEach(cleanup);

it("treats an objective named pause as text, not a control action", async () => {
  const onAction = vi.fn(async () => {});
  render(<GoalPanel onAction={onAction} />);
  fireEvent.change(screen.getByLabelText("Goal objective"), { target: { value: "pause" } });
  fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: "start", objective: "pause" }));
});

it("shows errors without losing the proposed objective", async () => {
  render(<GoalPanel onAction={async () => { throw new Error("Offline"); }} />);
  fireEvent.change(screen.getByLabelText("Goal objective"), { target: { value: "Review tests" } });
  fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Offline");
  expect(screen.getByLabelText("Goal objective").value).toBe("Review tests");
});
