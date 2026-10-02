import { useEffect, useRef } from "react";

// Slash command menu (spec section 6): opens above the composer while the
// first "/" token is typed. The textarea keeps focus; ArrowUp/Down move the
// highlighted option and Enter/Tab accept (see lib/composerKeys.js).
export function SlashMenu({ id, commands, activeIndex, onPick, onHover }) {
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.querySelector("[aria-selected='true']")?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (!commands.length) return null;
  return (
    <div ref={listRef} id={id} className="slash-menu" role="listbox" aria-label="Slash commands">
      {commands.map((command, index) => (
        <div
          key={command.id}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          className={`slash-option${index === activeIndex ? " active" : ""}`}
          onMouseDown={(event) => { event.preventDefault(); onPick?.(command); }}
          onMouseEnter={() => onHover?.(index)}
        >
          <span className="slash-name">/{command.slash}</span>{" "}
          <span className="slash-title">{command.title}</span>
          {command.usage && <span className="slash-hint">{command.usage}</span>}
        </div>
      ))}
    </div>
  );
}
