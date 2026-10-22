import { demoInfo, EFFORTS, MODELS, SETTINGS_ROOT_ITEMS } from "./demo.js";
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
        "/model and /effort switch the active selection or save folder and global defaults.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      type("/model", [
        "Open the model deck with /model, or switch directly with /model set <name>.",
      ]),
      submit(),
      menu({
        kind: "model",
        input: "/model",
        items: MODELS,
        selected: 1,
        target: 3,
      }, [
        "↑↓ moves through the deck (image support is shown next to each model). With GPT-6-Astra selected,",
        "press Enter for this session, f for the folder default, g for the global default, or Esc to cancel.",
      ]),
      note([
        "↑↓ moves through the deck (image support is shown next to each model). With GPT-6-Astra selected,",
        "press Enter for this session, f for the folder default, g for the global default, or Esc to cancel.",
      ]),
      closeMenu("Enter"),
      info({ model: "GPT-6-Astra", reasoning_effort: "xhigh" }),
      slashResult({ text: "Model changed to GPT-6-Astra (session only)" }, [
        "A concise system notice confirms the new model and scope without echoing the menu command.",
      ]),
      type("/effort", [
        "Open the reasoning effort picker with /effort, or pass a level directly (/effort xhigh).",
      ]),
      submit(),
      menu({
        kind: "model",
        input: "/effort",
        items: EFFORTS,
        selected: 2,
        target: 3,
      }, [
        "Choose xhigh with ↑↓. Just like /model, press Enter for this session,",
        "f for the folder default, or g for the global default.",
      ]),
      closeMenu("Enter"),
      info({ reasoning_effort: "xhigh" }),
      slashResult({ text: "Reasoning effort set to xhigh (session only)" }),
      note([
        "Try /model or /effort between turns; press f in the menu for a folder default or g for a global default.",
        "Ctrl+T cycles only this conversation's effort. Models and effort levels depend on your connection.",
      ]),
    ],
  },
  {
    id: "model.theme",
    feature: "/settings theme",
    title: "Themes & settings",
    steps: [
      note([
        "Four Catppuccin flavors plus Rind's website-inspired greens.",
        "Markdown, tables and tool blocks all recolor instantly.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      type("/settings", [
        "Run /settings for brief output, theme, working spinner and skill imports, or /settings theme directly.",
      ]),
      submit(),
      menu({
        kind: "settings",
        input: "/settings",
        level: "root",
        items: SETTINGS_ROOT_ITEMS,
        selected: 0,
        target: 1,
      }, [
        "/settings groups visual and output preferences in one menu. Select Theme and press Enter.",
      ]),
      menu({
        kind: "theme",
        input: "/settings theme",
        items: themeOptions(),
        selected: 3,
        target: 0,
      }, [
        "Each row previews the flavor's palette. The demo highlights Latte — Enter applies it",
        "and replays the transcript in the new colors (Esc cancels; NO_COLOR disables color).",
      ]),
      note([
        "Each row previews the flavor's palette. The demo highlights Latte — Enter applies it",
        "and replays the transcript in the new colors (Esc cancels; NO_COLOR disables color).",
      ]),
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
        "Try /settings to choose a palette, toggle brief output, or customize the working spinner.",
      ]),
    ],
  },
];
