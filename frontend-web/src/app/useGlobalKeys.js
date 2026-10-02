import { useEffect } from "react";
import { INTERRUPT_ARM_MS } from "./constants.js";

// Global shortcuts: Ctrl/Cmd+, settings, Ctrl/Cmd+K palette, Ctrl/Cmd+B
// sidebar, and the double-Esc interrupt (second Esc within 3s cancels).
export function useGlobalKeys(ctx, active) {
  const { refs } = ctx;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const actions = ctx.call.current;
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const key = String(event.key).toLowerCase();
      if (mod && event.key === ",") { event.preventDefault(); ctx.setSettingsOpen(true); return; }
      if (mod && key === "k") {
        event.preventDefault();
        if (refs.paletteOpen.current) actions.closePalette();
        else ctx.setPaletteOpen(true);
        return;
      }
      if (mod && key === "b") { event.preventDefault(); ctx.call.current.toggleSidebar(); return; }
      if (event.key !== "Escape") return;
      if (document.querySelector("[aria-modal='true'], dialog[open]")) return;
      if (refs.paletteOpen.current) return; // the palette handles its own Esc
      if (ctx.call.current.drawerOpen()) return; // Esc closes a drawer first
      if (!refs.conv.current.active) return;
      event.preventDefault();
      if (refs.interruptTimer.current) {
        actions.disarmInterrupt();
        void actions.cancelTurn();
        return;
      }
      ctx.setInterruptArmed(true);
      refs.interruptTimer.current = window.setTimeout(() => {
        refs.interruptTimer.current = null;
        ctx.setInterruptArmed(false); // a single Esc after the window resets silently
      }, INTERRUPT_ARM_MS);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn end (or leaving the session) disarms a pending interrupt silently.
  useEffect(() => {
    if (!active) ctx.call.current.disarmInterrupt();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (refs.interruptTimer.current) window.clearTimeout(refs.interruptTimer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
