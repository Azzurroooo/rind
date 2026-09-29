import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { focusFirst, trapTab } from "./focusTrap.js";

// Modal dialog: scrim, focus trap, Esc to close, focus restored to the opener.
// Structure follows Jan's dialog primitive (title row + close, body, footer).
export function Dialog({
  open,
  onClose,
  title,
  description,
  className = "",
  size = "md",
  initialFocus,
  footer,
  hideClose = false,
  children,
}) {
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    focusFirst(panelRef.current, initialFocus?.current);
    return () => {
      const opener = openerRef.current;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
    // Focus runs once per open; initialFocus is a ref and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    trapTab(event, panelRef.current);
  };

  return createPortal(
    <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`dialog dialog-${size} ${className}`.trim()}
        onKeyDown={onKeyDown}
      >
        {(title || !hideClose) && (
          <div className="dialog-head">
            {title ? <h2 id={titleId} className="dialog-title">{title}</h2> : <span />}
            {!hideClose && (
              <button type="button" className="icon-button" aria-label="Close dialog" onClick={() => onClose?.()}>
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {description && <p id={descriptionId} className="dialog-description">{description}</p>}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
