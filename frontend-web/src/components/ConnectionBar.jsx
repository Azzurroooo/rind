import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleOff, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";

const FADE_MS = 800; // strip fades out 800ms after syncing completes (web-ui.md §2.1)

// Connection state machine rendering (web-ui.md §2.1):
//   online → nothing at all; reconnecting → 2px strip + "Reconnecting";
//   syncing → strip + "Syncing… (N items)" with a countdown; offline → strip + "Disconnected" + retry.
// The strip is position:fixed, so no transition ever shifts layout or scroll.
export function ConnectionBar({ phase = "online", syncRemaining = 0, syncTotal = 0, url, onChangeUrl, onReconnect, onLogout }) {
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
  const showStrip = phase === "reconnecting" || phase === "syncing" || phase === "offline" || fading;
  const sync = lastSyncRef.current;
  // Task contract: N = remaining durable events to apply (counts down to 0).
  const remaining = stripPhase === "syncing" ? syncRemaining : sync.remaining;
  const progressPercent = sync.total > 0 ? Math.round((Math.max(0, sync.total - remaining) / sync.total) * 100) : null;
  const connected = phase === "online" || phase === "syncing";

  return (
    <>
      {showStrip && (
        <div className={`connection-strip ${stripPhase}`} role="status" aria-live="polite">
          <div className="connection-strip-track">
            <div className="connection-strip-bar" style={progressPercent != null ? { width: `${progressPercent}%` } : undefined} />
          </div>
          <div className={`connection-strip-chip ${stripPhase === "offline" ? "is-error" : "is-warning"}`}>
            {stripPhase === "reconnecting" && <><LoaderCircle className="spin" size={13} /><span>Reconnecting</span></>}
            {(stripPhase === "syncing" || stripPhase === "fading") && <><LoaderCircle className="spin" size={13} /><span>Syncing… ({Math.max(0, remaining)} items)</span></>}
            {stripPhase === "offline" && <><span>Disconnected</span><button className="strip-retry" onClick={onReconnect}>Retry</button></>}
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="brand-lockup">
          <img src="/rind.svg" alt="Rind" className="brand-mark" />
          <div>
            <div className="brand-name">Rind</div>
            <div className="brand-subtitle">worker console</div>
          </div>
        </div>
        <div className="connection-control">
          <span className={`connection-dot ${connected ? "online" : phase === "reconnecting" || phase === "connecting" ? "pending" : "offline"}`} />
          <input aria-label="Worker WebSocket URL" value={url} onChange={(event) => onChangeUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onReconnect()} />
          <span className="connection-label">{phase === "online" ? "connected" : phase === "syncing" ? "syncing" : phase === "offline" || phase === "login" ? "offline" : "connecting"}</span>
          {connected
            ? <button className="icon-button subtle" title="Disconnect and clear this page's credentials" onClick={onLogout}><CircleOff size={16} /></button>
            : <button className="icon-button subtle" title="Reconnect to worker" onClick={onReconnect}>{phase === "reconnecting" || phase === "connecting" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>}
        </div>
        <div className="service-state">
          {connected ? <CheckCircle2 size={15} /> : <PlugZap size={15} />}
          <span>{connected ? "Worker available" : "Waiting for worker"}</span>
        </div>
      </header>
    </>
  );
}
