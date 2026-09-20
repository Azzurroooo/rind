// Single source of truth for CLI colors: palettes mapped to a
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
  dracula: {
    label: "Dracula",
    accent: "#bd93f9",
    success: "#50fa7b",
    danger: "#ff5555",
    warning: "#f1fa8c",
    notice: "#ff79c6",
    path: "#8be9fd",
    code: "#ffb86c",
    fence: "#6272a4",
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    accent: "#83a598",
    success: "#b8bb26",
    danger: "#fb4934",
    warning: "#fabd2f",
    notice: "#d3869b",
    path: "#8ec07c",
    code: "#fe8019",
    fence: "#928374",
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
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
  "solarized-dark": {
    label: "Solarized Dark",
    accent: "#268bd2",
    success: "#859900",
    danger: "#dc322f",
    warning: "#b58900",
    notice: "#6c71c4",
    path: "#2aa198",
    code: "#cb4b16",
    fence: "#586e75",
  },
  "rose-pine": {
    label: "Rose Pine",
    accent: "#c4a7e7",
    success: "#9ccfd8",
    danger: "#eb6f92",
    warning: "#f6c177",
    notice: "#ebbcba",
    path: "#9ccfd8",
    code: "#ebbcba",
    fence: "#908caa",
  },
  "everforest-dark-medium": {
    label: "Everforest Dark Medium",
    accent: "#7fbbb3",
    success: "#a7c080",
    danger: "#e67e80",
    warning: "#dbbc7f",
    notice: "#d699b6",
    path: "#83c092",
    code: "#e69875",
    fence: "#859289",
  },
  pistachio: {
    label: "Pistachio",
    accent: "#d6df9a",
    success: "#a8bf96",
    danger: "#df9b87",
    warning: "#d8bd83",
    notice: "#ebeee4",
    path: "#a7c4b5",
    code: "#d3b59c",
    fence: "#a5b0a4",
  },
};

export const DEFAULT_THEME = "catppuccin-mocha";

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
  const requested = String(name || "").trim().toLowerCase();
  // Preserve saved selections made before the palette was renamed.
  const key = requested === "rind" ? "pistachio" : requested;
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
// theme: one narrow cell per semantic color role.
const SWATCH_ORDER = ["danger", "code", "warning", "success", "fence", "path", "accent", "notice"];

export function flavorSwatch(name) {
  const flavor = FLAVORS[String(name || "").trim().toLowerCase()];
  if (!flavor) {
    return "";
  }
  return SWATCH_ORDER.map((role) => wrap(truecolor(flavor[role]), "█", true)).join("");
}
