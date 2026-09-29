import { useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { methods } from "../../methods.js";
import { errorText } from "../../app/constants.js";
import { formatDuration } from "../../lib/toolDisplay.js";

const POLL_MS = 3000;
const OUTPUT_CHARS = 20000;

// Background shell jobs from rind/background/list, used when the runtime has
// no durable task service (rind/task/list). Selecting a job reads its output.
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
      setJobs(Array.isArray(result?.tasks) ? result.tasks : []);
      setError("");
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
        <h3 className="inspector-section-title">Background jobs</h3>
        <button type="button" className="icon-button small" aria-label="Refresh background jobs" onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!jobs.length && !error && <p className="muted">No background jobs in this session.</p>}
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
