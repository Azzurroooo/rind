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
    if (!item) { item = { id, workspace: "", turn: "idle", draft: false, startedAt: "", updatedAt: new Date(now()).toISOString() }; sessions.set(id, item); }
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
      const { hosted, ...shown } = item;
      out.push({ ...shown, watchers: count });
    }
    return out;
  }
  return {
    list,
    // A window now shows `id` (opened, created, switched to or prompted).
    // `draft` is true while the conversation has no message yet.
    view(viewer, id, { workspace, draft } = {}) {
      if (!id) return;
      const item = entry(id);
      const was = viewers.get(viewer);
      if (workspace) item.workspace = workspace;
      item.hosted = true;
      if (typeof draft === "boolean" && item.draft !== draft) { item.draft = draft; changed(); }
      // Re-inserting keeps the map ordered by recency, newest last.
      viewers.delete(viewer);
      viewers.set(viewer, id);
      if (was !== id) changed();
    },
    // The window that most recently showed `id` and passes `accept`.
    newestViewer(id, accept = () => true) {
      let found;
      for (const [viewer, shown] of viewers) if (shown === id && accept(viewer)) found = viewer;
      return found;
    },
    // Opened in the current worker, so it has its tools and scope configured.
    hosted: id => Boolean(sessions.get(id)?.hosted),
    leave(viewer) { if (viewers.delete(viewer)) changed(); },
    // The worker went away: no turn can still be running, and a new worker
    // has configured no session until a window opens it again.
    reset() {
      let any = false;
      for (const item of sessions.values()) {
        item.hosted = false;
        if (item.turn !== "idle") { item.turn = "idle"; item.updatedAt = new Date(now()).toISOString(); any = true; }
      }
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
      if (turn === "running") item.draft = false;
      item.turn = turn;
      item.updatedAt = at;
      changed();
    },
  };
}
