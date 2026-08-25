// Single source of truth for CLI colors: Catppuccin flavors mapped to a
// handful of semantic roles. Every painter re-evaluates color support on
// each call so runtime toggles (isTTY / NO_COLOR) behave like before.
const FLAVORS = {
  latte: {
    label: "Latte",
    accent: "#1e66f5",
    success: "#40a02b",
    danger: "#d20f39",
    warning: "#df8e1d",
    notice: "#8839ef",
    path: "#209fb5",
    code: "#fe640b",
    fence: "#04a5e5",
    dim: "#6c6f85",
  },
  frappe: {
    label: "Frappé",
    accent: "#8caaee",
    success: "#a6d189",
    danger: "#e78284",
    warning: "#e5c890",
    notice: "#ca9ee6",
    path: "#85c1dc",
    code: "#ef9f76",
    fence: "#99d1db",
    dim: "#a5adce",
  },
  macchiato: {
    label: "Macchiato",
    accent: "#8aadf4",
    success: "#a6da95",
    danger: "#ed8796",
    warning: "#eed49f",
    notice: "#c6a0f6",
    path: "#7dc4e4",
    code: "#f5a97f",
    fence: "#91d7e3",
    dim: "#a5adcb",
  },
  mocha: {
    label: "Mocha",
    accent: "#89b4fa",
    success: "#a6e3a1",
    danger: "#f38ba8",
    warning: "#f9e2af",
    notice: "#cba6f7",
    path: "#74c7ec",
    code: "#fab387",
    fence: "#89dceb",
    dim: "#a6adc8",
  },
};

export const DEFAULT_THEME = "mocha";

let activeName = DEFAULT_THEME;

function enabled() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function truecolor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

function wrap(code, text, force) {
  const body = String(text || "");
  if (!body || (!force && !enabled())) {
    return body;
  }
  return `\x1b[${code}m${body}\x1b[0m`;
}

const ROLE_KEYS = ["accent", "success", "danger", "warning", "notice", "path", "code", "fence"];

// paint: honors isTTY / NO_COLOR. paintRaw: always emits — for callers that
// gate colors themselves (AssistantRenderer's color option, TTY-only blocks).
function buildPainters(force) {
  const painters = {
    dim: (text) => wrap("2", text, force),
    bold: (text) => wrap("1", text, force),
  };
  for (const key of ROLE_KEYS) {
    painters[key] = (text) => wrap(truecolor(FLAVORS[activeName][key]), text, force);
  }
  return painters;
}

export const paint = buildPainters(false);
export const paintRaw = buildPainters(true);

export function themeNames() {
  return Object.keys(FLAVORS);
}

export function currentTheme() {
  const flavor = FLAVORS[activeName];
  return { name: activeName, label: flavor.label };
}

export function setTheme(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!FLAVORS[key]) {
    return null;
  }
  activeName = key;
  return currentTheme();
}

export function resetTheme() {
  activeName = DEFAULT_THEME;
}

export function themeOptions() {
  return Object.entries(FLAVORS).map(([name, flavor]) => ({
    name,
    label: flavor.label,
    current: name === activeName,
  }));
}

// Eight-color preview rendered in the target flavor regardless of active
// theme: one narrow cell per Catppuccin hue family.
const SWATCH_ORDER = ["danger", "code", "warning", "success", "fence", "path", "accent", "notice"];

export function flavorSwatch(name) {
  const flavor = FLAVORS[String(name || "").trim().toLowerCase()];
  if (!flavor) {
    return "";
  }
  return SWATCH_ORDER.map((role) => wrap(truecolor(flavor[role]), "█", true)).join("");
}
