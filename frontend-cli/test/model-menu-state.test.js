import assert from "node:assert/strict";
import test from "node:test";

import { createModelMenuState } from "../lib/model-menu-state.js";

test("model menu groups models by provider and defaults to the current model", () => {
  const state = createModelMenuState(
    [
      { provider_id: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider_id: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
      { provider_id: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    ],
    { provider_id: "openai", model_id: "gpt-4o-mini" },
  );

  assert.deepEqual(
    state.items().map((item) => item.header ? `header:${item.name}` : item.modelId),
    ["header:openai", "gpt-5.5", "gpt-4o-mini", "header:deepseek", "deepseek-chat"],
  );
  assert.equal(state.selectedModel().modelId, "gpt-4o-mini");
  assert.equal(state.selectedModel().current, true);
});

test("model menu headers prefer provider display names when provided", () => {
  const state = createModelMenuState(
    [
      { provider_id: "openai-compatible", id: "custom-model" },
      { provider_id: "deepseek", id: "deepseek-chat" },
    ],
    { provider_id: "openai-compatible", model_id: "custom-model" },
    new Map([["openai-compatible", "OpenAI compatible (chat completions)"]]),
  );

  assert.deepEqual(
    state.items().map((item) => item.header ? `header:${item.name}` : item.modelId),
    ["header:OpenAI compatible (chat completions)", "custom-model", "header:deepseek", "deepseek-chat"],
  );
});

test("model menu handles plain string models without provider ids", () => {
  const state = createModelMenuState(["model-a", "model-b"], "model-b");

  assert.deepEqual(
    state.items().map((item) => item.modelId),
    ["model-a", "model-b"],
  );
  assert.equal(state.selectedModel().modelId, "model-b");
  assert.equal(state.selectedModel().current, true);
});

test("model menu includes current model when missing from server list", () => {
  const state = createModelMenuState(["model-a", "model-b"], "custom-model");

  assert.deepEqual(
    state.items().map((item) => item.modelId),
    ["custom-model", "model-a", "model-b"],
  );
  assert.equal(state.selectedModel().modelId, "custom-model");
  assert.equal(state.selectedModel().current, true);
});

test("model menu selection skips provider headers", () => {
  const state = createModelMenuState(
    [
      { provider_id: "openai", id: "gpt-5.5" },
      { provider_id: "deepseek", id: "deepseek-chat" },
    ],
    { provider_id: "openai", model_id: "gpt-5.5" },
  );

  assert.equal(state.handleKey({ name: "down" }), true);
  assert.equal(state.selectedModel().modelId, "deepseek-chat");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedModel().modelId, "gpt-5.5");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedModel().modelId, "deepseek-chat");
});

test("model menu can page beyond the first visible window", () => {
  const models = Array.from({ length: 10 }, (_, index) => `model-${index}`);
  const state = createModelMenuState(models, "model-0");

  for (let index = 0; index < 8; index += 1) {
    assert.equal(state.handleKey({ name: "down" }), true);
  }

  assert.equal(state.selectedModel().modelId, "model-8");
});
