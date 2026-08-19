import assert from "node:assert/strict";
import test from "node:test";

import { parseGoalCommand } from "../lib/slash-command-mode.js";

test("goal commands distinguish control actions from objectives", () => {
  assert.deepEqual(parseGoalCommand("/goal"), { action: "get" });
  assert.deepEqual(parseGoalCommand("/goal pause"), { action: "pause" });
  assert.deepEqual(parseGoalCommand(" /GOAL resume "), { action: "resume" });
  assert.deepEqual(parseGoalCommand("/goal clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("/goal finish the release"), {
    action: "set",
    objective: "finish the release",
  });
  assert.equal(parseGoalCommand("/goals now"), null);
});
