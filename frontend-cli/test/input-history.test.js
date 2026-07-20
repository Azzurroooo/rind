import assert from "node:assert/strict";
import test from "node:test";

import { createInputHistory } from "../lib/input-history.js";

test("input history recalls previous entries and restores draft", () => {
  const history = createInputHistory();
  history.add("first");
  history.add("second");

  assert.equal(history.previous("draft"), "second");
  assert.equal(history.previous("second"), "first");
  assert.equal(history.previous("first"), "first");
  assert.equal(history.next("first"), "second");
  assert.equal(history.next("second"), "draft");
  assert.equal(history.next("draft"), "draft");
});

test("input history skips blanks and adjacent duplicates", () => {
  const history = createInputHistory();
  history.add("");
  history.add("same");
  history.add("same");

  assert.equal(history.previous(""), "same");
  assert.equal(history.next("same"), "");
});

test("input history resets active browse session after add", () => {
  const history = createInputHistory();
  history.add("first");
  assert.equal(history.previous("draft"), "first");

  history.add("second");

  assert.equal(history.next("ignored"), "ignored");
  assert.equal(history.previous("draft"), "second");
});

test("input history respects limit", () => {
  const history = createInputHistory(2);
  history.add("one");
  history.add("two");
  history.add("three");

  assert.equal(history.previous(""), "three");
  assert.equal(history.previous("three"), "two");
  assert.equal(history.previous("two"), "two");
});
