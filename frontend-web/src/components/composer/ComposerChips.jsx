import { Brain, Check, ChevronDown, Cpu } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { REASONING_EFFORTS } from "../../app/constants.js";
import { formatTokens, usageFraction } from "../../lib/format.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Composer toolbar chips (spec section 6): 28px model and effort chips that
// open menus, and the 16px context ring that opens the Context tab.
// `data-composer-chip` lets the /model and /effort commands open them.
export function ModelChip({ model, models = [], disabled, onOpen, onSelect }) {
  const options = [...new Set([model, ...models].filter(Boolean))];
  const items = options.length
    ? options.map((option) => ({
      id: `model-${option}`,
      label: option,
      hint: option === model ? <Check size={14} aria-label="Selected" /> : undefined,
      onSelect: () => option !== model && onSelect?.(option),
    }))
    : [{ id: "model-none", label: "No models reported", disabled: true }];
  return (
    <Menu
      label="Models"
      items={items}
      placement="top"
      align="end"
      className="chip-menu"
      onOpenChange={(open) => open && onOpen?.()}
      trigger={(props) => (
        <button type="button" className="composer-chip" data-composer-chip="model" aria-label={`Model: ${model || "not set"}`} title={model || "Choose a model"} disabled={disabled} {...props}>
          <Cpu size={14} aria-hidden="true" />
          <span className="chip-text">{model || "Model"}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
    />
  );
}

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
