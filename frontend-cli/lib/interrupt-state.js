// How long a first idle Ctrl+C stays armed. Long enough to press again
// deliberately, short enough that a stray press expires on its own.
export const LEAVE_CONFIRM_MS = 2000;

// Ctrl+C means: stop the running turn first; when nothing runs, leave Rind.
// Leaving takes two presses so one stray key cannot close every window.
// Leaving never stops background agents; that is a separate, explicit action.
export function sigintAction({ activeTurn, interruptRequested, runtimeClosing = false, leaveArmed = false }) {
  if (runtimeClosing) {
    return "force-shutdown";
  }
  if (activeTurn) {
    return interruptRequested ? "force-shutdown" : "interrupt";
  }
  return leaveArmed ? "leave" : "arm-leave";
}

// A tiny timer-backed latch shared by the chat and the Agents page.
export function createLeaveLatch({ onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, ms = LEAVE_CONFIRM_MS } = {}) {
  let timer = null;
  const latch = {
    armed: false,
    arm() {
      clearTimer(timer);
      latch.armed = true;
      timer = setTimer(() => { latch.armed = false; timer = null; onChange(); }, ms);
      timer?.unref?.();
      onChange();
    },
    disarm() {
      if (!latch.armed) return;
      clearTimer(timer);
      timer = null;
      latch.armed = false;
      onChange();
    },
  };
  return latch;
}

export const LEAVE_HINT = "ctrl+c again to leave Rind · agents keep running";
