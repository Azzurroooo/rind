import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation.jsx";

afterEach(cleanup);

function makeProps(overrides = {}) {
  return {
    messages: [],
    draft: "",
    plan: [],
    active: false,
    onCancel: vi.fn(),
    onAnswer: vi.fn(),
    onExpire: vi.fn(),
    onRetrieve: vi.fn(async () => {}),
    onPromote: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    ...overrides,
  };
}

// jsdom has no layout: give the transcript element observable scroll metrics.
function stubScrollMetrics(initialTop = 0) {
  const node = document.querySelector(".transcript");
  const metrics = { scrollTop: initialTop, clientHeight: 400, scrollHeight: 1200 };
  for (const key of ["scrollTop", "clientHeight", "scrollHeight"]) {
    Object.defineProperty(node, key, {
      configurable: true,
      get: () => metrics[key],
      set: (value) => { metrics[key] = value; },
    });
  }
  return { node, metrics };
}

describe("Conversation — scroll governance (audit #5)", () => {
  it("sticks to the bottom on content growth while attached", () => {
    const props = makeProps({ messages: [{ id: "m1", role: "user", content: "hi" }] });
    const { rerender } = render(<Conversation {...props} />);
    const { metrics, node } = stubScrollMetrics();
    rerender(<Conversation {...props} messages={[...props.messages, { id: "m2", role: "assistant", content: "hello" }]} />);
    expect(metrics.scrollTop).toBe(1200); // pinned
    expect(node).not.toBeNull();
  });

  it("scrolling up >48px detaches, shows the Jump to latest chip, and new content no longer moves the view", () => {
    const props = makeProps({ messages: [{ id: "m1", role: "user", content: "hi" }] });
    const { rerender } = render(<Conversation {...props} />);
    const { metrics } = stubScrollMetrics(200);
    fireEvent.scroll(document.querySelector(".transcript"));
    expect(screen.getByText("Jump to latest")).not.toBeNull();

    metrics.scrollTop = 300; // reading position — must NOT be yanked
    rerender(<Conversation {...props} messages={[...props.messages, { id: "m2", role: "assistant", content: "long answer" }]} />);
    expect(metrics.scrollTop).toBe(300);

    fireEvent.click(screen.getByText("Jump to latest"));
    expect(metrics.scrollTop).toBe(1200); // re-attached
    expect(screen.queryByText("Jump to latest")).toBeNull();
  });

  it("scrolling back near the bottom (≤48px) re-attaches silently", () => {
    const props = makeProps({ messages: [{ id: "m1", role: "user", content: "hi" }] });
    render(<Conversation {...props} />);
    const { metrics } = stubScrollMetrics(100);
    fireEvent.scroll(document.querySelector(".transcript"));
    expect(screen.getByText("Jump to latest")).not.toBeNull();
    metrics.scrollTop = 770; // 1200-400-770 = 30px from bottom
    fireEvent.scroll(document.querySelector(".transcript"));
    expect(screen.queryByText("Jump to latest")).toBeNull();
  });

  it("the collapsed divider renders when the reducer dropped old entries", () => {
    render(<Conversation {...makeProps()} collapsedCount={7} />);
    expect(screen.getByText(/Earlier messages have been collapsed \(7\)/)).not.toBeNull();
  });
});

describe("Conversation — queued input chips (audit #1)", () => {
  const followUp = { id: "queued:in-1", role: "queued", inputId: "in-1", input: "Queued question", mode: "follow_up" };
  const steering = { id: "queued:in-2", role: "queued", inputId: "in-2", input: "Steering question", mode: "steering" };

  it("queued inputs render user-styled with the QUEUED tag and per-item actions", () => {
    render(<Conversation {...makeProps({ messages: [followUp] })} />);
    expect(screen.getByText("QUEUED · follow_up")).not.toBeNull();
    expect(screen.getByText("Queued question")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retrieve" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Steer" })).not.toBeNull(); // follow_up only
  });

  it("steering items offer Retrieve but no Steer", () => {
    render(<Conversation {...makeProps({ messages: [steering] })} />);
    expect(screen.getByText("QUEUED · steer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retrieve" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
  });

  it("Retrieve / Steer call back with the entry", async () => {
    const props = makeProps({ messages: [followUp] });
    render(<Conversation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await waitFor(() => expect(props.onRetrieve).toHaveBeenCalledWith(followUp));
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => expect(props.onPromote).toHaveBeenCalledWith(followUp));
  });

  it("a delivered queued input renders as a plain user message (no chip, no actions)", () => {
    render(<Conversation {...makeProps({ messages: [{ id: "msg:delivered:in-1", role: "user", content: "Queued question" }] })} />);
    expect(screen.queryByText(/QUEUED/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retrieve" })).toBeNull();
    expect(screen.getByText("Queued question")).not.toBeNull();
  });
});

describe("Conversation — message copy & retry (audit #10)", () => {
  it("hover actions copy a user message and reflect the copied state", async () => {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    render(<Conversation {...makeProps({ messages: [{ id: "m1", role: "user", content: "copy me" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith("copy me"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).not.toBeNull());
  });

  it("assistant finals get Retry which resends via the callback; user rows do not", async () => {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    const props = makeProps({ messages: [
      { id: "u1", role: "user", content: "question" },
      { id: "a1", role: "assistant", content: "answer" },
    ] });
    render(<Conversation {...props} />);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(props.onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" })));
    // copy exists on both rows
    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(2);
  });

  it("retry is hidden while a turn is active; copy failures show a state, never throw", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    render(<Conversation {...makeProps({ active: true, messages: [{ id: "a1", role: "assistant", content: "answer" }] })} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).not.toBeNull());
  });
});

describe("Conversation — turn-scoped change summary (audit #14)", () => {
  it("renders Changed N files +a −b after the turn and jumps to the first diff on click", () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const { container } = render(<Conversation {...makeProps({ messages: [
      { id: "u1", role: "user", content: "do it" },
      { id: "tool-1", role: "tool", tool_call_id: "c1", name: "edit_file", status: "completed" },
      { id: "a1", role: "assistant", content: "done" },
    ] })} turnChanges={{ fileCount: 2, added: 12, removed: 3, firstToolCallId: "c1" }} />);
    const chip = screen.getByText(/Changed 2 files/);
    expect(chip).not.toBeNull();
    expect(screen.getByText("+12 −3")).not.toBeNull();
    fireEvent.click(chip.closest("button"));
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(container.querySelector("[data-tool-id='c1']")).not.toBeNull();
  });

  it("no summary while a turn is running", () => {
    render(<Conversation {...makeProps({ active: true })} turnChanges={{ fileCount: 2, added: 12, removed: 3, firstToolCallId: "c1" }} />);
    expect(screen.queryByText(/Changed 2 files/)).toBeNull();
  });
});

describe("Conversation — interrupt arming surface (audit #1)", () => {
  it("the stop button mirrors the armed hint", () => {
    const props = makeProps({ active: true });
    const { rerender } = render(<Conversation {...props} interruptArmed={false} />);
    expect(screen.getByRole("button", { name: /Stop turn/ })).not.toBeNull();
    rerender(<Conversation {...props} interruptArmed={true} />);
    expect(screen.getByRole("button", { name: /Press Esc again to stop/ })).not.toBeNull();
  });
});
