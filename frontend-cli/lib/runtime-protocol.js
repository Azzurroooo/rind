export function createRuntimeRequest(requestId, method, params = {}) {
  return { request_id: requestId, method, params };
}

export function runtimeRequestId(message) {
  return message?.request_id;
}

export function runtimeEventType(message) {
  return message?.event_type || message?.event?.type || "";
}
