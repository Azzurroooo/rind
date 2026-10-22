import { themeOptions } from "./theme.js";
import { concurrentRunOptions, spinnerOptions } from "./cli-state-store.js";

const ROOT_LEVELS = ["brief", "theme", "spinner", "concurrency", "import"];

function briefOptions(enabled) {
  const active = Boolean(enabled);
  return [
    {
      name: "off",
      label: "Off",
      description: "Show each tool call in full",
      current: !active,
    },
    {
      name: "on",
      label: "On",
      description: "Collapse consecutive tool calls into one live line",
      current: active,
    },
  ];
}

function createChoiceSubmenu(rawItems) {
  const items = rawItems.map((item) => ({ ...item }));
  const initialIndex = Math.max(0, items.findIndex((item) => item.current));
  const initial = items[initialIndex]?.name || "";
  let chosen = initial;
  let index = initialIndex;

  return {
    items: () => items,
    index: () => index,
    selected: () => items[index] || null,
    chosen: () => chosen,
    chosenLabel: () => items.find((item) => item.name === chosen)?.label || chosen || "default",
    changed: () => Boolean(chosen && chosen !== initial),
    open() {
      index = Math.max(0, items.findIndex((item) => item.name === chosen));
    },
    revert() {
      index = Math.max(0, items.findIndex((item) => item.name === chosen));
    },
    move(delta) {
      index = (index + delta + items.length) % items.length;
    },
    commit() {
      chosen = items[index]?.name || initial;
      for (const item of items) {
        item.current = item.name === chosen;
      }
    },
  };
}

// Two-level /settings menu state:
// - Root level: "Brief output", "Theme", "Working spinner", "Max concurrent runs", and "Skill imports".
// - Single-choice submenus: Enter applies, Esc returns to root.
// - "import" submenu: multi-select checklist (Space toggles, Enter applies, Esc reverts & returns to root).
export function createSettingsMenuState({ brief = false, sources = [], initialLevel = "root" } = {}) {
  const submenus = {
    brief: createChoiceSubmenu(briefOptions(brief)),
    theme: createChoiceSubmenu(themeOptions()),
    spinner: createChoiceSubmenu(spinnerOptions()),
    concurrency: createChoiceSubmenu(concurrentRunOptions()),
  };

  const importItems = (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    chosen: Boolean(source.enabled),
  }));

  let level = "root";
  let rootIndex = 0;
  if (initialLevel in submenus && submenus[initialLevel].items().length) {
    level = initialLevel;
    rootIndex = ROOT_LEVELS.indexOf(initialLevel);
  } else if (initialLevel === "import" && importItems.length) {
    level = "import";
    rootIndex = ROOT_LEVELS.indexOf("import");
  }
  let importIndex = 0;

  const briefChanged = () => submenus.brief.changed();
  const themeChanged = () => submenus.theme.changed();
  const spinnerChanged = () => submenus.spinner.changed();
  const concurrencyChanged = () => submenus.concurrency.changed();
  const importChanged = () => importItems.some((item) => item.chosen !== Boolean(item.enabled));
  const changed = () => briefChanged() || themeChanged() || spinnerChanged() || concurrencyChanged() || importChanged();

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
        value: `${submenus.brief.chosen()} ›`,
        description: "Collapse consecutive tool calls into one live line",
      },
      {
        id: "theme",
        label: "Theme",
        value: `${submenus.theme.chosenLabel()} ›`,
        description: "Switch the CLI color theme",
      },
      {
        id: "spinner",
        label: "Working spinner",
        value: `${submenus.spinner.chosenLabel()} ›`,
        description: "Choose the working activity animation",
      },
      {
        id: "concurrency",
        label: "Concurrent runs",
        value: `${submenus.concurrency.chosenLabel()} ›`,
        description: "Set the global parallel agent run limit",
      },
      {
        id: "import",
        label: "Skill imports",
        value: importValue,
        description: "Choose the Claude and Codex skills this conversation reads",
      },
    ];
  }

  function handleRootKey(key) {
    const count = ROOT_LEVELS.length;
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
    if (key?.name === "enter" || key?.name === "return" || key?.text === " " || key?.name === "right") {
      const target = ROOT_LEVELS[rootIndex];
      if (target === "import") {
        if (importItems.length) {
          level = "import";
          importIndex = 0;
          return "redraw";
        }
        return changed() ? "submit" : "cancel";
      }
      const sub = submenus[target];
      if (sub?.items().length) {
        sub.open();
        level = target;
        return "redraw";
      }
      return changed() ? "submit" : "cancel";
    }
    return null;
  }

  function handleChoiceSubmenuKey(subName, key) {
    const sub = submenus[subName];
    if (!sub?.items().length) {
      level = "root";
      return "redraw";
    }
    if (key?.name === "up") {
      sub.move(-1);
      return "redraw";
    }
    if (key?.name === "down") {
      sub.move(1);
      return "redraw";
    }
    if (key?.name === "escape" || key?.name === "left" || key?.name === "backspace") {
      sub.revert();
      rootIndex = ROOT_LEVELS.indexOf(subName);
      level = "root";
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      sub.commit();
      if (changed()) return "submit";
      rootIndex = ROOT_LEVELS.indexOf(subName);
      level = "root";
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
      rootIndex = ROOT_LEVELS.indexOf("import");
      level = "root";
      return "redraw";
    }
    if (key?.name === "enter" || key?.name === "return") {
      if (changed()) return "submit";
      rootIndex = ROOT_LEVELS.indexOf("import");
      level = "root";
      return "redraw";
    }
    return null;
  }

  return {
    level: () => level,
    items: () => {
      if (level in submenus) return submenus[level].items();
      if (level === "import") return importItems;
      return rootItems();
    },
    selectedIndex: () => {
      if (level in submenus) return submenus[level].index();
      if (level === "import") return importIndex;
      return rootIndex;
    },
    selectedBrief: () => submenus.brief.selected(),
    selectedTheme: () => submenus.theme.selected(),
    selectedSpinner: () => submenus.spinner.selected(),
    selectedConcurrency: () => submenus.concurrency.selected(),
    briefChanged,
    themeChanged,
    spinnerChanged,
    concurrencyChanged,
    importChanged,
    changed,
    importChoices,
    value: () => ({
      brief: submenus.brief.chosen() === "on",
      briefChanged: briefChanged(),
      theme: submenus.theme.chosen(),
      themeChanged: themeChanged(),
      spinner: submenus.spinner.chosen(),
      spinnerChanged: spinnerChanged(),
      concurrency: Number(submenus.concurrency.chosen()),
      concurrencyChanged: concurrencyChanged(),
      importChoices: importChoices(),
    }),
    handleKey(key) {
      if (level in submenus) return handleChoiceSubmenuKey(level, key);
      if (level === "import") return handleImportKey(key);
      return handleRootKey(key);
    },
  };
}
