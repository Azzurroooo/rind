import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Computer, LoaderCircle, Moon, Plus, QrCode, Sun, Trash2 } from "lucide-react";
import App from "@surface/App.jsx";
import { ConfirmDialog } from "@surface/components/overlays/ConfirmDialog.jsx";
import { fetchTicket, loginErrorMessage } from "@surface/ticket.js";
import { useThemeState } from "@surface/app/useThemeState.js";
import { readThemePreference } from "@surface/lib/theme.js";
import { memoryCredentials, parsePairing } from "./pairing.js";
import { hostStore, installNativeUI, isNative, scanPairing, shareConversation, subscribeLifecycle, ticketFetch } from "./native.js";

export default function MobileApp() {
  const theme = useThemeState();
  const [hosts, setHosts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(null);
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState(null);
  const [forgetError, setForgetError] = useState("");
  const current = useRef({});
  const operation = useRef(0);
  const locked = useRef(false);
  const refresh = async () => setHosts(await hostStore.list());

  useEffect(() => { refresh().catch((e) => setError(e.message)).finally(() => setLoaded(true)); }, []);
  const disconnect = () => { ++operation.current; connection?.platform.credentials.dropCredentials(); theme.set(readThemePreference()); setConnection(null); setError(""); };
  const pairing = (value) => {
    try {
      const parsed = parsePairing(value);
      if (locked.current) return;
      disconnect();
      setForm({ address: parsed.origin, token: parsed.token, name: "", remember: isNative });
    } catch (e) { setError(e.message); }
  };
  current.current = { pairing, back: () => {
    if (locked.current) return true;
    if (forget) { setForget(null); return true; }
    if (form) { setForm(null); setError(""); return true; }
    if (connection) { disconnect(); return true; }
    return false;
  } };
  useEffect(() => installNativeUI({ onLink: (url) => current.current.pairing(url), onBack: () => current.current.back() }), []);

  async function connect(values, saved) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const run = ++operation.current;
    try {
      const parsed = parsePairing(values.address, values.token);
      const token = parsed.token || (saved ? await hostStore.token(saved.id) : "");
      if (!token) { setForm({ ...values, token: "" }); return; }
      // Verify the entered address/code before saving it or mounting the conversation.
      await fetchTicket(token, { endpoint: `${parsed.origin}/ticket`, fetchImpl: ticketFetch });
      if (run !== operation.current) return;
      const host = await hostStore.save({ name: values.name, origin: parsed.origin }, token, values.remember);
      const credentials = memoryCredentials(token, parsed.endpoint);
      const signOut = async (expired = false) => {
        locked.current = true; setBusy(true);
        credentials.dropCredentials();
        theme.set(readThemePreference());
        ++operation.current;
        setConnection(null);
        setForm({ address: host.origin, name: host.name, token: "", remember: isNative });
        setError(expired ? "Access has expired. Enter the current code from Rind Desktop." : "");
        try { await hostStore.clearToken(host.id); }
        catch { setError("The saved code could not be removed. Try forgetting this computer from Connections."); }
        finally { locked.current = false; setBusy(false); }
      };
      setConnection({ host, platform: {
        endpoint: parsed.endpoint, credentials, fetch: ticketFetch,
        subscribeLifecycle: isNative ? subscribeLifecycle : undefined,
        exportConversation: shareConversation,
        onSignOut: () => void signOut(), onUnauthorized: () => void signOut(true),
      } });
      setForm(null);
      await refresh();
    } catch (e) {
      if (run === operation.current) {
        setError(e.status !== undefined ? loginErrorMessage(e) : e.message);
        if (saved && [401, 403].includes(e.status)) {
          setForm({ ...values, token: "" });
          await hostStore.clearToken(saved.id).catch(() => {});
        }
      }
    }
    finally { locked.current = false; setBusy(false); }
  }

  async function scan() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { const value = await scanPairing(); locked.current = false; if (value) pairing(value); }
    catch (e) { setError(e.message || "Unable to scan. Allow camera access or paste a sign-in link."); }
    finally { locked.current = false; setBusy(false); }
  }
  const newForm = () => { setError(""); setForm({ name: "", address: "", token: "", remember: isNative }); };

  if (connection) return <div className="mobile-session">
    <header className="mobile-host-bar">
      <button className="icon-button" aria-label="Connections" onClick={disconnect}><ArrowLeft size={18} /></button>
      <span className="mobile-host-name"><Computer size={14} />{connection.host.name}</span>
      <span className="mobile-host-origin">{new URL(connection.host.origin).host}</span>
    </header>
    <App key={connection.host.id} platform={connection.platform} />
  </div>;

  return <main className="mobile-home">
    <header className="mobile-home-header">
      <div className="brand-lockup"><img src="/rind.svg" alt="" className="brand-mark" /><span className="brand-name">Rind</span></div>
      <button className="icon-button" aria-label={`Switch to ${theme.resolved === "dark" ? "light" : "dark"} theme`} onClick={theme.toggle}>{theme.resolved === "dark" ? <Sun size={19} /> : <Moon size={19} />}</button>
    </header>
    <section className="mobile-connect">
      {form ? <>
        <button className="button ghost mobile-back" disabled={busy} onClick={() => { setForm(null); setError(""); }}><ArrowLeft size={16} /> Connections</button>
        <h1>Connect a computer</h1>
        <p className="mobile-intro">Open Remote access in Rind Desktop. Scan its QR code, paste the sign-in link, or enter the address and code.</p>
        <button className="button secondary mobile-scan" onClick={scan} disabled={busy}><QrCode size={18} /> Scan QR code</button>
        <form className="mobile-pair-form" onSubmit={(event) => { event.preventDefault(); void connect(form); }}>
          <label><span>Computer name <span className="muted">(optional)</span></span><input type="text" maxLength={80} autoComplete="off" placeholder="My workstation" value={form.name} disabled={busy} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>Server address or sign-in link<input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="http://192.168.1.10:8766" value={form.address} disabled={busy} onChange={(event) => {
            const address = event.target.value;
            if (address.includes("#connect=")) {
              try { const parsed = parsePairing(address); setForm({ ...form, address: parsed.origin, token: parsed.token }); return; } catch { /* Validate on submit. */ }
            }
            setForm({ ...form, address });
          }} /></label>
          <label>Access code<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="From Rind Desktop" value={form.token} disabled={busy} onChange={(event) => setForm({ ...form, token: event.target.value })} /></label>
          {isNative && <label className="mobile-remember"><input type="checkbox" checked={form.remember} disabled={busy} onChange={(event) => setForm({ ...form, remember: event.target.checked })} /> Remember code securely on this device</label>}
          {error && <p className="mobile-error" role="alert">{error}</p>}
          <button className="button primary mobile-primary" type="submit" disabled={busy || !form.address.trim() || (!form.token.trim() && !form.address.includes("#connect="))}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />} {busy ? "Connecting…" : "Connect"}</button>
        </form>
        <p className="mobile-footnote">Use a trusted Wi-Fi network, VPN, or HTTPS address. Your computer runs the agent and must stay online.</p>
      </> : <>
        <h1>Your workspace,<br />wherever you are.</h1>
        <p className="mobile-intro">Continue your Rind sessions from your phone. Your computer does the work.</p>
        <div className="mobile-section-heading"><h2>Computers</h2>{hosts.length > 0 && <button className="icon-button" aria-label="Add computer" onClick={newForm}><Plus size={18} /></button>}</div>
        {!loaded && <p className="muted" role="status">Loading saved computers…</p>}
        {hosts.map((host) => <div className="mobile-computer" key={host.id}>
          <button className="mobile-computer-connect" disabled={busy} onClick={() => void connect({ name: host.name, address: host.origin, token: "", remember: isNative }, host)}>
            <span className="mobile-computer-icon"><Computer size={22} /></span><span><strong>{host.name}</strong><small>{host.origin}</small></span><ArrowRight size={18} />
          </button><button className="icon-button" disabled={busy} aria-label={`Forget ${host.name}`} onClick={() => setForget(host)}><Trash2 size={16} /></button>
        </div>)}
        {loaded && !hosts.length && <div className="mobile-empty"><Computer size={32} strokeWidth={1.4} /><h3>Bring your computer along</h3><p>Enable Remote access in Rind Desktop, then connect here.</p></div>}
        {error && <p className="mobile-error" role="alert">{error}</p>}
        {busy && <p className="muted" role="status">Connecting…</p>}
        <button className="button primary mobile-primary" disabled={busy || !loaded} onClick={newForm}><Plus size={18} /> Add computer</button>
        <button className="button ghost mobile-scan" disabled={busy} onClick={scan}><QrCode size={18} /> Scan QR code</button>
        <p className="mobile-footnote">Sessions, tools and files stay on your computer. Disconnecting this app leaves running tasks in place.</p>
      </>}
    </section>
    <ConfirmDialog open={Boolean(forget)} onCancel={() => { if (!busy) { setForget(null); setForgetError(""); } }} title="Forget computer?" message={`Remove ${forget?.name || "this computer"} and its saved access code from this device. Remote sessions will stay on the computer.`} confirmLabel="Forget computer" danger busy={busy} error={forgetError} onConfirm={async () => {
      if (locked.current) return;
      locked.current = true; setBusy(true); setForgetError("");
      try { await hostStore.forget(forget.id); await refresh(); setForget(null); }
      catch (e) { setForgetError(e.message || "Unable to forget this computer. Try again."); }
      finally { locked.current = false; setBusy(false); }
    }} />
  </main>;
}
