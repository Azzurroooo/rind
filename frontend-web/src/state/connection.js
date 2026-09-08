// Connection state machine (web-ui.md §2.1) — pure reducer, no IO.
//
// Phases and their visuals (ConnectionBar renders the strip):
//   login        → LoginGate card, shown only after the worker demanded auth
//   connecting   → renders NOTHING (transitional, e.g. handshake in flight)
//   online       → renders NOTHING (contract: online shows no element)
//   reconnecting → 2px top strip + "重连中"
//   syncing      → strip + "同步中…（N 条）", N counts down; fades out 800ms after done
//   offline      → strip + "已断开" + retry button (after >= 3 failed reconnect attempts)
//
// Invariants that must hold in every phase (enforced by construction):
//   - no modal is ever opened;
//   - the Composer draft lives outside this state and is never touched;
//   - scroll position is untouched (the strip is position:fixed, no layout shift);
//   - composer input is never disabled by connection state.

export const CONNECTION_PHASES = ["login", "connecting", "online", "reconnecting", "syncing", "offline"];

const OFFLINE_AFTER_FAILED_ATTEMPTS = 3;

export function initialConnectionState({ gated = false } = {}) {
  return {
    phase: gated ? "login" : "connecting",
    failedAttempts: 0,
    needsSync: false, // a live connection was lost → next open must replay-catch-up
    syncTotal: 0,
    syncRemaining: 0,
    message: "",
  };
}

export function reduceConnection(state, action) {
  const type = action?.type;
  switch (type) {
    case "connect_start": // a connect attempt is in flight (initial or manual)
      return { ...state, phase: "connecting", message: "" };

    case "submit_credentials": // login card submitted
      return { ...state, phase: "connecting", message: "" };

    case "socket_open": // handshake succeeded; syncing only if we lost the wire before
      if (state.needsSync) {
        return { ...state, phase: "syncing", syncTotal: 0, syncRemaining: 0, failedAttempts: 0, message: "" };
      }
      return { ...state, phase: "online", failedAttempts: 0, message: "" };

    case "connect_failed": { // a reconnect attempt ended in failure; attempt is 1-based
      const attempt = Math.max(1, Number(action.attempt) || state.failedAttempts + 1);
      return {
        ...state,
        failedAttempts: attempt,
        phase: attempt >= OFFLINE_AFTER_FAILED_ATTEMPTS ? "offline" : "reconnecting",
        needsSync: true,
      };
    }

    case "socket_lost": // underlying socket closed unexpectedly
    case "heartbeat_timeout": // no sign of life within the heartbeat window
      if (state.phase === "login" || state.phase === "offline") return state;
      return { ...state, phase: "reconnecting", needsSync: true };

    case "retry": // user pressed the retry button
      return { ...state, phase: "reconnecting", failedAttempts: 0, needsSync: true };

    case "sync_start": // replay response known: total = remaining durable events
      return { ...state, phase: "syncing", syncTotal: positiveOrZero(action.total), syncRemaining: positiveOrZero(action.total) };

    case "sync_progress": // applied a batch of catch-up events
      return { ...state, phase: "syncing", syncRemaining: Math.max(0, state.syncRemaining - positiveOrZero(action.applied)) };

    case "sync_complete": // caught up → back to a quiet wire
      return { ...state, phase: "online", needsSync: false, syncTotal: 0, syncRemaining: 0 };

    case "unauthorized": // 4401 / rejected credential → back to the login card
      return { ...initialConnectionState({ gated: true }), phase: "login", message: String(action.message || "") };

    case "sign_out": // user-initiated disconnect, no error text
      return { ...initialConnectionState() };

    default:
      return state;
  }
}

// Maps runtimeClient status callbacks to reducer actions (pure, testable).
export function statusAction(status) {
  switch (status?.state) {
    case "connecting":
      return { type: "connect_start" };
    case "connected":
      return { type: "socket_open" };
    case "reconnecting":
      return { type: "connect_failed", attempt: Number(status.attempt) || 1 };
    case "disconnected":
    case "error":
      return { type: "socket_lost", reason: status.state };
    case "heartbeat_timeout":
      return { type: "heartbeat_timeout" };
    case "unauthorized":
      return { type: "unauthorized" };
    default: // "closed" is user-initiated; App decides (sign out / re-login)
      return null;
  }
}

// Thin controller: forwards runtimeClient statuses into dispatch.
export function createConnectionController({ dispatch } = {}) {
  return {
    handleStatus(status) {
      const action = statusAction(status);
      if (action && dispatch) dispatch(action);
      return action;
    },
  };
}

function positiveOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
