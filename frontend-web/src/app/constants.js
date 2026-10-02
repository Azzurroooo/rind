export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const SESSION_PAGE = 10; // session/list page size; the server caps limit at 100
export const SESSION_LIMIT_MAX = 100;
export const INTERRUPT_ARM_MS = 3000; // second Esc within 3s cancels the turn
// Below 768px the sidebar and inspector become exclusive drawers (spec §2).
export const NARROW_QUERY = "(max-width: 767px)";

export const SIDEBAR_WIDTH = Object.freeze({ min: 232, max: 360, initial: 264 });
export const INSPECTOR_WIDTH = Object.freeze({ min: 320, max: 640, initial: 360 });
export const INSPECTOR_TABS = Object.freeze(["context", "activity", "files"]);

export const LAYOUT_KEYS = Object.freeze({
  sidebarWidth: "rind.layout.sidebarWidth",
  sidebarCollapsed: "rind.layout.sidebarCollapsed",
  inspectorWidth: "rind.layout.inspectorWidth",
  inspectorOpen: "rind.layout.inspectorOpen",
  inspectorTab: "rind.layout.inspectorTab",
});

// Local transcript ids that never exist on the server (fork points must be
// real message ids from session/replay).
const LOCAL_ID = /^(local-|msg:|history-|queued:|question:|task:|tool-)/;

export function isServerMessageId(id) {
  const value = String(id || "");
  return Boolean(value) && !LOCAL_ID.test(value);
}

export function formatResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  return JSON.stringify(result, null, 2);
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
