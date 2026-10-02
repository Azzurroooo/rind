import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker.jsx";

afterEach(cleanup);

const models = [
  { id: "claude-sonnet-4", providerId: "anthropic", contextWindow: 200000, imageInput: true },
  { id: "claude-opus-4", providerId: "anthropic", contextWindow: 200000, imageInput: false },
  { id: "gpt-5", providerId: "openai", contextWindow: 400000, imageInput: true },
];

describe("ModelPicker", () => {
  it("groups models by provider and marks the current selection", async () => {
    const onOpen = vi.fn();
    render(<ModelPicker model="gpt-5" providerId="openai" models={models} providerNames={{ anthropic: "Anthropic" }} onOpen={onOpen} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Model: gpt-5/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Models" })).not.toBeNull();
    expect(screen.getByText("Anthropic")).not.toBeNull();
    expect(screen.getByText("Openai")).not.toBeNull();
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.textContent).toContain("gpt-5");
    expect(screen.getByText("400K ctx")).not.toBeNull();
    // Vision markers only on models that accept images.
    expect(screen.getAllByRole("img", { name: "Supports images" })).toHaveLength(2);
  });

  it("selects a model with its provider and closes", () => {
    const onSelect = vi.fn();
    render(<ModelPicker model="gpt-5" providerId="openai" models={models} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Model: gpt-5/ }));
    fireEvent.click(screen.getByRole("option", { name: /claude-sonnet-4/ }));
    expect(onSelect).toHaveBeenCalledWith({ providerId: "anthropic", modelId: "claude-sonnet-4" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with arrow keys across provider groups", () => {
    const onSelect = vi.fn();
    render(<ModelPicker model="claude-sonnet-4" providerId="anthropic" models={models} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Model: claude-sonnet-4/ }));
    const list = screen.getByRole("listbox");
    expect(document.activeElement.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement.textContent).toContain("claude-opus-4");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers a filter when the catalog is long", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, providerId: "", contextWindow: null, imageInput: null }));
    render(<ModelPicker model="model-0" models={many} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Model: model-0/ }));
    const search = screen.getByRole("searchbox", { name: "Filter models" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "model-9" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement.textContent).toContain("model-0");
  });

  it("explains an empty catalog", () => {
    render(<ModelPicker models={[]} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Model: not set" }));
    expect(screen.getByText(/No models reported/)).not.toBeNull();
  });
});
