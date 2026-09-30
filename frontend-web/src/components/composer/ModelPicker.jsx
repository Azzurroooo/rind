import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Eye, Search } from "lucide-react";
import { formatContextWindow, groupModelsByProvider } from "../../lib/models.js";

const SEARCH_THRESHOLD = 8;

// Provider-grouped model picker (after Jan's provider groups and LobeHub's
// ModelSwitchPanel): search when the catalog is long, provider headers, and
// rows that show the context window and image support beside the name.
// `data-composer-chip` lets the /model command open it.
export function ModelPicker({ model, providerId = "", models = [], providerNames = {}, disabled, onOpen, onSelect }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    onOpen?.();
    // With a search box the user types first; otherwise focus lands on the
    // selected row (LobeHub scrolls the active item into view).
    if (models.length > SEARCH_THRESHOLD) searchRef.current?.focus();
    else {
      const nodes = optionNodes();
      (nodes.find((node) => node.getAttribute("aria-selected") === "true") || nodes[0])?.focus();
    }
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function close(restore = true) {
    setOpen(false);
    setQuery("");
    if (restore) triggerRef.current?.focus?.();
  }

  const groups = useMemo(() => {
    const clean = query.trim().toLowerCase();
    const filtered = clean
      ? models.filter((option) => option.id.toLowerCase().includes(clean) || (option.providerId || "").toLowerCase().includes(clean))
      : models;
    return groupModelsByProvider(filtered, providerNames);
  }, [models, providerNames, query]);

  const optionNodes = () => Array.from(listRef.current?.querySelectorAll("[data-model-option]:not([disabled])") || []);

  function onKeyDown(event) {
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
    const nodes = optionNodes();
    if (!nodes.length) return;
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (event.key in moves) {
      const index = nodes.indexOf(document.activeElement);
      next = nodes[(index + moves[event.key] + nodes.length) % nodes.length];
    } else if (event.key === "Home") next = nodes[0];
    else if (event.key === "End") next = nodes[nodes.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  const showSearch = models.length > SEARCH_THRESHOLD;
  const currentLabel = model || "Model";

  return (
    <div ref={rootRef} className="menu-root chip-menu" data-open={open ? "true" : undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip"
        data-composer-chip="model"
        aria-label={`Model: ${model || "not set"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={model || "Choose a model"}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <Cpu size={14} aria-hidden="true" />
        <span className="chip-text">{currentLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="model-picker menu menu-end menu-top" role="listbox" aria-label="Models" onKeyDown={onKeyDown} ref={listRef}>
          {showSearch && (
            <div className="model-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                role="searchbox"
                aria-label="Filter models"
                placeholder="Filter models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    optionNodes()[0]?.focus();
                  }
                }}
              />
            </div>
          )}
          <div className="model-picker-list">
            {groups.map((group) => (
              <div key={group.providerId || "none"} className="model-group" role="group" aria-label={group.name}>
                <div className="model-group-header">
                  <span className="model-group-name">{group.name}</span>
                  <span className="model-group-count">{group.models.length}</span>
                </div>
                {group.models.map((option) => {
                  const selected = option.id === model && (option.providerId || "") === (providerId || "");
                  const context = formatContextWindow(option.contextWindow);
                  return (
                    <button
                      key={`${option.providerId}\u0000${option.id}`}
                      type="button"
                      role="option"
                      data-model-option
                      aria-selected={selected}
                      title={option.id}
                      className={`model-option${selected ? " selected" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        close();
                        onSelect?.({ providerId: option.providerId, modelId: option.id });
                      }}
                    >
                      <span className="model-option-check">{selected && <Check size={14} aria-label="Selected" />}</span>
                      <span className="model-option-name">{option.id}</span>
                      {option.imageInput && (
                        <span role="img" aria-label="Supports images" className="model-option-vision">
                          <Eye size={12} aria-hidden="true" />
                        </span>
                      )}
                      {context && <span className="model-option-meta">{context}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length && (
              <p className="model-picker-empty">{query ? "No models match." : "No models reported. Sign in to a provider on the host."}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
