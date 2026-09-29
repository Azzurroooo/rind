import { describe, expect, it } from "vitest";
import { COMPOSER_ACTIONS as A, composerKeyAction, slashQuery } from "./composerKeys.js";

const key = (name, mods = {}) => ({ key: name, ...mods });

describe("composerKeys — send, queue and steer", () => {
  it("Enter sends when idle and queues a follow-up while running", () => {
    expect(composerKeyAction(key("Enter"), { active: false })).toBe(A.send);
    expect(composerKeyAction(key("Enter"), { active: true })).toBe(A.followUp);
  });

  it("Alt+Enter steers while running and sends when idle", () => {
    expect(composerKeyAction(key("Enter", { altKey: true }), { active: true })).toBe(A.steer);
    expect(composerKeyAction(key("Enter", { altKey: true }), { active: false })).toBe(A.send);
  });

  it("Shift+Enter is a newline and IME composition never acts", () => {
    expect(composerKeyAction(key("Enter", { shiftKey: true }), {})).toBe(A.none);
    expect(composerKeyAction(key("Enter", { isComposing: true }), {})).toBe(A.none);
    expect(composerKeyAction(key("Enter", { nativeEvent: { isComposing: true } }), {})).toBe(A.none);
    expect(composerKeyAction(key("Enter", { keyCode: 229 }), {})).toBe(A.none);
  });
});

describe("composerKeys — recall", () => {
  it("ArrowUp recalls only when the composer is empty and a prompt exists", () => {
    expect(composerKeyAction(key("ArrowUp"), { value: "", lastPrompt: "hi" })).toBe(A.recall);
    expect(composerKeyAction(key("ArrowUp"), { value: "draft", lastPrompt: "hi" })).toBe(A.none);
    expect(composerKeyAction(key("ArrowUp"), { value: "", lastPrompt: "" })).toBe(A.none);
    expect(composerKeyAction(key("ArrowUp", { shiftKey: true }), { value: "", lastPrompt: "hi" })).toBe(A.none);
  });
});

describe("composerKeys — slash menu", () => {
  const open = { menuOpen: true, value: "/mo", active: true, lastPrompt: "x" };
  it("navigates, accepts and closes while open", () => {
    expect(composerKeyAction(key("ArrowDown"), open)).toBe(A.menuNext);
    expect(composerKeyAction(key("ArrowUp"), open)).toBe(A.menuPrev);
    expect(composerKeyAction(key("Enter"), open)).toBe(A.menuAccept);
    expect(composerKeyAction(key("Tab"), open)).toBe(A.menuAccept);
    expect(composerKeyAction(key("Escape"), open)).toBe(A.menuClose);
  });

  it("computes the slash query only for the first token", () => {
    expect(slashQuery("/Mo")).toBe("mo");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/model gpt")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });
});
