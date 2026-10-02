import { useState } from "react";
import { Keyboard, LogOut, Monitor, Moon, Palette, Sun, UserRound } from "lucide-react";
import { Dialog } from "../overlays/Dialog.jsx";

const SECTIONS = Object.freeze([
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "account", label: "Account", icon: UserRound },
]);

const THEME_OPTIONS = Object.freeze([
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
]);

const SHORTCUTS = Object.freeze([
  ["Command palette", "Ctrl / Cmd K"],
  ["Settings", "Ctrl / Cmd ,"],
  ["Toggle sidebar", "Ctrl / Cmd B"],
  ["Send, or queue a follow-up while running", "Enter"],
  ["Steer the running turn", "Alt Enter"],
  ["New line", "Shift Enter"],
  ["Recall last prompt", "Arrow Up"],
  ["Stop the current turn", "Esc Esc"],
]);

// Settings (spec section 8), after Jan's settings layout: a 760x560 dialog with
// a 200px section nav. Web settings are presentation-only; provider sign-in
// and runtime configuration live in Rind Desktop.
export function SettingsDialog({ open, onClose, theme, onTheme, onLogout }) {
  const [section, setSection] = useState("appearance");
  return (
    <Dialog open={open} onClose={onClose} title="Settings" size="lg" className="settings-dialog">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className="settings-nav-item" aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>
              <Icon size={15} aria-hidden="true" />{" "}{label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "appearance" && (
            <section aria-labelledby="settings-appearance">
              <h3 id="settings-appearance" className="settings-heading">Appearance</h3>
              <div className="settings-row">
                <span>Color theme</span>
                <div className="segmented" role="radiogroup" aria-label="Color theme">
                  {THEME_OPTIONS.map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" role="radio" aria-checked={theme === id} className="segmented-item" onClick={() => onTheme?.(id)}>
                      <Icon size={14} aria-hidden="true" />{" "}{label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
          {section === "keyboard" && (
            <section aria-labelledby="settings-keyboard">
              <h3 id="settings-keyboard" className="settings-heading">Keyboard</h3>
              <dl className="shortcut-list">
                {SHORTCUTS.map(([label, keys]) => (
                  <div key={label} className="settings-row">
                    <dt>{label}</dt>
                    <dd><kbd>{keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {section === "account" && (
            <section aria-labelledby="settings-account">
              <h3 id="settings-account" className="settings-heading">Account</h3>
              <p className="muted">Connection is managed automatically. Your conversations and tasks remain on the Rind computer when you sign out here.</p>
              <button type="button" className="button secondary" onClick={onLogout}>
                <LogOut size={14} aria-hidden="true" />{" "}Sign out of this device
              </button>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  );
}
