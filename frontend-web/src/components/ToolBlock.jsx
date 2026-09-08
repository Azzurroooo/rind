import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, FileCode2, LoaderCircle, TerminalSquare } from "lucide-react";
import { DiffView } from "./DiffView.jsx";
import {
  TOOL_OUTPUT_PREVIEW_LINES,
  extractDiffText,
  failedMessage,
  rawPayloads,
  toolDetails,
  toolItems,
  toolLabel,
  toolOutput,
  toolSummary,
} from "../lib/toolDisplay.js";

// Tool block with three disclosure levels (web-ui.md §2.2 / master plan §6.1):
//   1 — summary row, default COLLAPSED (status icon + tool name + param summary)
//   2 — expanded detail: args/output rows, item lists, diff for edit_file
//   3 — raw JSON (<details>) of the request and result payloads
// State machine: running → ok | failed; failed auto-expands ONCE (new failures
// stay visible; collapsing it again is respected — no re-expanding).
export function ToolBlock({ tool }) {
  const running = tool?.status === "running";
  const failed = tool?.status === "failed" || failedMessage(tool);
  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);

  // Runs on mount too: a block that ARRIVES already failed is a new failure.
  useEffect(() => {
    if (failed && !autoExpandedRef.current) {
      autoExpandedRef.current = true;
      setExpanded(true);
    }
  }, [failed]);

  const name = String(tool?.name || "tool");
  const label = toolLabel(name);
  const summary = toolSummary(name, tool) || (running ? "运行中…" : "");
  const diffText = extractDiffText(name, tool);
  const output = toolOutput(name, tool);
  const details = toolDetails(name, tool);
  const items = toolItems(name, tool);
  const error = failedMessage(tool);
  const raw = rawPayloads(tool);
  const hasBody = Boolean(error || details.length || items.length || output || diffText || tool?.file);

  return (
    <article className={`tool-block ${running ? "running" : ""} ${failed ? "failed" : ""} ${expanded ? "expanded" : ""}`}>
      <button type="button" className="tool-title" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <StatusIcon running={running} failed={Boolean(failed)} />
        <strong>{label}</strong>
        {summary && <span className="tool-summary-line">{summary}</span>}
        <span className={`tool-status ${running && tool?.progress ? "live" : ""}`}>{running ? (tool?.progress || "running") : failed ? "failed" : "complete"}</span>
        <ChevronDown size={14} className={`tool-chevron ${expanded ? "open" : ""}`} />
      </button>
      {expanded && hasBody && (
        <div className="tool-body">
          {error && <div className="tool-error" role="alert">{error}</div>}
          {details.length > 0 && (
            <div className="tool-rows">
              {details.map((detail) => (
                <div className="tool-detail" key={`${detail.label}-${detail.value}`}>
                  <span>{detail.label}</span>
                  <strong>{detail.value}</strong>
                </div>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div className="tool-items">
              {items.map((item, index) =>
                item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer" key={`${item.url}-${index}`}>
                    <strong>{item.title || item.url}</strong>
                    {item.detail && <span>{item.detail}</span>}
                  </a>
                ) : (
                  <div key={`${item.title}-${index}`}>
                    <strong>{item.title || item.path || item.file || "item"}</strong>
                    {item.detail && <span>{item.detail}</span>}
                  </div>
                ),
              )}
            </div>
          )}
          {diffText && <DiffView diff={diffText} caption={tool?.file} />}
          {output && <OutputArea output={output} />}
          {tool?.file && !diffText && (
            <div className="file-change"><FileCode2 size={14} /> {tool.file}</div>
          )}
          <details className="tool-raw">
            <summary><TerminalSquare size={13} /> 原始 JSON</summary>
            {raw.args && <pre data-raw="args">{raw.args}</pre>}
            {raw.result && <pre data-raw="result">{raw.result}</pre>}
            {!raw.args && !raw.result && <pre data-raw="empty">{"{}"}</pre>}
          </details>
        </div>
      )}
    </article>
  );
}

function StatusIcon({ running, failed }) {
  return (
    <span className={`tool-icon ${running ? "is-running" : failed ? "is-failed" : "is-ok"}`} aria-hidden="true">
      <span className="tool-icon-state">
        {failed ? <AlertTriangle size={14} /> : <Check size={14} />}
      </span>
      <span className="tool-icon-running"><LoaderCircle className="spin" size={14} /></span>
    </span>
  );
}

// Long output is capped at level 2 with an expand-all affordance (level 3 raw
// JSON stays available regardless).
function OutputArea({ output }) {
  const lines = String(output).replace(/\n$/, "").split("\n");
  const [showAll, setShowAll] = useState(false);
  const capped = !showAll && lines.length > TOOL_OUTPUT_PREVIEW_LINES;
  const text = capped ? lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES).join("\n") : output;
  return (
    <div className="tool-output">
      <pre>{text}</pre>
      {capped && (
        <button type="button" className="tool-expand-all" onClick={() => setShowAll(true)}>
          展开全部（共 {lines.length} 行）
        </button>
      )}
    </div>
  );
}
