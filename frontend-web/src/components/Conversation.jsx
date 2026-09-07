import { Check, CircleStop, LoaderCircle, Wrench } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { QuestionCard } from "./QuestionCard.jsx";
import { ToolBlock } from "./ToolBlock.jsx";

export function Conversation({ messages, draft, plan, active, onCancel, onAnswer, onExpire }) {
  return (
    <section className="conversation-panel">
      <div className="conversation-header">
        <div><span className="eyebrow">LIVE TRANSCRIPT</span><h1>{active ? "Working through the request" : "Ready for your next request"}</h1></div>
        {active && <button className="stop-button" onClick={onCancel}><CircleStop size={16} /> Stop turn</button>}
      </div>
      <div className="transcript" aria-live="polite">
        {!messages.length && !draft && <EmptyConversation />}
        {messages.map((message, index) => <Message key={`${message.id || message.role}-${index}`} message={message} onAnswer={onAnswer} onExpire={onExpire} />)}
        {draft && <article className="message assistant streaming"><div className="message-avatar">R</div><div className="message-body"><div className="message-meta">Rind <span>streaming</span></div><MarkdownContent value={draft} className="streaming-content" /><span className="cursor-block" /></div></article>}
        {plan?.length > 0 && <PlanBlock plan={plan} />}
        {active && !draft && !messages.some((message) => message.role === "tool" && message.status === "running") && <div className="thinking-line"><LoaderCircle className="spin" size={15} /> <span>Rind is thinking</span></div>}
      </div>
    </section>
  );
}

function EmptyConversation() {
  return <div className="empty-conversation"><div className="empty-orbit">R</div><h2>Start a conversation with your worker</h2><p>Your worker stays alive independently. Close this tab and reconnect later without losing the session.</p><div className="starter-grid"><span>Inspect the current workspace</span><span>Review recent changes</span><span>Plan the next task</span></div></div>;
}

function Message({ message, onAnswer, onExpire }) {
  if (message.role === "tool") return <div className="tool-stack"><ToolBlock tool={message} /></div>;
  if (message.role === "question") return <div className="tool-stack question-stack"><QuestionCard entry={message} onAnswer={onAnswer} onExpire={onExpire} /></div>;
  const assistant = message.role === "assistant";
  const system = message.role === "system";
  return <article className={`message ${assistant ? "assistant" : system ? "system" : "user"}`}><div className={`message-avatar ${assistant ? "rind" : "human"}`}>{assistant ? "R" : "You"}</div><div className="message-body"><div className="message-meta">{assistant ? "Rind" : "You"}<span>{message.time || ""}</span></div><MarkdownContent value={message.content} />{message.meta && <div className="message-note">{message.meta}</div>}</div></article>;
}

function PlanBlock({ plan }) {
  return <div className="plan-block"><div className="plan-heading"><Wrench size={14} /><span>Plan</span></div>{plan.map((item, index) => <div className={`plan-row ${item.status || "pending"}`} key={`${item.step || item.title}-${index}`}><span className="plan-check">{item.status === "completed" ? <Check size={12} /> : index + 1}</span><span>{item.step || item.title || "Untitled step"}</span></div>)}</div>;
}
