import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, GitFork, Info, Pencil, RefreshCw, X } from "lucide-react";
import { MarkdownContent } from "../MarkdownContent.jsx";
import { copyText } from "../../lib/clipboard.js";
import { messageTime } from "../../lib/format.js";
import { StatusMessage } from "./StatusMessage.jsx";

const COPY_RESET_MS = 1600;

// User message (spec section 4): a right-aligned bubble with Copy and
// Edit & resend on hover.
export function UserMessage({ message, onEdit }) {
  return (
    <article className="message user" data-message-id={message.id || ""}>
      <div className="user-bubble" dir="auto">{message.content}</div>
      <div className="message-actions">
        <CopyButton text={message.content} />
        {onEdit && (
          <ActionButton label="Edit and resend" onClick={() => onEdit(message)}><Pencil size={14} /></ActionButton>
        )}
        <MessageTime value={message.time} />
      </div>
    </article>
  );
}

// Assistant message: full-width prose with Copy, Fork from here and the time.
// The action bar stays visible on the latest assistant message.
export function AssistantMessage({ message, latest, onFork }) {
  return (
    <article className={`message assistant${latest ? " is-latest" : ""}`} data-message-id={message.id || ""}>
      <MarkdownContent value={message.content} className="assistant-content" />
      {message.meta && <div className="message-note">{message.meta}</div>}
      <div className="message-actions">
        <CopyButton text={message.content} />
        {onFork && (
          <ActionButton label="Fork from here" onClick={() => onFork(message)}><GitFork size={14} /></ActionButton>
        )}
        <MessageTime value={message.time} />
      </div>
    </article>
  );
}

// Streaming assistant text with the blinking caret.
export function StreamingMessage({ text }) {
  return (
    <article className="message assistant streaming" aria-busy="true">
      <MarkdownContent value={text} className="assistant-content streaming-content" />
      <span className="caret" aria-hidden="true" />
    </article>
  );
}

// System entries: errors render as a block with Retry; notices are one quiet line.
export function SystemNote({ message, onRetry }) {
  const error = message.tone === "error";
  return (
    <article className="message system" data-message-id={message.id || ""}>
      {message.display?.type === "status" ? <StatusMessage display={message.display} /> : (
        <div className={`system-note ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "note"}>
          {error ? <AlertTriangle size={15} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
          <span className="system-note-text">{message.content}</span>
          {error && onRetry && (
            <button type="button" className="button ghost small system-retry" onClick={() => onRetry(message)}>
              <RefreshCw size={13} aria-hidden="true" />{" "}Retry
            </button>
          )}
        </div>
      )}
      <div className="message-actions">
        <CopyButton text={message.content} />
        <MessageTime value={message.time} />
      </div>
    </article>
  );
}

function ActionButton({ label, onClick, children }) {
  return (
    <button type="button" className="message-action" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function CopyButton({ text }) {
  const [state, setState] = useState("idle"); // idle | copied | failed
  const timer = useRef(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), COPY_RESET_MS);
  }

  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy message";
  return (
    <button type="button" className={`message-action ${state}`} data-state={state} aria-label={label} title={label} onClick={copy}>
      {state === "copied" ? <Check size={14} /> : state === "failed" ? <X size={14} /> : <Copy size={14} />}
    </button>
  );
}

function MessageTime({ value }) {
  const time = messageTime(value);
  return time
    ? <time className="message-time" dateTime={time.iso} title={time.full}>{time.label}</time>
    : <span className="message-time" title="This older message has no recorded timestamp.">Time unavailable</span>;
}
