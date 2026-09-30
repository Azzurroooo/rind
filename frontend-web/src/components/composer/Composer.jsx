import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, CornerUpRight, Paperclip, Slash, Square, Upload } from "lucide-react";
import { UploadChip } from "../UploadChip.jsx";
import { Tooltip } from "../overlays/Tooltip.jsx";
import { QueueTray } from "./QueueTray.jsx";
import { SlashMenu } from "./SlashMenu.jsx";
import { ContextRing, EffortChip } from "./ComposerChips.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { useAttachments } from "./useAttachments.js";
import { COMPOSER_ACTIONS, composerKeyAction, slashQuery } from "../../lib/composerKeys.js";
import { matchingSlashCommands } from "../../lib/commands.js";
import { composeMessageWithAttachments } from "../../lib/files.js";

// Composer (spec section 6), after Jan's chat input and LobeHub's action bar:
// queue tray, attachment chips, an auto-growing textarea and a toolbar with
// Attach and "/" on the left and model, effort, context ring and Send/Stop on
// the right. Enter sends (queues a follow-up while a turn runs), Alt+Enter
// steers, Shift+Enter is a newline and ArrowUp on an empty draft recalls the
// last prompt. Typing is never blocked by uploads or connection state.
export const Composer = forwardRef(function Composer({
  value,
  onChange,
  onSubmit,
  active = false,
  loading = false,
  interruptArmed = false,
  commands = [],
  queued = [],
  lastPrompt = "",
  model = "",
  models = [],
  providerId = "",
  providerNames = {},
  effort = "",
  stats = null,
  hasSession = false,
  onCancel,
  onUpload,
  onPromote,
  onEditQueued,
  onRemoveQueued,
  onRefreshModels,
  onModel,
  onEffort,
  onOpenContext,
  onError,
}, ref) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepth = useRef(0);
  const menuId = useId();
  const [dragging, setDragging] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const attachments = useAttachments(onUpload);

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  useEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [value]);

  const query = slashQuery(value);
  const suggestions = query === null || menuDismissed ? [] : matchingSlashCommands(commands, query);
  const menuOpen = suggestions.length > 0;
  const activeIndex = Math.min(menuIndex, Math.max(0, suggestions.length - 1));
  const hasContent = Boolean(String(value || "").trim()) || attachments.ready;

  function change(next) {
    setMenuDismissed(false);
    setMenuIndex(0);
    onChange?.(next);
  }

  function send(mode) {
    if (loading) return;
    const composed = composeMessageWithAttachments(value, attachments.take());
    if (!composed.trim()) return;
    onSubmit?.(composed, { mode });
  }

  function acceptCommand(command) {
    change(`/${command.slash} `);
    textareaRef.current?.focus();
  }

  async function guard(action, argument) {
    try {
      await action?.(argument);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  function onKeyDown(event) {
    const action = composerKeyAction(event, { value, active, menuOpen, lastPrompt });
    const handlers = {
      [COMPOSER_ACTIONS.menuNext]: () => setMenuIndex((activeIndex + 1) % suggestions.length),
      [COMPOSER_ACTIONS.menuPrev]: () => setMenuIndex((activeIndex - 1 + suggestions.length) % suggestions.length),
      [COMPOSER_ACTIONS.menuAccept]: () => acceptCommand(suggestions[activeIndex]),
      [COMPOSER_ACTIONS.menuClose]: () => setMenuDismissed(true),
      [COMPOSER_ACTIONS.send]: () => send("follow_up"),
      [COMPOSER_ACTIONS.followUp]: () => send("follow_up"),
      [COMPOSER_ACTIONS.steer]: () => send("steering"),
      [COMPOSER_ACTIONS.recall]: () => change(lastPrompt),
    };
    const handler = handlers[action];
    if (!handler) return;
    event.preventDefault();
    if (action === COMPOSER_ACTIONS.menuClose) event.stopPropagation();
    handler();
  }

  const dropHandlers = {
    onDragEnter: (event) => {
      if (!event.dataTransfer?.types?.includes?.("Files")) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event) => {
      if (event.dataTransfer?.types?.includes?.("Files")) event.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (event) => {
      dragDepth.current = 0;
      setDragging(false);
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      attachments.addFiles(event.dataTransfer.files);
    },
  };

  const placeholder = loading
    ? "Opening conversation…"
    : active ? "Queue a follow-up (Enter) or steer (Alt+Enter)…" : "Message Rind…";

  return (
    <div className="composer-wrap">
      {attachments.notice && <div className="upload-notice" role="status">{attachments.notice}</div>}
      {interruptArmed && <div className="interrupt-hint" role="status">Press Esc again to stop</div>}
      <QueueTray entries={queued} onPromote={onPromote} onEdit={onEditQueued} onRemove={onRemoveQueued} />
      <div className={`composer-shell${dragging ? " is-dragging" : ""}`} {...dropHandlers}>
        {menuOpen && <SlashMenu id={menuId} commands={suggestions} activeIndex={activeIndex} onPick={acceptCommand} onHover={setMenuIndex} />}
        {dragging && <div className="drop-overlay" aria-hidden="true"><Upload size={18} />{" "}Drop files</div>}
        {attachments.chips.length > 0 && (
          <div className="chip-row" aria-label="Attachments">
            {attachments.chips.map((chip) => (
              <UploadChip key={chip.id} chip={chip} onDelete={attachments.removeChip} onRetry={attachments.startUpload} />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          dir="auto"
          rows={1}
          value={value}
          placeholder={placeholder}
          readOnly={loading}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen ? `${menuId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (!event.clipboardData?.files?.length) return;
            event.preventDefault();
            attachments.addFiles(event.clipboardData.files);
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <input ref={fileInputRef} type="file" multiple className="visually-hidden" aria-hidden="true" tabIndex={-1} onChange={(event) => { attachments.addFiles(event.target.files); event.target.value = ""; }} />
            <Tooltip label="Attach files" side="top">
              <button type="button" className="icon-button" aria-label="Add attachment" onClick={() => fileInputRef.current?.click()}>
                <Paperclip size={16} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Commands" side="top">
              <button type="button" className="icon-button" aria-label="Insert slash command" onClick={() => { if (!value) change("/"); textareaRef.current?.focus(); }}>
                <Slash size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
          <div className="composer-actions">
            <ModelPicker model={model} providerId={providerId} models={models} providerNames={providerNames} disabled={!hasSession} onOpen={onRefreshModels} onSelect={(next) => guard(onModel, next)} />
            <EffortChip effort={effort} disabled={!hasSession} onSelect={(next) => guard(onEffort, next)} />
            <ContextRing stats={stats} onOpen={onOpenContext} />
            {active && hasContent && (
              <Tooltip label="Steer this turn · Alt+Enter" side="top">
                <button type="button" className="send-button steer" aria-label="Steer active turn" disabled={loading} onClick={() => send("steering")}>
                  <CornerUpRight size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            {active && !hasContent ? (
              <button type="button" className="send-button stop" aria-label="Stop active turn" title={interruptArmed ? "Press Esc again to stop" : "Stop (Esc Esc)"} onClick={onCancel}>
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="send-button" aria-label={active ? "Send queued message" : "Send message"} disabled={!hasContent || loading} onClick={() => send("follow_up")}>
                <ArrowUp size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
