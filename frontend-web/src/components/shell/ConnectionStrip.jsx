import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

const FADE_MS = 800; // the strip fades out 800ms after syncing completes

// Connection state rendering:
//   online / connecting -> nothing; reconnecting -> 2px strip + "Reconnecting";
//   syncing -> strip + "Syncing... (N items)" counting down; offline -> strip +
//   "Disconnected" + Retry. The strip is position:fixed so it never shifts layout.
export function ConnectionStrip({ phase = "online", syncRemaining = 0, syncTotal = 0, onReconnect }) {
  const [fading, setFading] = useState(false);
  const phaseRef = useRef(phase);
  const lastSyncRef = useRef({ remaining: 0, total: 0 });

  if (phase === "syncing") {
    lastSyncRef.current = { remaining: syncRemaining, total: syncTotal };
  }

  useEffect(() => {
    const completed = phaseRef.current === "syncing" && phase === "online";
    phaseRef.current = phase;
    if (!completed) return undefined;
    setFading(true);
    const timer = window.setTimeout(() => setFading(false), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const stripPhase = fading ? "fading" : phase;
  const visible = phase === "reconnecting" || phase === "syncing" || phase === "offline" || fading;
  if (!visible) return null;

  const sync = lastSyncRef.current;
  const remaining = stripPhase === "syncing" ? syncRemaining : sync.remaining;
  const percent = sync.total > 0 ? Math.round((Math.max(0, sync.total - remaining) / sync.total) * 100) : null;

  return (
    <div className={`connection-strip ${stripPhase}`} role="status" aria-live="polite">
      <div className="connection-strip-track">
        <div className="connection-strip-bar" style={percent != null ? { width: `${percent}%` } : undefined} />
      </div>
      <div className={`connection-strip-chip ${stripPhase === "offline" ? "is-error" : "is-warning"}`}>
        {stripPhase === "reconnecting" && <><LoaderCircle className="spin" size={13} aria-hidden="true" /><span>Reconnecting</span></>}
        {(stripPhase === "syncing" || stripPhase === "fading") && (
          <><LoaderCircle className="spin" size={13} aria-hidden="true" /><span>Syncing… ({Math.max(0, remaining)} items)</span></>
        )}
        {stripPhase === "offline" && <><span>Disconnected</span><button type="button" className="strip-retry" onClick={onReconnect}>Retry</button></>}
      </div>
    </div>
  );
}
