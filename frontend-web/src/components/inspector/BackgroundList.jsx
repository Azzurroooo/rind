import { useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { methods } from "../../methods.js";
import { errorText } from "../../app/constants.js";
import { formatDuration } from "../../lib/toolDisplay.js";

const POLL_MS = 3000;
const OUTPUT_CHARS = 20000;
const ACTIVE_STATES = new Set(["starting", "running", "cancelling"]);

// Background shell jobs from rind/background/list, the fallback for runtimes
// without the durable task service (rind/task/list). Like the task service
// view, only jobs that are still running appear; finished ones stay in the
// transcript. Selecting a job reads its output.
export function BackgroundList({ sessionId, request }) {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [output, setOutput] = useState(null);
  const generation = useRef(0);

  async function refresh(current = generation.current) {
    try {
      const result = await request(methods.backgroundList, { session_id: sessionId });
      if (current !== generation.current) return;
      const listed = Array.isArray(result?.tasks) ? result.tasks.filter((job) => ACTIVE_STATES.has(String(job.status))) : [];
      setJobs(listed);
      setError("");
      setSelected((current) => (current && listed.some((job) => (job.bg_id || job.task_id) === current) ? current : ""));
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    }
  }

  useEffect(() => {
    const current = ++generation.current;
    setJobs([]); setSelected(""); setOutput(null); setError("");
    if (!sessionId) return undefined;
    void refresh(current);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(current); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id) {
    setSelected(id);
    setOutput({ id, loading: true });
    try {
      const result = await request(methods.backgroundOutput, { session_id: sessionId, bg_id: id, max_output_chars: OUTPUT_CHARS });
      const task = result?.task || {};
      setOutput({ id, text: [task.stdout || task.output, task.stderr].filter(Boolean).join("\n") });
    } catch (cause) {
      setOutput({ id, error: errorText(cause) });
    }
  }

  return (
    <section className="inspector-section" aria-label="Background jobs">
      <div className="inspector-section-head">
        <h3 className="inspector-section-title">Tasks</h3>
        <button type="button" className="icon-button small" aria-label="Refresh background jobs" onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!jobs.length && !error && <p className="muted section-hint">No background commands are running. Commands Rind yields to the background appear here while they run.</p>}
      <ul className="task-list">
        {jobs.map((job) => {
          const id = job.bg_id || job.task_id;
          return (
            <li key={id}>
              <button type="button" className={`task-row${selected === id ? " selected" : ""}`} aria-expanded={selected === id} onClick={() => void open(id)}>
                <Terminal size={14} aria-hidden="true" />
                <span className="task-command">{job.command || id}</span>{" "}
                <span className={`task-status ${job.status || ""}`.trim()}>{job.status || "unknown"}</span>
                {Number(job.elapsed_ms) > 0 && <span className="task-elapsed">{" "}{formatDuration(job.elapsed_ms)}</span>}
              </button>
              {output?.id === id && (
                <pre className="task-output" aria-live="polite">
                  {output.loading ? "Loading output…" : output.error || output.text || "No output yet."}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
