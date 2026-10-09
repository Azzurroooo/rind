import { demoInfo, MODELS } from "./demo.js";
import { closeMenu, info, menu, note, shell, slashResult, startup, submit, type } from "./steps.js";
import { themeOptions } from "../../theme.js";

export const modelPages = [
  {
    id: "model.pick",
    feature: "/model /effort",
    title: "Model and effort",
    steps: [
      note([
        "Use built-in providers or a named OpenAI-compatible endpoint.",
        "/model groups the available models by connection.",
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
      menu({ kind: "auth-choice", title: "Also the default for new conversations in this folder?", options: ["No · only this conversation", "Yes · new conversations here start with zai / glm-4.6"], selected: 0 },
        "The model changes in this conversation first. You can also save it as this folder's default for new conversations and agent tasks."),
      closeMenu("Enter"),
      type("/effort high"),
      submit(),
      info({ reasoning_effort: "high" }),
      slashResult({ text: "Reasoning effort: high" }),
      note([
        "Try /model or /effort high between turns; both can offer folder defaults.",
        "Ctrl+T cycles only this conversation's effort. Models and effort levels depend on your connection.",
      ]),
    ],
  },
  {
    id: "model.theme",
    feature: "/theme",
    title: "Themes",
    steps: [
      note([
        "Four Catppuccin flavors plus Rind's website-inspired greens.",
        "Markdown, tables and tool blocks all recolor instantly.",
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
          previous: "catppuccin-mocha",
          current: "latte",
          flavors: themeOptions(),
        },
      }),
      note([
        "This demo previews Latte without saving it. Your original theme returns when you leave this page.",
        "Try /theme to choose and save a palette. /theme pistachio brings the website's colors to dark terminals.",
      ]),
    ],
  },
];
