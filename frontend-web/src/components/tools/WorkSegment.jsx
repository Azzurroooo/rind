import { useEffect, useRef, useState } from "react";
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
  const single = segment.calls.length === 1;
  const wantsOpen = single || segment.autoOpen;
  const [settledOpen, setSettledOpen] = useState(wantsOpen);
  useEffect(() => {
    if (wantsOpen) { setSettledOpen(true); return; }
    const timer = setTimeout(() => setSettledOpen(false), 600);
    return () => clearTimeout(timer);
  }, [wantsOpen]);
  const open = single || (override ?? (wantsOpen || settledOpen));
  const revealed = useRef(open);
  useEffect(() => { if (open) revealed.current = true; }, [open]);
  const candidate = (segment.live || (!segment.autoOpen && settledOpen)) && !showEarlier && override !== true ? liveWindow(segment.calls) : { visible: segment.calls, earlier: 0 };
  const lastVisible = useRef(candidate);
  useEffect(() => { if (open) lastVisible.current = candidate; });
  const windowed = open ? candidate : lastVisible.current;
  const duration = formatDuration(segment.duration_ms);
  const { summary } = segment;

  return (
    <section
      className={`${single ? "work-single" : "work-segment"} is-${segment.status} ${open ? "is-open" : ""}`}
      data-segment-calls={segment.calls.map((call) => call.callId).join(" ")}
    >
      <div className="work-segment-heading" aria-hidden={single} inert={single ? "" : undefined}><div className="work-segment-clip">
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
      </div></div>
      <div className="work-segment-shell" aria-hidden={!open} inert={!open ? "" : undefined}><div className="work-segment-clip">
      {(open || revealed.current) && (
        <div className="work-segment-body" onFocusCapture={() => setOverride(true)}>
          {windowed.earlier > 0 && (
            <button type="button" className="work-segment-earlier" onClick={() => { setShowEarlier(true); setOverride(true); }}>+{windowed.earlier} earlier</button>
          )}
          {windowed.visible.map((call) => <ToolRow key={call.id} call={call} onOpenFile={onOpenFile} />)}
        </div>
      )}
      </div></div>
    </section>
  );
}
