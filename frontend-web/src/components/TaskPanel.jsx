import { useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { methods } from "../methods.js";

const activeStates = new Set(["starting", "running", "cancelling"]);

export function TaskPanel({ sessionId, request, enabled = true }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [output, setOutput] = useState(null);
  const [outputCursor, setOutputCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(null);
  const generation = useRef(0);
  const pagesLoaded = useRef(1);
  const outputRequest = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    pagesLoaded.current = 1;
    ++outputRequest.current;
    setTasks([]); setExpanded(""); setOutput(null); setOutputCursor(null); setError(""); setPage(null); setBusy(false);
    if (!sessionId || !enabled) return;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const count = pagesLoaded.current;
        let token;
        const rows = [];
        for (let index = 0; index < count; index++) {
          const result = await request(methods.taskList, { session_id: sessionId, ...(token ? { page_token: token } : {}) });
          if (current !== generation.current) return;
          rows.push(...(result?.tasks || []));
          token = result?.next_page_token;
          if (!token) break;
        }
        if (current === generation.current && count === pagesLoaded.current) {
          setTasks([...new Map(rows.map((task) => [task.task_id, task])).values()]);
          setPage(token); setError("");
        }
      } catch (cause) { if (current === generation.current) setError(cause.message); }
      finally { inFlight = false; }
    }
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => { ++generation.current; clearInterval(timer); };
  }, [sessionId, request, enabled]);
  async function act(method, taskId, cursor) {
    const current = generation.current;
    const requestId = ++outputRequest.current;
    setBusy(true); setError("");
    try {
      const result = await request(method, { session_id: sessionId, task_id: taskId, ...(cursor ? { cursor } : {}), ...(method === methods.taskRead ? { max_output_chars: 12000 } : {}) });
      if (current !== generation.current || requestId !== outputRequest.current) return;
      if (method === methods.taskRead || method === methods.taskCancel) {
        setOutput(result); setExpanded(taskId);
        setOutputCursor(cursor || null);
        if (result?.status) setTasks((rows) => rows.map((task) => task.task_id === taskId ? { ...task, status: result.status } : task));
      }
    } catch (cause) { if (current === generation.current && requestId === outputRequest.current) setError(cause.message); }
    finally { if (current === generation.current && requestId === outputRequest.current) setBusy(false); }
  }
  async function loadMore() {
    const current = generation.current;
    setBusy(true);
    try { const result = await request(methods.taskList, { session_id: sessionId, page_token: page }); if (current !== generation.current) return; ++pagesLoaded.current; setTasks((rows) => [...new Map([...rows, ...(result?.tasks || [])].map((task) => [task.task_id, task])).values()]); setPage(result?.next_page_token); }
    catch (cause) { if (current === generation.current) setError(cause.message); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="task-panel" aria-label="Background tasks">
    <div className="section-title"><Terminal size={15} /> Background tasks</div>
    {!enabled ? <p className="muted">This worker does not support task controls.</p> : !tasks.length && <p className="panel-empty">Long-running commands appear here. You can inspect output or stop a task while continuing the conversation.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {tasks.map((task) => <div className="task-row" key={task.task_id}>
      <button className="task-summary" onClick={() => { if (expanded === task.task_id) { ++outputRequest.current; setExpanded(""); setBusy(false); } else { setOutput(null); setExpanded(task.task_id); void act(methods.taskRead, task.task_id); } }} aria-expanded={expanded === task.task_id}><span className={`task-dot ${activeStates.has(task.status) ? "running" : task.status}`} /><span><strong>{task.command || task.task_id}</strong><small>{String(task.status || "unknown").replaceAll("_", " ")}</small></span></button>
      {expanded === task.task_id && <div className="task-detail">
        <pre>{[output?.stdout, output?.stderr].filter(Boolean).join("\n") || (busy ? "Loading output…" : "No output yet.")}</pre>
        {output?.meta?.truncated && <p className="muted">More output is available.</p>}
        <div className="panel-actions">
          <button disabled={busy} onClick={() => act(methods.taskRead, task.task_id)}><RefreshCw size={13} /> {outputCursor ? "Latest output" : "Refresh"}</button>
          {output?.start_cursor && <button disabled={busy} onClick={() => act(methods.taskRead, task.task_id, output.start_cursor)}>Read from start</button>}
          {output?.meta?.truncated && output.next_cursor && (outputCursor || !output.start_cursor) && <button disabled={busy} onClick={() => act(methods.taskRead, task.task_id, output.next_cursor)}>Next output</button>}
          {activeStates.has(task.status) && <>
            <button disabled={busy} onClick={() => act(methods.taskReleaseWait, task.task_id)}>Run in background</button>
            <button className="danger-text" disabled={busy} onClick={() => act(methods.taskCancel, task.task_id)}>Stop task</button>
          </>}
        </div>
      </div>}
    </div>)}
    {page && <button className="secondary-action" disabled={busy} onClick={loadMore}>Load more tasks</button>}
  </section>;
}
