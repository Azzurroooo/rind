export function createCompactContextState() {
  let awaitingPostCompactContext = false;
  return {
    handleContextBuilt(event = {}) {
      const decisions = event.decisions && typeof event.decisions === "object" ? event.decisions : {};
      if (awaitingPostCompactContext) {
        awaitingPostCompactContext = false;
        return true;
      }
      if (decisions.auto_compact_token_limit_reached || decisions.compact_required) {
        awaitingPostCompactContext = true;
      }
      return false;
    },
    clear() {
      awaitingPostCompactContext = false;
    },
    pending() {
      return awaitingPostCompactContext;
    },
  };
}
