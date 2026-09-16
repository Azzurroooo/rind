import { demoInfo, MODELS } from "./demo.js";
import { menu, note, result, shell, slashResult, startup, submit, type } from "./steps.js";
import { themeOptions } from "../../theme.js";

export const modelPages = [
  {
    id: "model.pick",
    title: "Model and effort",
    steps: [
      note([
        "Rind speaks any OpenAI-compatible endpoint. /model lists what your",
        "providers expose; the deck groups models per provider.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      menu({
        kind: "model",
        input: "/model",
        items: MODELS,
        selected: 1,
        target: 2,
      }, [
        "↑↓ moves through the deck, enter switches. The current model is",
        "marked; /model set <name> works without the menu too.",
      ]),
      result("Model switched", "zai/glm-4.6"),
      type("/effort high"),
      submit(),
      result("Reasoning effort: high", "low · medium · high · xhigh · max"),
      note([
        "Effort scales how hard the model thinks per turn. ctrl+t cycles it",
        "without leaving the composer.",
      ]),
    ],
  },
  {
    id: "model.theme",
    title: "Themes",
    steps: [
      note([
        "Four Catppuccin flavors, applied instantly — markdown, tables and",
        "tool blocks all recolor together.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      menu({
        kind: "theme",
        input: "/theme",
        items: themeOptions(),
        selected: 3,
        target: 0,
      }, [
        "Each row previews the flavor's palette. enter applies it and the",
        "whole transcript replays in the new colors.",
      ]),
      slashResult({
        text: "Theme: latte",
        display: {
          type: "theme",
          changed: true,
          previous: "mocha",
          current: "latte",
          flavors: themeOptions(),
        },
      }),
      note([
        "This tour keeps its own theme, but in a session the choice persists",
        "across restarts via /theme latte | frappe | macchiato | mocha.",
      ]),
    ],
  },
];
