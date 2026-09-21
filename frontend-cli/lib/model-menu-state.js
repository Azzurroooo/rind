export function createModelMenuState(models, currentModel = "", providerNames = new Map()) {
  const items = normalizeModels(models, currentModel, providerNames);
  let selected = initialSelection(items);
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
      if (selected < 0) {
        return false;
      }
      if (key.name === "up") {
        selected = step(items, selected, -1);
        return true;
      }
      if (key.name === "down") {
        selected = step(items, selected, 1);
        return true;
      }
      return false;
    },
  };
}

function normalizeModels(models, currentModel, providerNames) {
  const current = typeof currentModel === "object"
    ? { providerId: String(currentModel.provider_id || "").trim(), modelId: String(currentModel.model_id || "").trim() }
    : { providerId: "", modelId: String(currentModel || "").trim() };
  const seen = new Set();
  const providers = [];
  const byProvider = new Map();
  let currentFound = false;
  for (const model of Array.isArray(models) ? models : []) {
    const structured = model && typeof model === "object";
    const modelId = structured ? String(model.id || "").trim() : String(model || "").trim();
    const providerId = structured ? String(model.provider_id || "").trim() : "";
    if (!modelId || seen.has(`${providerId}/${modelId}`)) {
      continue;
    }
    seen.add(`${providerId}/${modelId}`);
    const isCurrent = (!current.modelId || modelId === current.modelId)
      && (!current.providerId || !providerId || providerId === current.providerId);
    currentFound ||= isCurrent;
    appendModel(byProvider, providers, providerId, {
      name: structured ? String(model.name || modelId).trim() : modelId,
      modelId,
      providerId,
      current: isCurrent,
      image_input: structured && typeof model.image_input === "boolean" ? model.image_input : null,
    });
  }
  if (current.modelId && !currentFound) {
    const entry = {
      name: current.modelId,
      modelId: current.modelId,
      providerId: current.providerId,
      current: true,
    };
    if (byProvider.has(current.providerId)) {
      byProvider.get(current.providerId).unshift(entry);
    } else {
      appendModel(byProvider, providers, current.providerId, entry);
      providers.splice(providers.indexOf(current.providerId), 1);
      providers.unshift(current.providerId);
    }
  }
  const items = [];
  if (providers.some((providerId) => providerId)) {
    for (const providerId of providers) {
      items.push({ header: true, name: providerNames.get(providerId) || providerId });
      items.push(...byProvider.get(providerId));
    }
    return items;
  }
  for (const providerId of providers) {
    items.push(...byProvider.get(providerId));
  }
  return items;
}

function appendModel(byProvider, providers, providerId, entry) {
  if (!byProvider.has(providerId)) {
    byProvider.set(providerId, []);
    providers.push(providerId);
  }
  byProvider.get(providerId).push(entry);
}

function initialSelection(items) {
  const current = items.findIndex((item) => item.current);
  if (current >= 0) {
    return current;
  }
  return items.findIndex((item) => !item.header);
}

function step(items, selected, delta) {
  let index = selected;
  do {
    index = index <= 0 && delta < 0 ? items.length - 1 : index >= items.length - 1 && delta > 0 ? 0 : index + delta;
  } while (items[index] && items[index].header && index !== selected);
  return index;
}
