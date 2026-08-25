import { themeOptions } from "./theme.js";

export function createThemeMenuState() {
  const items = themeOptions();
  let selected = Math.max(0, items.findIndex((item) => item.current));
  return {
    items() {
      return items;
    },
    selectedIndex() {
      return selected;
    },
    selectedTheme() {
      return items[selected] || null;
    },
    handleKey(key = {}) {
      if (!items.length) {
        return false;
      }
      if (key.name === "up") {
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        return true;
      }
      if (key.name === "down") {
        selected = selected >= items.length - 1 ? 0 : selected + 1;
        return true;
      }
      return false;
    },
  };
}
