import { ArrowUp, Command, Paperclip, Send, Square } from "lucide-react";
import { slashCommands } from "../methods.js";

export function Composer({ value, onChange, onSubmit, active, onCancel, disabled }) {
  const commandMode = value.startsWith("/");
  const query = value.slice(1).split(/\s/)[0].toLowerCase();
  const suggestions = commandMode && !value.includes(" ") ? slashCommands.filter(([name]) => name.startsWith(query)).slice(0, 5) : [];
  return <div className="composer-wrap"><div className="composer-shell">{suggestions.length > 0 && <div className="slash-suggestions">{suggestions.map(([name, description]) => <button key={name} onClick={() => onChange(`/${name} `)}><Command size={14} /><strong>/{name}</strong><span>{description}</span></button>)}</div>}<textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }} placeholder={active ? "Send steering input to the active turn..." : "Ask your worker anything..."} disabled={disabled} rows={1} /><div className="composer-footer"><div className="composer-tools"><button className="icon-button subtle" title="Attach file (coming soon)" disabled><Paperclip size={16} /></button><span>Enter to send · Shift+Enter for new line</span></div>{active ? <button className="send-button stop" title="Stop active turn" onClick={onCancel}><Square size={15} fill="currentColor" /></button> : <button className="send-button" title="Send message" onClick={onSubmit} disabled={!value.trim() || disabled}><ArrowUp size={18} /></button>}</div></div><div className="composer-status"><span><span className="status-led" />{active ? "Turn in progress" : "Ready"}</span><span>Worker remains online when this tab closes</span></div></div>;
}

