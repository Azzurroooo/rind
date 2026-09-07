// Line-level red/green rendering of a unified diff text (web-ui.md §1).
// Pure presentational: input is the diff string extracted from edit_file /
// write_file results; no highlighting library, monospace + +/- classes only.

export function parseUnifiedDiff(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((line, index, all) => !(index === all.length - 1 && line === ""))
    .map((line) => {
      if (line.startsWith("@@")) return { kind: "meta", text: line };
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
        return { kind: "meta", text: line };
      }
      if (line.startsWith("+")) return { kind: "added", text: line.slice(1) };
      if (line.startsWith("-")) return { kind: "removed", text: line.slice(1) };
      if (line.startsWith("\\")) return { kind: "meta", text: line };
      return { kind: "context", text: line.replace(/^ /, "") };
    });
}

export function DiffView({ diff, caption }) {
  const lines = parseUnifiedDiff(diff);
  if (!lines.length) return null;
  return (
    <div className="diff-view">
      {caption && <div className="diff-caption">{caption}</div>}
      <div className="diff-body" role="figure" aria-label="代码差异">
        {lines.map((line, index) => (
          <div key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-marker">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>
            <span className="diff-text">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
