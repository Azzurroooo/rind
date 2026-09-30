import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { methods } from "../../methods.js";
import { formatTokens } from "../../lib/format.js";
import { errorText } from "../../app/constants.js";

const USAGE_DAYS = 7;

function useRuntimeRead(enabled, read) {
  const [state, setState] = useState({ status: "idle", data: null, error: "" });
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setState((current) => ({ ...current, status: "loading", error: "" }));
    read()
      .then((data) => live && setState({ status: "ready", data, error: "" }))
      .catch((error) => live && setState({ status: "error", data: null, error: errorText(error) }));
    return () => { live = false; };
  }, [enabled, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setSeq((value) => value + 1) };
}

// Global Usage dialog: the rind/usage/summary ledger for the last seven
// days, plus the provider list from rind/auth/list. Web shows auth read-only;
// signing in to a provider happens in Rind Desktop or the CLI.
export function UsageTab({ request, usageEnabled, authEnabled }) {
  const usage = useRuntimeRead(usageEnabled, () => request(methods.usageSummary, { days: USAGE_DAYS }));
  const auth = useRuntimeRead(authEnabled, () => request(methods.authList, {}));
  const totals = usage.data?.totals;
  const models = Array.isArray(usage.data?.by_model) ? usage.data.by_model : [];
  const days = Array.isArray(usage.data?.by_day) ? usage.data.by_day : [];
  const peak = Math.max(1, ...days.map((day) => Number(day.tokens) || 0));
  const providers = Array.isArray(auth.data?.providers) ? auth.data.providers : [];

  return (
    <div className="inspector-body usage-tab">
      {usageEnabled && (
        <section className="inspector-section" aria-label="Token usage">
          <div className="inspector-section-head">
            <h3 className="inspector-section-title">Last {usage.data?.days || USAGE_DAYS} days</h3>
            <button type="button" className="icon-button small" aria-label="Refresh usage" onClick={usage.reload} disabled={usage.status === "loading"}>
              <RefreshCw size={14} aria-hidden="true" className={usage.status === "loading" ? "spin" : ""} />
            </button>
          </div>
          {usage.error && <p className="form-error" role="alert">{usage.error}</p>}
          {totals && (
            <dl className="stat-list">
              <Stat label="Total tokens" value={formatTokens(totals.total)} />
              <Stat label="Input" value={formatTokens(totals.input)} />
              <Stat label="Cached" value={formatTokens(totals.cached)} />
              <Stat label="Output" value={formatTokens(totals.output)} />
              <Stat label="Model calls" value={String(totals.samples || 0)} />
              {Number(totals.compactions) > 0 && <Stat label="Compactions" value={String(totals.compactions)} />}
            </dl>
          )}
          {days.length > 0 && (
            <ul className="usage-days" aria-label="Tokens by day">
              {days.map((day) => (
                <li key={day.day} className="breakdown-row">
                  <div className="breakdown-label"><span>{day.day}</span>{" "}<span className="breakdown-value">{formatTokens(day.tokens)}</span></div>
                  <div className="breakdown-bar" aria-hidden="true"><span style={{ width: `${Math.max(1, (Number(day.tokens) / peak) * 100)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
          {models.length > 0 && (
            <>
              <h3 className="inspector-section-title">By model</h3>
              <dl className="stat-list">
                {models.map((row) => <Stat key={row.model} label={row.model} value={`${formatTokens(row.tokens)} · ${row.samples} calls`} />)}
              </dl>
            </>
          )}
          {usage.status === "ready" && !totals?.samples && <p className="muted">No model calls recorded in this window.</p>}
        </section>
      )}
      {authEnabled && (
        <section className="inspector-section" aria-label="Providers">
          <h3 className="inspector-section-title">Providers</h3>
          {auth.error && <p className="form-error" role="alert">{auth.error}</p>}
          <ul className="provider-list">
            {providers.map((provider) => (
              <li key={provider.id} className="provider-row">
                <span className="provider-name">{provider.name || provider.id}</span>{" "}
                <span className={`provider-state ${provider.configured ? "success" : ""}`.trim()}>
                  {provider.configured ? `Signed in${provider.source ? ` (${provider.source})` : ""}` : "Not signed in"}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">Provider sign-in is managed in Rind Desktop or the CLI.</p>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
