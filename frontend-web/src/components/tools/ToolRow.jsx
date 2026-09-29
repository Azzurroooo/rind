import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ToolBody } from "./ToolBody.jsx";
import { ToolStatusIcon } from "./ToolStatusIcon.jsx";

// One 28px call row (spec 5.2): status icon, verb, mono target (paths
// truncate from the start), meta on the right, chevron only with a body.
// A failed call opens itself once; collapsing it again is respected.
export function ToolRow({ call, onOpenFile }) {
  const failed = call.status === "error";
  const [open, setOpen] = useState(failed);
  const autoOpened = useRef(failed);

  useEffect(() => {
    if (failed && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [failed]);

  const hasBody = Boolean(call.body || call.error);
  const opensFile = !hasBody && Boolean(call.openFile && onOpenFile);
  const head = <RowHead call={call} hasBody={hasBody} open={open} />;

  return (
    <div className={`tool-row-wrap is-${call.status} ${open && hasBody ? "is-open" : ""}`} data-tool-id={call.callId}>
      {hasBody && (
        <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{head}</button>
      )}
      {opensFile && (
        <button type="button" className="tool-row" title="Open in Files" onClick={() => onOpenFile(call.openFile)}>{head}</button>
      )}
      {!hasBody && !opensFile && <div className="tool-row">{head}</div>}
      {open && hasBody && (
        <div className="tool-row-body">
          {call.error && <ToolError error={call.error} />}
          <ToolBody body={call.body} />
        </div>
      )}
    </div>
  );
}

function RowHead({ call, hasBody, open }) {
  const pending = !call.target && call.status === "running";
  return (
    <>
      <ToolStatusIcon status={call.status} />{" "}
      <span className="tool-verb">{call.verb}</span>{" "}
      {call.target && (
        <span className={`tool-target ${call.targetIsPath ? "is-path" : ""} ${call.targetIsPath || call.mono ? "is-mono" : ""}`}>
          {call.targetIsPath ? <bdi>{call.target}</bdi> : call.target}
        </span>
      )}
      {pending && <span className="tool-target is-pending" aria-hidden="true">…</span>}{" "}
      <span className="tool-meta">
        {call.meta.map((part, index) => <span key={index} className={`tone-${part.tone}`}>{index ? " " : ""}{part.text}</span>)}
      </span>
      {hasBody && <ChevronRight size={14} className={`tool-chevron ${open ? "open" : ""}`} aria-hidden="true" />}
    </>
  );
}

function ToolError({ error }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="tool-error" role="alert">
      <pre>{error.lines.join("\n")}</pre>
      {error.details && (
        <button type="button" className="tool-show-all" aria-expanded={details} onClick={() => setDetails((value) => !value)}>
          {details ? "Hide details" : "Show details"}
        </button>
      )}
      {details && <pre className="tool-error-details">{error.details}</pre>}
    </div>
  );
}
