// Provider-aware model list helpers. The runtime's model/list returns one
// entry per usable model with provider_id, context_window and image_input;
// the composer picker groups them by provider (after Jan's provider groups
// and LobeHub's ModelSwitchPanel).
//
// A model option is { id, providerId, contextWindow, imageInput }.

export function normalizeModelList(result) {
  const rows = Array.isArray(result?.models) ? result.models : [];
  const models = rows
    .map((row) => {
      if (typeof row === "string") return { id: row, providerId: "", contextWindow: null, imageInput: null };
      const id = String(row?.id || "").trim();
      if (!id) return null;
      return {
        id,
        providerId: String(row?.provider_id || "").trim(),
        contextWindow: positiveNumber(row?.context_window),
        imageInput: typeof row?.image_input === "boolean" ? row.image_input : null,
      };
    })
    .filter(Boolean);
  const seen = new Set();
  const unique = models.filter((model) => {
    const key = `${model.providerId}\u0000${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const current = result?.current && typeof result.current === "object"
    ? { providerId: String(result.current.provider_id || "").trim(), modelId: String(result.current.model_id || "").trim() }
    : null;
  return { models: unique, current, warning: String(result?.warning || "").trim() };
}

export function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Groups keep the runtime's order (signed-in providers first, then by id).
export function groupModelsByProvider(models, providerNames = {}) {
  const groups = new Map();
  for (const model of models) {
    const key = model.providerId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  return [...groups.entries()].map(([providerId, list]) => ({
    providerId,
    name: providerName(providerId, providerNames),
    models: list,
  }));
}

export function providerName(providerId, providerNames = {}) {
  const known = providerNames[providerId];
  if (known && known.trim()) return known.trim();
  if (!providerId) return "Provider";
  return providerId
    .split(/[-_]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function formatContextWindow(tokens) {
  if (!positiveNumber(tokens)) return "";
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions}M ctx`;
  }
  return `${Math.round(tokens / 1000)}K ctx`;
}

// String model selections resolve to the provider-aware
// option so model/set can carry provider_id.
export function findModelOption(options, name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean) return null;
  return options.find((model) => model.id.toLowerCase() === clean)
    || options.find((model) => model.id.toLowerCase().includes(clean))
    || null;
}
