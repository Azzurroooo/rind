import { describe, expect, it, vi } from "vitest";
import {
  applyThemePreference, readThemePreference, resolveTheme, THEME_KEY, THEME_PREFERENCES, watchSystemTheme,
} from "./theme.js";

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    data,
  };
}

describe("theme preference — system | dark | light", () => {
  it("lists system first and reads system when nothing is stored", () => {
    expect(THEME_PREFERENCES).toEqual(["system", "dark", "light"]);
    expect(readThemePreference(fakeStorage())).toBe("system");
    expect(readThemePreference(fakeStorage({ [THEME_KEY]: "light" }))).toBe("light");
  });

  it("resolves system through prefers-color-scheme and keeps pinned values", () => {
    const dark = () => ({ matches: true });
    const light = () => ({ matches: false });
    expect(resolveTheme("system", dark)).toBe("dark");
    expect(resolveTheme("system", light)).toBe("light");
    expect(resolveTheme("light", dark)).toBe("light");
    expect(resolveTheme("system", () => { throw new Error("no media"); })).toBe("light");
  });

  it("pins explicit themes and clears data-theme and storage for system", () => {
    const storage = fakeStorage();
    applyThemePreference("dark", storage);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storage.data[THEME_KEY]).toBe("dark");
    expect(applyThemePreference("system", storage)).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(storage.data[THEME_KEY]).toBeUndefined();
  });

  it("notifies OS scheme changes and unsubscribes", () => {
    const listeners = new Set();
    const query = {
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    const onChange = vi.fn();
    const stop = watchSystemTheme(onChange, () => query);
    listeners.forEach((fn) => fn({ matches: true }));
    expect(onChange).toHaveBeenCalledWith("dark");
    stop();
    expect(listeners.size).toBe(0);
    expect(typeof watchSystemTheme(onChange, () => null)).toBe("function");
  });
});
