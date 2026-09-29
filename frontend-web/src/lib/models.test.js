import { describe, expect, it } from "vitest";
import { findModelOption, formatContextWindow, groupModelsByProvider, normalizeModelList, providerName } from "./models.js";

describe("normalizeModelList", () => {
  it("parses provider-aware entries and the current selection", () => {
    const listing = normalizeModelList({
      models: [
        { provider_id: "anthropic", id: "claude-sonnet-4", context_window: 200000, image_input: true },
        { provider_id: "openai", id: "gpt-5", context_window: null },
        { provider_id: "openai", id: "gpt-5" },
        "legacy-string",
        { provider_id: "", id: "" },
      ],
      current: { provider_id: "anthropic", model_id: "claude-sonnet-4" },
    });
    expect(listing.models).toEqual([
      { id: "claude-sonnet-4", providerId: "anthropic", contextWindow: 200000, imageInput: true },
      { id: "gpt-5", providerId: "openai", contextWindow: null, imageInput: null },
      { id: "legacy-string", providerId: "", contextWindow: null, imageInput: null },
    ]);
    expect(listing.current).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4" });
  });

  it("tolerates an absent or shapeless response", () => {
    expect(normalizeModelList(null).models).toEqual([]);
    expect(normalizeModelList({ models: "nope" }).current).toBe(null);
  });
});

describe("groupModelsByProvider", () => {
  it("groups in first-seen order and names providers", () => {
    const groups = groupModelsByProvider(
      [
        { id: "a1", providerId: "anthropic" },
        { id: "o1", providerId: "openai" },
        { id: "a2", providerId: "anthropic" },
        { id: "flat", providerId: "" },
      ],
      { anthropic: "Anthropic" },
    );
    expect(groups.map((group) => group.name)).toEqual(["Anthropic", "Openai", "Provider"]);
    expect(groups[0].models.map((model) => model.id)).toEqual(["a1", "a2"]);
  });
});

describe("providerName", () => {
  it("title-cases dashed ids and prefers known names", () => {
    expect(providerName("deepseek")).toBe("Deepseek");
    expect(providerName("zai-coding", { "zai-coding": "Z.ai Coding" })).toBe("Z.ai Coding");
    expect(providerName("")).toBe("Provider");
  });
});

describe("formatContextWindow", () => {
  it("formats thousands and millions", () => {
    expect(formatContextWindow(128000)).toBe("128K ctx");
    expect(formatContextWindow(1000000)).toBe("1M ctx");
    expect(formatContextWindow(1500000)).toBe("1.5M ctx");
    expect(formatContextWindow(null)).toBe("");
    expect(formatContextWindow(0)).toBe("");
  });
});

describe("findModelOption", () => {
  const options = [
    { id: "claude-sonnet-4", providerId: "anthropic" },
    { id: "gpt-5", providerId: "openai" },
  ];
  it("matches exactly first, then by substring", () => {
    expect(findModelOption(options, "gpt-5").providerId).toBe("openai");
    expect(findModelOption(options, "sonnet").id).toBe("claude-sonnet-4");
  });
  it("returns null for unknown or empty names", () => {
    expect(findModelOption(options, "")).toBe(null);
    expect(findModelOption(options, "nope")).toBe(null);
  });
});
