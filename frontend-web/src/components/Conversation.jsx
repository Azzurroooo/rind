import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown, Check, CircleStop, ClipboardCopy, FileDiff, LoaderCircle, RefreshCw, Wrench, X } from "lucide-react";
import { copyText } from "../lib/clipboard.js";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { QuestionCard } from "./QuestionCard.jsx";
import { ToolBlock } from "./ToolBlock.jsx";

// Distance (px) from the bottom beyond which the user counts as "scrolled up"
// and auto-follow pauses (audit #5: never disturb scroll).
const DETACH_THRESHOLD_PX = 48;

// Transcript governance (audit #5): stick to the bottom while streaming unless
// the user scrolled up; a floating "↓ 回到最新" chip offers the way back.
// The oldest entries beyond the cap are dropped reducer-side; this component
// renders the honest "更早的消息已折叠" divider for them.
const Conversation = forwardRef(function Conversation({
  messages,
  draft,
  plan,
  active,
  collapsedCount = 0,
  turnChanges = null,
  interruptArmed = false,
  onCancel,
  onAnswer,
  onExpire,
  onRetrieve,
  onPromote,
  onRetry,
}, ref) {
  const transcriptRef = useRef(null);
  const [detached, setDetached] = useState(false);

  const distanceFromBottom = useCallback(() => {
    const node = transcriptRef.current;
    if (!node) return 0;
    return node.scrollHeight - node.clientHeight - node.scrollTop;
  }, []);

  const stickToBottom = useCallback(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
  }, [distanceFromBottom]);

  // Auto-follow: content growth (streaming text, new entries) keeps the view
  // pinned to the bottom only while the user has not scrolled away.
  useEffect(() => {
    if (detached) return;
    stickToBottom();
  }, [draft, messages, active, detached, stickToBottom]);

  const scrollToLatest = useCallback(() => {
    stickToBottom();
    setDetached(false);
  }, [stickToBottom]);

  useImperativeHandle(ref, () => ({ scrollToLatest }), [scrollToLatest]);

  function jumpToDiff(toolCallId) {
    const node = transcriptRef.current?.querySelector(`[data-tool-id="${toolCallId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center" });
    setDetached(distanceFromBottom() > DETACH_THRESHOLD_PX);
  }

  return (
    <section className="conversation-panel">
      <div className="conversation-header">
        <div><span className="eyebrow">LIVE TRANSCRIPT</span><h1>{active ? "Working through the request" : "Ready for your next request"}</h1></div>
        {active && <button className={`stop-button ${interruptArmed ? "armed" : ""}`} onClick={onCancel}><CircleStop size={16} /> {interruptArmed ? "再按一次 Esc 停止" : "Stop turn"}</button>}
      </div>
      <div className="transcript-frame">
        <div className="transcript" ref={transcriptRef} onScroll={handleScroll} aria-live="polite">
          {collapsedCount > 0 && (
            <div className="collapsed-divider" role="note">更早的消息已折叠（{collapsedCount} 条）</div>
          )}
          {!messages.length && !draft && <EmptyConversation />}
          {messages.map((message, index) => (
            <Message
              key={`${message.id || message.role}-${index}`}
              message={message}
              onAnswer={onAnswer}
              onExpire={onExpire}
              onRetrieve={onRetrieve}
              onPromote={onPromote}
              onRetry={active ? undefined : onRetry}
            />
          ))}
          {draft && <article className="message assistant streaming"><div className="message-avatar">R</div><div className="message-body"><div className="message-meta">Rind <span>streaming</span></div><MarkdownContent value={draft} className="streaming-content" /><span className="cursor-block" /></div></article>}
          {plan?.length > 0 && <PlanBlock plan={plan} />}
          {!active && turnChanges && (
            <button type="button" className="change-summary" onClick={() => jumpToDiff(turnChanges.firstToolCallId)}>
              <FileDiff size={14} />
              <span>改动 {turnChanges.fileCount} 个文件</span>
              <span className="change-delta">+{turnChanges.added} −{turnChanges.removed}</span>
            </button>
          )}
          {active && !draft && !messages.some((message) => message.role === "tool" && message.status === "running") && <div className="thinking-line"><LoaderCircle className="spin" size={15} /> <span>Rind is thinking</span></div>}
        </div>
        {detached && (
          <button type="button" className="jump-latest" onClick={scrollToLatest}>
            <ArrowDown size={14} /> 回到最新
          </button>
        )}
      </div>
    </section>
  );
});

function EmptyConversation() {
  return <div className="empty-conversation"><div className="empty-orbit">R</div><h2>Start a conversation with your worker</h2><p>Your worker stays alive independently. Close this tab and reconnect later without losing the session.</p><div className="starter-grid"><span>Inspect the current workspace</span><span>Review recent changes</span><span>Plan the next task</span></div></div>;
}

function Message({ message, onAnswer, onExpire, onRetrieve, onPromote, onRetry }) {
  if (message.role === "tool") return <div className="tool-stack" data-tool-id={message.tool_call_id || ""}><ToolBlock tool={message} /></div>;
  if (message.role === "question") return <div className="tool-stack question-stack"><QuestionCard entry={message} onAnswer={onAnswer} onExpire={onExpire} /></div>;
  if (message.role === "queued") return <QueuedRow message={message} onRetrieve={onRetrieve} onPromote={onPromote} />;
  const assistant = message.role === "assistant";
  const system = message.role === "system";
  const actionable = (assistant || !system) && Boolean(message.content);
  return (
    <article className={`message ${assistant ? "assistant" : system ? "system" : "user"}`} data-message-id={message.id || ""}>
      <div className={`message-avatar ${assistant ? "rind" : "human"}`}>{assistant ? "R" : "You"}</div>
      <div className="message-body">
        <div className="message-meta">{assistant ? "Rind" : "You"}<span>{message.time || ""}</span></div>
        <MarkdownContent value={message.content} />{message.meta && <div className="message-note">{message.meta}</div>}
      </div>
      {actionable && <MessageActions message={message} onRetry={assistant ? onRetry : undefined} />}
    </article>
  );
}

// Hover-only affordances (audit: subtle, keyboard-invisible, no focus trap):
// copy on every user/assistant message; retry on assistant finals only.
function MessageActions({ message, onRetry }) {
  const [state, setState] = useState("idle"); // idle | copied | failed
  const timer = useRef(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  async function handleCopy() {
    const ok = await copyText(message.content);
    setState(ok ? "copied" : "failed");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <div className={`message-actions ${state}`} data-state={state}>
      <button
        type="button"
        className="message-action"
        tabIndex={-1}
        title={state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制消息"}
        aria-label={state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制消息"}
        onClick={handleCopy}
      >
        {state === "copied" ? <Check size={13} /> : state === "failed" ? <X size={13} /> : <ClipboardCopy size={13} />}
      </button>
      {onRetry && (
        <button
          type="button"
          className="message-action"
          tabIndex={-1}
          title="重试（重新发送该回合的用户输入）"
          aria-label="重试"
          onClick={() => onRetry(message)}
        >
          <RefreshCw size={13} />
        </button>
      )}
    </div>
  );
}

// Queued input chip (audit #1): renders like a user row plus the QUEUED tag
// and per-item actions — 取回 retrieves the input back to the draft
// (unsteer / dequeue_follow_up), 转向 promotes a follow_up to steering.
function QueuedRow({ message, onRetrieve, onPromote }) {
  const [busy, setBusy] = useState(false);
  async function run(action) {
    if (busy) return;
    setBusy(true);
    try {
      await action?.(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="message user queued-row" data-input-id={message.inputId || ""}>
      <div className="message-avatar human">You</div>
      <div className="message-body">
        <div className="message-meta">You<span className="queued-chip">QUEUED 队列中{message.mode === "follow_up" ? " · follow_up" : " · steer"}</span></div>
        <div className="message-content">{message.input}</div>
        <div className="queued-actions">
          <button type="button" className="queued-action" tabIndex={-1} disabled={busy} title="取回该输入（回到输入框草稿）" onClick={() => run(onRetrieve)}>取回</button>
          {message.mode === "follow_up" && (
            <button type="button" className="queued-action" tabIndex={-1} disabled={busy} title="转为立即转向（steer）插入当前回合" onClick={() => run(onPromote)}>转向</button>
          )}
        </div>
      </div>
    </article>
  );
}

function PlanBlock({ plan }) {
  return <div className="plan-block"><div className="plan-heading"><Wrench size={14} /><span>Plan</span></div>{plan.map((item, index) => <div className={`plan-row ${item.status || "pending"}`} key={`${item.step || item.title}-${index}`}><span className="plan-check">{item.status === "completed" ? <Check size={12} /> : index + 1}</span><span>{item.step || item.title || "Untitled step"}</span></div>)}</div>;
}

export { Conversation };
export default Conversation;
