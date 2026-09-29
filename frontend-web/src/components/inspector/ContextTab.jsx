import { Sparkles } from "lucide-react";
import { formatTokens, usageFraction } from "../../lib/format.js";
import { formatDuration } from "../../lib/toolDisplay.js";

const RING_RADIUS = 26;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function toneFor(fraction) {
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warning";
  return "";
}

// Context tab (spec section 7): the usage gauge, the last turn's totals and
// the rind/context/inspect breakdown rendered generically as labelled bars.
export function ContextTab({ stats, snapshot, contextInfo, compacting, canCompact, onCompact }) {
  const fraction = usageFraction(stats?.context_usage_percent);
  const percent = Math.round(fraction * 100);
  const breakdown = snapshot?.breakdown;
  const sections = Array.isArray(breakdown?.sections) ? breakdown.sections.filter((section) => Number(section?.tokens) > 0) : [];
  const windowTokens = Number(stats?.context_window_tokens || breakdown?.context_window_tokens || 0);
  const scale = windowTokens || sections.reduce((sum, section) => sum + Number(section.tokens || 0), 0) || 1;

  return (
    <div className="inspector-body context-tab">
      <div className="context-gauge">
        <svg className={`context-gauge-ring ${toneFor(fraction)}`.trim()} viewBox="0 0 64 64" role="img" aria-label={`Context ${percent}% used`}>
          <circle className="ring-track" cx="32" cy="32" r={RING_RADIUS} fill="none" strokeWidth="6" />
          <circle
            className="ring-value"
            cx="32"
            cy="32"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
            transform="rotate(-90 32 32)"
          />
        </svg>
        <div className="context-gauge-text">
          <strong>{percent}% used</strong>
          <span>{formatTokens(stats?.input_tokens)} of {formatTokens(windowTokens)} tokens</span>
        </div>
      </div>

      <dl className="stat-list">
        <Stat label="Cached input" value={formatTokens(stats?.cached_input_tokens)} />
        {Number(stats?.output_tokens) > 0 && <Stat label="Output" value={formatTokens(stats.output_tokens)} />}
        {Number(contextInfo?.lastTurnDurationMs) > 0 && <Stat label="Last turn" value={formatDuration(contextInfo.lastTurnDurationMs)} />}
        {Number(contextInfo?.messageCount) > 0 && <Stat label="Context messages" value={String(contextInfo.messageCount)} />}
      </dl>

      <section className="inspector-section" aria-label="Context breakdown">
        <h3 className="inspector-section-title">Breakdown</h3>
        {sections.length ? (
          <ul className="breakdown-list">
            {sections.map((section) => {
              const share = Math.min(1, Number(section.tokens) / scale);
              return (
                <li key={section.key || section.label} className="breakdown-row">
                  <div className="breakdown-label">
                    <span>{section.label || section.key}</span>{" "}
                    <span className="breakdown-value">{formatTokens(section.tokens)}</span>
                  </div>
                  <div className="breakdown-bar" aria-hidden="true"><span style={{ width: `${Math.max(1, share * 100)}%` }} /></div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">The breakdown appears after the next turn.</p>
        )}
      </section>

      {canCompact && (
        <button type="button" className="button secondary" onClick={onCompact} disabled={compacting}>
          <Sparkles size={14} aria-hidden="true" />{" "}{compacting ? "Compacting…" : "Compact context"}
        </button>
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
