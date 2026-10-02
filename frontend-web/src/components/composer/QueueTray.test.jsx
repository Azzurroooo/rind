import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueTray } from "./QueueTray.jsx";

afterEach(cleanup);

const entries = [
  { inputId: "in-1", input: "first follow-up", mode: "follow_up" },
  { inputId: "in-2", input: "redirect", mode: "steering" },
];

describe("QueueTray", () => {
  it("renders nothing without entries", () => {
    render(<QueueTray entries={[]} />);
    expect(document.querySelector(".queue-tray")).toBeNull();
  });

  it("labels follow-ups and steers and only offers Promote on follow-ups", () => {
    render(<QueueTray entries={entries} />);
    const tray = document.querySelector(".queue-tray");
    expect(tray.getAttribute("aria-label")).toBe("Queued messages");
    const rows = document.querySelectorAll(".queued-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".queued-label").textContent).toBe("Queued");
    expect(rows[1].className).toContain("steering");
    expect(rows[1].querySelector(".queued-label").textContent).toBe("Steering");
    expect(screen.getAllByRole("button", { name: "Promote to steer the current turn" })).toHaveLength(1);
  });

  it("routes each action with the entry", () => {
    const onPromote = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<QueueTray entries={entries} onPromote={onPromote} onEdit={onEdit} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to steer the current turn" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[0]);
    expect(onPromote.mock.calls[0][0]).toMatchObject({ inputId: "in-1" });
    expect(onEdit.mock.calls[0][0]).toMatchObject({ inputId: "in-2" });
    expect(onRemove.mock.calls[0][0]).toMatchObject({ inputId: "in-1" });
  });
});
