// Turn-state reconciliation for runtime events (pure, unit-testable).
//
// The worker is authoritative about turn generations: goal continuations and
// post-restart turns change the turn_id, and a terminal event means *nothing*
// is running for the session even when the renderer's memory is stale. The
// previous renderer dropped any event whose turn_id mismatched the remembered
// one — including terminals — which left the session permanently stuck in
// "queue follow-up" mode where every send failed with TurnNotActive.

export const TURN_SETTLED_TYPES: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
])

export interface TurnEventDecision {
  /** Feed the envelope into the conversation reducer (timeline/timeline state). */
  apply: boolean
  /** Adopt the envelope's turn_id as the session's active turn. */
  adopt: boolean
  /** The worker reports nothing running — clear local turn/queue state. */
  settle: boolean
  /** The envelope belongs to a turn generation the renderer already retired. */
  retired: boolean
}

export function isTurnSettled(type: string): boolean {
  return TURN_SETTLED_TYPES.has(type)
}

export function decideTurnEvent(type: string, turnId: string, activeTurnId: string): TurnEventDecision {
  if (type === "turn_started") {
    // A new generation supersedes the remembered one (goal continuation,
    // post-restart turn, or a terminal event the renderer missed).
    return { apply: true, adopt: true, settle: false, retired: false }
  }
  if (TURN_SETTLED_TYPES.has(type)) {
    // Terminals always reconcile — a mismatched turn_id means the renderer was
    // stale, never that the worker is still running the remembered turn.
    return { apply: true, adopt: false, settle: true, retired: false }
  }
  if (turnId && activeTurnId && turnId !== activeTurnId) {
    // A late event from a retired generation: archive it into the transcript
    // (entries are keyed by turn) but never mutate turn/queue state.
    return { apply: true, adopt: false, settle: false, retired: true }
  }
  return { apply: true, adopt: false, settle: false, retired: false }
}

export function isTurnNotActive(error: unknown): boolean {
  return error instanceof Error && error.name === "TurnNotActive"
}
