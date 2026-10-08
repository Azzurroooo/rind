import test from "node:test";
import assert from "node:assert/strict";
import { createChoice } from "../lib/agents-choice.js";
import { renderAgents } from "../lib/agents-view.js";
import { emptyAgentsSnapshot, sidebarRows } from "../lib/agents-model.js";
import { hintsFor } from "../lib/agents-keys.js";
import { stripAnsi } from "../lib/text-width.js";
import { CURSOR_MARKER } from "../lib/tui/frame.js";

const key = (text, name) => ({ text, name: name ?? text });
const labels = choice => choice.visible().map(item => (item.header ? "# " : "") + item.label);
const screenOf = view => stripAnsi(renderAgents(view, 80, 24).join("\n")).replaceAll(CURSOR_MARKER, "");
const run = (choice, ...keys) => keys.map(value => choice.handleKey(typeof value === "string" ? key(value) : value)).at(-1);

const MODELS = [
  { header: true, label: "DeepSeek" }, { label: "deepseek-flash" }, { label: "deepseek-v4-pro" },
  { header: true, label: "OpenAI" }, { label: "gpt-5.5" }, { label: "o3" },
];

test("a fixed menu of up to nine picks by number and letter; more than nine shows no numbers at all", () => {
  const short = createChoice({ title: "Actions", items: [{ label: "Open", key: "o" }, { label: "Remove", key: "x" }] });
  assert.equal(short.numbered(), true);
  assert.equal(run(short, "2").pick.label, "Remove");
  assert.equal(run(short, "o").pick.label, "Open");
  const long = createChoice({ title: "Many", items: Array.from({ length: 11 }, (_, i) => ({ label: "Item " + i })) });
  assert.equal(long.numbered(), false);
  assert.equal(run(long, "1"), undefined, "no item answers to a number it does not show");
  run(long, key("", "end"));
  assert.equal(run(long, key("", "enter")).pick.label, "Item 10");
});

test("a searchable list filters by what is typed, digits included, and keeps headers over their matches", () => {
  const choice = createChoice({ title: "Model", items: MODELS, searchable: true });
  assert.equal(choice.numbered(), false);
  run(choice, "5", ".", "5");
  assert.deepEqual(labels(choice), ["# OpenAI", "gpt-5.5"]);
  assert.equal(choice.position(), "1 match");
  run(choice, key("", "backspace"), key("", "backspace"), key("", "backspace"));
  run(choice, "o", "p", "e", "n");
  assert.deepEqual(labels(choice), ["# OpenAI", "gpt-5.5", "o3"], "a header's name finds the items under it");
  run(choice, "x");
  assert.equal(choice.position(), "No match");
  assert.equal(run(choice, key("", "enter")), undefined);
});

test("navigation skips headers, one step wraps and a page stops at the end", () => {
  const choice = createChoice({ title: "Model", items: MODELS, searchable: true });
  assert.equal(choice.visible()[choice.index].label, "deepseek-flash", "a header is never selected");
  assert.equal(choice.position(), "1 of 4");
  run(choice, key("", "down"), key("", "down"));
  assert.equal(choice.visible()[choice.index].label, "gpt-5.5");
  run(choice, key("", "pagedown"));
  assert.equal(choice.visible()[choice.index].label, "o3");
  run(choice, key("", "down"));
  assert.equal(choice.visible()[choice.index].label, "deepseek-flash");
  run(choice, "j");
  assert.equal(choice.query, "j", "j and k type in a searchable list");
});

test("Esc clears the filter first and closes the second time; the selection survives a filter that still shows it", () => {
  const choice = createChoice({ title: "Model", items: MODELS, searchable: true, selected: "o3" });
  run(choice, "o");
  assert.equal(choice.visible()[choice.index].label, "o3");
  assert.equal(run(choice, key("", "escape")), undefined);
  assert.equal(choice.query, "");
  assert.equal(choice.visible()[choice.index].label, "o3");
  assert.equal(run(choice, key("", "escape")), "close");
  choice.paste("gpt  5");
  assert.equal(choice.query, "gpt 5");
});

test("the dialog shows the filter, the position and the right hints", () => {
  const view = { snapshot: emptyAgentsSnapshot(), sidebar: sidebarRows(emptyAgentsSnapshot()), entries: [], focus: "main", page: { kind: "inbox" }, tabs: {}, query: "", filter: "All",
    dialog: createChoice({ title: "Model", items: MODELS, searchable: true }) };
  let screen = screenOf(view);
  assert.match(screen, /\/ type to filter/);
  assert.match(screen, /1 of 4/);
  assert.match(screen, /DeepSeek/);
  assert.deepEqual(hintsFor(view).map(h => h.key + " " + h.label), ["type filter", "↑↓ choose", "enter confirm", "esc cancel"]);
  run(view.dialog, "o", "3");
  screen = screenOf(view);
  assert.match(screen, /\/ o3/);
  assert.doesNotMatch(screen, /deepseek-flash/);
  assert.equal(hintsFor(view).at(-1).label, "clear");
  view.dialog = createChoice({ title: "Pick", items: [{ label: "A" }, { label: "B" }] });
  assert.ok(hintsFor(view).some(h => h.key === "1-9"));
});
