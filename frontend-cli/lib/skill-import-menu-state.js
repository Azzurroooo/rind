// The /import checklist: which Claude and Codex skill layers the conversation
// reads. Nothing changes until the choices are applied.
export function createSkillImportMenuState(sources) {
  let items = sources.map((source) => ({ ...source, chosen: Boolean(source.enabled) }));
  let selected = 0;
  return {
    items: () => items,
    selectedIndex: () => selected,
    changed: () => items.some((item) => item.chosen !== Boolean(item.enabled)),
    choices: () => Object.fromEntries(items.map((item) => [item.id, item.chosen])),
    handleKey(key = {}) {
      if (key.name === "up") {
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        return true;
      }
      if (key.name === "down") {
        selected = selected >= items.length - 1 ? 0 : selected + 1;
        return true;
      }
      if (key.text === " ") {
        items = items.map((item, index) => (index === selected ? { ...item, chosen: !item.chosen } : item));
        return true;
      }
      return false;
    },
  };
}
