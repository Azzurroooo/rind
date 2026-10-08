// What every session in the shared Runtime is doing right now: whether a turn
// runs or waits for an answer, which background jobs it will resume after, and
// how many windows show it on screen. A
// window covered by the Agents page still holds its session but shows nothing. The host already
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
  const viewers = new Map(); // viewer -> session id it shows on screen
  const covered = new Map(); // viewer -> session id it holds while covered
  let pending = false;

  const entry = id => {
    let item = sessions.get(id);
    if (!item) { item = { id, workspace: "", turn: "idle", background: null, startedAt: "", updatedAt: new Date(now()).toISOString() }; sessions.set(id, item); }
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
      if (!count && item.turn === "idle" && !item.background && Date.parse(item.updatedAt) < cutoff) { sessions.delete(item.id); continue; }
      out.push({ ...item, watchers: count });
    }
    return out;
  }
  return {
    list,
    // A window now shows `id` (opened, created, switched to or prompted).
    view(viewer, id, { workspace } = {}) {
      if (!id) return;
      const item = entry(id);
      const was = viewers.get(viewer);
      if (workspace) item.workspace = workspace;
      // A request finishing while the window is covered does not uncover it.
      if (covered.has(viewer)) { covered.set(viewer, id); return; }
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
    turn: id => sessions.get(id)?.turn || "idle",
    // The conversation no longer exists (its first prompt failed before saving it).
    forget(id) {
      if (!sessions.delete(id)) return;
      for (const [viewer, shown] of viewers) if (shown === id) viewers.delete(viewer);
      for (const [viewer, held] of covered) if (held === id) covered.delete(viewer);
      changed();
    },
    // The window is covered (the Agents page is in front) or back on screen.
    hide(viewer) {
      if (!viewers.has(viewer)) return;
      covered.set(viewer, viewers.get(viewer));
      viewers.delete(viewer);
      changed();
    },
    show(viewer) {
      if (!covered.has(viewer)) return;
      const id = covered.get(viewer);
      covered.delete(viewer);
      if (!sessions.has(id)) return;
      viewers.set(viewer, id);
      changed();
    },
    // The window closed, or (with `id`) stopped holding that conversation.
    leave(viewer, id) {
      if (id !== undefined && viewers.get(viewer) !== id && covered.get(viewer) !== id) return;
      const known = covered.delete(viewer);
      if (viewers.delete(viewer) || known) changed();
    },
    // The worker went away: no turn or job can still be running.
    reset() {
      let any = false;
      for (const item of sessions.values()) {
        if (item.turn === "idle" && !item.background) continue;
        item.turn = "idle"; item.background = null; item.updatedAt = new Date(now()).toISOString(); any = true;
      }
      if (any) changed();
    },
    event(message) {
      const id = message?.session_id;
      // Renamed in some window: every list shows the new title at once.
      if (id && message?.event?.type === "session_renamed") {
        const item = entry(id);
        const title = String(message.event.title || "");
        if (item.title === title) return;
        item.title = title;
        changed();
        return;
      }
      // What it runs on, changed in some window: lists show it at once.
      if (id && message?.event?.type === "session_settings_changed") {
        const item = entry(id);
        const { provider = "", model = "", reasoning_effort: reasoningEffort = "", selection_source: selectionSource = {}, connection_ready: connectionReady } = message.event;
        const next = { provider, model, reasoningEffort, selectionSource, connectionReady: connectionReady !== false };
        if (Object.entries(next).every(([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value))) return;
        Object.assign(item, next);
        changed();
        return;
      }
      // The turn ended but jobs it started still run; it resumes when they finish.
      if (id && message?.event?.type === "background_wait_changed") {
        const wait = message.event.background_wait;
        const background = wait?.count > 0 ? { count: wait.count, commands: Array.isArray(wait.commands) ? wait.commands.map(String) : [], startedAt: new Date(Number(wait.started_at) * 1000 || now()).toISOString() } : null;
        const item = entry(id);
        if (JSON.stringify(item.background) === JSON.stringify(background)) return;
        item.background = background;
        item.updatedAt = new Date(now()).toISOString();
        changed();
        return;
      }
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
