import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStrip } from "./ConnectionStrip.jsx";

afterEach(cleanup);

describe("ConnectionStrip: connection states", () => {
  it("online renders nothing", () => {
    render(<ConnectionStrip phase="online" />);
    expect(document.querySelector(".connection-strip")).toBeNull();
  });

  it("connecting (initial handshake) renders nothing", () => {
    render(<ConnectionStrip phase="connecting" />);
    expect(document.querySelector(".connection-strip")).toBeNull();
  });

  it("reconnecting shows the strip without a retry button", () => {
    render(<ConnectionStrip phase="reconnecting" />);
    const strip = document.querySelector(".connection-strip.reconnecting");
    expect(strip).not.toBeNull();
    expect(strip.getAttribute("role")).toBe("status");
    expect(screen.getByText("Reconnecting")).not.toBeNull();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("syncing shows the remaining count", () => {
    render(<ConnectionStrip phase="syncing" syncTotal={6} syncRemaining={2} />);
    expect(document.querySelector(".connection-strip.syncing")).not.toBeNull();
    expect(screen.getByText("Syncing… (2 items)")).not.toBeNull();
  });

  it("offline shows Disconnected and Retry calls onReconnect", () => {
    const onReconnect = vi.fn();
    render(<ConnectionStrip phase="offline" onReconnect={onReconnect} />);
    expect(screen.getByText("Disconnected")).not.toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionStrip: syncing completion fade", () => {
  it("keeps a fading strip for 800ms after syncing completes", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ConnectionStrip phase="syncing" syncTotal={3} syncRemaining={0} />);
      rerender(<ConnectionStrip phase="online" syncTotal={3} syncRemaining={0} />);
      expect(document.querySelector(".connection-strip.fading")).not.toBeNull();
      expect(screen.getByText("Syncing… (0 items)")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(800); });
      expect(document.querySelector(".connection-strip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
