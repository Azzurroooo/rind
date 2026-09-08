export function sigintAction({ activeTurn, interruptRequested, runtimeClosing = false, exitArmed = false }) {
  if (runtimeClosing) {
    return "force-shutdown";
  }
  if (!activeTurn) {
    return exitArmed ? "shutdown" : "arm-exit";
  }
  return interruptRequested ? "force-shutdown" : "interrupt";
}
