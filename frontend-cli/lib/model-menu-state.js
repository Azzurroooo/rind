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
  const current = typeof currentModel === "object"
    ? { providerId: String(currentModel.provider_id || "").trim(), modelId: String(currentModel.model_id || "").trim() }
    : { providerId: "", modelId: String(currentModel || "").trim() };
  const seen = new Set();
  const items = [];
  let currentFound = false;
  for (const model of Array.isArray(models) ? models : []) {
    const structured = model && typeof model === "object";
    const modelId = structured ? String(model.id || "").trim() : String(model || "").trim();
    const providerId = structured ? String(model.provider_id || "").trim() : "";
    const name = structured ? `${providerId ? `${providerId} / ` : ""}${String(model.name || modelId).trim()}` : modelId;
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const isCurrent = modelId === current.modelId && (!current.providerId || providerId === current.providerId);
    currentFound ||= isCurrent;
    items.push({ name, modelId, providerId, current: isCurrent });
  }
  if (current.modelId && !currentFound) {
    items.unshift({ name: current.providerId ? `${current.providerId} / ${current.modelId}` : current.modelId, modelId: current.modelId, providerId: current.providerId, current: true });
  }
  return items;
}
