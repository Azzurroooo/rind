import { describe, expect, it } from "vitest";
import { applyTheme, initialTheme, readStoredTheme, storeTheme, THEME_KEY, THEMES, toggleTheme } from "./theme.js";

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    data,
  };
}

describe("theme — persisted choice (audit #11)", () => {
  it("stores and reads a valid theme; invalid values read as empty", () => {
    const storage = fakeStorage();
    expect(storeTheme("light", storage)).toBe("light");
    expect(storage.data[THEME_KEY]).toBe("light");
    expect(readStoredTheme(storage)).toBe("light");
    storeTheme("neon", storage);
    expect(readStoredTheme(storage)).toBe("");
    storeTheme("dark", storage);
    expect(readStoredTheme(storage)).toBe("dark");
  });

  it("initialTheme prefers the stored choice, then the OS preference, then dark", () => {
    expect(initialTheme(fakeStorage({ [THEME_KEY]: "light" }), () => ({ matches: false }))).toBe("light");
    expect(initialTheme(fakeStorage(), () => ({ matches: true }))).toBe("light");
    expect(initialTheme(fakeStorage(), () => ({ matches: false }))).toBe("dark");
    expect(initialTheme(fakeStorage(), () => { throw new Error("no matchMedia"); })).toBe("dark");
  });

  it("applyTheme sets data-theme on <html> and normalizes unknown values", () => {
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("unknown");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("toggleTheme flips between the two supported themes", () => {
    expect(toggleTheme("dark")).toBe("light");
    expect(toggleTheme("light")).toBe("dark");
    expect(THEMES).toEqual(["dark", "light"]);
  });
});
