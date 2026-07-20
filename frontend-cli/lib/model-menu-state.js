export function createModelMenuState(models, currentModel = "") {
  const items = normalizeModels(models, currentModel);
  let selected = Math.max(0, items.findIndex((item) => item.current));
  return {
    items() {
      return items;
    },
    selectedIndex() {
      return selected;
    },
    selectedModel() {
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

function normalizeModels(models, currentModel) {
  const current = String(currentModel || "").trim();
  const seen = new Set();
  const items = [];
  let currentFound = false;
  for (const model of Array.isArray(models) ? models : []) {
    const name = String(model || "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const isCurrent = name === current;
    currentFound ||= isCurrent;
    items.push({ name, current: isCurrent });
  }
  if (current && !currentFound) {
    items.unshift({ name: current, current: true });
  }
  return items;
}
