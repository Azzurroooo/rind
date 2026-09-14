import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.jsx";
import { buildCommands, COMMAND_CATEGORIES } from "../lib/commands.js";

afterEach(cleanup);

const commands = buildCommands({});

function renderPalette(overrides = {}) {
  const props = {
    open: true,
    commands,
    onClose: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
  render(<CommandPalette {...props} />);
  return props;
}

describe("CommandPalette — open/filter/execute (audit #10)", () => {
  it("does not render when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("renders the registry grouped with categories and keybind hints resolved from it", () => {
    renderPalette();
    expect(screen.getByRole("dialog", { name: "Command palette" })).not.toBeNull();
    expect(screen.getByText("New session")).not.toBeNull();
    expect(screen.getByText(COMMAND_CATEGORIES.session)).not.toBeNull();
    // keybind hint comes from the registry, never hardcoded
    expect(screen.getByText("Esc ×2")).not.toBeNull();
  });

  it("filters as you type and shows an empty state without matches", () => {
    renderPalette();
    const input = screen.getByLabelText("Search commands");
    fireEvent.change(input, { target: { value: "theme" } });
    expect(screen.getByText("Theme")).not.toBeNull();
    expect(screen.queryByText("Compact context")).toBeNull();
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText("No matching commands")).not.toBeNull();
  });

  it("Enter executes the highlighted command; arrows move the highlight", () => {
    const onRun = vi.fn();
    renderPalette({ onRun });
    const input = screen.getByLabelText("Search commands");
    fireEvent.change(input, { target: { value: "stop" } });
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].id).toBe("turn.stop");
  });

  it("arrow down/up cycles the selection and click executes", () => {
    const onRun = vi.fn();
    renderPalette({ onRun });
    const input = screen.getByLabelText("Search commands");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    const activeIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(activeIndex).toBe(options.length - 1); // wrapped around
    fireEvent.click(options[activeIndex]);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("Esc closes and the scrim click closes", () => {
    const onClose = vi.fn();
    renderPalette({ onClose });
    fireEvent.keyDown(screen.getByLabelText("Search commands"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("palette-scrim"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("the filter input receives focus on open", () => {
    renderPalette();
    expect(document.activeElement).toBe(screen.getByLabelText("Search commands"));
  });
});
