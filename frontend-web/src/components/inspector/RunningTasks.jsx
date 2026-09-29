import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { methods } from "../../methods.js";
import { errorText } from "../../app/constants.js";
import { formatDuration } from "../../lib/toolDisplay.js";

const POLL_MS = 4000;
const OUTPUT_CHARS = 20000;

const ACTIVE_STATES = new Set(["starting", "running", "cancelling"]);

// A task qualifies for the Activity sidebar only while it runs in the
// background on its own: the agent yielded the tool call (handoff) and the
// process has not settled yet. Finished tasks surface in the transcript.
export function isYieldedRunningTask(task) {
  return Boolean(task) && task.handoff === true && ACTIVE_STATES.has(String(task.status));
}

// Background commands the Activity tab watches (rind/task/list), after
// LobeHub's task list: one expandable row per running command, output paging
// and a stop action. Only the current turn's yielded tasks appear.
export function RunningTasks({ sessionId, request, waitingCount = 0 }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [outputs, setOutputs] = useState({});
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setTasks([]); setError(""); setExpanded(""); setOutputs({});
    if (!sessionId) return undefined;

    async function refresh() {
      if (document.hidden) return;
      try {
        const result = await request(methods.taskList, { session_id: sessionId });
        if (current !== generation.current) return;
        const listed = Array.isArray(result?.tasks) ? result.tasks.filter(isYieldedRunningTask) : [];
        setTasks(listed);
        setError("");
        // Keep the expanded row, but drop rows whose task finished.
        setExpanded((id) => (id && listed.some((task) => task.task_id === id) ? id : ""));
      } catch (cause) {
        if (current === generation.current) setError(errorText(cause));
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => { window.clearInterval(timer); };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function readOutput(taskId, cursor) {
    const current = generation.current;
    setOutputs((rows) => ({ ...rows, [taskId]: { loading: true } }));
    try {
      const result = await request(methods.taskRead, {
        session_id: sessionId,
        task_id: taskId,
        max_output_chars: OUTPUT_CHARS,
        ...(cursor ? { cursor } : {}),
      });
      if (current !== generation.current) return;
      setOutputs((rows) => ({ ...rows, [taskId]: result || {} }));
      setError("");
    } catch (cause) {
      if (current === generation.current) setOutputs((rows) => ({ ...rows, [taskId]: { error: errorText(cause) } }));
    }
  }

  function toggle(taskId) {
    if (expanded === taskId) {
      setExpanded("");
      return;
    }
    setExpanded(taskId);
    void readOutput(taskId);
  }

  async function stop(taskId) {
    try {
      const result = await request(methods.taskCancel, { session_id: sessionId, task_id: taskId });
      setTasks((rows) => rows.map((task) => (task.task_id === taskId ? { ...task, status: result?.status || "cancelling" } : task)));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const output = outputs[expanded];

  return (
    <section className="inspector-section" aria-label="Running background tasks">
      <div className="inspector-section-head">
        <h3 className="inspector-section-title">Tasks</h3>
        <span className="section-note">{tasks.length ? `${tasks.length} running` : ""}</span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!tasks.length && !error && (
        <p className="muted section-hint">
          {waitingCount > 0
            ? `Rind is waiting on ${waitingCount} background ${waitingCount === 1 ? "command" : "commands"}; yielded ones appear here.`
            : "No background commands are running. Commands Rind yields to the background appear here while they run."}
        </p>
      )}
      <ul className="task-list">
        {tasks.map((task) => {
          const id = task.task_id;
          const open = expanded === id;
          return (
            <li key={id}>
              <button type="button" className={`task-row${open ? " selected" : ""}`} aria-expanded={open} onClick={() => toggle(id)}>
                <span className={`task-pip ${ACTIVE_STATES.has(task.status) ? "running" : task.status}`} aria-hidden="true" />
                <span className="task-command">{task.command || id}</span>
                {Number(task.elapsed_ms) > 0 && <span className="task-elapsed">{formatDuration(task.elapsed_ms)}</span>}
              </button>
              {open && (
                <div className="task-detail">
                  <pre className="task-output" aria-live="polite">
                    {output?.loading ? "Loading output…" : output?.error || [output?.stdout, output?.stderr].filter(Boolean).join("\n") || "No output yet."}
                  </pre>
                  {output?.meta?.truncated && <p className="muted">More output is available.</p>}
                  <div className="panel-actions">
                    <button type="button" onClick={() => void readOutput(id)}>
                      <RefreshCw size={13} aria-hidden="true" /> {output?.start_cursor ? "Latest output" : "Refresh"}
                    </button>
                    {output?.start_cursor && (
                      <button type="button" onClick={() => void readOutput(id, output.start_cursor)}>Read from start</button>
                    )}
                    {output?.meta?.truncated && output.next_cursor && (
                      <button type="button" onClick={() => void readOutput(id, output.next_cursor)}>Next output</button>
                    )}
                    <button type="button" className="danger-text" onClick={() => void stop(id)}>Stop task</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
