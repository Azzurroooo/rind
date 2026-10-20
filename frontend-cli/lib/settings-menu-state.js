// Two-level /settings menu state:
// - Root level: "Brief output" (global toggle) and "Skill imports" (submenu).
// - Submenu level ("import"): Claude and Codex skill layers checklist.
export function createSettingsMenuState({ brief = false, sources = [], initialLevel = "root" } = {}) {
  const initialBrief = Boolean(brief);
  let briefEnabled = initialBrief;
  const importItems = (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    chosen: Boolean(source.enabled),
  }));
  let level = initialLevel === "import" && importItems.length ? "import" : "root";
  let rootIndex = level === "import" ? 1 : 0;
  let importIndex = 0;

  function briefChanged() {
    return briefEnabled !== initialBrief;
  }

  function importChanged() {
    return importItems.some((item) => item.chosen !== Boolean(item.enabled));
  }

  function changed() {
    return briefChanged() || importChanged();
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
    return [
      {
        id: "brief",
        label: "Brief output",
        value: briefEnabled ? "on" : "off",
        enabled: briefEnabled,
        description: "Collapse consecutive tool calls into one live line",
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
    if (key?.name === "up") {
      rootIndex = (rootIndex - 1 + 2) % 2;
      return "redraw";
    }
    if (key?.name === "down") {
      rootIndex = (rootIndex + 1) % 2;
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
      rootIndex = 1;
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      if (changed()) return "submit";
      level = "root";
      rootIndex = 1;
      return "redraw";
    }
    return null;
  }

  return {
    level: () => level,
    items: () => (level === "import" ? importItems : rootItems()),
    selectedIndex: () => (level === "import" ? importIndex : rootIndex),
    briefChanged,
    importChanged,
    changed,
    importChoices,
    value: () => ({
      brief: briefEnabled,
      briefChanged: briefChanged(),
      importChoices: importChoices(),
    }),
    handleKey(key) {
      return level === "import" ? handleImportKey(key) : handleRootKey(key);
    },
  };
}
