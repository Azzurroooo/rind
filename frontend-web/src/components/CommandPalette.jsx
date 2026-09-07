import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands } from "../lib/commands.js";

// Command palette (audit #10, opencode pattern): one fuzzy-filtered, fully
// keyboard-operable list over the single command registry. Esc closes and App
// hands focus back to the Composer. Categories render in registry order and
// keybind hints come from the registry itself — never hardcoded here.
export function CommandPalette({ open, commands, onClose, onRun }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef(new Map());

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // (Re)opening resets the query and hands focus to the filter input. The
  // effect runs post-mount, so the ref is live — no deferred focusing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    const node = itemRefs.current.get(active);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [active, filtered.length]);

  if (!open) return null;

  const move = (delta) => {
    if (!filtered.length) return;
    setActive((current) => (current + delta + filtered.length) % filtered.length);
  };

  function execute(command) {
    if (!command) return;
    onRun?.(command);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      execute(filtered[active]);
    }
  }

  // Grouped rows keep registry order; only categories with hits render.
  const groups = [];
  for (const command of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.category === command.category) last.commands.push(command);
    else groups.push({ category: command.category, commands: [command] });
  }
  let flatIndex = -1;

  return (
    <div className="palette-scrim" onClick={onClose} data-testid="palette-scrim">
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索命令…"
          aria-label="搜索命令"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef} role="listbox" aria-label="命令列表">
          {filtered.length === 0 && <div className="palette-empty">没有匹配的命令</div>}
          {groups.map((group, groupIndex) => (
            <div className="palette-group" key={`group-${groupIndex}`}>
              <div className="palette-category">{group.category}</div>
              {group.commands.map((command) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    ref={(node) => {
                      if (node) itemRefs.current.set(index, node);
                      else itemRefs.current.delete(index);
                    }}
                    className={`palette-item ${index === active ? "active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => execute(command)}
                  >
                    <span className="palette-title">{command.title}</span>
                    {command.keybind && <kbd className="palette-keybind">{command.keybind}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
