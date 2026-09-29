import { useEffect, useRef } from "react";
import { LogOut, Moon, Sun, X } from "lucide-react";

export function SettingsDialog({ open, onClose, onLogout, theme, onTheme }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open) dialog.current?.showModal?.();
    else dialog.current?.close?.();
  }, [open]);
  return <dialog ref={dialog} className="settings-dialog" aria-label="Settings" onCancel={onClose} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
    <div className="dialog-heading"><div><h2>Settings</h2><p>Make this workspace yours.</p></div><button className="icon-button subtle" aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>
    <section className="settings-section"><h3>Appearance</h3><div className="setting-row"><span>Color theme</span><button className="secondary-action" onClick={onTheme}>{theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}{theme === "dark" ? "Dark" : "Light"}</button></div></section>
    <section className="settings-section"><h3>This device</h3><p>Connection is managed automatically. Your conversations and tasks remain on the Rind computer when you sign out here.</p></section>
    <section className="settings-section"><h3>Keyboard</h3><div className="setting-row"><span>Commands</span><kbd>Ctrl / ⌘ K</kbd></div><div className="setting-row"><span>Settings</span><kbd>Ctrl / ⌘ ,</kbd></div><div className="setting-row"><span>New line</span><kbd>Shift Enter</kbd></div><div className="setting-row"><span>Stop current turn</span><kbd>Esc × 2</kbd></div></section>
    <button className="secondary-action" onClick={onLogout}><LogOut size={15} /> Sign out of this device</button>
  </dialog>;
}
