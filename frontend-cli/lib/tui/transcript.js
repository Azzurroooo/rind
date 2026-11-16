// Transcript mutations are explicit; status/composer frames reuse its lines.
export function createTranscript() {
  const children = [];
  let cache = null;
  let segmentCache = null;
  const resetCaches = () => { cache = null; segmentCache = null; };
  return {
    addChild(child) {
      children.push(child);
      resetCaches();
      return child;
    },
    changed: resetCaches,
    clear() { children.length = 0; resetCaches(); },
    get length() { return children.length; },
    renderSegments(width) {
      if (segmentCache?.width !== width) {
        const sources = new Array(children.length);
        for (let i = 0; i < children.length; i++) {
          const out = children[i].render(width);
          sources[i] = Object.isFrozen(out)
            ? out
            : Object.freeze(Array.isArray(out) ? out.map((line) => String(line ?? "")) : []);
        }
        segmentCache = { width, sources };
      }
      return segmentCache.sources;
    },
    render(width) {
      if (cache?.width !== width) {
        const lines = [];
        for (const segment of this.renderSegments(width)) {
          for (const line of segment) lines.push(line);
        }
        cache = { width, lines: Object.freeze(lines) };
      }
      return cache.lines;
    },
    invalidate() {
      for (const child of children) child.invalidate?.();
      resetCaches();
    },
  };
}
