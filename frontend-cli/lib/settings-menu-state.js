import { themeOptions } from "./theme.js";
import { spinnerOptions } from "./cli-state-store.js";

// Two-level /settings menu state:
// - Root level: "Brief output" (global toggle), "Theme" (submenu), "Working spinner" (submenu), and "Skill imports" (submenu).
// - "theme" submenu: CLI color theme selector with live swatches.
// - "spinner" submenu: Working activity spinner animation selector.
// - "import" submenu: Claude and Codex skill layers checklist.
export function createSettingsMenuState({ brief = false, sources = [], initialLevel = "root" } = {}) {
  const initialBrief = Boolean(brief);
  let briefEnabled = initialBrief;

  const themeItems = themeOptions().map((item) => ({ ...item }));
  const initialThemeIndex = Math.max(0, themeItems.findIndex((item) => item.current));
  const initialTheme = themeItems[initialThemeIndex]?.name || "";
  let chosenTheme = initialTheme;
  let themeIndex = initialThemeIndex;

  const spinnerItems = spinnerOptions().map((item) => ({ ...item }));
  const initialSpinnerIndex = Math.max(0, spinnerItems.findIndex((item) => item.current));
  const initialSpinner = spinnerItems[initialSpinnerIndex]?.name || "";
  let chosenSpinner = initialSpinner;
  let spinnerIndex = initialSpinnerIndex;

  const importItems = (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    chosen: Boolean(source.enabled),
  }));

  let level = "root";
  let rootIndex = 0;
  if (initialLevel === "theme" && themeItems.length) {
    level = "theme";
    rootIndex = 1;
  } else if (initialLevel === "spinner" && spinnerItems.length) {
    level = "spinner";
    rootIndex = 2;
  } else if (initialLevel === "import" && importItems.length) {
    level = "import";
    rootIndex = 3;
  }
  let importIndex = 0;

  function briefChanged() {
    return briefEnabled !== initialBrief;
  }

  function themeChanged() {
    return Boolean(chosenTheme && chosenTheme !== initialTheme);
  }

  function spinnerChanged() {
    return Boolean(chosenSpinner && chosenSpinner !== initialSpinner);
  }

  function importChanged() {
    return importItems.some((item) => item.chosen !== Boolean(item.enabled));
  }

  function changed() {
    return briefChanged() || themeChanged() || spinnerChanged() || importChanged();
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
    const spinnerLabel = spinnerItems.find((item) => item.name === chosenSpinner)?.label || chosenSpinner || "default";
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
        value: `${themeLabel} ›`,
        submenu: true,
        description: "Switch the CLI color theme",
      },
      {
        id: "spinner",
        label: "Working spinner",
        value: `${spinnerLabel} ›`,
        submenu: true,
        description: "Choose the working activity animation",
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
    const count = 4;
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
    if (rootIndex === 2) {
      if (key?.name === "enter" || key?.name === "return" || key?.text === " " || key?.name === "right") {
        if (spinnerItems.length) {
          level = "spinner";
          spinnerIndex = Math.max(0, spinnerItems.findIndex((item) => item.name === chosenSpinner));
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

  function handleSpinnerKey(key) {
    if (!spinnerItems.length) {
      level = "root";
      return "redraw";
    }
    if (key?.name === "up") {
      spinnerIndex = (spinnerIndex - 1 + spinnerItems.length) % spinnerItems.length;
      return "redraw";
    }
    if (key?.name === "down") {
      spinnerIndex = (spinnerIndex + 1) % spinnerItems.length;
      return "redraw";
    }
    if (key?.name === "escape" || key?.name === "left" || key?.name === "backspace") {
      spinnerIndex = Math.max(0, spinnerItems.findIndex((item) => item.name === chosenSpinner));
      level = "root";
      rootIndex = 2;
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      const picked = spinnerItems[spinnerIndex]?.name || initialSpinner;
      chosenSpinner = picked;
      for (const item of spinnerItems) {
        item.current = item.name === chosenSpinner;
      }
      if (changed()) return "submit";
      level = "root";
      rootIndex = 2;
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
      rootIndex = 3;
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      if (changed()) return "submit";
      level = "root";
      rootIndex = 3;
      return "redraw";
    }
    return null;
  }

  return {
    level: () => level,
    items: () => {
      if (level === "theme") return themeItems;
      if (level === "spinner") return spinnerItems;
      if (level === "import") return importItems;
      return rootItems();
    },
    selectedIndex: () => {
      if (level === "theme") return themeIndex;
      if (level === "spinner") return spinnerIndex;
      if (level === "import") return importIndex;
      return rootIndex;
    },
    selectedTheme: () => themeItems[themeIndex] || null,
    selectedSpinner: () => spinnerItems[spinnerIndex] || null,
    briefChanged,
    themeChanged,
    spinnerChanged,
    importChanged,
    changed,
    importChoices,
    value: () => ({
      brief: briefEnabled,
      briefChanged: briefChanged(),
      theme: chosenTheme,
      themeChanged: themeChanged(),
      spinner: chosenSpinner,
      spinnerChanged: spinnerChanged(),
      importChoices: importChoices(),
    }),
    handleKey(key) {
      if (level === "theme") return handleThemeKey(key);
      if (level === "spinner") return handleSpinnerKey(key);
      if (level === "import") return handleImportKey(key);
      return handleRootKey(key);
    },
  };
}
