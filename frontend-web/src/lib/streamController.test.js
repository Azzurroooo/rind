import { describe, expect, it, vi } from "vitest";
import { createEventCoalescer } from "./streamController.js";

function delta(sequence, text, turnId = "t1", sessionId = "s1") {
  return { kind: "event", durability: "incremental", session_id: sessionId, turn_id: turnId, sequence, event: { type: "assistant_delta", text } };
}

// Immediate synchronous scheduler: each push flushes on the next manual tick.
function manualScheduler() {
  const queue = [];
  const schedule = (fn) => { queue.push(fn); return () => {}; };
  schedule.tick = () => {
    const jobs = queue.splice(0, queue.length);
    for (const job of jobs) job();
  };
  schedule.pending = () => queue.length;
  return schedule;
}

describe("streamController — delta coalescing (audit #5)", () => {
  it("merges consecutive deltas into one dispatch with concatenated text", () => {
    const schedule = manualScheduler();
    const dispatch = vi.fn();
    const coalescer = createEventCoalescer({ dispatch, schedule });
    coalescer.push(delta(2, "hel"));
    coalescer.push(delta(3, "lo"));
    coalescer.push(delta(4, " world"));
    expect(dispatch).not.toHaveBeenCalled(); // nothing emitted before the frame
    schedule.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const envelope = dispatch.mock.calls[0][0];
    expect(envelope.event.type).toBe("assistant_delta");
    expect(envelope.event.text).toBe("hello world");
    expect(envelope.sequence).toBe(4); // survivor keeps the last sequence
  });

  it("records absorbed sequences so replayed deltas stay idempotent", () => {
    const schedule = manualScheduler();
    const dispatch = vi.fn();
    const coalescer = createEventCoalescer({ dispatch, schedule });
    coalescer.push(delta(2, "a"));
    coalescer.push(delta(3, "b"));
    schedule.tick();
    expect(dispatch.mock.calls[0][0].absorbed).toEqual([2]);
  });

  it("flushes before non-delta envelopes so cross-type order is preserved", () => {
    const schedule = manualScheduler();
    const dispatch = vi.fn();
    const coalescer = createEventCoalescer({ dispatch, schedule });
    coalescer.push(delta(2, "partial"));
    const started = { kind: "event", durability: "durable", session_id: "s1", turn_id: "t1", sequence: 3, event: { type: "tool_requested", tool_call_id: "c1", tool_name: "bash" } };
    coalescer.push(started);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].event.text).toBe("partial");
    expect(dispatch.mock.calls[1][0]).toBe(started);
  });

  it("never merges across turns or sessions", () => {
    const schedule = manualScheduler();
    const dispatch = vi.fn();
    const coalescer = createEventCoalescer({ dispatch, schedule });
    coalescer.push(delta(1, "one", "t1"));
    coalescer.push(delta(2, "two", "t2"));
    schedule.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].event.text).toBe("one");
    expect(dispatch.mock.calls[1][0].event.text).toBe("two");
  });

  it("dispose flushes a pending buffer", () => {
    const schedule = manualScheduler();
    const dispatch = vi.fn();
    const coalescer = createEventCoalescer({ dispatch, schedule });
    coalescer.push(delta(1, "tail"));
    coalescer.dispose();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].event.text).toBe("tail");
  });

  it("works without rAF (timer fallback path)", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    try {
      vi.useFakeTimers();
      const dispatch = vi.fn();
      const coalescer = createEventCoalescer({ dispatch });
      coalescer.push(delta(1, "slow"));
      expect(dispatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(dispatch).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
