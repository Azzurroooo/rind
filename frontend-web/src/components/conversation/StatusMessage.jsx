const LABELS = { session: "Session", settings: "Settings", apiKey: "API key", baseUrl: "Endpoint", model: "Model", reasoningEffort: "Reasoning effort", runtime: "Runtime", workspace: "Workspace" };
const count = (value) => value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "—";
const percent = (value) => value != null && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "—";

export function StatusMessage({ display }) {
  const entries = Array.isArray(display.entries) ? display.entries.filter((entry) => entry?.label) : [];
  const usage = Array.isArray(display.usage) ? display.usage.filter((item) => item && typeof item === "object") : [];
  return (
    <section className="status-message" aria-label="Session status">
      <header>/status</header>
      <div className="status-display">
        <dl className="status-config">
          {entries.map((entry, index) => <div key={index}><dt>{LABELS[entry.label] || entry.label}</dt><dd>{String(entry.value ?? "—")}{entry.state && <small> {String(entry.state)}</small>}</dd></div>)}
        </dl>
        <section className="status-sampling" aria-label="Latest model response">
          <h4>Latest model response</h4>
          {!usage.length && <p className="status-empty">No completed sampling yet.</p>}
          {usage.map((item, index) => <div key={index}>
            {Number(item.context_window_tokens) > 0 && Number.isFinite(Number(item.context_usage_percent)) && <div className="status-context">
              <span>Context</span><meter min="0" max="1" value={Math.min(1, Math.max(0, Number(item.context_usage_percent)))} aria-label="Context used" /><span>{percent(item.context_usage_percent)}</span>
            </div>}
            <dl className="status-metrics">
              <div><dt>Input</dt><dd>{count(item.input_tokens)}{Number(item.context_window_tokens) > 0 && <small>/ {count(item.context_window_tokens)}</small>}</dd></div>
              <div><dt>Cached input</dt><dd>{count(item.cached_input_tokens)}<small>· {percent(item.cache_hit_rate)} hit</small></dd></div>
              <div><dt>Output</dt><dd>{count(item.output_tokens)}</dd></div>
            </dl>
          </div>)}
        </section>
      </div>
    </section>
  );
}
