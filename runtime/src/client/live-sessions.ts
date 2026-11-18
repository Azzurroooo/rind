export type LiveTurnState = "idle" | "running" | "question";

export interface LiveBackgroundState {
  count: number;
  commands: string[];
  startedAt: string;
}

export interface LiveSessionEntry {
  id: string;
  workspace: string;
  turn: LiveTurnState;
  background: LiveBackgroundState | null;
  startedAt: string;
  updatedAt: string;
  watchers: number;
  title?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  selectionSource?: Record<string, unknown>;
  connectionReady?: boolean;
}

type InternalLiveSession = Omit<LiveSessionEntry, "watchers">;

const TURN_EVENTS: Readonly<Record<string, LiveTurnState>> = {
  turn_started: "running",
  user_question_requested: "question",
  turn_completed: "idle",
  turn_failed: "idle",
  turn_cancelled: "idle",
};

const FORGET_AFTER_MS = 10 * 60 * 1000;

export function createLiveSessions<TViewer = unknown>({
  onChange = () => {},
  now = () => Date.now(),
  schedule = (fn: () => void) => setImmediate(fn),
}: {
  onChange?: (sessions: LiveSessionEntry[]) => void;
  now?: () => number;
  schedule?: (fn: () => void) => unknown;
} = {}) {
  const sessions = new Map<string, InternalLiveSession>();
  const viewers = new Map<TViewer, string>();
  const covered = new Map<TViewer, string>();
  let pending = false;

  const entry = (id: string): InternalLiveSession => {
    let item = sessions.get(id);
    if (!item) {
      item = {
        id,
        workspace: "",
        turn: "idle",
        background: null,
        startedAt: "",
        updatedAt: new Date(now()).toISOString(),
      };
      sessions.set(id, item);
    }
    return item;
  };

  const changed = (): void => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      onChange(list());
    });
  };

  function list(): LiveSessionEntry[] {
    const watchers = new Map<string, number>();
    for (const id of viewers.values()) watchers.set(id, (watchers.get(id) || 0) + 1);
    const held = new Set(covered.values());
    const cutoff = now() - FORGET_AFTER_MS;
    const out: LiveSessionEntry[] = [];
    for (const item of sessions.values()) {
      const count = watchers.get(item.id) || 0;
      if (
        !count &&
        !held.has(item.id) &&
        item.turn === "idle" &&
        !item.background &&
        Date.parse(item.updatedAt) < cutoff
      ) {
        sessions.delete(item.id);
        continue;
      }
      out.push({ ...item, watchers: count });
    }
    return out;
  }

  return {
    list,
    view(viewer: TViewer, id: string, { workspace }: { workspace?: string } = {}): void {
      if (!id) return;
      const item = entry(id);
      const was = viewers.get(viewer);
      if (workspace) item.workspace = workspace;
      if (covered.has(viewer)) {
        covered.set(viewer, id);
        return;
      }
      viewers.delete(viewer);
      viewers.set(viewer, id);
      if (was !== id) changed();
    },
    newestViewer(id: string, accept: (viewer: TViewer) => boolean = () => true): TViewer | undefined {
      let found: TViewer | undefined;
      for (const [viewer, shown] of viewers) {
        if (shown === id && accept(viewer)) found = viewer;
      }
      return found;
    },
    turn: (id: string): LiveTurnState => sessions.get(id)?.turn || "idle",
    forget(id: string): void {
      if (!sessions.delete(id)) return;
      for (const [viewer, shown] of viewers) if (shown === id) viewers.delete(viewer);
      for (const [viewer, held] of covered) if (held === id) covered.delete(viewer);
      changed();
    },
    hide(viewer: TViewer): void {
      const current = viewers.get(viewer);
      if (current === undefined) return;
      covered.set(viewer, current);
      viewers.delete(viewer);
      changed();
    },
    show(viewer: TViewer, canShow: (id: string) => boolean = () => true): void {
      const id = covered.get(viewer);
      if (id === undefined || !canShow(id)) return;
      covered.delete(viewer);
      viewers.set(viewer, id);
      changed();
    },
    leave(viewer: TViewer, id?: string): void {
      if (id !== undefined && viewers.get(viewer) !== id && covered.get(viewer) !== id) return;
      const known = covered.delete(viewer);
      if (viewers.delete(viewer) || known) changed();
    },
    reset(): void {
      let any = false;
      for (const item of sessions.values()) {
        if (item.turn === "idle" && !item.background) continue;
        item.turn = "idle";
        item.background = null;
        item.updatedAt = new Date(now()).toISOString();
        any = true;
      }
      if (any) changed();
    },
    settle(id: string, clearBackground = false): void {
      const item = sessions.get(id);
      if (!item || (item.turn === "idle" && (!clearBackground || !item.background))) return;
      item.turn = "idle";
      if (clearBackground) item.background = null;
      item.updatedAt = new Date(now()).toISOString();
      changed();
    },
    event(message: any): void {
      const id = message?.session_id;
      if (id && message?.event?.type === "session_renamed") {
        const item = entry(id);
        const title = String(message.event.title || "");
        if (item.title === title) return;
        item.title = title;
        changed();
        return;
      }
      if (id && message?.event?.type === "session_settings_changed") {
        const item = entry(id);
        const {
          provider = "",
          model = "",
          reasoning_effort: reasoningEffort = "",
          selection_source: selectionSource = {},
          connection_ready: connectionReady,
        } = message.event;
        const next = {
          provider: String(provider),
          model: String(model),
          reasoningEffort: String(reasoningEffort),
          selectionSource: selectionSource as Record<string, unknown>,
          connectionReady: connectionReady !== false,
        };
        if (
          Object.entries(next).every(
            ([key, value]) => JSON.stringify((item as Record<string, unknown>)[key]) === JSON.stringify(value),
          )
        ) {
          return;
        }
        Object.assign(item, next);
        changed();
        return;
      }
      const toBackground = (wait: any): LiveBackgroundState | null =>
        wait?.count > 0
          ? {
              count: Number(wait.count),
              commands: Array.isArray(wait.commands) ? wait.commands.map(String) : [],
              startedAt: new Date(Number(wait.started_at) * 1000 || now()).toISOString(),
            }
          : null;
      if (id && message?.event?.type === "background_wait_changed") {
        const background = toBackground(message.event.background_wait);
        const item = entry(id);
        if (JSON.stringify(item.background) === JSON.stringify(background)) return;
        item.background = background;
        item.updatedAt = new Date(now()).toISOString();
        changed();
        return;
      }
      const eventType = String(message?.event?.type || "");
      const turn: LiveTurnState | undefined =
        TURN_EVENTS[eventType] ||
        (eventType === "tool_result" && message.event.tool_name === "ask_user_question"
          ? "running"
          : undefined);
      if (!id || !turn) return;
      const item = entry(id);
      const hasBackground =
        (eventType === "turn_completed" && "background_wait" in message.event) ||
        ["turn_failed", "turn_cancelled"].includes(eventType);
      const background =
        eventType === "turn_completed" ? toBackground(message.event.background_wait) : null;
      const backgroundChanged =
        hasBackground && JSON.stringify(item.background) !== JSON.stringify(background);
      if (item.turn === turn && !backgroundChanged) return;
      const at = new Date(now()).toISOString();
      if (turn === "running" && item.turn === "idle") item.startedAt = at;
      item.turn = turn;
      if (hasBackground) item.background = background;
      item.updatedAt = at;
      changed();
    },
  };
}
