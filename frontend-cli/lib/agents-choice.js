// A choice dialog on the Agents page. A fixed menu (written in code, with
// letter keys) picks with 1-9 while it has at most nine items. A searchable
// list (one that grows with data: models, members, statuses) filters by what
// is typed instead, so digits and letters go to the filter. Headers group
// items; they are never selected and hide when nothing under them matches.
// Pure state: the page draws it and runs the picked item's action.
const PAGE = 10;

export function createChoice({ title, items, description = [], selected, danger = false, searchable = false }) {
  const choice = { kind: "choice", title, items, description, danger, searchable, query: "", error: "", index: 0, visible, numbered, position, handleKey, paste };

  // A header's text matches for the items under it ("deepseek" finds its models).
  function visible() {
    if (!choice.query) return items;
    const query = choice.query.toLowerCase();
    const result = [];
    let header = null;
    for (const item of items) {
      if (item.header) { header = item; continue; }
      if (![item.label, item.description, header?.label].join(" ").toLowerCase().includes(query)) continue;
      if (header && !result.includes(header)) result.push(header);
      result.push(item);
    }
    return result;
  }
  function numbered() { return !searchable && items.length > 1 && items.length <= 9; }
  function selectable(list = visible()) { return list.flatMap((item, index) => (item.header ? [] : [index])); }
  // "12 of 54" while browsing, the match count while filtering.
  function position() {
    const indices = selectable();
    if (choice.query) return indices.length ? indices.length + (indices.length === 1 ? " match" : " matches") : "No match";
    return indices.length ? indices.indexOf(choice.index) + 1 + " of " + indices.length : "";
  }
  // One step wraps around; a page stops at either end.
  function move(step) {
    const indices = selectable();
    if (!indices.length) return;
    const at = Math.max(0, indices.indexOf(choice.index));
    const next = Math.abs(step) === 1 ? (at + step + indices.length) % indices.length : Math.min(indices.length - 1, Math.max(0, at + step));
    choice.index = indices[next];
  }
  function filter(query) {
    const current = visible()[choice.index];
    choice.query = query;
    const list = visible(), indices = selectable(list);
    choice.index = indices.includes(list.indexOf(current)) ? list.indexOf(current) : indices[0] ?? 0;
  }
  function paste(text) { if (searchable) filter(choice.query + String(text).replace(/\s+/g, " ")); }

  // Returns { pick } for an item to run, "close" to leave, or undefined once handled.
  function handleKey(key) {
    if (key.name === "escape") return choice.query ? filter("") : "close";
    if (key.name === "enter" || key.name === "return") {
      const item = visible()[choice.index];
      return item && !item.header ? { pick: item } : undefined;
    }
    if (key.name === "up" || (!searchable && key.text === "k")) return move(-1);
    if (key.name === "down" || (!searchable && key.text === "j")) return move(1);
    if (key.name === "pageup") return move(-PAGE);
    if (key.name === "pagedown") return move(PAGE);
    if (key.name === "home") return move(-Infinity);
    if (key.name === "end") return move(Infinity);
    if (searchable) {
      if (key.name === "backspace") return filter(choice.query.slice(0, -1));
      if (key.text && !key.ctrl && !key.alt && key.text >= " ") return filter(choice.query + key.text);
      return undefined;
    }
    if (numbered() && /^[1-9]$/.test(key.text || "")) return items[Number(key.text) - 1] ? { pick: items[Number(key.text) - 1] } : undefined;
    const keyed = key.text && items.find(item => item.key === key.text.toLowerCase());
    return keyed ? { pick: keyed } : undefined;
  }

  const start = items.findIndex(item => !item.header && (item.id ?? item.label) === selected);
  choice.index = start >= 0 ? start : selectable()[0] ?? 0;
  return choice;
}
