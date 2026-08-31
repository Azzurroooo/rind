import { AlertTriangle, Check, ChevronDown, CircleStop, FileCode2, LoaderCircle, Wrench } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent.jsx";

export function Conversation({ messages, draft, plan, active, onCancel }) {
  return (
    <section className="conversation-panel">
      <div className="conversation-header">
        <div><span className="eyebrow">LIVE TRANSCRIPT</span><h1>{active ? "Working through the request" : "Ready for your next request"}</h1></div>
        {active && <button className="stop-button" onClick={onCancel}><CircleStop size={16} /> Stop turn</button>}
      </div>
      <div className="transcript" aria-live="polite">
        {!messages.length && !draft && <EmptyConversation />}
        {messages.map((message, index) => <Message key={`${message.id || message.role}-${index}`} message={message} />)}
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

function Message({ message }) {
  if (message.role === "tool") return <div className="tool-stack"><ToolBlock tool={message} /></div>;
  const assistant = message.role === "assistant";
  const system = message.role === "system";
  return <article className={`message ${assistant ? "assistant" : system ? "system" : "user"}`}><div className={`message-avatar ${assistant ? "rind" : "human"}`}>{assistant ? "R" : "You"}</div><div className="message-body"><div className="message-meta">{assistant ? "Rind" : "You"}<span>{message.time || ""}</span></div><MarkdownContent value={message.content} />{message.meta && <div className="message-note">{message.meta}</div>}</div></article>;
}

function ToolBlock({ tool }) {
  const running = tool.status === "running";
  const failed = tool.status === "failed";
  const view = describeTool(tool);
  return <article className={`tool-block ${running ? "running" : ""} ${failed || view.failed ? "failed" : ""}`}><div className="tool-title"><span className="tool-icon">{running ? <LoaderCircle className="spin" size={14} /> : failed || view.failed ? <AlertTriangle size={14} /> : <Check size={14} />}</span><strong>{view.label}</strong><span className="tool-status">{running ? "running" : failed || view.failed ? "failed" : "complete"}</span><ChevronDown size={14} className="tool-chevron" /></div>{view.summary && <div className="tool-summary">{view.summary}</div>}{view.details?.map((detail, index) => <div className="tool-detail" key={index}><span>{detail.label}</span><strong>{detail.value}</strong></div>)}{view.items?.length > 0 && <div className="tool-items">{view.items.map((item, index) => item.url ? <a href={item.url} target="_blank" rel="noreferrer" key={index}><strong>{item.title || item.url}</strong>{item.detail && <span>{item.detail}</span>}</a> : <div key={index}><strong>{item.title || item.path || item.file || "item"}</strong>{item.detail && <span>{item.detail}</span>}</div>)}</div>}{view.output && <details className="tool-details"><summary>{view.outputLabel || "View output"}</summary>{view.outputMarkdown ? <MarkdownContent value={view.output} /> : <pre>{view.output}</pre>}</details>}{tool.file && <div className="file-change"><FileCode2 size={14} /> {tool.file}</div>}</article>;
}

function describeTool(tool) {
  const name = String(tool.name || "tool");
  const label = toolLabels[name] || humanToolName(name);
  const args = parseObject(tool.args);
  const payload = parseObject(tool.result || tool.content);
  const data = payload.data;
  if (!payload || !Object.keys(payload).length) return { label, summary: String(tool.result || tool.content || "") };
  if (payload.ok === false) return { label, failed: true, summary: String(payload.error || "Tool failed"), details: payload.error_type ? [{ label: "type", value: payload.error_type }] : [] };
  if (name === "bash" || name === "bash_output") return describeShell(label, args, payload, data);
  if (name === "read_file") return describeReadFile(label, args, payload, data);
  if (name === "glob") return describeGlob(label, args, payload, data);
  if (name === "grep") return describeGrep(label, args, payload, data);
  if (name === "search_web") return describeSearch(label, payload, data);
  if (name === "fetch_web_page") return { label, summary: String(args.url || payload.meta?.url || ""), output: typeof data === "string" ? data : "", outputLabel: "View extracted page", outputMarkdown: true };
  if (name === "write_file" || name === "edit_file") return describeMutation(label, data);
  if (name === "update_plan") return { label, summary: "Plan updated" };
  return { label, summary: summarizeValue(data ?? payload.message ?? "") };
}

function describeShell(label, args, payload, data) {
  const details = [];
  if (data?.cwd) details.push({ label: "cwd", value: data.cwd });
  if (data?.exit_code !== undefined) details.push({ label: "exit", value: String(data.exit_code) });
  if (data?.bg_id) details.push({ label: "background", value: data.bg_id });
  if (data?.status) details.push({ label: "state", value: data.status });
  const output = data && typeof data === "object" ? [data.stdout, data.stderr].filter(Boolean).join("\n") : typeof data === "string" ? data : "";
  const summary = args.command ? `$ ${args.command}` : label === "Background output" ? "Background output read" : data?.status === "completed" ? "Command completed" : data?.status || "";
  return { label, summary, details, output, outputLabel: output ? "View command output" : "" };
}

function describeReadFile(label, args, payload, data) {
  const meta = payload.meta || {};
  const details = [];
  const path = meta.path || args.path;
  if (path) details.push({ label: "file", value: path });
  if (meta.offset !== undefined) details.push({ label: "lines", value: `${meta.offset}-${meta.next_offset ? meta.next_offset - 1 : "end"}` });
  if (meta.truncated) details.push({ label: "note", value: "output truncated; continue with next offset" });
  return { label, summary: "Read file", details, output: typeof data === "string" ? data : "", outputLabel: "View file excerpt" };
}

function describeGlob(label, args, payload, data) {
  const values = Array.isArray(data) ? data : [];
  const meta = payload.meta || {};
  return { label, summary: `${values.length} file${values.length === 1 ? "" : "s"} found`, details: [{ label: "pattern", value: args.pattern || meta.pattern || "" }].filter((item) => item.value), items: values.slice(0, 12).map((item) => ({ path: item.path, detail: formatBytes(item.size_bytes) })), output: values.length > 12 ? `${values.length - 12} more files` : "", outputLabel: "View remaining count" };
}

function describeGrep(label, args, payload, data) {
  const values = Array.isArray(data) ? data : [];
  const meta = payload.meta || {};
  return { label, summary: `${values.length} match${values.length === 1 ? "" : "es"}`, details: [{ label: "pattern", value: args.pattern || meta.pattern || "" }].filter((item) => item.value), items: values.slice(0, 12).map((item) => ({ title: `${item.file || "file"}:${item.line || ""}`, detail: item.text || "" })), output: values.length > 12 ? `${values.length - 12} more matches` : "", outputLabel: "View remaining count" };
}

function describeSearch(label, payload, data) {
  const values = Array.isArray(data) ? data : [];
  const meta = payload.meta || {};
  return { label, summary: `${values.length} result${values.length === 1 ? "" : "s"}`, details: meta.engine ? [{ label: "source", value: meta.engine }] : [], items: values.slice(0, 8).map((item) => ({ title: item.title, url: item.url, detail: item.snippet })) };
}

function describeMutation(label, data) {
  const values = Array.isArray(data) ? data : [];
  return { label, summary: values.length ? `${values.length} file${values.length === 1 ? "" : "s"} changed` : "File updated", items: values.slice(0, 8).map((item) => ({ title: item.path, detail: `+${item.added_lines || 0} / -${item.removed_lines || 0} lines` })) };
}

const toolLabels = { bash: "Shell command", bash_output: "Background output", read_file: "Read file", write_file: "Write file", edit_file: "Edit file", glob: "Find files", grep: "Search files", search_web: "Web search", fetch_web_page: "Fetch web page", update_plan: "Update plan", delegate: "Delegate task", skill: "Load skill", skill_create: "Create skill" };

function humanToolName(value) { return String(value || "tool").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function parseObject(value) { try { const parsed = JSON.parse(String(value || "")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function summarizeValue(value) { if (typeof value === "string") return value; if (Array.isArray(value)) return `${value.length} items`; return value && typeof value === "object" ? Object.keys(value).slice(0, 4).join(", ") : String(value || ""); }
function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes)) return ""; if (bytes < 1024) return `${bytes} B`; return `${(bytes / 1024).toFixed(1)} KiB`; }

function PlanBlock({ plan }) {
  return <div className="plan-block"><div className="plan-heading"><Wrench size={14} /><span>Plan</span></div>{plan.map((item, index) => <div className={`plan-row ${item.status || "pending"}`} key={`${item.step || item.title}-${index}`}><span className="plan-check">{item.status === "completed" ? <Check size={12} /> : index + 1}</span><span>{item.step || item.title || "Untitled step"}</span></div>)}</div>;
}
