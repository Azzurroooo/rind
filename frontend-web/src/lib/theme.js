// Theme selection (audit #11): dark is the shipped default; light is an
// independently tuned token set (not an inversion) applied via
// `data-theme` on <html>. The choice persists in localStorage — it is a
// presentation preference, not a credential (credentials stay in
// sessionStorage per ticket.js).
export const THEME_KEY = "rind.theme";
export const THEMES = ["dark", "light"];

export function readStoredTheme(storage = safeLocalStorage()) {
  const value = String(storage?.getItem(THEME_KEY) || "").trim().toLowerCase();
  return THEMES.includes(value) ? value : "";
}

// No stored choice → follow the OS preference once; the first explicit toggle
// persists from then on.
export function initialTheme(storage = safeLocalStorage(), matchMedia = defaultMatchMedia) {
  const stored = readStoredTheme(storage);
  if (stored) return stored;
  try {
    return matchMedia("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme) {
  const clean = THEMES.includes(theme) ? theme : "dark";
  try {
    document.documentElement.dataset.theme = clean;
  } catch {
    // no document (SSR/tests without DOM): nothing to mutate
  }
  return clean;
}

export function storeTheme(theme, storage = safeLocalStorage()) {
  const clean = THEMES.includes(theme) ? theme : "";
  try {
    if (clean) storage.setItem(THEME_KEY, clean);
    else storage.removeItem(THEME_KEY);
  } catch {
    // storage unavailable (private mode): theme still applies for this page
  }
  return clean;
}

export function toggleTheme(theme) {
  return theme === "light" ? "dark" : "light";
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultMatchMedia(query) {
  try {
    return window.matchMedia?.(query);
  } catch {
    return null;
  }
}

// v2 adds an explicit "system" preference (spec section 1): nothing pinned on
// <html>, so the tokens follow prefers-color-scheme live. "dark" and "light"
// still pin a palette exactly as before.
export const THEME_SYSTEM = "system";
export const THEME_PREFERENCES = [THEME_SYSTEM, ...THEMES];

export function readThemePreference(storage = safeLocalStorage()) {
  return readStoredTheme(storage) || THEME_SYSTEM;
}

export function resolveTheme(preference, matchMedia = defaultMatchMedia) {
  if (THEMES.includes(preference)) return preference;
  try {
    return matchMedia("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyThemePreference(preference, storage = safeLocalStorage()) {
  if (THEMES.includes(preference)) {
    storeTheme(preference, storage);
    return applyTheme(preference);
  }
  storeTheme("", storage);
  try {
    delete document.documentElement.dataset.theme;
  } catch {
    // no document: nothing to clear
  }
  return THEME_SYSTEM;
}

// Subscribe to OS scheme changes; returns an unsubscribe function.
export function watchSystemTheme(onChange, matchMedia = defaultMatchMedia) {
  let query = null;
  try {
    query = matchMedia("(prefers-color-scheme: dark)");
  } catch {
    query = null;
  }
  if (!query?.addEventListener) return () => {};
  const listener = (event) => onChange(event.matches ? "dark" : "light");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
