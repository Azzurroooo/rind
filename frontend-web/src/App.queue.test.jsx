import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { applyTheme } from "./lib/theme.js";

// Queue + interrupt behaviours at the shell level (audit #1). The runtime
// client is a recording stub: bootstrap RPCs succeed, a running live_turn can
// be injected via h.hooks.current.liveTurn, and each test can override
// h.hooks.current.respond for the RPC it cares about.
const h = vi.hoisted(() => ({
  hooks: { current: { requests: [], respond: null, liveTurn: null } },
}));

vi.mock("./runtimeClient.js", () => ({
  initialRuntimeUrl: "ws://runtime.test",
  isAuthError: () => false,
  createRuntimeClient: (options) => {
    h.hooks.current.options = options || {};
    return {
      connect: async () => {
        await h.hooks.current.options.onOpen?.();
      },
      disconnect: () => {},
      setUrl: () => {},
      request: async (method, params = {}) => {
        h.hooks.current.requests.push({ method, params });
        if (h.hooks.current.respond) return h.hooks.current.respond(method, params);
        if (method === "initialize") return { session_id: "s-1", workspace_root: "E:/projects/rind", model: "model-a" };
        if (method === "session/list") {
          const limit = Math.max(0, Number(params.limit) || 30);
          return { sessions: Array.from({ length: limit }, (_, index) => ({ id: `p-${index + 1}`, title: `Session ${index + 1}` })) };
        }
        if (method === "session/replay") return { messages: [], live_turn: h.hooks.current.liveTurn };
        if (method === "model/list") return { models: ["model-a"], current_model: "model-a" };
        if (method === "session/subscribe" || method === "session/unsubscribe") return { ok: true, subscribed: [] };
        if (method === "rind/session/follow_up" || method === "rind/session/steer") return { accepted: true, input_id: "in-1", mode: "follow_up", pending: 1 };
        if (method === "rind/session/unsteer" || method === "rind/session/dequeue_follow_up") return { retrieved: true, input_id: "in-9", input: "queued text", mode: "follow_up", pending: 0 };
        return {};
      },
    };
  },
}));

function runningTurn(pendingInputs = []) {
  return { turn_id: "t1", status: "running", assistant_text: "", pending_inputs: pendingInputs };
}

async function renderShell(liveTurn = null) {
  h.hooks.current.requests = [];
  h.hooks.current.respond = null;
  h.hooks.current.liveTurn = liveTurn;
  render(<App />);
  await screen.findByText("Session 2"); // bootstrap + rail list settled
}

function composerTextarea() {
  return document.querySelector(".composer-shell textarea");
}

function typeAndSend(text) {
  const textarea = composerTextarea();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

const requests = () => h.hooks.current.requests;
const called = (method) => requests().some((entry) => entry.method === method);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem("rind_token", "test-token");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
});

describe("App — queue mode (audit #1)", () => {
  it("submitting while a turn runs queues as follow_up by default and renders the chip", async () => {
    await renderShell(runningTurn());
    typeAndSend("排队追问一句话");
    await waitFor(() => expect(called("rind/session/follow_up")).toBe(true));
    const call = requests().find((entry) => entry.method === "rind/session/follow_up");
    expect(call.params).toMatchObject({ session_id: "s-1", input: "排队追问一句话" });
    // the returned input_id is kept and the queued chip renders
    await waitFor(() => expect(document.querySelector(".queued-row[data-input-id='in-1']")).not.toBeNull());
    expect(screen.getByText(/QUEUED 队列中/)).not.toBeNull();
    // the draft was consumed by the send
    expect(composerTextarea().value).toBe("");
  });

  it("the composer switch flips the wire method to steer", async () => {
    await renderShell(runningTurn());
    fireEvent.click(screen.getByTitle("立即插入当前回合（steer）"));
    typeAndSend("立即转向");
    await waitFor(() => expect(called("rind/session/steer")).toBe(true));
    expect(called("rind/session/follow_up")).toBe(false);
  });

  it("取回 dequeues by input_id and restores the draft; 转向 promotes to steering", async () => {
    await renderShell(runningTurn([{ input_id: "in-9", input: "queued text", mode: "follow_up" }]));
    expect(document.querySelector(".queued-row[data-input-id='in-9']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "转向" }));
    await waitFor(() => expect(called("rind/session/promote_follow_up")).toBe(true));
    expect(requests().find((entry) => entry.method === "rind/session/promote_follow_up").params).toMatchObject({ session_id: "s-1", input_id: "in-9" });
    await waitFor(() => expect(screen.getByText("QUEUED 队列中 · steer")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "取回" }));
    await waitFor(() => expect(called("rind/session/unsteer")).toBe(true));
    expect(requests().find((entry) => entry.method === "rind/session/unsteer").params).toMatchObject({ session_id: "s-1", input_id: "in-9" });
    await waitFor(() => expect(document.querySelector(".queued-row")).toBeNull());
    // never lose the text: the draft comes back
    await waitFor(() => expect(composerTextarea().value).toContain("queued text"));
  });

  it("queued_input_delivered converts the chip into a normal user message", async () => {
    await renderShell(runningTurn([{ input_id: "in-9", input: "delivered text", mode: "follow_up" }]));
    expect(document.querySelector(".queued-row[data-input-id='in-9']")).not.toBeNull();

    await act(async () => {
      h.hooks.current.options.onEvent({
        kind: "event",
        method: "session/update",
        durability: "durable",
        session_id: "s-1",
        turn_id: "t1",
        sequence: 1,
        event: { type: "queued_input_delivered", input_id: "in-9", input: "delivered text", mode: "follow_up" },
      });
    });
    await waitFor(() => expect(document.querySelector(".queued-row")).toBeNull());
    expect(screen.getByText("delivered text")).not.toBeNull();
  });

  it("loading a session restores the queue from live_turn pending_inputs (reconnect path)", async () => {
    await renderShell(runningTurn([{ input_id: "in-a", input: "restored", mode: "steering" }]));
    expect(document.querySelector(".queued-row[data-input-id='in-a']")).not.toBeNull();
    expect(screen.getByText("QUEUED 队列中 · steer")).not.toBeNull();
    // steering items expose 取回 only
    expect(screen.queryByRole("button", { name: "转向" })).toBeNull();
  });
});

describe("App — double-Esc interrupt (audit #1)", () => {
  it("first Esc arms with the 再按一次 hint; second Esc cancels the turn", async () => {
    await renderShell(runningTurn());
    expect(screen.queryByText("再按一次 Esc 停止")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".interrupt-hint")).not.toBeNull();
    expect(called("session/cancel")).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(called("session/cancel")).toBe(true));
    expect(document.querySelector(".interrupt-hint")).toBeNull();
  });

  it("a single Esc resets silently after the 3s window", async () => {
    await renderShell(runningTurn());
    vi.useFakeTimers(); // installed BEFORE arming so the 3s timer is fake
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".interrupt-hint")).not.toBeNull();

    act(() => { vi.runAllTimers(); });
    expect(document.querySelector(".interrupt-hint")).toBeNull();
    expect(called("session/cancel")).toBe(false);
  });

  it("Esc does not arm when no turn is running", async () => {
    await renderShell(null);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".interrupt-hint")).toBeNull();
    expect(called("session/cancel")).toBe(false);
  });
});

describe("App — Ctrl/Cmd+K palette (audit #10)", () => {
  it("opens with Ctrl+K, closes on Esc and hands focus back to the composer", async () => {
    await renderShell(null);
    expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "命令面板" })).not.toBeNull();

    fireEvent.keyDown(screen.getByLabelText("搜索命令"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
    expect(document.activeElement).toBe(composerTextarea());
  });

  it("executing 停止 from the palette cancels the active turn", async () => {
    await renderShell(runningTurn());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(screen.getByText("停止"));
    await waitFor(() => expect(called("session/cancel")).toBe(true));
  });

  it("executing 主题 flips data-theme and persists the choice (audit #11)", async () => {
    await renderShell(null);
    applyTheme("dark");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByText("主题"));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem("rind.theme")).toBe("light");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByText("主题"));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("rind.theme")).toBe("dark");
  });
});

describe("App — session subscriptions (audit #13)", () => {
  it("subscribes every listed session plus the current one after the list loads", async () => {
    await renderShell(null);
    await waitFor(() => {
      const ids = requests().filter((entry) => entry.method === "session/subscribe").map((entry) => entry.params.session_id);
      expect(ids).toEqual(expect.arrayContaining(["p-1", "p-2", "s-1"]));
    });
  });

  it("unsubscribes a deleted session", async () => {
    await renderShell(null);
    const item = () => document.querySelector(".session-item[data-session-id='p-2']");
    fireEvent.click(item().querySelector(".session-delete"));
    fireEvent.click(item().querySelector(".confirm-yes"));
    await waitFor(() => expect(called("session/unsubscribe")).toBe(true));
    expect(requests().find((entry) => entry.method === "session/unsubscribe").params).toMatchObject({ session_id: "p-2" });
    await waitFor(() => expect(document.querySelector(".session-item[data-session-id='p-2']")).toBeNull());
  });
});

describe("App — rail search + pagination (audit #9)", () => {
  it("load more requests a larger limit; search filters the rail client-side", async () => {
    await renderShell(null);
    fireEvent.click(screen.getByText("加载更多"));
    await waitFor(() => {
      const listCalls = requests().filter((entry) => entry.method === "session/list");
      expect(listCalls.at(-1).params.limit).toBe(60);
    });

    const search = screen.getByLabelText("搜索会话");
    fireEvent.change(search, { target: { value: "Session 5" } });
    expect(screen.queryByText("Session 1")).toBeNull();
    expect(screen.getByText("Session 5")).not.toBeNull();
  });
});
