import { useState } from "react";
import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";

// Full-screen single login card (web-ui.md §1, J1).
// Errors render inline in red; the token input is preserved; no redirects, no
// modals, and the token never leaves this tab (sessionStorage only).
export function LoginGate({ onSubmit, busy = false, error = "", initialToken = "", description = "Enter the access code shown in Rind Desktop → Remote access. Your connection stays signed in for this browser tab." }) {
  const [token, setToken] = useState(initialToken);

  async function handleSubmit(event) {
    event.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    await onSubmit(value);
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-lockup">
          <img src="/rind.svg" alt="Rind" className="brand-mark" />
          <div>
            <div className="brand-name">Rind</div>
            <div className="brand-subtitle">Your workspace, wherever you are</div>
          </div>
        </div>
        <label className="login-label" htmlFor="rind-login-token">Access code</label>
        <div className="login-input-row">
          <KeyRound size={15} />
          <input
            id="rind-login-token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            placeholder="Paste your access code"
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" className="login-submit" title="Connect to Rind" disabled={busy || !token.trim()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}
          </button>
        </div>
        {error && <div className="login-error" role="alert">{error}</div>}
        <p className="login-description">{description}</p>
      </form>
    </div>
  );
}
