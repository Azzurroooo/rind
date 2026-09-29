import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowDown, FileDiff } from "lucide-react";
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
// streaming caret and the "Working…" shimmer. Auto-follow sticks to the
// bottom unless the user scrolled up; "Jump to latest" offers the way back.
export const Conversation = forwardRef(function Conversation({
  messages,
  draft,
  active,
  collapsedCount = 0,
  turnChanges = null,
  canFork = false,
  onAnswer,
  onExpire,
  onRetry,
  onEdit,
  onFork,
  onSuggestion,
  onOpenFile,
}, ref) {
  const transcriptRef = useRef(null);
  const [detached, setDetached] = useState(false);
  const entries = useMemo(() => (messages || []).filter((entry) => entry.role !== "queued"), [messages]);
  const timeline = useMemo(() => buildTimeline(entries, { active }), [entries, active]);
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
    const node = transcriptRef.current?.querySelector(`[data-tool-id="${toolCallId}"], [data-segment-calls~="${toolCallId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center" });
    setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
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
      return <AssistantMessage key={item.key} message={entry} latest={entry.id === lastAssistantId && !active} onFork={forkHandler(entry)} />;
    }
    return <UserMessage key={item.key} message={entry} onEdit={active ? undefined : onEdit} />;
  }

  const toolRunning = entries.some((entry) => entry.role === "tool" && entry.status === "running");
  const empty = !entries.length && !draft;

  return (
    <section className="conversation-panel">
      <div className="transcript" ref={transcriptRef} aria-live="polite" onScroll={() => setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX)}>
        <div className="transcript-column">
          {collapsedCount > 0 && (
            <div className="collapsed-divider" role="note">Earlier messages have been collapsed ({collapsedCount})</div>
          )}
          {empty && <EmptyConversation onSuggestion={onSuggestion} />}
          {timeline.map(renderEntry)}
          {draft && <StreamingMessage text={draft} />}
          {!active && turnChanges && (
            <button type="button" className="change-summary" onClick={() => jumpToDiff(turnChanges.firstToolCallId)}>
              <FileDiff size={14} aria-hidden="true" />{" "}
              <span>Changed {turnChanges.fileCount} {turnChanges.fileCount === 1 ? "file" : "files"}</span>{" "}
              <span className="change-delta"><span className="added">+{turnChanges.added}</span>{" "}<span className="removed">−{turnChanges.removed}</span></span>
            </button>
          )}
          {active && !draft && !toolRunning && (
            <div className="working-line" role="status"><span className="shimmer-text">Working…</span></div>
          )}
        </div>
      </div>
      {detached && (
        <button type="button" className="jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={14} aria-hidden="true" />{" "}Jump to latest
        </button>
      )}
    </section>
  );
});

export default Conversation;
