import { describe, expect, it, vi } from "vitest";
import { CONNECTION_PHASES, createConnectionController, initialConnectionState, reduceConnection, statusAction } from "./connection.js";

const connecting = () => initialConnectionState();

describe("connection reducer — transition table (web-ui.md §2.1)", () => {
  it("starts connecting unless gated by the worker", () => {
    expect(initialConnectionState().phase).toBe("connecting");
    expect(initialConnectionState({ gated: true }).phase).toBe("login");
  });

  it("login → submit_credentials → connecting", () => {
    const next = reduceConnection(initialConnectionState(), { type: "submit_credentials" });
    expect(next.phase).toBe("connecting");
  });

  it("connecting → socket_open (first connect, no gap) → online", () => {
    const next = reduceConnection(connecting(), { type: "socket_open" });
    expect(next.phase).toBe("online");
    expect(next.needsSync).toBe(false);
  });

  it("connecting → connect_failed(attempt<3) → reconnecting", () => {
    const next = reduceConnection(connecting(), { type: "connect_failed", attempt: 1 });
    expect(next.phase).toBe("reconnecting");
    expect(next.failedAttempts).toBe(1);
  });

  it("connecting → connect_failed(attempt>=3) → offline", () => {
    const next = reduceConnection(connecting(), { type: "connect_failed", attempt: 3 });
    expect(next.phase).toBe("offline");
    expect(next.failedAttempts).toBe(3);
  });

  it("online → socket_lost → reconnecting and marks the gap", () => {
    const next = reduceConnection({ ...connecting(), phase: "online" }, { type: "socket_lost" });
    expect(next.phase).toBe("reconnecting");
    expect(next.needsSync).toBe(true);
  });

  it("online → heartbeat_timeout → reconnecting and marks the gap", () => {
    const next = reduceConnection({ ...connecting(), phase: "online" }, { type: "heartbeat_timeout" });
    expect(next.phase).toBe("reconnecting");
    expect(next.needsSync).toBe(true);
  });

  it("online → socket_open stays online (idempotent)", () => {
    const next = reduceConnection({ ...connecting(), phase: "online" }, { type: "socket_open" });
    expect(next.phase).toBe("online");
  });

  it("reconnecting → socket_open (gap pending) → syncing with counters reset", () => {
    const state = { ...connecting(), phase: "reconnecting", needsSync: true, failedAttempts: 2 };
    const next = reduceConnection(state, { type: "socket_open" });
    expect(next.phase).toBe("syncing");
    expect(next.syncTotal).toBe(0);
    expect(next.syncRemaining).toBe(0);
    expect(next.failedAttempts).toBe(0);
  });

  it("reconnecting → connect_failed(attempt<3) → reconnecting", () => {
    const state = { ...connecting(), phase: "reconnecting", needsSync: true };
    const next = reduceConnection(state, { type: "connect_failed", attempt: 2 });
    expect(next.phase).toBe("reconnecting");
    expect(next.failedAttempts).toBe(2);
  });

  it("reconnecting → connect_failed(attempt=3) → offline (≥3 failed attempts)", () => {
    const state = { ...connecting(), phase: "reconnecting", needsSync: true, failedAttempts: 2 };
    const next = reduceConnection(state, { type: "connect_failed", attempt: 3 });
    expect(next.phase).toBe("offline");
  });

  it("reconnecting → socket_lost stays reconnecting (no flicker)", () => {
    const state = { ...connecting(), phase: "reconnecting", needsSync: true };
    const next = reduceConnection(state, { type: "socket_lost" });
    expect(next.phase).toBe("reconnecting");
  });

  it("syncing → sync_start sets total and remaining", () => {
    const state = { ...connecting(), phase: "syncing", needsSync: true };
    const next = reduceConnection(state, { type: "sync_start", total: 7 });
    expect(next.phase).toBe("syncing");
    expect(next.syncTotal).toBe(7);
    expect(next.syncRemaining).toBe(7);
  });

  it("syncing → sync_progress counts remaining down and clamps at 0", () => {
    let state = { ...connecting(), phase: "syncing", syncTotal: 5, syncRemaining: 5 };
    state = reduceConnection(state, { type: "sync_progress", applied: 2 });
    expect(state.syncRemaining).toBe(3);
    state = reduceConnection(state, { type: "sync_progress", applied: 99 });
    expect(state.syncRemaining).toBe(0);
  });

  it("syncing → sync_complete → online and clears the gap", () => {
    const state = { ...connecting(), phase: "syncing", needsSync: true, syncTotal: 4, syncRemaining: 1 };
    const next = reduceConnection(state, { type: "sync_complete" });
    expect(next.phase).toBe("online");
    expect(next.needsSync).toBe(false);
    expect(next.syncTotal).toBe(0);
    expect(next.syncRemaining).toBe(0);
  });

  it("syncing → socket_lost → reconnecting (connection died mid-catch-up)", () => {
    const state = { ...connecting(), phase: "syncing", needsSync: true };
    const next = reduceConnection(state, { type: "socket_lost" });
    expect(next.phase).toBe("reconnecting");
    expect(next.needsSync).toBe(true);
  });

  it("offline → retry → reconnecting with attempts reset", () => {
    const state = { ...connecting(), phase: "offline", failedAttempts: 4, needsSync: true };
    const next = reduceConnection(state, { type: "retry" });
    expect(next.phase).toBe("reconnecting");
    expect(next.failedAttempts).toBe(0);
  });

  it("offline → retry → socket_open → syncing (J2: retry walks through syncing)", () => {
    let state = { ...connecting(), phase: "offline", failedAttempts: 3, needsSync: true };
    state = reduceConnection(state, { type: "retry" });
    expect(state.phase).toBe("reconnecting");
    state = reduceConnection(state, { type: "socket_open" });
    expect(state.phase).toBe("syncing");
  });

  it("offline → socket_lost stays offline (no flicker while waiting)", () => {
    const state = { ...connecting(), phase: "offline", failedAttempts: 3 };
    const next = reduceConnection(state, { type: "socket_lost" });
    expect(next.phase).toBe("offline");
  });

  it("offline → connect_failed(attempt>=3) stays offline", () => {
    const state = { ...connecting(), phase: "offline", failedAttempts: 3 };
    const next = reduceConnection(state, { type: "connect_failed", attempt: 5 });
    expect(next.phase).toBe("offline");
    expect(next.failedAttempts).toBe(5);
  });

  it("any phase → unauthorized → login with inline message", () => {
    for (const phase of ["connecting", "online", "reconnecting", "syncing", "offline"]) {
      const state = { ...connecting(), phase, needsSync: true, syncRemaining: 3 };
      const next = reduceConnection(state, { type: "unauthorized", message: "登录已失效" });
      expect(next.phase).toBe("login");
      expect(next.message).toBe("登录已失效");
      expect(next.needsSync).toBe(false);
      expect(next.syncRemaining).toBe(0);
    }
  });

  it("gated login → socket_lost stays login (never connected)", () => {
    const next = reduceConnection(initialConnectionState({ gated: true }), { type: "socket_lost" });
    expect(next.phase).toBe("login");
  });

  it("any phase → sign_out → clean connecting state (direct reconnect)", () => {
    const state = { ...connecting(), phase: "online", failedAttempts: 1 };
    const next = reduceConnection(state, { type: "sign_out" });
    expect(next.phase).toBe("connecting");
    expect(next).toEqual(initialConnectionState());
  });

  it("unknown action returns the same state", () => {
    const state = connecting();
    expect(reduceConnection(state, { type: " nonsense " })).toBe(state);
    expect(reduceConnection(state, null)).toBe(state);
  });
});

describe("connection reducer — scripted journey (J2)", () => {
  it("online → loss → reconnect attempts → offline → retry → syncing → online", () => {
    let state = { ...connecting(), phase: "online" };
    state = reduceConnection(state, { type: "heartbeat_timeout" });
    expect(state.phase).toBe("reconnecting");
    state = reduceConnection(state, { type: "connect_failed", attempt: 1 });
    state = reduceConnection(state, { type: "connect_failed", attempt: 2 });
    expect(state.phase).toBe("reconnecting");
    state = reduceConnection(state, { type: "connect_failed", attempt: 3 });
    expect(state.phase).toBe("offline");
    state = reduceConnection(state, { type: "retry" });
    state = reduceConnection(state, { type: "socket_open" });
    expect(state.phase).toBe("syncing");
    state = reduceConnection(state, { type: "sync_start", total: 3 });
    state = reduceConnection(state, { type: "sync_progress", applied: 1 });
    expect(state.syncRemaining).toBe(2);
    state = reduceConnection(state, { type: "sync_progress", applied: 2 });
    state = reduceConnection(state, { type: "sync_complete" });
    expect(state.phase).toBe("online");
    expect(state.needsSync).toBe(false);
  });
});

describe("connection reducer — invariants hold from every state", () => {
  const actions = [
    { type: "connect_start" },
    { type: "submit_credentials" },
    { type: "socket_open" },
    { type: "connect_failed", attempt: 2 },
    { type: "connect_failed", attempt: 4 },
    { type: "socket_lost" },
    { type: "heartbeat_timeout" },
    { type: "retry" },
    { type: "sync_start", total: 2 },
    { type: "sync_progress", applied: 1 },
    { type: "sync_complete" },
    { type: "unauthorized" },
    { type: "sign_out" },
    { type: "bogus" },
  ];

  it("always yields a valid phase and bounded counters", () => {
    for (const phase of CONNECTION_PHASES) {
      let state = { ...connecting(), phase };
      for (const action of actions) {
        state = reduceConnection(state, action);
        expect(CONNECTION_PHASES).toContain(state.phase);
        expect(state.failedAttempts).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(state.syncRemaining)).toBe(true);
        expect(Number.isFinite(state.syncTotal)).toBe(true);
      }
    }
  });

  it("never touches composer-owned state (draft/input live outside this reducer)", () => {
    // Structural guarantee: the state shape has no draft/input fields at all.
    const state = reduceConnection(connecting(), { type: "socket_lost" });
    expect(Object.keys(state).sort()).toEqual(["failedAttempts", "message", "needsSync", "phase", "syncRemaining", "syncTotal"].sort());
  });
});

describe("statusAction mapping", () => {
  const cases = [
    [{ state: "connecting" }, { type: "connect_start" }],
    [{ state: "connected" }, { type: "socket_open" }],
    [{ state: "reconnecting", attempt: 2 }, { type: "connect_failed", attempt: 2 }],
    [{ state: "disconnected" }, { type: "socket_lost", reason: "disconnected" }],
    [{ state: "error" }, { type: "socket_lost", reason: "error" }],
    [{ state: "heartbeat_timeout" }, { type: "heartbeat_timeout" }],
    [{ state: "unauthorized", code: 4401 }, { type: "unauthorized" }],
    [{ state: "closed" }, null],
    [null, null],
  ];
  for (const [status, expected] of cases) {
    it(`maps ${JSON.stringify(status)} → ${JSON.stringify(expected)}`, () => {
      expect(statusAction(status)).toEqual(expected);
    });
  }
});

describe("connection controller", () => {
  it("dispatches the mapped action and reports what it dispatched", () => {
    const dispatch = vi.fn();
    const controller = createConnectionController({ dispatch });
    const action = controller.handleStatus({ state: "reconnecting", attempt: 1 });
    expect(action).toEqual({ type: "connect_failed", attempt: 1 });
    expect(dispatch).toHaveBeenCalledWith({ type: "connect_failed", attempt: 1 });
    expect(controller.handleStatus({ state: "closed" })).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
