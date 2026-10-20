import { themeOptions } from "./theme.js";

// Two-level /settings menu state:
// - Root level: "Brief output" (global toggle), "Theme" (submenu), and "Skill imports" (submenu).
// - "theme" submenu: CLI color theme selector with live swatches.
// - "import" submenu: Claude and Codex skill layers checklist.
export function createSettingsMenuState({ brief = false, sources = [], initialLevel = "root" } = {}) {
  const initialBrief = Boolean(brief);
  let briefEnabled = initialBrief;

  const themeItems = themeOptions().map((item) => ({ ...item }));
  const initialThemeIndex = Math.max(0, themeItems.findIndex((item) => item.current));
  const initialTheme = themeItems[initialThemeIndex]?.name || "";
  let chosenTheme = initialTheme;
  let themeIndex = initialThemeIndex;

  const importItems = (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    chosen: Boolean(source.enabled),
  }));

  let level = "root";
  let rootIndex = 0;
  if (initialLevel === "theme" && themeItems.length) {
    level = "theme";
    rootIndex = 1;
  } else if (initialLevel === "import" && importItems.length) {
    level = "import";
    rootIndex = 2;
  }
  let importIndex = 0;

  function briefChanged() {
    return briefEnabled !== initialBrief;
  }

  function themeChanged() {
    return Boolean(chosenTheme && chosenTheme !== initialTheme);
  }

  function importChanged() {
    return importItems.some((item) => item.chosen !== Boolean(item.enabled));
  }

  function changed() {
    return briefChanged() || themeChanged() || importChanged();
  }

  function importChoices() {
    return Object.fromEntries(
      importItems
        .filter((item) => item.chosen !== Boolean(item.enabled))
        .map((item) => [item.id, item.chosen]),
    );
  }

  function rootItems() {
    const enabledCount = importItems.filter((item) => item.chosen).length;
    const importValue = importItems.length
      ? `${enabledCount} of ${importItems.length} on ›`
      : "none";
    const themeLabel = themeItems.find((item) => item.name === chosenTheme)?.label || chosenTheme || "default";
    const themeValue = `${themeLabel} ›`;
    return [
      {
        id: "brief",
        label: "Brief output",
        value: briefEnabled ? "on" : "off",
        enabled: briefEnabled,
        description: "Collapse consecutive tool calls into one live line",
      },
      {
        id: "theme",
        label: "Theme",
        value: themeValue,
        submenu: true,
        description: "Switch the CLI color theme",
      },
      {
        id: "import",
        label: "Skill imports",
        value: importValue,
        submenu: true,
        description: "Choose the Claude and Codex skills this conversation reads",
      },
    ];
  }

  function handleRootKey(key) {
    const count = 3;
    if (key?.name === "up") {
      rootIndex = (rootIndex - 1 + count) % count;
      return "redraw";
    }
    if (key?.name === "down") {
      rootIndex = (rootIndex + 1) % count;
      return "redraw";
    }
    if (key?.name === "escape") {
      return "cancel";
    }
    if (rootIndex === 0) {
      if (key?.text === " " || key?.name === "left" || key?.name === "right") {
        briefEnabled = !briefEnabled;
        return "redraw";
      }
      if (key?.name === "enter" || key?.name === "return") {
        if (changed()) return "submit";
        briefEnabled = !briefEnabled;
        return "redraw";
      }
      return null;
    }
    if (rootIndex === 1) {
      if (key?.name === "enter" || key?.name === "return" || key?.text === " " || key?.name === "right") {
        if (themeItems.length) {
          level = "theme";
          themeIndex = Math.max(0, themeItems.findIndex((item) => item.name === chosenTheme));
          return "redraw";
        }
        return changed() ? "submit" : "cancel";
      }
      return null;
    }
    if (key?.name === "enter" || key?.name === "return" || key?.text === " " || key?.name === "right") {
      if (importItems.length) {
        level = "import";
        importIndex = 0;
        return "redraw";
      }
      return changed() ? "submit" : "cancel";
    }
    return null;
  }

  function handleThemeKey(key) {
    if (!themeItems.length) {
      level = "root";
      return "redraw";
    }
    if (key?.name === "up") {
      themeIndex = (themeIndex - 1 + themeItems.length) % themeItems.length;
      return "redraw";
    }
    if (key?.name === "down") {
      themeIndex = (themeIndex + 1) % themeItems.length;
      return "redraw";
    }
    if (key?.name === "escape" || key?.name === "left" || key?.name === "backspace") {
      themeIndex = Math.max(0, themeItems.findIndex((item) => item.name === chosenTheme));
      level = "root";
      rootIndex = 1;
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      const picked = themeItems[themeIndex]?.name || initialTheme;
      chosenTheme = picked;
      for (const item of themeItems) {
        item.current = item.name === chosenTheme;
      }
      if (changed()) return "submit";
      level = "root";
      rootIndex = 1;
      return "redraw";
    }
    return null;
  }

  function handleImportKey(key) {
    if (!importItems.length) {
      level = "root";
      return "redraw";
    }
    if (key?.name === "up") {
      importIndex = (importIndex - 1 + importItems.length) % importItems.length;
      return "redraw";
    }
    if (key?.name === "down") {
      importIndex = (importIndex + 1) % importItems.length;
      return "redraw";
    }
    if (key?.text === " ") {
      importItems[importIndex].chosen = !importItems[importIndex].chosen;
      return "redraw";
    }
    if (key?.name === "escape" || key?.name === "left" || key?.name === "backspace") {
      for (const item of importItems) {
        item.chosen = Boolean(item.enabled);
      }
      level = "root";
      rootIndex = 2;
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      if (changed()) return "submit";
      level = "root";
      rootIndex = 2;
      return "redraw";
    }
    return null;
  }

  return {
    level: () => level,
    items: () => (level === "theme" ? themeItems : level === "import" ? importItems : rootItems()),
    selectedIndex: () => (level === "theme" ? themeIndex : level === "import" ? importIndex : rootIndex),
    selectedTheme: () => themeItems[themeIndex] || null,
    briefChanged,
    themeChanged,
    importChanged,
    changed,
    importChoices,
    value: () => ({
      brief: briefEnabled,
      briefChanged: briefChanged(),
      theme: chosenTheme,
      themeChanged: themeChanged(),
      importChoices: importChoices(),
    }),
    handleKey(key) {
      if (level === "theme") return handleThemeKey(key);
      if (level === "import") return handleImportKey(key);
      return handleRootKey(key);
    },
  };
}
