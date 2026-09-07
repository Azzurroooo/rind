import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";

// The shell (not the login card) must render for the drawer tests, so the
// runtime client is a stub: connect() mimics a successful handshake by
// invoking onOpen, and request() answers the bootstrap RPCs with a fixed
// session list. No socket, no timers.
const h = vi.hoisted(() => ({ hooks: { current: {} } }));

vi.mock("./runtimeClient.js", () => ({
  initialRuntimeUrl: "ws://runtime.test",
  isAuthError: () => false,
  createRuntimeClient: (options) => {
    h.hooks.current = options || {};
    return {
      connect: async () => {
        await h.hooks.current.onOpen?.();
      },
      disconnect: () => {},
      setUrl: () => {},
      request: async (method) => {
        if (method === "initialize") return { session_id: "s-1", workspace_root: "E:/projects/rind", model: "model-a" };
        if (method === "session/list") return { sessions: [{ id: "s-1", title: "First session" }, { id: "s-2", title: "Second session" }] };
        if (method === "session/replay") return { messages: [] };
        if (method === "model/list") return { models: ["model-a"], current_model: "model-a" };
        return {};
      },
    };
  },
}));

// jsdom has no matchMedia; the app reads (max-width: 900px) on mount and on
// change. dispatch(next) simulates crossing the breakpoint.
function stubMatchMedia(matches) {
  const listeners = new Set();
  const media = {
    matches,
    media: "(max-width: 900px)",
    addEventListener: (type, listener) => { if (type === "change") listeners.add(listener); },
    removeEventListener: (type, listener) => { listeners.delete(listener); },
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    dispatch(next) {
      media.matches = next;
      for (const listener of [...listeners]) listener({ matches: next, media: media.media });
    },
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return media;
}

const railPanel = () => document.getElementById("session-rail-panel");
const inspectorPanel = () => document.getElementById("inspector-panel");
const railToggle = () => screen.getByRole("button", { name: "会话列表" });
const inspectorToggle = () => screen.getByRole("button", { name: "会话状态" });

function expectClosed(panel) {
  expect(panel.className).toContain("drawer-closed");
  expect(panel.className).not.toContain("drawer-open");
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  expect(panel.hasAttribute("inert")).toBe(true);
}

function expectOpen(panel) {
  expect(panel.className).toContain("drawer-open");
  expect(panel.className).not.toContain("drawer-closed");
  expect(panel.getAttribute("aria-hidden")).toBeNull();
  expect(panel.hasAttribute("inert")).toBe(false);
}

beforeEach(() => {
  sessionStorage.setItem("rind_token", "test-token"); // shell renders instead of LoginGate
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("App — narrow viewport (≤900px): drawers start closed", () => {
  it("renders the compact header toggles wired to both off-canvas panels", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(railToggle().getAttribute("aria-expanded")).toBe("false");
    expect(inspectorToggle().getAttribute("aria-expanded")).toBe("false");
    expect(railToggle().getAttribute("aria-controls")).toBe("session-rail-panel");
    expect(inspectorToggle().getAttribute("aria-controls")).toBe("inspector-panel");
    expectClosed(railPanel());
    expectClosed(inspectorPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("App — narrow viewport: rail drawer", () => {
  it("hamburger opens it (focus moves in, backdrop appears); Esc closes and refocuses the toggle", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(railToggle());
    expect(railToggle().getAttribute("aria-expanded")).toBe("true");
    expectOpen(railPanel());
    expect(inspectorPanel().className).toContain("drawer-closed");
    expect(document.querySelector(".drawer-backdrop")).not.toBeNull();
    expect(document.activeElement).toBe(railPanel());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(railToggle().getAttribute("aria-expanded")).toBe("false");
    expectClosed(railPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
    expect(document.activeElement).toBe(railToggle());
  });

  it("backdrop tap closes it", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(railToggle());
    fireEvent.click(document.querySelector(".drawer-backdrop"));
    expectClosed(railPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });

  it("selecting a session is the route-relevant action that closes it", async () => {
    stubMatchMedia(true);
    render(<App />);
    await screen.findByText("First session");
    fireEvent.click(railToggle());
    expect(railPanel().className).toContain("drawer-open");
    fireEvent.click(document.querySelector(".session-item[data-session-id='s-2'] .session-main"));
    await waitFor(() => expect(railPanel().className).toContain("drawer-closed"));
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("App — narrow viewport: inspector drawer", () => {
  it("opens from the right toggle and is exclusive with the rail drawer", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(railToggle());
    expectOpen(railPanel());
    fireEvent.click(inspectorToggle());
    expect(inspectorToggle().getAttribute("aria-expanded")).toBe("true");
    expectOpen(inspectorPanel());
    expect(railToggle().getAttribute("aria-expanded")).toBe("false");
    expectClosed(railPanel());
    expect(document.activeElement).toBe(inspectorPanel());
    expect(document.querySelector(".drawer-backdrop")).not.toBeNull();
  });
});

describe("App — crossing the breakpoint", () => {
  it("force-closes an open drawer when the viewport becomes desktop-sized", () => {
    const media = stubMatchMedia(true);
    render(<App />);
    fireEvent.click(railToggle());
    expect(railPanel().className).toContain("drawer-open");
    act(() => media.dispatch(false));
    expect(railPanel().className).not.toContain("drawer-open");
    expect(railPanel().className).not.toContain("drawer-closed");
    expect(railPanel().getAttribute("aria-hidden")).toBeNull();
    expect(railPanel().hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("App — desktop viewport (>900px)", () => {
  it("panels are plain columns (no drawer classes/aria) and the hidden toggles are no-ops", () => {
    stubMatchMedia(false);
    render(<App />);
    expect(railToggle()).not.toBeNull(); // in the DOM, display:none via CSS
    expect(railPanel().className).toBe("session-rail");
    expect(inspectorPanel().className).toBe("inspector");
    expect(railPanel().getAttribute("aria-hidden")).toBeNull();
    expect(railPanel().hasAttribute("inert")).toBe(false);
    expect(inspectorPanel().hasAttribute("inert")).toBe(false);
    fireEvent.click(railToggle());
    expect(railPanel().className).toBe("session-rail");
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});
