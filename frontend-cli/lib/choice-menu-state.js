export function createChoiceMenuState(options, recommended = "") {
  const items = normalizeOptions(options);
  let selected = items.indexOf(recommended);
  if (selected < 0) {
    selected = 0;
  }
  return {
    options() {
      return items;
    },
    selectedIndex() {
      return selected;
    },
    selectedOption() {
      return items[selected] || "";
    },
    handleKey(key = {}) {
      if (!items.length) {
        return false;
      }
      if (key.name === "up" || key.text === "k") {
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        return true;
      }
      if (key.name === "down" || key.text === "j") {
        selected = selected >= items.length - 1 ? 0 : selected + 1;
        return true;
      }
      return false;
    },
  };
}

function normalizeOptions(options) {
  const seen = new Set();
  const items = [];
  for (const option of Array.isArray(options) ? options : []) {
    const value = String(option || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    items.push(value);
  }
  return items;
}
