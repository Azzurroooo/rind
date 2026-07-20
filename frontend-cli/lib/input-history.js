export function createInputHistory(limit = 100) {
  const entries = [];
  let index = null;
  let draft = "";

  return {
    add(value) {
      const text = String(value || "").trim();
      if (!text) {
        return;
      }
      if (entries[entries.length - 1] !== text) {
        entries.push(text);
        while (entries.length > limit) {
          entries.shift();
        }
      }
      this.reset();
    },
    previous(current) {
      if (!entries.length) {
        return String(current || "");
      }
      if (index === null) {
        draft = String(current || "");
        index = entries.length - 1;
      } else if (index > 0) {
        index -= 1;
      }
      return entries[index];
    },
    next(current) {
      if (index === null) {
        return String(current || "");
      }
      if (index < entries.length - 1) {
        index += 1;
        return entries[index];
      }
      const text = draft;
      this.reset();
      return text;
    },
    reset() {
      index = null;
      draft = "";
    },
  };
}
