import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.jsx";

afterEach(cleanup);

function Harness({ initial = "", ...props }) {
  const [value, setValue] = useState(initial);
  return <Composer value={value} onChange={setValue} {...props} />;
}

const textarea = () => screen.getByLabelText("Message");

describe("Composer", () => {
  it("lets a new session select provider models and effort before sending", () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    render(<Harness model="first" models={[{ id: "first", providerId: "alpha" }, { id: "second", providerId: "beta" }]} onModel={onModel} onEffort={onEffort} />);
    fireEvent.click(screen.getByRole("button", { name: /Model:/ }));
    fireEvent.click(screen.getByRole("option", { name: /second/ }));
    expect(onModel).toHaveBeenCalledWith({ providerId: "beta", modelId: "second" });
    fireEvent.click(screen.getByRole("button", { name: /Reasoning effort:/ }));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(onEffort).toHaveBeenCalledWith("high");
  });
  it("Enter sends as follow_up and Shift+Enter does not send", () => {
    const onSubmit = vi.fn();
    render(<Harness initial="hello" onSubmit={onSubmit} />);
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hello", { mode: "follow_up" });
  });

  it("Alt+Enter steers while a turn is active", () => {
    const onSubmit = vi.fn();
    render(<Harness initial="redirect" active onSubmit={onSubmit} />);
    fireEvent.keyDown(textarea(), { key: "Enter", altKey: true });
    expect(onSubmit).toHaveBeenCalledWith("redirect", { mode: "steering" });
  });

  it("disables Send without content and enables it once typed", () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(false);
  });

  it("shows Stop while active and empty, and a queued send once typed", () => {
    const onCancel = vi.fn();
    render(<Harness active onCancel={onCancel} onSubmit={vi.fn()} />);
    const stop = screen.getByRole("button", { name: "Stop active turn" });
    expect(stop.className).toContain("stop");
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea(), { target: { value: "later" } });
    expect(screen.getByRole("button", { name: "Send queued message" })).not.toBeNull();
  });

  it("recalls the last prompt with ArrowUp on an empty draft", () => {
    render(<Harness lastPrompt="previous prompt" onSubmit={vi.fn()} />);
    fireEvent.keyDown(textarea(), { key: "ArrowUp" });
    expect(textarea().value).toBe("previous prompt");
  });

  it("shows the interrupt hint when armed", () => {
    render(<Harness active interruptArmed onSubmit={vi.fn()} />);
    expect(document.querySelector(".composer-activity.interrupt-hint").textContent).toContain("Esc again to stop");
  });

  it("opens the slash menu, filters by prefix and accepts with Enter", () => {
    const onSubmit = vi.fn();
    const commands = [
      { id: "compact", slash: "compact", title: "Compact context" },
      { id: "clear", slash: "clear", title: "Clear" },
      { id: "model", slash: "model", title: "Model" },
    ];
    render(<Harness commands={commands} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert slash command" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(textarea(), { target: { value: "/c" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea().value).toBe("/compact ");
  });

  it("renders the queue tray and the context ring", () => {
    render(
      <Harness
        queued={[{ inputId: "in-1", input: "queued", mode: "follow_up" }]}
        stats={{ context_usage_percent: 0.75 }}
        hasSession
        onOpenContext={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(document.querySelector(".queued-row[data-input-id=\"in-1\"]")).not.toBeNull();
    const ring = document.querySelector(".context-ring-button");
    expect(ring.getAttribute("aria-label")).toMatch(/^Context 75% used/);
    expect(ring.className).toContain("warning");
  });

  it("puts steer and stop in an accessible menu while the primary action queues", () => {
    const onSubmit = vi.fn(), onCancel = vi.fn();
    render(<Harness initial="adjust this" active onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.queryByRole("button", { name: "Steer active turn" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Steer this turn/ }));
    expect(onSubmit).toHaveBeenCalledWith("adjust this", { mode: "steering" });
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop active turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(textarea().value).toBe("adjust this");
  });

  it("keeps the workspace and status slots mounted when running starts and ends", () => {
    const { rerender } = render(<Composer value="" workspace="E:/work/project" active={false} />);
    const row = document.querySelector(".composer-context"), status = document.querySelector(".composer-activity");
    const folder = screen.getByLabelText("Working folder: E:/work/project");
    expect(folder.textContent).toBe("project");
    rerender(<Composer value="" workspace="E:/work/project" active />);
    expect(document.querySelector(".composer-context")).toBe(row);
    expect(document.querySelector(".composer-activity")).toBe(status);
    expect(status.textContent).toContain("Working");
    rerender(<Composer value="" workspace="E:/work/project" active={false} />);
    expect(document.querySelector(".composer-activity")).toBe(status);
    expect(status.textContent).toContain("Ready");
  });

  it("allows preparing a draft during compaction and keeps cancellation reachable", () => {
    const onSubmit = vi.fn(), onCancel = vi.fn();
    render(<Harness initial="next task" active compacting onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea().readOnly).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop active turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(textarea().value).toBe("next task");
  });
});
