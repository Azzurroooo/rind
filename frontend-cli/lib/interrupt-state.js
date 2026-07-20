export function sigintAction({ activeTurn, interruptRequested, runtimeClosing = false }) {
  if (runtimeClosing) {
    return "force-shutdown";
  }
  if (!activeTurn) {
    return "shutdown";
  }
  return interruptRequested ? "force-shutdown" : "interrupt";
}
