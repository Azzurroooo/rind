import { Brain, Check, ChevronDown } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { REASONING_EFFORTS } from "../../app/constants.js";
import { formatTokens, usageFraction } from "../../lib/format.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Composer toolbar chips (spec section 6): the effort chip opens a menu and
// the 16px context ring opens the Context tab. The model picker lives in
// ModelPicker.jsx. `data-composer-chip` lets the /model and /effort commands
// open them.
export function EffortChip({ effort, disabled, onSelect }) {
  const items = REASONING_EFFORTS.map((option) => ({
    id: `effort-${option}`,
    label: option,
    hint: option === effort ? <Check size={14} aria-label="Selected" /> : undefined,
    onSelect: () => option !== effort && onSelect?.(option),
  }));
  return (
    <Menu
      label="Reasoning effort"
      items={items}
      placement="top"
      align="end"
      className="chip-menu"
      trigger={(props) => (
        <button type="button" className="composer-chip" data-composer-chip="effort" aria-label={`Reasoning effort: ${effort || "default"}`} disabled={disabled} {...props}>
          <Brain size={14} aria-hidden="true" />
          <span className="chip-text">{effort || "Effort"}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
    />
  );
}

export function ContextRing({ stats, onOpen }) {
  const fraction = usageFraction(stats?.context_usage_percent);
  const percent = Math.round(fraction * 100);
  const tone = fraction >= 0.9 ? "danger" : fraction >= 0.7 ? "warning" : "";
  const label = `Context ${percent}% used (${formatTokens(stats?.input_tokens)} of ${formatTokens(stats?.context_window_tokens)} tokens)`;
  return (
    <button type="button" className={`context-ring-button ${tone}`.trim()} aria-label={label} title={label} onClick={onOpen}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle className="ring-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" />
        <circle
          className="ring-value"
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </button>
  );
}
