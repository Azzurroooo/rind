import { useCallback, useEffect, useState } from "react";
import { THEME_PREFERENCES, THEME_SYSTEM, applyThemePreference, readThemePreference, resolveTheme, toggleTheme, watchSystemTheme } from "../lib/theme.js";

// Theme preference: "system" follows prefers-color-scheme live; "light" and
// "dark" pin the palette. `resolved` is what is on screen right now.
export function useThemeState() {
  const [preference, setPreference] = useState(() => readThemePreference());
  const [resolved, setResolved] = useState(() => resolveTheme(readThemePreference()));

  useEffect(() => {
    applyThemePreference(preference);
    setResolved(resolveTheme(preference));
    if (preference !== THEME_SYSTEM) return undefined;
    return watchSystemTheme((next) => setResolved(next));
  }, [preference]);

  const set = useCallback((value) => {
    if (THEME_PREFERENCES.includes(value)) setPreference(value);
  }, []);

  // Toggle flips what is visible, so from "system" it pins the opposite.
  const toggle = useCallback(() => {
    setPreference((current) => toggleTheme(resolveTheme(current)));
  }, []);

  return { preference, resolved, set, toggle };
}
