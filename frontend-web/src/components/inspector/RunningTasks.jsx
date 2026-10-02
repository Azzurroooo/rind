import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { methods } from "../../methods.js";
import { errorText } from "../../app/constants.js";
import { formatDuration } from "../../lib/toolDisplay.js";

const POLL_MS = 4000;
const OUTPUT_CHARS = 20000;
const ACTIVE_STATES = new Set(["starting", "running", "cancelling"]);
export const taskId = (task) => String(task?.task_id || task?.bg_id || "").trim();
export const isYieldedRunningTask = (task) => Boolean(task) && task.handoff === true && ACTIVE_STATES.has(String(task.status));

// Normalize by identity before filtering: a terminal update replaces its running row.
export function listedTasks(rows, legacy = false) {
  return [...new Map((Array.isArray(rows) ? rows : []).filter(taskId).map((task) => [taskId(task), task])).values()]
    .filter((task) => legacy ? ACTIVE_STATES.has(String(task.status)) : isYieldedRunningTask(task))
    .sort((a, b) => taskId(a).localeCompare(taskId(b)));
}

// Keep previous data during revalidation, and serialize polling instead of allowing
// overlapping intervals. A session generation owns every async response.
export function RunningTasks({ sessionId, request, waitingCount = 0, enabled = true, legacy = false, renderEmpty }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [outputs, setOutputs] = useState({});
  const generation = useRef(0);
  const scope = useRef("");
  const selected = useRef("");
  const cursors = useRef({});
  const reads = useRef({});
  const pendingReads = useRef(new Set());
  const requestRef = useRef(request);
  requestRef.current = request;

  async function readOutput(id, cursor, silent = false) {
    const current = generation.current;
    const sequence = (reads.current[id] || 0) + 1;
    reads.current[id] = sequence;
    pendingReads.current.add(id);
    if (!silent) setOutputs((rows) => ({ ...rows, [id]: { ...rows[id], loading: true, error: "" } }));
    try {
      const result = await requestRef.current(legacy ? methods.backgroundOutput : methods.taskRead, {
        session_id: sessionId, ...(legacy ? { bg_id: id } : { task_id: id }),
        max_output_chars: OUTPUT_CHARS, ...(cursor ? { cursor } : {}),
      });
      if (current !== generation.current || reads.current[id] !== sequence) return;
      const value = legacy ? result?.task : result;
      cursors.current[id] = cursor;
      setOutputs((rows) => ({ ...rows, [id]: { ...value, loading: false } }));
    } catch (cause) {
      if (current === generation.current && reads.current[id] === sequence)
        setOutputs((rows) => ({ ...rows, [id]: { ...rows[id], loading: false, error: errorText(cause) } }));
    } finally {
      if (current === generation.current && reads.current[id] === sequence) pendingReads.current.delete(id);
    }
  }

  useEffect(() => {
    const current = ++generation.current;
    pendingReads.current.clear();
    setOutputs((rows) => Object.fromEntries(Object.entries(rows).map(([id, output]) => [id, { ...output, loading: false }])));
    const nextScope = sessionId + ":" + legacy;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      selected.current = "";
      cursors.current = {}; reads.current = {}; pendingReads.current = new Set();
      setTasks([]); setError(""); setLoaded(false); setExpanded(""); setOutputs({});
    }
    if (!sessionId || !enabled) return undefined;
    let timer;
    let refreshing = false;
    async function refresh() {
      if (document.hidden || refreshing || current !== generation.current) return;
      clearTimeout(timer);
      refreshing = true;
      try {
        const result = await requestRef.current(legacy ? methods.backgroundList : methods.taskList, { session_id: sessionId });
        if (current !== generation.current) return;
        const listed = listedTasks(result?.tasks, legacy);
        setTasks(listed); setLoaded(true); setError("");
        const id = selected.current;
        if (id && !listed.some((task) => taskId(task) === id)) {
          selected.current = ""; setExpanded("");
        } else if (id && !cursors.current[id] && !pendingReads.current.has(id)) {
          await readOutput(id, undefined, true);
        }
      } catch (cause) {
        if (current === generation.current) setError(errorText(cause));
      } finally {
        refreshing = false;
        if (current === generation.current) timer = window.setTimeout(refresh, POLL_MS);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++generation.current;
      pendingReads.current.clear();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [sessionId, enabled, legacy]);

  function toggle(id) {
    const next = selected.current === id ? "" : id;
    selected.current = next; setExpanded(next);
    if (next && !outputs[next]) void readOutput(next);
  }

  async function stop(id) {
    const current = generation.current;
    try {
      const result = await requestRef.current(methods.taskCancel, { session_id: sessionId, task_id: id });
      if (current !== generation.current) return;
      setTasks((rows) => rows.map((task) => taskId(task) === id ? { ...task, status: result?.status || "cancelling" } : task));
      setError("");
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    }
  }

  if (!tasks.length && !error && !waitingCount) {
    return renderEmpty?.({ loading: Boolean(sessionId && enabled && !loaded) }) || null;
  }

  return <section className="inspector-section" aria-label="Running background tasks">
    <div className="inspector-section-head"><h3 className="inspector-section-title">Tasks</h3>
      <span className="section-note">{tasks.length ? tasks.length + " running" : ""}</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!tasks.length && !error && <p className="muted section-hint">Waiting on background commands. Yielded commands appear here.</p>}
    <ul className="task-list">{tasks.map((task) => {
      const id = taskId(task), open = expanded === id, output = outputs[id];
      const text = [output?.stdout || output?.output, output?.stderr].filter(Boolean).join("\n");
      return <li key={id} data-task-id={id}>
        <button type="button" className={"task-row" + (open ? " selected" : "")} aria-expanded={open} onClick={() => toggle(id)}>
          <span className={"task-pip " + task.status} aria-hidden="true" />
          <span className="task-identity"><span className="task-command">{task.command || id}</span><span className="task-id">{id} · {task.status}</span></span>
          {Number(task.elapsed_ms) > 0 && <span className="task-elapsed">{formatDuration(task.elapsed_ms)}</span>}
        </button>
        {open && <div className="task-detail">
          <pre className="task-output">{text || (output?.loading ? "Loading output…" : "No output yet.")}</pre>
          {output?.error && <p className="form-error" role="alert">{output.error}</p>}
          <div className="panel-actions">
            <button type="button" disabled={output?.loading} onClick={() => void readOutput(id)}><RefreshCw size={13} aria-hidden="true" />{cursors.current[id] ? "Latest output" : "Refresh"}</button>
            {output?.start_cursor && <button type="button" disabled={output?.loading} onClick={() => void readOutput(id, output.start_cursor)}>Read from start</button>}
            {output?.meta?.truncated && output.next_cursor && <button type="button" disabled={output?.loading} onClick={() => void readOutput(id, output.next_cursor)}>Next output</button>}
            {!legacy && <button type="button" className="danger-text" onClick={() => void stop(id)}>Stop task</button>}
          </div>
        </div>}
      </li>;
    })}</ul>
  </section>;
}
