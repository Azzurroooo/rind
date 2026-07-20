import assert from "node:assert/strict";
import test from "node:test";

import { clipCells, graphemes, middleClipCells, textWidth } from "../lib/text-width.js";

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
