// Delta render batching (audit #5, hermes pattern): assistant_delta envelopes
// arrive per token; dispatching each one re-runs the reducer and schedules a
// render. The coalescer buffers consecutive deltas for one animation frame
// (≤50ms) and hands the reducer a SINGLE merged envelope, so streaming stays
// at 60fps without touching the reducer's math.
//
// Purity contract: the reducer stays pure. Merging records the absorbed
// sequence numbers on the envelope (`absorbed`), and applyEnvelope marks them
// seen alongside the survivor — so a post-reconnect replay that re-delivers
// the absorbed deltas is still dropped idempotently.
//
// Non-delta envelopes flush the buffer first and dispatch immediately, so
// event order is never reordered across event types.

const DEFAULT_INTERVAL_MS = 50;

// schedule(fn) -> cancel. rAF aligns the flush with paint; a timer fallback
// covers environments without rAF (tests can inject their own scheduler).
function defaultSchedule(fn) {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(fn, DEFAULT_INTERVAL_MS);
  return () => clearTimeout(handle);
}

export function createEventCoalescer({ dispatch, intervalMs = DEFAULT_INTERVAL_MS, schedule } = {}) {
  const emit = typeof dispatch === "function" ? dispatch : () => {};
  const scheduleFlush = typeof schedule === "function" ? schedule : defaultSchedule;
  let buffered = null; // { session, turn, text, sequence, absorbed, envelope }
  let cancelFlush = null;

  function flush() {
    if (cancelFlush) {
      cancelFlush();
      cancelFlush = null;
    }
    if (!buffered) return;
    const buffer = buffered;
    buffered = null;
    const envelope = {
      ...(buffer.envelope || {}),
      event: {
        ...(buffer.envelope?.event || {}),
        type: "assistant_delta",
        text: buffer.text,
      },
      sequence: buffer.sequence,
    };
    if (buffer.absorbed.length) envelope.absorbed = buffer.absorbed;
    emit(envelope);
  }

  function push(envelope) {
    const event = envelope?.event;
    if (!event || typeof event !== "object" || event.type !== "assistant_delta") {
      flush(); // preserve cross-type ordering
      emit(envelope);
      return;
    }
    const sessionId = String(envelope.session_id || event.session_id || "");
    const turnId = String(envelope.turn_id || event.turn_id || "");
    if (buffered && (buffered.session !== sessionId || buffered.turn !== turnId)) {
      flush(); // turn boundary: never merge across turns
    }
    if (!buffered) {
      buffered = { session: sessionId, turn: turnId, text: "", sequence: envelope.sequence, absorbed: [], envelope };
    } else {
      // The last delta wins the sequence (its key guards idempotence); earlier
      // sequence numbers ride along as `absorbed` keys for the seen-map.
      buffered.absorbed.push(buffered.sequence);
      buffered.sequence = envelope.sequence;
      buffered.envelope = envelope;
    }
    buffered.text += String(event.text || "");
    if (!cancelFlush) cancelFlush = scheduleFlush(() => { cancelFlush = null; flush(); });
  }

  return { push, flush, dispose: flush };
}
