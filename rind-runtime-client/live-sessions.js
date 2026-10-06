// What every session in the shared Runtime is doing right now: whether a turn
// runs or waits for an answer, and how many windows show it. The host already
// sees every request and event, so this costs no polling; observers get the
// whole (small) table pushed when it changes, coalesced per tick.
const TURN_EVENTS = {
  turn_started: "running",
  user_question_requested: "question",
  turn_completed: "idle",
  turn_failed: "idle",
  turn_cancelled: "idle",
};
// Idle sessions nobody shows are forgotten after this; history keeps them.
const FORGET_AFTER_MS = 10 * 60 * 1000;

export function createLiveSessions({ onChange = () => {}, now = () => Date.now(), schedule = fn => setImmediate(fn) } = {}) {
  const sessions = new Map();
  const viewers = new Map(); // viewer -> session id it shows
  let pending = false;

  const entry = id => {
    let item = sessions.get(id);
    if (!item) { item = { id, workspace: "", turn: "idle", startedAt: "", updatedAt: new Date(now()).toISOString() }; sessions.set(id, item); }
    return item;
  };
  const changed = () => {
    if (pending) return;
    pending = true;
    schedule(() => { pending = false; onChange(list()); });
  };
  function list() {
    const watchers = new Map();
    for (const id of viewers.values()) watchers.set(id, (watchers.get(id) || 0) + 1);
    const cutoff = now() - FORGET_AFTER_MS;
    const out = [];
    for (const item of sessions.values()) {
      const count = watchers.get(item.id) || 0;
      if (!count && item.turn === "idle" && Date.parse(item.updatedAt) < cutoff) { sessions.delete(item.id); continue; }
      out.push({ ...item, watchers: count });
    }
    return out;
  }
  return {
    list,
    // A window now shows `id` (opened, created, switched to or prompted).
    view(viewer, id, workspace) {
      if (!id) return;
      const item = entry(id);
      if (workspace) item.workspace = workspace;
      if (viewers.get(viewer) !== id) { viewers.set(viewer, id); changed(); }
    },
    leave(viewer) { if (viewers.delete(viewer)) changed(); },
    // The worker went away: no turn can still be running.
    reset() {
      let any = false;
      for (const item of sessions.values()) if (item.turn !== "idle") { item.turn = "idle"; item.updatedAt = new Date(now()).toISOString(); any = true; }
      if (any) changed();
    },
    event(message) {
      const id = message?.session_id;
      const turn = TURN_EVENTS[message?.event?.type] || (message?.event?.type === "tool_result" && message.event.tool_name === "ask_user_question" ? "running" : undefined);
      if (!id || !turn) return;
      const item = entry(id);
      if (item.turn === turn) return;
      const at = new Date(now()).toISOString();
      if (turn === "running" && item.turn === "idle") item.startedAt = at;
      item.turn = turn;
      item.updatedAt = at;
      changed();
    },
  };
}
