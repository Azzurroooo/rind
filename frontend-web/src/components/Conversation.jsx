import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, CircleStop, ClipboardCopy, FileDiff, LoaderCircle, RefreshCw, Wrench, X } from "lucide-react";
import { copyText } from "../lib/clipboard.js";
import { formatDuration, groupToolRuns, toolLabel, toolSummary } from "../lib/toolDisplay.js";
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
  activeSince = 0,
  stepRetry = null,
  collapsedCount = 0,
  turnChanges = null,
  workspace = "",
  connection = "",
  interruptArmed = false,
  onCancel,
  onAnswer,
  onExpire,
  onRetrieve,
  onPromote,
  onRetry,
  onStarter,
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
          {!messages.length && !draft && <EmptyConversation workspace={workspace} onStarter={onStarter} offline={connection === "offline"} />}
          {groupToolRuns(messages).map((entry, index) => (
            entry.kind === "tool-run"
              ? <ToolRunGroup key={`tool-run-${index}`} tools={entry.tools} />
              : <Message
                  key={`${entry.id || entry.role}-${index}`}
                  message={entry}
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
          {active && <WorkingStatus messages={messages} hasDraft={Boolean(draft)} activeSince={activeSince} stepRetry={stepRetry} />}
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

const STARTERS = [
  "检查当前工作区的结构，总结这个项目是做什么的",
  "审查最近的改动，指出潜在问题",
  "帮我梳理当前项目待办，列一个计划",
];

// opencode session-new-view pattern: the workspace path leads (directory muted,
// project name emphasized) and the starters are one-click fills, not decoration.
// When the worker is unreachable, the console teaches how to start one — the
// exact commands, copy-ready, instead of a dead "已断开" chip alone.
function EmptyConversation({ workspace, onStarter, offline = false }) {
  const { dir, name } = splitWorkspace(workspace);
  return <div className="empty-conversation">
    <div className="empty-orbit">R</div>
    <h2>Start a conversation with your worker</h2>
    {name && <div className="empty-workspace"><span>{dir}</span><strong>{name}</strong></div>}
    <p>Your worker stays alive independently. Close this tab and reconnect later without losing the session.</p>
    <div className="starter-grid">
      {STARTERS.map((starter) => (
        <button key={starter} type="button" className="starter-chip" onClick={() => onStarter?.(starter)}>{starter}</button>
      ))}
    </div>
    {offline && <SetupGuide />}
  </div>;
}

const SETUP_COMMANDS = [
  { label: "本地启动 worker", command: "python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd <workspace>" },
  { label: "或一键容器化部署（web + worker）", command: "docker compose up -d --build" },
];

function SetupGuide() {
  return <div className="setup-guide" role="note">
    <strong>连接不上 worker？</strong>
    <span>在仓库根目录用以下任一方式启动，然后用顶部地址栏连接：</span>
    {SETUP_COMMANDS.map(({ label, command }) => (
      <div className="setup-command" key={command}>
        <span>{label}</span>
        <div className="setup-command-row">
          <code>{command}</code>
          <CopyOnce text={command} label="复制" />
        </div>
      </div>
    ))}
  </div>;
}

// One-shot copy chip: 复制 → 已复制 (1.6s). Enough for the two command rows.
function CopyOnce({ text, label }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <button type="button" className="setup-copy" onClick={handleCopy} disabled={copied}>{copied ? "已复制" : label}</button>;
}

function splitWorkspace(value) {
  const clean = String(value || "").replace(/[\\/]+$/, "");
  if (!clean) return { dir: "", name: "" };
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return cut < 0 ? { dir: "", name: clean } : { dir: clean.slice(0, cut + 1), name: clean.slice(cut + 1) };
}

// Single-row turn status (codex status widget / claude spinner pattern):
// `Working 42s · Shell command $ pytest -q · Esc 停止`. The elapsed clock and
// the current activity come from state the reducer already tracks; the clock
// hides when unknown (turn resumed from a snapshot). A step-retry strip rides
// below while the model is between attempts.
function WorkingStatus({ messages, hasDraft, activeSince, stepRetry }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!activeSince) return undefined;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeSince]);

  const runningTool = latestRunningTool(messages);
  const elapsed = activeSince ? formatElapsed(Date.now() - activeSince) : "";
  return <div className="working-status">
    <div className="working-line">
      <LoaderCircle className="spin" size={14} />
      <strong>Working</strong>
      {elapsed && <span className="working-elapsed">{elapsed}</span>}
      <span className="working-activity">{runningTool ? workingToolText(runningTool) : hasDraft ? "responding" : "thinking"}</span>
      <span className="working-hint"><kbd>Esc</kbd> 中断</span>
    </div>
    {stepRetry && (
      <div className="retry-strip" role="status">
        模型响应中断 · 第 {stepRetry.attempt || "?"} 次重试{stepRetry.reason ? ` · ${stepRetry.reason}` : ""}
      </div>
    )}
  </div>;
}

function latestRunningTool(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role !== "tool" && entry.role !== "question" && entry.role !== "queued") return null; // newer non-tool activity
    if (entry.role === "tool" && entry.status === "running") return entry;
  }
  return null;
}

function workingToolText(tool) {
  const label = toolLabel(String(tool.name || ""));
  const summary = toolSummary(String(tool.name || ""), tool);
  return summary ? `${label} · ${summary}` : label;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
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
        <div className="message-meta">{assistant ? "Rind" : "You"}</div>
        <MarkdownContent value={message.content} />{message.meta && <div className="message-note">{message.meta}</div>}
      </div>
      {actionable && <MessageActions message={message} onRetry={assistant ? onRetry : undefined} />}
    </article>
  );
}

// Collapsed run of consecutive read/search blocks (claude-code collapse): one
// quiet row with the run size and total duration; expanding reveals the
// familiar per-tool blocks. Never auto-expands — the row IS the summary.
function ToolRunGroup({ tools }) {
  const [expanded, setExpanded] = useState(false);
  const totalMs = tools.reduce((sum, tool) => sum + (Number(tool.duration_ms) || 0), 0);
  return <div className="tool-stack">
    <article className={`tool-block tool-run ${expanded ? "expanded" : ""}`}>
      <button type="button" className="tool-title" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="tool-icon is-ok"><Check size={14} /></span>
        <strong>Reads &amp; searches</strong>
        <span className="tool-summary-line">{tools.length} 次调用</span>
        <span className="tool-status">{totalMs ? formatDuration(totalMs) : "complete"}</span>
        <ChevronDown size={14} className={`tool-chevron ${expanded ? "open" : ""}`} />
      </button>
      {expanded && <div className="tool-run-body">{tools.map((tool) => <ToolBlock key={tool.tool_call_id || tool.id} tool={tool} />)}</div>}
    </article>
  </div>;
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
