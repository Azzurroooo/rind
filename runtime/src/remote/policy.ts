import {
  clientRuntimeMethods,
  localOnlyRuntimeMethods,
  type ClientRuntimeMethod,
} from "../protocol/runtime-protocol.js";

const CLIENT_RUNTIME_METHODS = new Set<string>(Object.values(clientRuntimeMethods));

const REMOTE_RUNTIME_METHODS = new Set<string>(
  [...CLIENT_RUNTIME_METHODS].filter(
    (method) => !localOnlyRuntimeMethods.has(method as ClientRuntimeMethod),
  ),
);

export function isClientRuntimeMethod(value: unknown): value is ClientRuntimeMethod {
  return typeof value === "string" && CLIENT_RUNTIME_METHODS.has(value);
}

export function isRemoteRuntimeMethod(value: unknown): value is ClientRuntimeMethod {
  return typeof value === "string" && REMOTE_RUNTIME_METHODS.has(value);
}
