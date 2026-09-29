import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog.jsx";
import { ConfirmDialog } from "./ConfirmDialog.jsx";
import { Menu } from "./Menu.jsx";
import { TOAST_LIMIT, ToastProvider, useToast } from "./Toast.jsx";
import { Tooltip } from "./Tooltip.jsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Example">
        <input aria-label="First field" />
        <button type="button">Last</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("is modal, moves focus inside and restores it to the opener on Esc", () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Example" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab at both ends", () => {
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on scrim click but not on panel click", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T"><p>Body</p></Dialog>);
    fireEvent.mouseDown(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".dialog-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  it("focuses cancel first and reports the choice", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete session?" confirmLabel="Delete" danger onConfirm={onConfirm} onCancel={onCancel} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Menu", () => {
  function renderMenu(onSelect = vi.fn()) {
    render(
      <Menu
        label="Session actions"
        items={[
          { id: "fork", label: "Fork", onSelect },
          { separator: true },
          { id: "delete", label: "Delete", danger: true, onSelect },
        ]}
        trigger={(props) => <button type="button" aria-label="More" {...props} />}
      />,
    );
    return onSelect;
  }

  it("opens from the trigger, focuses the first item and cycles with arrows", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Session actions" });
    expect(document.activeElement.textContent).toBe("Fork");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement.textContent).toBe("Delete");
    expect(document.activeElement.className).toContain("danger");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement.textContent).toBe("Fork");
  });

  it("Esc closes and restores focus; selecting runs the item", () => {
    const onSelect = renderMenu();
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on outside pointer down", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

function ToastButton({ text }) {
  const { show } = useToast();
  return <button type="button" onClick={() => show(text)}>Show {text}</button>;
}

describe("Toast", () => {
  it("keeps at most three and auto-dismisses after 4s", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        {["a", "b", "c", "d"].map((text) => <ToastButton key={text} text={text} />)}
      </ToastProvider>,
    );
    for (const text of ["a", "b", "c", "d"]) fireEvent.click(screen.getByText(`Show ${text}`));
    const toasts = document.querySelectorAll(".toast");
    expect(toasts.length).toBe(TOAST_LIMIT);
    expect(Array.from(toasts).map((node) => node.textContent)).toEqual(["b", "c", "d"]);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(document.querySelectorAll(".toast").length).toBe(0);
  });
});

describe("Tooltip", () => {
  it("appears after the delay on hover and links via aria-describedby", () => {
    vi.useFakeTimers();
    render(<Tooltip label="New session"><button type="button" aria-label="New session">+</button></Tooltip>);
    const button = screen.getByRole("button", { name: "New session" });
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    const tip = screen.getByRole("tooltip");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
