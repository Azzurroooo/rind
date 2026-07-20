export function isInputClosed(error) {
  return error instanceof Error && ["Input closed", "readline was closed"].includes(error.message);
}
