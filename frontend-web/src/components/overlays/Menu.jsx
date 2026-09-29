import { useCallback, useEffect, useId, useRef, useState } from "react";

// Dropdown menu with roving focus (ArrowUp/Down, Home/End), Esc and outside-click close.
// Items: { id, label, icon?, danger?, disabled?, onSelect } or { separator: true }.
// The trigger is a render prop so each call site keeps its own button styling.
export function Menu({ label, items, trigger, align = "end", placement = "bottom", className = "", onOpenChange }) {
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

  useEffect(() => {
    if (!open) return undefined;
    const first = listRef.current?.querySelector("[role='menuitem']:not([disabled])");
    first?.focus();
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, close]);

  const move = (event) => {
    const nodes = Array.from(listRef.current?.querySelectorAll("[role='menuitem']:not([disabled])") || []);
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
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: (event) => {
      event.stopPropagation();
      setOpen(!open);
    },
  };

  return (
    <div ref={rootRef} className={`menu-root ${className}`.trim()} data-open={open ? "true" : undefined}>
      {trigger(triggerProps, open)}
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`menu menu-${align} menu-${placement}`}
          onKeyDown={onKeyDown}
        >
          {items.map((item, index) =>
            item.separator ? (
              <div key={`sep-${index}`} role="separator" className="menu-separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? " danger" : ""}`}
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
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
