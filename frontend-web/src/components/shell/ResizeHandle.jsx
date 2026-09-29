import { useRef } from "react";

const KEY_STEP = 16;

// Panel resize handle (spec section 2, after Jan's left panel): a 6px hit area
// with a 1px line. Pointer drag or ArrowLeft/ArrowRight resizes; while dragging
// the body carries `is-resizing` so width transitions are disabled.
// `edge` is the side of the panel the handle sits on: a sidebar grows to the
// right ("end"), the inspector grows to the left ("start").
export function ResizeHandle({ label, width, min, max, edge = "end", onResize, className = "" }) {
  const drag = useRef(null);
  const direction = edge === "end" ? 1 : -1;

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing");
  }

  function onPointerMove(event) {
    if (!drag.current) return;
    const delta = (event.clientX - drag.current.startX) * direction;
    onResize?.(drag.current.startWidth + delta);
  }

  function stop(event) {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("is-resizing");
  }

  function onKeyDown(event) {
    const step = { ArrowRight: KEY_STEP, ArrowLeft: -KEY_STEP }[event.key];
    if (step) {
      event.preventDefault();
      onResize?.(width + step * direction);
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize?.(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize?.(max);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`resize-handle resize-${edge} ${className}`.trim()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  );
}
