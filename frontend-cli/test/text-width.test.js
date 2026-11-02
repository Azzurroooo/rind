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

test("middleClipCells keeps escape sequences whole and closes styles", () => {
  const styled = "\x1b[31mabcdefghijklmnop\x1b[0m";
  const cut = middleClipCells(styled, 9);
  assert.equal(textWidth(cut), 9);
  assert.equal(stripAnsi(cut), "abc...nop");
  assert.doesNotMatch(cut.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b|\[\d/);
  assert.ok(cut.endsWith("\x1b[0m"));
});

// Symbols that default to text presentation take one cell in a terminal, even
// though they are pictographic; only emoji presentation takes two.
test("text-presentation symbols take one cell, as a terminal draws them", async () => {
  const { Terminal } = (await import("@xterm/headless")).default;
  const samples = ["↩", "▶", "✔", "©", "☀", "↔", "😀", "✅", "⌚", "↩\ufe0f", "你"];
  const terminal = new Terminal({ cols: 80, rows: 2, allowProposedApi: true });
  await new Promise(resolve => terminal.write(samples.join("|"), resolve));
  const line = terminal.buffer.active.getLine(0);
  const drawn = [];
  for (let x = 0, width = 0; x < 80; x++) {
    const cell = line.getCell(x);
    if (cell.getChars() === "|") { drawn.push(width); width = 0; } else width += cell.getWidth();
  }
  const expected = { "↩": 1, "▶": 1, "✔": 1, "©": 1, "☀": 1, "↔": 1, "😀": 2, "✅": 2, "⌚": 2, "↩\ufe0f": 2, "你": 2 };
  assert.deepEqual(samples.map(text => [text, textWidth(text)]), samples.map(text => [text, expected[text]]));
  assert.deepEqual(drawn.slice(0, 6), [1, 1, 1, 1, 1, 1], "the terminal draws text-presentation symbols in one cell");
  terminal.dispose();
});


// Long text from a delivered report or tool output: every grapheme comes back
// exactly as one Intl.Segmenter pass would return it, while the segmenter
// itself never sees more than a bounded window.
const COMPLEX = ["👩‍💻", "🇨🇳🇺🇸", "👍🏽", "e\u0301", "9️⃣", "\r\n", "\x07", "한", "\u1100\u1161\u11a8", "✈️", "中文，标点。", "é", "ab cd"];
const longMixedText = (length) => {
  let text = "";
  for (let index = 0; text.length < length; index += 1) text += COMPLEX[index % COMPLEX.length] + (index % 7 ? "" : "这是一段中文回复内容 English words 123 ");
  return text;
};

test("windowed segmentation matches a single segmenter pass grapheme for grapheme", () => {
  const reference = (text) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  for (const text of [
    longMixedText(6000),
    "👨‍👩‍👧‍👦".repeat(400) + "abc",
    "🇨🇳".repeat(700) + "x",
    "a" + "\u0301".repeat(1500) + "b",
    "\u0e01\u0e33".repeat(900),
  ]) {
    assert.deepEqual(graphemes(text), reference(text));
    assert.equal(textWidth(text), reference(text).reduce((sum, g) => sum + textWidth(g), 0));
  }
});

test("long text is measured, clipped and wrapped without handing the segmenter more than a window", (t) => {
  const original = Intl.Segmenter.prototype.segment;
  let longest = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (input) {
    longest = Math.max(longest, input.length);
    return original.call(this, input);
  });
  const text = longMixedText(280_000);
  const styled = `\x1b[2m${text}\x1b[0m`;
  textWidth(text);
  graphemes(text);
  const clipped = clipCells(styled, 66);
  assert.ok(textWidth(clipped) >= 65 && textWidth(clipped) <= 66, "a wide character never straddles the cut");
  assert.ok(clipped.endsWith("...\x1b[0m"));
  const middle = textWidth(middleClipCells(styled, 40));
  assert.ok(middle >= 38 && middle <= 40, `middle clip is ${middle} cells`);
  assert.equal(truncateToWidth(text, 20, "…").length < 40, true);
  assert.ok(longest <= 1024, `segmenter saw ${longest} code units`);
});

test("clipping reads only as far as the cut", (t) => {
  const original = Intl.Segmenter.prototype.segment;
  let seen = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (input) {
    seen += input.length;
    return original.call(this, input);
  });
  clipCells(longMixedText(280_000), 66);
  assert.ok(seen <= 2048, `clip segmented ${seen} code units`);
});
