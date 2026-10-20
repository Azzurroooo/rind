import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronRight, FileDiff, FileText, Quote } from "lucide-react";
import { QuestionCard } from "../QuestionCard.jsx";
import { WorkSegment } from "../tools/WorkSegment.jsx";
import { buildTimeline } from "../../lib/workSegments.js";
import { isServerMessageId } from "../../app/constants.js";
import { EmptyConversation } from "./EmptyConversation.jsx";
import { AssistantMessage, StreamingMessage, SystemNote, UserMessage } from "./MessageItem.jsx";

// Distance (px) from the bottom beyond which the user counts as "scrolled up"
// and auto-follow pauses.
const DETACH_THRESHOLD_PX = 48;

// Fork point for an assistant reply: the next server-known user message after
// it (fork keeps everything before that message). Null forks the whole session.
function forkPointAfter(entries, index) {
  for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    if (entry.role === "user" && isServerMessageId(entry.id)) return entry.id;
  }
  return null;
}

// Conversation column (spec section 4): an 800px reading column with user
// bubbles, full-width assistant prose, folded work segments, questions, the
// streaming caret. Working status lives in the fixed chat header. Auto-follow sticks to the
// bottom unless the user scrolled up; "Jump to latest" offers the way back.
export const Conversation = forwardRef(function Conversation({
  messages,
  draft,
  active,
  collapsedCount = 0,
  turnChanges = null,
  turnFileList = [],
  canFork = false,
  onAnswer,
  onExpire,
  onRetry,
  onEdit,
  onFork,
  onQuote,
  onSuggestion,
  onOpenFile,
}, ref) {
  const panelRef = useRef(null);
  const transcriptRef = useRef(null);
  const [detached, setDetached] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [quotePill, setQuotePill] = useState(null);
  const entries = useMemo(() => (messages || []).filter((entry) => entry.role !== "queued"), [messages]);
  const timeline = useMemo(() => buildTimeline(entries, { active }), [entries, active]);
  const userTurns = useMemo(() => entries.filter((entry) => entry.role === "user" && entry.id), [entries]);
  const lastAssistantId = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === "assistant") return entries[index].id;
    }
    return null;
  }, [entries]);

  const distanceFromBottom = useCallback(() => {
    const node = transcriptRef.current;
    if (!node) return 0;
    return node.scrollHeight - node.clientHeight - node.scrollTop;
  }, []);

  const stickToBottom = useCallback(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  useEffect(() => {
    if (!detached) stickToBottom();
  }, [draft, messages, active, detached, stickToBottom]);

  const scrollToLatest = useCallback(() => {
    stickToBottom();
    setDetached(false);
  }, [stickToBottom]);

  useImperativeHandle(ref, () => ({ scrollToLatest }), [scrollToLatest]);

  function jumpToDiff(toolCallId) {
    if (!toolCallId) return;
    const node = transcriptRef.current?.querySelector(`[data-tool-id="${toolCallId}"], [data-segment-calls~="${toolCallId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center" });
    setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
  }

  function jumpToMessage(messageId) {
    if (!messageId) return;
    const node = transcriptRef.current?.querySelector(`[data-message-id="${messageId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "start", behavior: "smooth" });
    setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
  }

  function handleSelectionChange() {
    if (!onQuote || typeof window === "undefined" || !window.getSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setQuotePill(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotePill(null);
      return;
    }
    const anchor = selection.anchorNode?.parentElement;
    const focus = selection.focusNode?.parentElement;
    const assistantRoot = anchor?.closest?.(".assistant-content") || focus?.closest?.(".assistant-content");
    if (!assistantRoot || !transcriptRef.current?.contains(assistantRoot)) {
      setQuotePill(null);
      return;
    }
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const panelRect = panelRef.current?.getBoundingClientRect();
      if (!rect?.width || !panelRect) {
        setQuotePill(null);
        return;
      }
      const top = Math.max(8, rect.top - panelRect.top - 34);
      const left = Math.min(panelRect.width - 88, Math.max(12, rect.left - panelRect.left + rect.width / 2 - 36));
      setQuotePill({ text, top, left });
    } catch {
      setQuotePill(null);
    }
  }

  function forkHandler(entry) {
    if (!canFork || !onFork) return undefined;
    const index = entries.indexOf(entry);
    return () => onFork(forkPointAfter(entries, index));
  }

  function renderEntry(item) {
    const entry = item.entry;
    if (item.type === "segment") return <WorkSegment key={item.key} segment={item} onOpenFile={onOpenFile} />;
    if (entry.role === "question") {
      return <div key={item.key} className="question-stack"><QuestionCard entry={entry} onAnswer={onAnswer} onExpire={onExpire} /></div>;
    }
    if (entry.role === "system") {
      return <SystemNote key={item.key} message={entry} onRetry={active ? undefined : onRetry} />;
    }
    if (entry.role === "assistant") {
      return (
        <AssistantMessage
          key={item.key}
          message={entry}
          latest={entry.id === lastAssistantId && !active}
          onFork={forkHandler(entry)}
          onQuote={onQuote}
        />
      );
    }
    return <UserMessage key={item.key} message={entry} onEdit={active ? undefined : onEdit} />;
  }

  const empty = !entries.length && !draft;
  const hasFileList = Array.isArray(turnFileList) && turnFileList.length > 0;

  return (
    <section className="conversation-panel" ref={panelRef} onMouseUp={handleSelectionChange} onKeyUp={handleSelectionChange}>
      <div
        className="transcript"
        ref={transcriptRef}
        aria-live="polite"
        onScroll={() => {
          setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
          if (quotePill) setQuotePill(null);
        }}
      >
        <div className="transcript-column">
          {collapsedCount > 0 && (
            <div className="collapsed-divider" role="note">Earlier messages have been collapsed ({collapsedCount})</div>
          )}
          {empty && <EmptyConversation onSuggestion={onSuggestion} />}
          {timeline.map(renderEntry)}
          {draft && <StreamingMessage text={draft} />}
          {!active && turnChanges && (
            <div className={`change-summary-card${filesExpanded && hasFileList ? " is-expanded" : ""}`}>
              <div className="change-summary-bar">
                <button
                  type="button"
                  className="change-summary"
                  aria-expanded={hasFileList ? filesExpanded : undefined}
                  onClick={() => {
                    if (hasFileList) setFilesExpanded((v) => !v);
                    else jumpToDiff(turnChanges.firstToolCallId);
                  }}
                >
                  {hasFileList && (filesExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />)}
                  <FileDiff size={14} aria-hidden="true" />{" "}
                  <span>Changed {turnChanges.fileCount} {turnChanges.fileCount === 1 ? "file" : "files"}</span>{" "}
                  <span className="change-delta"><span className="added">+{turnChanges.added}</span>{" "}<span className="removed">−{turnChanges.removed}</span></span>
                </button>
                {hasFileList && turnChanges.firstToolCallId && (
                  <button
                    type="button"
                    className="change-summary-jump"
                    onClick={() => jumpToDiff(turnChanges.firstToolCallId)}
                    title="Jump to first diff in conversation"
                  >
                    Jump to diff
                  </button>
                )}
              </div>
              {filesExpanded && hasFileList && (
                <div className="change-file-list" role="list">
                  {turnFileList.map((file) => (
                    <div key={file.path} className="change-file-row" role="listitem">
                      <button
                        type="button"
                        className="change-file-path"
                        onClick={() => onOpenFile?.(file.path)}
                        title={`Preview ${file.path} in Files`}
                      >
                        <FileText size={13} aria-hidden="true" />
                        <span>{file.path}</span>
                      </button>
                      <span className="change-delta">
                        <span className="added">+{file.added}</span>{" "}
                        <span className="removed">−{file.removed}</span>
                      </span>
                      {file.toolCallId && (
                        <button
                          type="button"
                          className="change-file-diff"
                          onClick={() => jumpToDiff(file.toolCallId)}
                          title="Scroll to edit in conversation"
                        >
                          Diff
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {quotePill && onQuote && (
        <button
          type="button"
          className="quote-selection-pill"
          style={{ top: `${quotePill.top}px`, left: `${quotePill.left}px` }}
          onMouseDown={(event) => {
            event.preventDefault();
            onQuote(quotePill.text);
            setQuotePill(null);
            window.getSelection?.()?.removeAllRanges?.();
          }}
        >
          <Quote size={12} aria-hidden="true" />
          <span>Quote</span>
        </button>
      )}
      {userTurns.length >= 2 && (
        <nav className="chat-minimap" aria-label="Turn landmarks">
          {userTurns.map((turn, index) => {
            const preview = String(turn.content || "").replace(/\s+/g, " ").trim().slice(0, 72) || `Turn ${index + 1}`;
            return (
              <button
                key={turn.id || index}
                type="button"
                className={`chat-minimap-tick${turn.delivery ? " is-delivery" : ""}`}
                title={`${index + 1}. ${preview}`}
                aria-label={`Jump to turn ${index + 1}: ${preview}`}
                onClick={() => jumpToMessage(turn.id)}
              >
                <span className="chat-minimap-bar" />
              </button>
            );
          })}
        </nav>
      )}
      {detached && (
        <button type="button" className="jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={14} aria-hidden="true" />{" "}Jump to latest
        </button>
      )}
    </section>
  );
});

export default Conversation;
