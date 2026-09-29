import { useState } from "react";
import { DiffView } from "../DiffView.jsx";
import { MarkdownContent } from "../MarkdownContent.jsx";

// Body renderers for an opened call row, one per body type produced by
// lib/toolDisplay.js. Each shows `cap` lines first and offers "Show all" up
// to `expandedCap`; nothing renders for an empty section.
export function ToolBody({ body }) {
  if (!body) return null;
  switch (body.type) {
    case "terminal": return <TerminalBody body={body} />;
    case "code": return <CodeBody body={body} />;
    case "diff": return <DiffBody body={body} />;
    case "list": return <ListBody body={body} />;
    case "markdown": return <MarkdownBody body={body} />;
    case "text": return <TextBody body={body} />;
    case "kv": return <KeyValueBody body={body} />;
    default: return null;
  }
}

function useShowAll() {
  const [all, setAll] = useState(false);
  return [all, () => setAll(true)];
}

function ShowAll({ hidden, onClick, label = "Show all" }) {
  if (hidden <= 0) return null;
  return <button type="button" className="tool-show-all" onClick={onClick}>{label} ({hidden} more)</button>;
}

// Terminal output keeps the tail: the last lines are what matter.
function TerminalBody({ body }) {
  const [all, showAll] = useShowAll();
  const limit = all ? body.expandedCap : body.cap;
  const shown = body.lines.slice(-limit);
  const hidden = Math.min(body.lines.length, body.expandedCap) - shown.length;
  return (
    <div className="tool-body-block">
      <ShowAll hidden={all ? 0 : hidden} onClick={showAll} label="Show earlier" />
      <pre className="tool-terminal">{shown.join("\n")}</pre>
    </div>
  );
}

function CodeBody({ body }) {
  const [all, showAll] = useShowAll();
  const shown = body.lines.slice(0, all ? body.expandedCap : body.cap);
  return (
    <div className="tool-body-block">
      <pre className="tool-code">{shown.join("\n")}</pre>
      <ShowAll hidden={all ? 0 : Math.min(body.lines.length, body.expandedCap) - shown.length} onClick={showAll} />
    </div>
  );
}

function DiffBody({ body }) {
  const [all, showAll] = useShowAll();
  const lines = String(body.diff || "").split("\n");
  const shown = lines.slice(0, all ? body.expandedCap : body.cap);
  return (
    <div className="tool-body-block">
      <DiffView diff={shown.join("\n")} />
      <ShowAll hidden={all ? 0 : Math.min(lines.length, body.expandedCap) - shown.length} onClick={showAll} />
    </div>
  );
}

function ListBody({ body }) {
  const [all, showAll] = useShowAll();
  const shown = body.items.slice(0, all ? body.expandedCap : body.cap);
  return (
    <div className="tool-body-block">
      <ul className="tool-list">
        {shown.map((item, index) => <ListItem key={`${item.title}-${index}`} item={item} path={body.pathTitles} />)}
      </ul>
      <ShowAll hidden={all ? 0 : Math.min(body.items.length, body.expandedCap) - shown.length} onClick={showAll} />
    </div>
  );
}

function ListItem({ item, path }) {
  const title = item.href
    ? <a href={item.href} target="_blank" rel="noreferrer noopener" className="tool-list-title">{item.title}</a>
    : <span className={`tool-list-title ${path ? "is-mono" : ""}`}>{item.title}</span>;
  if (!item.lines?.length) {
    return <li className="tool-list-item">{title}{item.detail && <span className="tool-list-detail">{item.detail}</span>}</li>;
  }
  return (
    <li className="tool-list-item has-lines">
      <details>
        <summary>{title}{item.detail && <span className="tool-list-detail">{item.detail}</span>}</summary>
        <pre className="tool-code">{item.lines.join("\n")}</pre>
      </details>
    </li>
  );
}

function MarkdownBody({ body }) {
  const lines = String(body.text || "").split("\n");
  const hidden = lines.length - body.cap;
  return (
    <div className="tool-body-block tool-markdown">
      <MarkdownContent value={lines.slice(0, body.cap).join("\n")} />
      {hidden > 0 && <div className="tool-more-note">{hidden} more lines</div>}
    </div>
  );
}

function TextBody({ body }) {
  return (
    <div className="tool-body-block tool-text">
      {body.title && <strong>{body.title}</strong>}
      {body.lines.length > 0 && <p>{body.lines.slice(0, body.cap).join(" ")}</p>}
    </div>
  );
}

function KeyValueBody({ body }) {
  const [raw, setRaw] = useState(false);
  const output = body.output || [];
  const hidden = output.length - body.cap;
  const hasRaw = Boolean(body.raw && (body.raw.args || body.raw.result));
  return (
    <div className="tool-body-block">
      {body.rows.length > 0 && (
        <dl className="tool-kv">
          {body.rows.map((row) => (
            <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
          ))}
        </dl>
      )}
      {output.length > 0 && <pre className="tool-code">{output.slice(0, body.cap).join("\n")}</pre>}
      {hidden > 0 && <div className="tool-more-note">{hidden} more lines</div>}
      {hasRaw && (
        <button type="button" className="tool-show-all" aria-expanded={raw} onClick={() => setRaw((value) => !value)}>
          {raw ? "Hide raw JSON" : "Show raw JSON"}
        </button>
      )}
      {raw && <pre className="tool-code tool-raw-json">{[body.raw.args, body.raw.result].filter(Boolean).join("\n\n")}</pre>}
    </div>
  );
}
