import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { formatDuration } from "../../lib/toolDisplay.js";
import { liveWindow } from "../../lib/workSegments.js";
import { ToolRow } from "./ToolRow.jsx";
import { ToolStatusIcon } from "./ToolStatusIcon.jsx";

// One fold per work segment (spec 5.1). Live: open, showing the running call
// plus the last two finished with "+N earlier". Ended: collapsed to the
// summary unless a call failed or waits on the user. A user toggle wins over
// the automatic rule. A single-call segment is just its row.
export function WorkSegment({ segment, onOpenFile }) {
  const [override, setOverride] = useState(null);
  const [showEarlier, setShowEarlier] = useState(false);
  if (segment.calls.length === 1) {
    return <div className="work-single"><ToolRow call={segment.calls[0]} onOpenFile={onOpenFile} /></div>;
  }

  const open = override ?? segment.autoOpen;
  const windowed = segment.live && !showEarlier ? liveWindow(segment.calls) : { visible: segment.calls, earlier: 0 };
  const duration = formatDuration(segment.duration_ms);
  const { summary } = segment;

  return (
    <section
      className={`work-segment is-${segment.status} ${open ? "is-open" : ""}`}
      data-segment-calls={segment.calls.map((call) => call.callId).join(" ")}
    >
      <button type="button" className="work-segment-head" aria-expanded={open} onClick={() => setOverride(!open)}>
        <ToolStatusIcon status={segment.status} />{" "}
        <span className="work-segment-summary">
          {summary.text}
          {summary.failed > 0 && <span className="tone-danger">{summary.text ? ", " : ""}{summary.failed} failed</span>}
          {summary.cancelled > 0 && <span className="tone-dim">{summary.text || summary.failed ? ", " : ""}{summary.cancelled} cancelled</span>}
        </span>
        {duration && <span className="work-segment-duration">{" "}{duration}</span>}
        <ChevronRight size={14} className={`tool-chevron ${open ? "open" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="work-segment-body">
          {windowed.earlier > 0 && (
            <button type="button" className="work-segment-earlier" onClick={() => setShowEarlier(true)}>+{windowed.earlier} earlier</button>
          )}
          {windowed.visible.map((call) => <ToolRow key={call.id} call={call} onOpenFile={onOpenFile} />)}
        </div>
      )}
    </section>
  );
}
