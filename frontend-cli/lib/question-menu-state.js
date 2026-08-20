export const CUSTOM_ANSWER_LABEL = "Type your own answer";

export function createQuestionMenuState(options) {
  const items = normalizeOptions(options);
  const customIndex = items.length;
  let selected = 0;
  let editing = false;

  return {
    options() {
      return items;
    },
    selectedIndex() {
      return selected;
    },
    selectedOption() {
      return items[selected] || null;
    },
    isEditing() {
      return editing;
    },
    enterEditing() {
      if (selected !== customIndex) {
        return false;
      }
      editing = true;
      return true;
    },
    handleNavigation(key = {}) {
      const vimNavigation = !editing && (key.text === "j" || key.text === "k");
      if (key.name !== "up" && key.name !== "down" && !vimNavigation) {
        return false;
      }
      const total = items.length + 1;
      if (key.name === "up" || key.text === "k") {
        selected = selected <= 0 ? total - 1 : selected - 1;
      } else {
        selected = selected >= total - 1 ? 0 : selected + 1;
      }
      editing = false;
      return true;
    },
  };
}

function normalizeOptions(options) {
  const labels = new Set();
  const items = [];
  for (const option of Array.isArray(options) ? options : []) {
    const label = String(option?.label || "").trim();
    if (!label || labels.has(label)) {
      continue;
    }
    labels.add(label);
    items.push({
      label,
      description: String(option?.description || "").trim(),
    });
  }
  return items;
}
