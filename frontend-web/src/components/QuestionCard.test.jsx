import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard.jsx";

afterEach(cleanup);

const pendingEntry = {
  id: "question:s1:q1",
  role: "question",
  sessionId: "s1",
  toolCallId: "q1",
  question: "Proceed with the deploy?",
  options: [
    { value: "yes", label: "Yes, deploy", description: "ship it now" },
    { value: "no", label: "No, wait" },
  ],
  status: "pending",
  selectedAnswer: "",
  requestedAt: 0,
  ttlMs: 120_000,
};

function answeredEntry(overrides = {}) {
  return { ...pendingEntry, status: "answered", selectedAnswer: "yes", ...overrides };
}

describe("QuestionCard — pending state (§2.3)", () => {
  it("renders the question, options with ≥44px hit area, and the silent timer bar", () => {
    const { container } = render(<QuestionCard entry={pendingEntry} onAnswer={() => {}} />);
    expect(screen.getByText("Proceed with the deploy?")).not.toBeNull();
    const option = screen.getByText("Yes, deploy").closest("button");
    expect(option.className).toContain("question-option");
    // hit area contract is enforced by CSS (min-height: 44px); the class must be present
    expect(document.querySelector(".question-option")).not.toBeNull();
    expect(container.querySelector(".question-timer-bar")).not.toBeNull();
    expect(container.querySelector(".question-timer-bar").style.animationDuration).toBe("120000ms");
    expect(screen.queryByText("已超时")).toBeNull();
  });

  it("no ticking countdown numbers anywhere", () => {
    const { container } = render(<QuestionCard entry={pendingEntry} onAnswer={() => {}} />);
    expect(container.querySelector(".question-timer").textContent).toBe("");
  });

  it("clicking an option answers it via the app callback", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("No, wait"));
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0].toolCallId).toBe("q1");
    expect(onAnswer.mock.calls[0][1]).toBe("no");
  });
});

describe("QuestionCard — answered freezes in the stream (§2.3)", () => {
  it("buttons freeze with the chosen option marked and stay rendered", () => {
    render(<QuestionCard entry={answeredEntry()} onAnswer={() => {}} onExpire={() => {}} />);
    expect(screen.getByText("已回答")).not.toBeNull();
    const selected = screen.getByText("Yes, deploy").closest("button");
    expect(selected.className).toContain("selected");
    expect(selected.disabled).toBe(true);
    expect(screen.getByText("No, wait").closest("button").disabled).toBe(true);
    expect(screen.getByText("已选择：yes")).not.toBeNull();
    expect(document.querySelector(".question-timer")).toBeNull();
  });

  it("keeps the pending card interactive when the answer request fails", async () => {
    const onAnswer = vi.fn(async () => false);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("Yes, deploy"));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("未发送成功");
    expect(screen.getByText("Yes, deploy").closest("button").disabled).toBe(false);
  });

  it("supports the custom answer input", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<QuestionCard entry={pendingEntry} onAnswer={onAnswer} />);
    const input = screen.getByLabelText("自定义答案");
    fireEvent.change(input, { target: { value: "ship on friday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(onAnswer.mock.calls[0][1]).toBe("ship on friday");
  });
});

describe("QuestionCard — expired and cancelled (§2.3)", () => {
  it("expired shows the 已超时 tag and closes the options", () => {
    render(<QuestionCard entry={{ ...pendingEntry, status: "expired" }} onAnswer={() => {}} />);
    expect(screen.getByText("已超时")).not.toBeNull();
    expect(screen.getByText("Yes, deploy").closest("button").disabled).toBe(true);
  });

  it("cancelled (turn terminal) shows the closed tag", () => {
    render(<QuestionCard entry={{ ...pendingEntry, status: "cancelled" }} onAnswer={() => {}} />);
    expect(screen.getByText("已随回合结束")).not.toBeNull();
    expect(screen.getByText("Yes, deploy").closest("button").disabled).toBe(true);
  });

  it("fires onExpire once the TTL runs out", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      render(<QuestionCard entry={pendingEntry} onAnswer={() => {}} onExpire={onExpire} />);
      act(() => {
        vi.advanceTimersByTime(120_500);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith("s1:q1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule expiry for closed cards", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      render(<QuestionCard entry={answeredEntry()} onAnswer={() => {}} onExpire={onExpire} />);
      act(() => {
        vi.advanceTimersByTime(1_000_000);
      });
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
