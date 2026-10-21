import { localOnlyRuntimeMethods, runtimeMethods } from "../runtime-protocol.js";

const NON_CLIENT_RUNTIME_METHODS = new Set([
  runtimeMethods.initialize,
  runtimeMethods.shutdown,
  runtimeMethods.authPrompt,
  runtimeMethods.authUpdate,
]);

export const DESKTOP_RUNTIME_METHODS = new Set(
  Object.values(runtimeMethods).filter((method) => !NON_CLIENT_RUNTIME_METHODS.has(method)),
);

export const REMOTE_RUNTIME_METHODS = new Set(
  [...DESKTOP_RUNTIME_METHODS].filter((method) => !localOnlyRuntimeMethods.has(method)),
);

export function isDesktopRuntimeMethod(value) {
  return typeof value === "string" && DESKTOP_RUNTIME_METHODS.has(value);
}

export function isRemoteRuntimeMethod(value) {
  return typeof value === "string" && REMOTE_RUNTIME_METHODS.has(value);
}
