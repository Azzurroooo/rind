import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard.jsx";

afterEach(cleanup);

const pendingEntry = {
  id: "question:s1:q1",
  role: "question",
  sessionId: "s1",
  toolCallId: "q1",
  questions: [
    {
      header: "Deploy",
      question: "Proceed with the deploy?",
      options: [
        { label: "Yes, deploy (Recommended)", description: "Ship it now" },
        { label: "No, wait", description: "Hold release" },
      ],
    },
  ],
  status: "pending",
  selectedAnswers: [],
  requestedAt: 0,
  ttlMs: 120_000,
};

function answeredEntry(overrides = {}) {
  return {
    ...pendingEntry,
    status: "answered",
    selectedAnswers: [["Yes, deploy (Recommended)"]],
    ...overrides,
  };
}

describe("QuestionCard — pending state & Recommended badge polish", () => {
  it("renders stripped option label with Recommended badge, ≥44px option class, and silent timer bar", () => {
    const { container } = render(<QuestionCard entry={pendingEntry} onAnswer={() => {}} />);
    expect(screen.getByText("Proceed with the deploy?")).not.toBeNull();
    expect(screen.getByText("Yes, deploy")).not.toBeNull();
    expect(screen.getByText("Recommended")).not.toBeNull();
    // Single-question mode omits multi-step tablist chrome
    expect(screen.queryByRole("tablist")).toBeNull();
    const option = screen.getByText("Yes, deploy").closest("button");
    expect(option.className).toContain("question-option");
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".question-timer-bar")).not.toBeNull();
    expect(container.querySelector(".question-timer").textContent).toBe("");
  });

  it("selects an option and confirms only when Send answer is clicked (preventing accidental touch misfires)", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("No, wait"));
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0].toolCallId).toBe("q1");
    expect(onAnswer.mock.calls[0][1]).toEqual([["No, wait"]]);
  });

  it("supports multi-question step deck with auto-advance on single-select and multi-select checkboxes", async () => {
    const onAnswer = vi.fn(async () => true);
    const multiEntry = {
      ...pendingEntry,
      toolCallId: "q-multi",
      questions: [
        {
          header: "Storage",
          question: "Which database should we use?",
          options: [
            { label: "SQLite", description: "Embedded" },
            { label: "Postgres", description: "Server" },
          ],
        },
        {
          header: "Surfaces",
          question: "Which surfaces should we update?",
          multiple: true,
          options: [
            { label: "CLI", description: "Terminal" },
            { label: "Web", description: "Browser" },
            { label: "Mobile", description: "Phone" },
          ],
        },
      ],
    };
    render(<QuestionCard entry={multiEntry} onAnswer={onAnswer} />);
    expect(screen.getByRole("tablist")).not.toBeNull();
    expect(screen.getByText("1 / 2")).not.toBeNull();

    // Selecting single-choice Q1 auto-advances to Q2
    fireEvent.click(screen.getByText("Postgres"));
    expect(screen.getByText("2 / 2")).not.toBeNull();
    expect(screen.getByText("Which surfaces should we update?")).not.toBeNull();
    expect(screen.getByText("Select all that apply")).not.toBeNull();

    // Toggle two checkboxes on Q2 and submit
    fireEvent.click(screen.getByText("CLI"));
    fireEvent.click(screen.getByText("Web"));
    const submitBtn = screen.getByRole("button", { name: "Submit (2/2)" });
    expect(submitBtn.disabled).toBe(false);
    fireEvent.click(submitBtn);
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledWith(multiEntry, [["Postgres"], ["CLI", "Web"]]);
  });

  it("supports inline custom answer expansion and Skip action", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("Write your own answer…"));
    const input = screen.getByLabelText("Custom answer");
    fireEvent.change(input, { target: { value: "ship on friday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledWith(pendingEntry, [["ship on friday"]]);

    onAnswer.mockClear();
    cleanup();
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledWith(pendingEntry, []);
  });

  it("keeps the pending card interactive when sending fails", async () => {
    const onAnswer = vi.fn(async () => false);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Failed to send");
    expect(screen.getByText("Yes, deploy").closest("button").disabled).toBe(false);
  });
});

describe("QuestionCard — answered decision receipt & terminal states", () => {
  it("collapses answered card into a compact read-only decision receipt", () => {
    const { container } = render(<QuestionCard entry={answeredEntry()} onAnswer={() => {}} onExpire={() => {}} />);
    expect(screen.getAllByText("Answered").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Deploy")).not.toBeNull();
    expect(screen.getByText("Yes, deploy")).not.toBeNull();
    // Unselected options and timer bar are collapsed away
    expect(screen.queryByText("No, wait")).toBeNull();
    expect(container.querySelector(".question-timer")).toBeNull();
  });

  it("renders expired and cancelled summaries cleanly and fires onExpire on TTL", () => {
    render(<QuestionCard entry={{ ...pendingEntry, status: "expired" }} onAnswer={() => {}} />);
    expect(screen.getByText("Expired")).not.toBeNull();
    cleanup();

    render(<QuestionCard entry={{ ...pendingEntry, status: "cancelled" }} onAnswer={() => {}} />);
    expect(screen.getByText("Ended with the turn")).not.toBeNull();
    cleanup();

    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      render(<QuestionCard entry={pendingEntry} onAnswer={() => {}} onExpire={onExpire} />);
      act(() => {
        vi.advanceTimersByTime(120_500);
      });
      expect(onExpire).toHaveBeenCalledWith("s1:q1");
    } finally {
      vi.useRealTimers();
    }
  });
});
