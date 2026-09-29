import { useCallback, useEffect, useRef, useState } from "react";
import { INSPECTOR_TABS, INSPECTOR_WIDTH, LAYOUT_KEYS, NARROW_QUERY, SIDEBAR_WIDTH } from "./constants.js";

// Shell layout (spec section 2), after Jan's resizable left panel and
// LobeHub's dismissible right panel: a collapsible, resizable sidebar and a
// resizable inspector on desktop; below 768px both become exclusive drawers.
// Desktop layout is persisted per device; drawers never are.

export function readLayout(storage = safeStorage()) {
  return {
    sidebarWidth: clampWidth(readNumber(storage, LAYOUT_KEYS.sidebarWidth), SIDEBAR_WIDTH),
    sidebarCollapsed: read(storage, LAYOUT_KEYS.sidebarCollapsed) === "true",
    inspectorWidth: clampWidth(readNumber(storage, LAYOUT_KEYS.inspectorWidth), INSPECTOR_WIDTH),
    inspectorOpen: read(storage, LAYOUT_KEYS.inspectorOpen) === "true",
    inspectorTab: INSPECTOR_TABS.includes(read(storage, LAYOUT_KEYS.inspectorTab)) ? read(storage, LAYOUT_KEYS.inspectorTab) : INSPECTOR_TABS[0],
  };
}

export function clampWidth(value, { min, max, initial }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return initial;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function readNarrow() {
  try {
    return Boolean(window.matchMedia?.(NARROW_QUERY)?.matches);
  } catch {
    return false;
  }
}

export function useShellLayout() {
  const [narrow, setNarrow] = useState(readNarrow);
  const [drawer, setDrawer] = useState(""); // "" | "sidebar" | "inspector"
  const [layout, setLayout] = useState(() => readLayout());
  const sidebarToggleRef = useRef(null);
  const inspectorToggleRef = useRef(null);
  const sidebarPanelRef = useRef(null);
  const inspectorPanelRef = useRef(null);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const update = useCallback((patch) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      persist(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(NARROW_QUERY);
    if (!media) return undefined;
    const apply = (event) => {
      const next = Boolean(event?.matches);
      setNarrow(next);
      if (!next) setDrawer("");
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    media.addListener?.(apply);
    return () => media.removeListener?.(apply);
  }, []);

  // Focus moves into a drawer when it opens.
  useEffect(() => {
    if (!narrow) return;
    if (drawer === "sidebar") sidebarPanelRef.current?.focus();
    else if (drawer === "inspector") inspectorPanelRef.current?.focus();
  }, [narrow, drawer]);

  const closeDrawers = useCallback(() => {
    const opener = drawerRef.current === "sidebar" ? sidebarToggleRef.current : drawerRef.current === "inspector" ? inspectorToggleRef.current : null;
    setDrawer("");
    opener?.focus(); // Esc and backdrop hand focus back to the toggle
  }, []);

  const closeDrawersSilently = useCallback(() => setDrawer(""), []);

  useEffect(() => {
    if (!narrow || !drawer) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || document.querySelector("[aria-modal='true']")) return;
      event.preventDefault();
      closeDrawers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, drawer, closeDrawers]);

  const toggleSidebar = useCallback(() => {
    if (narrow) setDrawer((current) => (current === "sidebar" ? "" : "sidebar"));
    else update({ sidebarCollapsed: !layout.sidebarCollapsed });
  }, [narrow, layout.sidebarCollapsed, update]);

  const showSidebar = useCallback(() => {
    if (narrow) setDrawer("sidebar");
    else update({ sidebarCollapsed: false });
  }, [narrow, update]);

  const toggleInspector = useCallback(() => {
    if (narrow) setDrawer((current) => (current === "inspector" ? "" : "inspector"));
    else update({ inspectorOpen: !layout.inspectorOpen });
  }, [narrow, layout.inspectorOpen, update]);

  const openInspector = useCallback((tab) => {
    const patch = INSPECTOR_TABS.includes(tab) ? { inspectorTab: tab } : {};
    if (narrow) {
      setDrawer("inspector");
      update(patch);
    } else {
      update({ ...patch, inspectorOpen: true });
    }
  }, [narrow, update]);

  const closeInspector = useCallback(() => {
    if (narrow) closeDrawers();
    else update({ inspectorOpen: false });
  }, [narrow, closeDrawers, update]);

  const sidebarVisible = narrow ? drawer === "sidebar" : !layout.sidebarCollapsed;
  const inspectorVisible = narrow ? drawer === "inspector" : layout.inspectorOpen;

  return {
    narrow,
    drawer,
    ...layout,
    sidebarVisible,
    inspectorVisible,
    sidebarToggleRef,
    inspectorToggleRef,
    sidebarPanelRef,
    inspectorPanelRef,
    toggleSidebar,
    showSidebar,
    toggleInspector,
    openInspector,
    closeInspector,
    closeDrawers,
    closeDrawersSilently,
    setSidebarWidth: (width) => update({ sidebarWidth: clampWidth(width, SIDEBAR_WIDTH) }),
    setInspectorWidth: (width) => update({ inspectorWidth: clampWidth(width, INSPECTOR_WIDTH) }),
    setInspectorTab: (tab) => INSPECTOR_TABS.includes(tab) && update({ inspectorTab: tab }),
  };
}

function persist(layout, storage = safeStorage()) {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_KEYS.sidebarWidth, String(layout.sidebarWidth));
    storage.setItem(LAYOUT_KEYS.sidebarCollapsed, String(layout.sidebarCollapsed));
    storage.setItem(LAYOUT_KEYS.inspectorWidth, String(layout.inspectorWidth));
    storage.setItem(LAYOUT_KEYS.inspectorOpen, String(layout.inspectorOpen));
    storage.setItem(LAYOUT_KEYS.inspectorTab, layout.inspectorTab);
  } catch {
    // Storage full or blocked: layout still works for this page view.
  }
}

function read(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readNumber(storage, key) {
  const value = read(storage, key);
  return value == null ? NaN : Number(value);
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
