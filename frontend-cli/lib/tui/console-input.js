// On Windows a console read started while the terminal is not raw is a line
// read: it stays pending across later mode switches, echoes what is typed and
// takes every key until Enter, whichever window they were meant for. pause()
// alone does not stop it, so input stops reading before it leaves raw mode and
// reads again only once it is raw.
export function releaseInput(input, raw = false) {
  input.pause?.();
  const handle = input._handle;
  if (handle?.reading) { handle.reading = false; handle.readStop(); }
  input.setRawMode?.(raw);
}

export function takeInput(input) {
  input.setRawMode?.(true);
  input.resume?.();
  const handle = input._handle;
  if (handle && !handle.reading) { handle.reading = true; handle.readStart(); }
}
