import assert from "node:assert/strict";
import test from "node:test";

import { clipCells, graphemes, middleClipCells, textWidth, wrapTextCells } from "../lib/text-width.js";

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
