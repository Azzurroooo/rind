import { CheckCircle2, CircleOff, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";

export function ConnectionBar({ state, url, onChangeUrl, onReconnect, onDisconnect }) {
  const connected = state === "connected";
  const connecting = state === "connecting";
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <img src="/rind.svg" alt="Rind" className="brand-mark" />
        <div>
          <div className="brand-name">Rind</div>
          <div className="brand-subtitle">worker console</div>
        </div>
      </div>
      <div className="connection-control">
        <span className={`connection-dot ${connected ? "online" : connecting ? "pending" : "offline"}`} />
        <input aria-label="Worker WebSocket URL" value={url} onChange={(event) => onChangeUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onReconnect()} />
        <span className="connection-label">{connected ? "connected" : connecting ? "connecting" : "offline"}</span>
        {connected ? <button className="icon-button subtle" title="Disconnect browser session" onClick={onDisconnect}><CircleOff size={16} /></button> : <button className="icon-button subtle" title="Reconnect to worker" onClick={onReconnect}>{connecting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>}
      </div>
      <div className="service-state">
        {connected ? <CheckCircle2 size={15} /> : <PlugZap size={15} />}
        <span>{connected ? "Worker available" : "Waiting for worker"}</span>
      </div>
    </header>
  );
}

