import assert from "node:assert/strict";
import test from "node:test";

import { isInputClosed } from "../lib/input-errors.js";

test("isInputClosed accepts readline close errors", () => {
  assert.equal(isInputClosed(new Error("Input closed")), true);
  assert.equal(isInputClosed(new Error("readline was closed")), true);
  assert.equal(isInputClosed(new Error("boom")), false);
});
