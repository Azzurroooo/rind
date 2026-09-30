import { ArrowUp, ChevronDown, CornerUpRight, ListPlus, Square } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";

// One primary action, with less frequent running-turn actions one tap away.
// The two slots always occupy the same width, including while idle.
export function SendControl({ active, hasContent, disabled, compacting, onSend, onCancel }) {
  const stopping = active && (!hasContent || compacting);
  const label = stopping ? "Stop active turn" : active ? "Send queued message" : "Send message";
  const items = [
    { id: "queue", label: "Send after this turn", hint: "Enter", icon: <ListPlus size={15} />, disabled: !hasContent || disabled || compacting, onSelect: () => onSend("follow_up") },
    { id: "steer", label: "Steer this turn", hint: "Alt+Enter", icon: <CornerUpRight size={15} />, disabled: !hasContent || disabled || compacting, onSelect: () => onSend("steering") },
    { separator: true },
    { id: "stop", label: "Stop active turn", icon: <Square size={13} />, danger: true, onSelect: onCancel },
  ];
  return (
    <div className="send-control">
      <button type="button" className={`send-button${stopping ? " stop" : ""}`} aria-label={label} title={label} disabled={stopping ? disabled : disabled || compacting || !hasContent} onClick={stopping ? onCancel : () => onSend("follow_up")}>
        {stopping ? <Square size={13} fill="currentColor" aria-hidden="true" /> : active ? <ListPlus size={17} aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}
      </button>
      <Menu label="Running turn actions" className="send-menu" placement="top" items={items} disabled={!active || disabled} trigger={(props) => (
        <button type="button" className="send-options" aria-label="Message actions" disabled={!active || disabled} {...props}><ChevronDown size={14} aria-hidden="true" /></button>
      )} />
    </div>
  );
}
