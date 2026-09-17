import { demoInfo, MODELS } from "./demo.js";
import { closeMenu, info, menu, note, shell, slashResult, startup, submit, type } from "./steps.js";
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
      type("/model"),
      submit(),
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
      note(["The demo selected glm-4.6. In Rind, press Enter to use the selected model, or Esc to keep the current one."]),
      closeMenu("Enter"),
      info({ model: "zai/glm-4.6" }),
      slashResult({ text: "Model switched to zai/glm-4.6" }),
      type("/effort high"),
      submit(),
      info({ reasoning_effort: "high" }),
      slashResult({ text: "Reasoning effort: high" }),
      note([
        "Try /model or /effort high between turns. Ctrl+T cycles reasoning effort.",
        "Available models and supported effort levels depend on your provider.",
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
      type("/theme"),
      submit(),
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
      note(["The demo highlights Latte. In Rind, Enter applies a flavor and Esc cancels. Colors depend on terminal support; NO_COLOR disables them."]),
      closeMenu("Enter"),
      info({ theme: "latte" }),
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
        "This demo previews Latte without saving it. Your original theme returns when you leave this page.",
        "Try /theme latte, frappe, macchiato or mocha in Rind to save your preference.",
      ]),
    ],
  },
];
