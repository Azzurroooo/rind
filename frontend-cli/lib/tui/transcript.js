// Transcript mutations are explicit; status/composer frames reuse its lines.
export function createTranscript() {
  const children = [];
  let cache = null;
  return {
    addChild(child) {
      children.push(child);
      cache = null;
      return child;
    },
    changed() { cache = null; },
    clear() { children.length = 0; cache = null; },
    get length() { return children.length; },
    render(width) {
      if (cache?.width !== width) {
        const lines = [];
        for (const child of children) {
          for (const line of child.render(width)) lines.push(String(line ?? ""));
        }
        cache = { width, lines: Object.freeze(lines) };
      }
      return cache.lines;
    },
    invalidate() {
      for (const child of children) child.invalidate?.();
      cache = null;
    },
  };
}
