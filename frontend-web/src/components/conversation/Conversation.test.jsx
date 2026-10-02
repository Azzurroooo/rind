import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation.jsx";

afterEach(cleanup);

const thread = [
  { id: "u-1", role: "user", content: "First question" },
  { id: "a-1", role: "assistant", content: "First answer" },
  { id: "u-2", role: "user", content: "Second question" },
  { id: "a-2", role: "assistant", content: "Second answer" },
];

describe("Conversation", () => {
  it("shows the empty state with starter chips", () => {
    const onSuggestion = vi.fn();
    render(<Conversation messages={[]} onSuggestion={onSuggestion} />);
    expect(screen.getByText("What would you like to work on?")).not.toBeNull();
    fireEvent.click(screen.getByText("Review recent changes"));
    expect(onSuggestion).toHaveBeenCalledWith("Review recent changes");
  });

  it("renders user bubbles and marks the latest assistant message", () => {
    render(<Conversation messages={thread} />);
    expect(document.querySelectorAll(".message.user .user-bubble")).toHaveLength(2);
    const assistants = document.querySelectorAll(".message.assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].className).not.toContain("is-latest");
    expect(assistants[1].className).toContain("is-latest");
  });

  it("offers Edit and resend only when idle", () => {
    const onEdit = vi.fn();
    const { rerender } = render(<Conversation messages={thread} onEdit={onEdit} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit and resend" })[0]);
    expect(onEdit.mock.calls[0][0]).toMatchObject({ id: "u-1" });
    rerender(<Conversation messages={thread} onEdit={onEdit} active />);
    expect(screen.queryByRole("button", { name: "Edit and resend" })).toBeNull();
  });

  it("forks at the next server user message, or the whole session after the last reply", () => {
    const onFork = vi.fn();
    render(<Conversation messages={thread} canFork onFork={onFork} />);
    const forks = screen.getAllByRole("button", { name: "Fork from here" });
    fireEvent.click(forks[0]);
    fireEvent.click(forks[1]);
    expect(onFork.mock.calls[0][0]).toBe("u-2");
    expect(onFork.mock.calls[1][0]).toBeNull();
  });

  it("hides Fork when the runtime cannot fork", () => {
    render(<Conversation messages={thread} onFork={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
  });

  it("renders error notes with Retry and quiet notices without", () => {
    const onRetry = vi.fn();
    render(
      <Conversation
        messages={[
          { id: "local-1", role: "system", tone: "error", content: "Prompt failed" },
          { id: "local-2", role: "system", content: "Session resumed" },
        ]}
        onRetry={onRetry}
      />,
    );
    const error = document.querySelector(".system-note.is-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(document.querySelector(".system-note.is-notice").textContent).toContain("Session resumed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry.mock.calls[0][0]).toMatchObject({ id: "local-1" });
  });

  it("does not insert an extra transcript row when a turn starts or ends", () => {
    const { rerender } = render(<Conversation messages={thread.slice(0, 1)} />);
    const count = document.querySelectorAll(".message").length;
    rerender(<Conversation messages={thread.slice(0, 1)} active />);
    expect(document.querySelectorAll(".message")).toHaveLength(count);
    expect(document.querySelector(".working-line")).toBeNull();
    rerender(<Conversation messages={thread.slice(0, 1)} />);
    expect(document.querySelectorAll(".message")).toHaveLength(count);
    rerender(<Conversation messages={thread.slice(0, 1)} active draft="Partial reply" />);
    expect(document.querySelector(".working-line")).toBeNull();
    expect(document.querySelector(".message.streaming .caret")).not.toBeNull();
  });

  it("shows the collapsed divider and the change summary", () => {
    render(
      <Conversation
        messages={thread}
        collapsedCount={4}
        turnChanges={{ fileCount: 2, added: 10, removed: 3, firstToolCallId: "tc-1" }}
      />,
    );
    expect(document.querySelector(".collapsed-divider").textContent).toBe("Earlier messages have been collapsed (4)");
    expect(document.querySelector(".change-summary").textContent).toContain("Changed 2 files");
  });
});
