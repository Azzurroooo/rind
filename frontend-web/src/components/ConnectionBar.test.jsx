import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBar } from "./ConnectionBar.jsx";

afterEach(cleanup);

const baseProps = {
  url: "ws://127.0.0.1:8765/ws",
  onChangeUrl: () => {},
  onReconnect: () => {},
  onLogout: () => {},
};

describe("ConnectionBar — four connection states (web-ui.md §2.1)", () => {
  it("online renders no connection strip at all", () => {
    render(<ConnectionBar {...baseProps} phase="online" />);
    expect(document.querySelector(".connection-strip")).toBeNull();
    expect(screen.queryByText("Reconnecting")).toBeNull();
    expect(screen.queryByText("Disconnected")).toBeNull();
  });

  it("reconnecting shows the strip with Reconnecting", () => {
    render(<ConnectionBar {...baseProps} phase="reconnecting" />);
    expect(document.querySelector(".connection-strip.reconnecting")).not.toBeNull();
    expect(screen.getByText("Reconnecting")).not.toBeNull();
    expect(screen.queryByText("Retry")).toBeNull(); // no retry button while auto-retrying
  });

  it("syncing shows Syncing… (N items) with the remaining count", () => {
    render(<ConnectionBar {...baseProps} phase="syncing" syncTotal={6} syncRemaining={2} />);
    expect(document.querySelector(".connection-strip.syncing")).not.toBeNull();
    expect(screen.getByText("Syncing… (2 items)")).not.toBeNull();
  });

  it("offline shows Disconnected and its retry button triggers onReconnect", () => {
    const onReconnect = vi.fn();
    render(<ConnectionBar {...baseProps} phase="offline" onReconnect={onReconnect} />);
    expect(document.querySelector(".connection-strip.offline")).not.toBeNull();
    expect(screen.getByText("Disconnected")).not.toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("connecting (initial handshake) renders no strip", () => {
    render(<ConnectionBar {...baseProps} phase="connecting" />);
    expect(document.querySelector(".connection-strip")).toBeNull();
  });
});

describe("ConnectionBar — syncing completion fade (800ms)", () => {
  it("keeps the strip visible with a fading class after completion, then removes it", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ConnectionBar {...baseProps} phase="syncing" syncTotal={3} syncRemaining={0} />);
      expect(screen.getByText("Syncing… (0 items)")).not.toBeNull();

      rerender(<ConnectionBar {...baseProps} phase="online" syncTotal={3} syncRemaining={0} />);
      expect(document.querySelector(".connection-strip.fading")).not.toBeNull();
      expect(screen.getByText("Syncing… (0 items)")).not.toBeNull(); // last count retained

      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(document.querySelector(".connection-strip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConnectionBar — topbar chrome", () => {
  it("reflects connection state in the dot and offers logout when connected", () => {
    const onLogout = vi.fn();
    const { container, rerender } = render(<ConnectionBar {...baseProps} phase="online" onLogout={onLogout} />);
    expect(container.querySelector(".connection-dot.online")).not.toBeNull();
    expect(screen.getByText("connected")).not.toBeNull();

    fireEvent.click(screen.getByTitle("Disconnect and clear this page's credentials"));
    expect(onLogout).toHaveBeenCalledTimes(1);

    rerender(<ConnectionBar {...baseProps} phase="offline" onLogout={onLogout} />);
    expect(container.querySelector(".connection-dot.offline")).not.toBeNull();
  });
});
