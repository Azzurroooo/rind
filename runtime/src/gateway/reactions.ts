import type { ReplyPosition } from "./types.js";

export const QUEUED_EMOJI = "👀";
export const THINKING_EMOJI = "🧠";
export const STALL_EMOJI = "⏳";
export const STALE_EMOJI = "⚠️";

export const TERMINAL_EMOJI: Readonly<Record<string, string>> = {
  turn_completed: "✅",
  turn_failed: "❌",
  turn_cancelled: "⏹️",
};

const TOOL_EMOJI: ReadonlyArray<readonly [ReadonlySet<string>, string]> = [
  [new Set(["bash", "edit", "read", "write", "read_file", "write_file", "edit_file", "run_command"]), "💻"],
  [new Set(["web_search", "web_fetch", "search_web"]), "🌐"],
  [new Set(["plan"]), "📋"],
];

export const DEFAULT_TOOL_EMOJI = "🛠️";

export const HOLD_SECONDS: Readonly<Record<string, number>> = {
  "✅": 1.5,
  "❌": 2.5,
  "⏹️": 1.5,
};

export const DEBOUNCE_SECONDS = 0.7;
export const STALL_WARN_SECONDS = 10.0;
export const STALE_WARN_SECONDS = 30.0;
export const STALL_SCAN_SECONDS = 1.0;

type SlotState = "idle" | "queued" | "thinking" | "tool" | "terminal" | "hold";
const LIVE_STATES: ReadonlySet<SlotState> = new Set(["queued", "thinking", "tool"]);

export type ReactFn = (position: ReplyPosition | null, emoji: string) => Promise<void>;

export function toolEmoji(name: string): string {
  const key = String(name || "").trim().toLowerCase();
  for (const [tools, emoji] of TOOL_EMOJI) {
    if (tools.has(key)) {
      return emoji;
    }
  }
  return DEFAULT_TOOL_EMOJI;
}

class AsyncSlotLock {
  private chain: Promise<void> = Promise.resolve();

  run(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
}

class ReactionSlot {
  readonly position: ReplyPosition;
  state: SlotState = "idle";
  emoji = "";
  lastProgress: number;
  paused = false;
  readonly lock = new AsyncSlotLock();
  debounceTimer: ReturnType<typeof setTimeout> | null = null;
  stallTimer: ReturnType<typeof setInterval> | null = null;
  holdTimer: ReturnType<typeof setTimeout> | null = null;
  deferred: string | null = null;

  constructor(position: ReplyPosition, now: number) {
    this.position = position;
    this.lastProgress = now;
  }
}

export class ReactionController {
  private readonly react: ReactFn;
  private readonly clock: () => number;
  private readonly debounceSeconds: number;
  private readonly stallWarnSeconds: number;
  private readonly staleWarnSeconds: number;
  private readonly stallScanSeconds: number;
  private readonly holdOverride: number | null;
  private readonly slots = new Map<string, ReactionSlot>();

  constructor(options: {
    react: ReactFn;
    clock?: () => number;
    debounceSeconds?: number;
    stallWarnSeconds?: number;
    staleWarnSeconds?: number;
    stallScanSeconds?: number;
    holdSeconds?: number | null;
  }) {
    this.react = options.react;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.debounceSeconds = options.debounceSeconds ?? DEBOUNCE_SECONDS;
    this.stallWarnSeconds = options.stallWarnSeconds ?? STALL_WARN_SECONDS;
    this.staleWarnSeconds = options.staleWarnSeconds ?? STALE_WARN_SECONDS;
    this.stallScanSeconds = options.stallScanSeconds ?? STALL_SCAN_SECONDS;
    this.holdOverride = options.holdSeconds ?? null;
  }

  async onEvent(
    position: ReplyPosition | null,
    event: Readonly<Record<string, unknown>>,
    options?: { replayed?: boolean },
  ): Promise<void> {
    const slot = this.slotFor(position);
    if (!slot) {
      return;
    }
    const replayed = options?.replayed ?? false;
    const etype = String(event.type ?? "");
    const terminal = TERMINAL_EMOJI[etype];
    if (replayed && !terminal) {
      return;
    }
    if (terminal) {
      await this.goTerminal(slot, terminal);
      return;
    }
    if (etype === "turn_started") {
      if (!LIVE_STATES.has(slot.state) && slot.state !== "hold") {
        slot.state = "thinking";
        slot.lastProgress = this.clock();
        slot.paused = false;
        this.ensureStallWatch(slot);
      }
      this.transition(slot, THINKING_EMOJI);
    } else if (etype === "user_question_requested") {
      slot.lastProgress = this.clock();
      slot.paused = true;
    } else if (etype === "tool_requested" || etype === "tool_result") {
      slot.lastProgress = this.clock();
      slot.paused = false;
      if (etype === "tool_requested") {
        // BUG FIX 3: read event.tool_name ?? event.tool
        const rawTool = String(event.tool_name ?? event.tool ?? "");
        this.transition(slot, toolEmoji(rawTool));
      } else {
        this.transition(slot, THINKING_EMOJI);
      }
    } else if (etype === "assistant_message_completed") {
      slot.lastProgress = this.clock();
      slot.paused = false;
    }
  }

  async queued(position: ReplyPosition | null): Promise<void> {
    const slot = this.slotFor(position);
    if (!slot || LIVE_STATES.has(slot.state)) {
      return;
    }
    if (slot.state === "hold") {
      slot.deferred = QUEUED_EMOJI;
      return;
    }
    slot.state = "queued";
    slot.lastProgress = this.clock();
    slot.paused = false;
    this.transition(slot, QUEUED_EMOJI);
    this.ensureStallWatch(slot);
  }

  async cancel(position: ReplyPosition | null): Promise<void> {
    const slot = this.slotFor(position);
    if (slot) {
      this.teardownTimers(slot);
      slot.state = "idle";
      slot.emoji = "";
      slot.deferred = null;
    }
  }

  checkStalls(): void {
    const now = this.clock();
    for (const slot of this.slots.values()) {
      if (!LIVE_STATES.has(slot.state) || slot.paused) {
        continue;
      }
      const idle = now - slot.lastProgress;
      if (idle >= this.staleWarnSeconds) {
        this.warn(slot, STALE_EMOJI);
      } else if (idle >= this.stallWarnSeconds) {
        this.warn(slot, STALL_EMOJI);
      }
    }
  }

  async aclose(): Promise<void> {
    for (const slot of this.slots.values()) {
      this.teardownTimers(slot);
    }
  }

  private keyOfPosition(position: ReplyPosition): string {
    const [channelId, target] = position;
    return `${channelId}\0${target.chat_id}\0${target.thread_id ?? ""}`;
  }

  private slotFor(position: ReplyPosition | null): ReactionSlot | null {
    if (!position) {
      return null;
    }
    const key = this.keyOfPosition(position);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = new ReactionSlot(position, this.clock());
      this.slots.set(key, slot);
    }
    return slot;
  }

  private transition(slot: ReactionSlot, emoji: string): void {
    if (slot.state === "hold") {
      slot.deferred = emoji;
      return;
    }
    if (!LIVE_STATES.has(slot.state) || emoji === slot.emoji) {
      return;
    }
    const key = this.keyOfPosition(slot.position);
    if (slot.debounceTimer !== null) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    const delayMs = Math.max(0, this.debounceSeconds * 1000);
    const timer = setTimeout(() => {
      slot.debounceTimer = null;
      const current = this.slots.get(key);
      if (!current || !LIVE_STATES.has(current.state)) {
        return;
      }
      void this.apply(current, emoji).then(() => {
        if (LIVE_STATES.has(current.state)) {
          current.state =
            emoji !== QUEUED_EMOJI && emoji !== THINKING_EMOJI ? "tool" : "thinking";
        }
      });
    }, delayMs);
    timer.unref?.();
    slot.debounceTimer = timer;
    this.ensureStallWatch(slot);
  }

  private async goTerminal(slot: ReactionSlot, emoji: string): Promise<void> {
    const key = this.keyOfPosition(slot.position);
    this.teardownTimers(slot);
    slot.paused = false;
    slot.state = "terminal";
    await this.apply(slot, emoji);
    slot.state = "hold";
    const holdSeconds =
      this.holdOverride !== null ? this.holdOverride : (HOLD_SECONDS[emoji] ?? 1.5);
    const timer = setTimeout(() => {
      slot.holdTimer = null;
      const current = this.slots.get(key);
      if (!current || current.state !== "hold") {
        return;
      }
      current.state = "idle";
      const deferred = current.deferred;
      current.deferred = null;
      if (deferred !== null) {
        current.state = "thinking";
        current.lastProgress = this.clock();
        void this.apply(current, deferred);
      }
    }, Math.max(0, holdSeconds * 1000));
    timer.unref?.();
    slot.holdTimer = timer;
  }

  private warn(slot: ReactionSlot, emoji: string): void {
    if (slot.emoji === emoji) {
      return;
    }
    if (slot.debounceTimer !== null) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    void this.apply(slot, emoji);
  }

  private ensureStallWatch(slot: ReactionSlot): void {
    if (slot.stallTimer !== null) {
      return;
    }
    const key = this.keyOfPosition(slot.position);
    const intervalMs = Math.max(5, this.stallScanSeconds * 1000);
    const timer = setInterval(() => {
      const current = this.slots.get(key);
      if (!current || !LIVE_STATES.has(current.state)) {
        clearInterval(timer);
        if (current?.stallTimer === timer) {
          current.stallTimer = null;
        }
        return;
      }
      this.checkStalls();
    }, intervalMs);
    timer.unref?.();
    slot.stallTimer = timer;
  }

  private async apply(slot: ReactionSlot, emoji: string): Promise<void> {
    if (emoji === slot.emoji) {
      return;
    }
    await slot.lock.run(async () => {
      try {
        await this.react(slot.position, emoji);
      } catch {
        // best-effort: reaction errors never break turns
      }
      slot.emoji = emoji;
    });
  }

  private teardownTimers(slot: ReactionSlot): void {
    if (slot.debounceTimer !== null) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    if (slot.stallTimer !== null) {
      clearInterval(slot.stallTimer);
      slot.stallTimer = null;
    }
    if (slot.holdTimer !== null) {
      clearTimeout(slot.holdTimer);
      slot.holdTimer = null;
    }
  }
}
