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

// jsdom has no matchMedia; the shell reads the narrow query (max-width: 767px)
// on mount and on change. dispatch(next) simulates crossing the breakpoint.
function stubMatchMedia(matches) {
  const listeners = new Set();
  const media = {
    matches,
    media: "(max-width: 767px)",
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

const sidebarPanel = () => document.getElementById("sidebar-panel");
const inspectorPanel = () => document.getElementById("inspector-panel");
const sidebarToggle = () => screen.getByRole("button", { name: "Toggle sidebar" });
const inspectorToggle = () => screen.getByRole("button", { name: "Toggle inspector" });

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
  localStorage.clear();
  sessionStorage.setItem("rind_token", "test-token");
  sessionStorage.setItem("rind_credential_server", "ws://runtime.test"); // shell renders instead of LoginGate
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("Shell - narrow viewport (<768px): drawers start closed", () => {
  it("renders header toggles wired to both off-canvas panels", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    expect(inspectorToggle().getAttribute("aria-expanded")).toBe("false");
    expect(sidebarToggle().getAttribute("aria-controls")).toBe("sidebar-panel");
    expect(inspectorToggle().getAttribute("aria-controls")).toBe("inspector-panel");
    expectClosed(sidebarPanel());
    expectClosed(inspectorPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("Shell - narrow viewport: sidebar drawer", () => {
  it("the toggle opens it (focus moves in, backdrop appears); Esc closes and refocuses the toggle", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(sidebarToggle());
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    expectOpen(sidebarPanel());
    expectClosed(inspectorPanel());
    expect(document.querySelector(".drawer-backdrop")).not.toBeNull();
    expect(document.activeElement).toBe(sidebarPanel());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    expectClosed(sidebarPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
    expect(document.activeElement).toBe(sidebarToggle());
  });

  it("backdrop tap closes it", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(sidebarToggle());
    fireEvent.click(document.querySelector(".drawer-backdrop"));
    expectClosed(sidebarPanel());
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });

  it("selecting a session closes it", async () => {
    stubMatchMedia(true);
    render(<App />);
    await screen.findAllByText("Second session");
    fireEvent.click(sidebarToggle());
    expect(sidebarPanel().className).toContain("drawer-open");
    fireEvent.click(document.querySelector(".session-item[data-session-id='s-2'] .session-main"));
    await waitFor(() => expect(sidebarPanel().className).toContain("drawer-closed"));
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("Shell - narrow viewport: inspector drawer", () => {
  it("opens from the right toggle and is exclusive with the sidebar drawer", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(sidebarToggle());
    expectOpen(sidebarPanel());
    fireEvent.click(inspectorToggle());
    expect(inspectorToggle().getAttribute("aria-expanded")).toBe("true");
    expectOpen(inspectorPanel());
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    expectClosed(sidebarPanel());
    expect(document.activeElement).toBe(inspectorPanel());
    expect(document.querySelector(".drawer-backdrop")).not.toBeNull();
  });
});

describe("Shell - crossing the breakpoint", () => {
  it("force-closes an open drawer when the viewport becomes desktop-sized", () => {
    const media = stubMatchMedia(true);
    render(<App />);
    fireEvent.click(sidebarToggle());
    expect(sidebarPanel().className).toContain("drawer-open");
    act(() => media.dispatch(false));
    expect(sidebarPanel().className).toBe("sidebar");
    expect(sidebarPanel().getAttribute("aria-hidden")).toBeNull();
    expect(sidebarPanel().hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("Shell - desktop viewport", () => {
  it("the sidebar is a column that collapses from the toggle and with Ctrl+B, and the choice persists", () => {
    stubMatchMedia(false);
    render(<App />);
    expect(sidebarPanel().className).toBe("sidebar");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[role='separator'][aria-label='Resize sidebar']")).not.toBeNull();

    fireEvent.click(sidebarToggle());
    expect(sidebarPanel().className).toContain("is-collapsed");
    expect(sidebarPanel().hasAttribute("inert")).toBe(true);
    expect(localStorage.getItem("rind.layout.sidebarCollapsed")).toBe("true");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebarPanel().className).toBe("sidebar");
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });

  it("the inspector starts closed and opens from its toggle", () => {
    stubMatchMedia(false);
    render(<App />);
    expect(inspectorPanel().className).toContain("is-collapsed");
    expect(inspectorPanel().hasAttribute("inert")).toBe(true);
    fireEvent.click(inspectorToggle());
    expect(inspectorPanel().className).toBe("inspector");
    expect(inspectorPanel().hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("tablist", { name: "Inspector sections" })).not.toBeNull();
    expect(document.querySelector("[role='separator'][aria-label='Resize inspector']")).not.toBeNull();
  });
});
