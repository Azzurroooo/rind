import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

// Dropdown menu with roving focus (ArrowUp/Down, Home/End), Esc and outside-click close.
// Items: { id, label, icon?, danger?, disabled?, onSelect } or { separator: true }.
// The trigger is a render prop so each call site keeps its own button styling.
export function Menu({ label, items, trigger, align = "end", placement = "bottom", className = "", onOpenChange, selection = false, disabled = false }) {
  const [open, setOpenState] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const menuId = useId();

  const setOpen = useCallback((next) => {
    setOpenState(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus?.();
  }, [setOpen]);

  useEffect(() => { if (disabled) close(false); }, [disabled, close]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const clampToViewport = () => {
      const listEl = listRef.current;
      const rootEl = rootRef.current;
      if (!listEl || !rootEl || typeof window === "undefined") return;
      listEl.style.left = "";
      listEl.style.right = "";
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      if (!viewportWidth) return;
      const margin = 8;
      const menuRect = listEl.getBoundingClientRect();
      const rootRect = rootEl.getBoundingClientRect();
      if (menuRect.width <= 0 && menuRect.right === 0) return;
      if (menuRect.right > viewportWidth - margin) {
        const targetLeft = Math.max(margin, viewportWidth - margin - menuRect.width);
        listEl.style.left = `${Math.round(targetLeft - rootRect.left)}px`;
        listEl.style.right = "auto";
      } else if (menuRect.left < margin) {
        listEl.style.left = `${Math.round(margin - rootRect.left)}px`;
        listEl.style.right = "auto";
      }
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [open, align, placement, items]);

  useEffect(() => {
    if (!open) return undefined;
    const first = listRef.current?.querySelector('[aria-selected="true"]') || listRef.current?.querySelector("button:not([disabled])");
    first?.focus();
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, close]);

  const move = (event) => {
    const nodes = Array.from(listRef.current?.querySelectorAll("button:not([disabled])") || []);
    if (nodes.length === 0) return;
    const index = nodes.indexOf(document.activeElement);
    const pick = {
      ArrowDown: () => nodes[(index + 1) % nodes.length],
      ArrowUp: () => nodes[(index - 1 + nodes.length) % nodes.length],
      Home: () => nodes[0],
      End: () => nodes[nodes.length - 1],
    }[event.key];
    if (pick) {
      event.preventDefault();
      pick().focus();
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    move(event);
  };

  const triggerProps = {
    ref: triggerRef,
    "aria-haspopup": selection ? "listbox" : "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: (event) => {
      event.stopPropagation();
      setOpen(!open);
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
    },
  };

  return (
    <div ref={rootRef} className={`menu-root ${className}`.trim()} data-open={open ? "true" : undefined}>
      {trigger(triggerProps, open)}
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role={selection ? "listbox" : "menu"}
          aria-label={label}
          className={`menu menu-${align} menu-${placement}`}
          onKeyDown={onKeyDown}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item, index) =>
            item.separator ? (
              <div key={`sep-${index}`} role="separator" className="menu-separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role={selection ? "option" : "menuitem"}
                aria-selected={selection ? Boolean(item.selected) : undefined}
                className={`menu-item${item.danger ? " danger" : ""}${selection && item.selected ? " selected" : ""}`}
                disabled={item.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                  item.onSelect?.();
                }}
              >
                {item.icon && <span className="menu-icon" aria-hidden="true">{item.icon}</span>}
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
                {selection && (
                  <span className="model-option-check" aria-hidden="true">
                    {item.selected && <Check size={13} />}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
