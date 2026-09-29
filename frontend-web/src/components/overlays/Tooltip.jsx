import { cloneElement, useEffect, useId, useRef, useState } from "react";

export const TOOLTIP_DELAY_MS = 400;

// Hover/focus tooltip for icon buttons. The child keeps its own aria-label; the
// tooltip is linked with aria-describedby only while visible.
export function Tooltip({ label, side = "bottom", delay = TOOLTIP_DELAY_MS, children }) {
  const [visible, setVisible] = useState(false);
  const timer = useRef(null);
  const id = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!label) return children;

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setVisible(false);
  };
  const chain = (own, next) => (event) => {
    own?.(event);
    next(event);
  };

  const child = cloneElement(children, {
    "aria-describedby": visible ? id : children.props["aria-describedby"],
    onMouseEnter: chain(children.props.onMouseEnter, show),
    onMouseLeave: chain(children.props.onMouseLeave, hide),
    onFocus: chain(children.props.onFocus, show),
    onBlur: chain(children.props.onBlur, hide),
    onKeyDown: chain(children.props.onKeyDown, (event) => { if (event.key === "Escape") hide(); }),
  });

  return (
    <span className="tooltip-anchor">
      {child}
      {visible && <span role="tooltip" id={id} className={`tooltip tooltip-${side}`}>{label}</span>}
    </span>
  );
}
