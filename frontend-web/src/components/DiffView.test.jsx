import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView, parseUnifiedDiff } from "./DiffView.jsx";

afterEach(cleanup);

const SAMPLE = [
  "--- a/src/app.py",
  "+++ b/src/app.py",
  "@@ -1,2 +1,2 @@",
  "context line",
  "-removed line",
  "+added line",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("classes header/meta, context, removed and added lines", () => {
    expect(parseUnifiedDiff(SAMPLE)).toEqual([
      { kind: "meta", text: "--- a/src/app.py" },
      { kind: "meta", text: "+++ b/src/app.py" },
      { kind: "meta", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: "context line" },
      { kind: "removed", text: "removed line" },
      { kind: "added", text: "added line" },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n")).toEqual([]);
  });

  it("normalizes CRLF line endings", () => {
    expect(parseUnifiedDiff("+a\r\n-b\r\n")).toEqual([
      { kind: "added", text: "a" },
      { kind: "removed", text: "b" },
    ]);
  });
});

describe("DiffView rendering", () => {
  it("renders one classed monospace line per diff row with +/- markers", () => {
    render(<DiffView diff={SAMPLE} />);
    expect(document.querySelectorAll(".diff-line")).toHaveLength(6);
    expect(document.querySelector(".diff-line.added .diff-marker").textContent).toBe("+");
    expect(document.querySelector(".diff-line.removed .diff-marker").textContent).toBe("-");
    expect(screen.getByText("added line")).not.toBeNull();
    expect(screen.getByText("removed line")).not.toBeNull();
  });

  it("shows the file caption when provided", () => {
    render(<DiffView diff={SAMPLE} caption="src/app.py" />);
    expect(screen.getByText("src/app.py")).not.toBeNull();
  });

  it("renders nothing without a diff", () => {
    const { container } = render(<DiffView diff="" />);
    expect(container.firstChild).toBeNull();
  });
});
