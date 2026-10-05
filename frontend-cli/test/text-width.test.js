import assert from "node:assert/strict";
import test from "node:test";

import { clipCells, graphemes, middleClipCells, stripAnsi, textWidth, truncateToWidth, wrapTextCells } from "../lib/text-width.js";

test("printable ASCII bypasses segmentation; Unicode and controls retain their semantics", (t) => {
  const segment = t.mock.method(Intl.Segmenter.prototype, "segment");
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join("");
  assert.equal(textWidth(ascii), 95);
  assert.equal(textWidth(`\x1b[31m${ascii}\x1b[0m`), 95);
  assert.deepEqual(graphemes(ascii), ascii.split(""));
  assert.equal(segment.mock.callCount(), 0);
  for (const [text, width] of [["中文", 4], ["e\u0301", 1], ["👩‍💻", 2], ["✈️", 2], ["\u200b", 0], ["\t", 1], ["\x07", 1]]) {
    assert.equal(textWidth(text), width);
  }
  assert.ok(segment.mock.callCount() >= 7);
  assert.deepEqual(graphemes("\r\n"), ["\r\n"]);
});

test("text width treats keycap emoji as one grapheme and two cells", () => {
  assert.deepEqual(graphemes("9️⃣a"), ["9️⃣", "a"]);
  assert.equal(textWidth("9️⃣a"), 3);
  assert.equal(textWidth("🔟a"), 3);
});

test("clipCells does not split emoji sequences", () => {
  assert.equal(clipCells("abc 9️⃣ def", 8), "abc ...");
  assert.equal(clipCells("abc 🔟 def", 9), "abc 🔟...");
});

test("middleClipCells preserves whole emoji at both ends", () => {
  assert.equal(middleClipCells("9️⃣abcdef🔟", 9), "9️⃣a...f🔟");
});

test("wrapTextCells preserves cursor ownership before wide characters", () => {
  const chunks = wrapTextCells("a你bc好d", 2, 6);

  assert.deepEqual(
    chunks.map(({ text, startColumn, allowsEnd }) => ({ text, startColumn, allowsEnd })),
    [
      { text: "a", startColumn: 0, allowsEnd: true },
      { text: "你bc好", startColumn: 1, allowsEnd: false },
      { text: "d", startColumn: 5, allowsEnd: true },
    ],
  );
});

test("truncateToWidth measures styled text by visible cells and closes open styles", () => {
  const styled = "\x1b[1mfe-state\x1b[0m\x1b[2m · Sub-agent | Frontend/State\x1b[0m";
  for (const width of [4, 10, 20, 33]) {
    const cut = truncateToWidth(styled, width, "…");
    assert.equal(textWidth(cut), width);
    assert.match(stripAnsi(cut), /^fe-/);
    assert.ok(cut.endsWith("\x1b[0m"));
    assert.doesNotMatch(cut, /\x1b(?!\[[0-?]*[ -/]*[@-~])/, "escape sequences stay whole");
  }
  assert.equal(truncateToWidth("plain text", 6, "…"), "plain…");
});
