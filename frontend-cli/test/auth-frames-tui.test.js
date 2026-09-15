import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualOutput, createVirtualInput } from "./helpers/virtual-terminal.js";
import { createTui } from "../lib/tui/tui.js";
import { Container } from "../lib/tui/component.js";
import { ComposerArea } from "../lib/components/composer-area.js";
import { MonitorStack } from "../lib/components/monitor-stack.js";
import { authChoiceFrame, authSecretFrame } from "../lib/rendering.js";
import { createChoiceMenuState } from "../lib/choice-menu-state.js";
import { createLineEditor } from "../lib/line-editor.js";

function createHarness({ columns = 64, rows = 16 } = {}) {
  const virtual = createVirtualOutput({ columns, rows });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: virtual.output,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  let frame = null;
  const composerArea = new ComposerArea((width) => (frame ? frame(width) : null));
  const monitorStack = new MonitorStack({
    composer: composerArea,
    monitor: { isMonitoring: () => false, frame: () => null },
    rows: () => tui.rows,
  });
  tui.addChild(new Container());
  tui.addChild(monitorStack);
  return {
    tui,
    virtual,
    input,
    setFrame(next) {
      frame = next;
    },
  };
}

async function settle(virtual) {
  await virtual.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await virtual.flush();
}

test("secret login renders a full box with a masked value and caret on it", async () => {
  const harness = createHarness();
  const editor = createLineEditor();
  editor.handleInput({ kind: "paste", text: "sk-test-1234" });
  harness.setFrame((width) => {
    const frame = authSecretFrame({
      title: "DeepSeek",
      message: "API key",
      kind: "secret",
      value: editor.input(),
      width,
      cursor: editor.cursorPosition(),
    });
    return {
      showCaret: true,
      prompt: "",
      inputText: "",
      cursor: { line: 0, column: 0 },
      menuText: frame.text.trimEnd(),
      menuCursor: frame.cursor,
    };
  });
  harness.tui.start();
  await settle(harness.virtual);

  const viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /┌─ Login · DeepSeek ─+/);
  assert.match(viewport, /│ API key\s+│/);
  assert.match(viewport, /│\s+▷ •{12}\s+│/);
  assert.match(viewport, /│ enter submit · esc cancel\s+│/);
  assert.match(viewport, /└─+┘/);

  const position = harness.virtual.getCursorPosition();
  const maskedRow = harness.virtual.getViewport().findIndex((line) => line.includes("▷ ••••"));
  assert.ok(maskedRow >= 0, `masked row missing:\n${viewport}`);
  assert.equal(position.y, maskedRow);
  assert.equal(position.x, "│   ▷ ".length + 12);
  harness.tui.stop();
});

test("provider choice renders a full box with the selected provider highlighted", async () => {
  const harness = createHarness();
  const choiceState = createChoiceMenuState(
    ["openai · OpenAI · not configured", "deepseek · DeepSeek · not configured"],
    "openai · OpenAI · not configured",
  );
  choiceState.handleKey({ name: "down" });
  harness.setFrame((width) => ({
    showCaret: false,
    prompt: "",
    inputText: "",
    cursor: { line: 0, column: 0 },
    menuText: authChoiceFrame({
      title: "Provider",
      options: choiceState.options(),
      selectedIndex: choiceState.selectedIndex(),
      width,
    }).trimEnd(),
  }));
  harness.tui.start();
  await settle(harness.virtual);

  const viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /┌─ Login · Provider ─+/);
  assert.match(viewport, /│ · openai · OpenAI · not configured\s+│/);
  assert.match(viewport, /│ › deepseek · DeepSeek · not configured\s+│/);
  assert.match(viewport, /│ ↑↓ select · enter choose · esc cancel\s+│/);
  assert.match(viewport, /└─+┘/);
  harness.tui.stop();
});
