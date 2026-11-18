export const runtimeProtocolVersion = "2";

export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type RequestId = string | number;

export interface RuntimeErrorObject {
  type: string;
  message: string;
}

export interface RuntimeRequestEnvelope {
  kind: "request";
  request_id: RequestId;
  method: string;
  params: Record<string, unknown>;
}

export interface RuntimeResponseEnvelope {
  kind: "response";
  request_id: RequestId | null;
  result?: unknown;
  error?: RuntimeErrorObject;
}

export interface RuntimeEventEnvelope {
  kind: "event";
  method: "session/update";
  sequence: number;
  durability: "durable" | "incremental";
  session_id: string;
  turn_id: string;
  event: Record<string, unknown>;
}

export const clientRuntimeMethods = Object.freeze({
  sessionNew: "session/new",
  sessionCreate: "session/create",
  sessionOpen: "session/open",
  sessionList: "session/list",
  sessionSwitch: "session/switch",
  sessionFork: "session/fork",
  sessionSubscribe: "session/subscribe",
  sessionDeliver: "rind/session/deliver",
  sessionDelete: "session/delete",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  modelList: "model/list",
  modelSet: "model/set",
  modelEffort: "model/effort",
  authList: "rind/auth/list",
  authLogin: "rind/auth/login",
  authLogout: "rind/auth/logout",
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
  sessionPromoteFollowUp: "rind/session/promote_follow_up",
  sessionUnsteer: "rind/session/unsteer",
  sessionDequeueFollowUp: "rind/session/dequeue_follow_up",
  sessionCompact: "rind/session/compact",
  commandExecute: "rind/command/execute",
  userQuestionRespond: "rind/user-question/respond",
  backgroundList: "rind/background/list",
  backgroundOutput: "rind/background/output",
  taskList: "rind/task/list",
  taskRead: "rind/task/read",
  taskWait: "rind/task/wait",
  taskCancel: "rind/task/cancel",
  taskReleaseWait: "rind/task/release_wait",
  goalGet: "rind/goal/get",
  goalSet: "rind/goal/set",
  goalStatus: "rind/goal/status",
  goalClear: "rind/goal/clear",
  contextInspect: "rind/context/inspect",
  usageSummary: "rind/usage/summary",
  folderDefaultsGet: "rind/folder_defaults/get",
  folderDefaultsSet: "rind/folder_defaults/set",
  folderDefaultsUnset: "rind/folder_defaults/unset",
  folderDefaultsApply: "rind/folder_defaults/apply",
  folderDefaultsResolve: "rind/folder_defaults/resolve",
  fileRead: "file/read",
  fileList: "file/list",
  fileWrite: "file/write",
} as const);

export type ClientRuntimeMethod = (typeof clientRuntimeMethods)[keyof typeof clientRuntimeMethods];

export const runtimeMethods = Object.freeze({
  initialize: "initialize",
  shutdown: "shutdown",
  authPrompt: "rind/auth/prompt",
  authUpdate: "rind/auth/update",
  ...clientRuntimeMethods,
} as const);

export type RuntimeMethod = ClientRuntimeMethod;
export type RuntimeLifecycleMethod = "initialize" | "shutdown";
export type RuntimeServerMethod = (typeof runtimeMethods)[keyof typeof runtimeMethods];

export const sessionScopedMethods: ReadonlySet<string> = new Set([
  runtimeMethods.sessionPrompt,
  runtimeMethods.sessionReplay,
  runtimeMethods.sessionSwitch,
  runtimeMethods.sessionFork,
  runtimeMethods.sessionCancel,
  runtimeMethods.sessionDelete,
  runtimeMethods.sessionDeliver,
  runtimeMethods.modelSet,
  runtimeMethods.modelEffort,
  runtimeMethods.folderDefaultsApply,
  runtimeMethods.authList,
  runtimeMethods.authLogin,
  runtimeMethods.authLogout,
  runtimeMethods.sessionSteer,
  runtimeMethods.sessionFollowUp,
  runtimeMethods.sessionPromoteFollowUp,
  runtimeMethods.sessionUnsteer,
  runtimeMethods.sessionDequeueFollowUp,
  runtimeMethods.sessionCompact,
  runtimeMethods.commandExecute,
  runtimeMethods.userQuestionRespond,
  runtimeMethods.backgroundList,
  runtimeMethods.backgroundOutput,
  runtimeMethods.taskList,
  runtimeMethods.taskRead,
  runtimeMethods.taskWait,
  runtimeMethods.taskCancel,
  runtimeMethods.taskReleaseWait,
  runtimeMethods.goalGet,
  runtimeMethods.goalSet,
  runtimeMethods.goalStatus,
  runtimeMethods.goalClear,
  runtimeMethods.contextInspect,
]);

export const localOnlyRuntimeMethods: ReadonlySet<string> = new Set([
  runtimeMethods.authLogin,
  runtimeMethods.authLogout,
  runtimeMethods.sessionOpen,
]);

export const turnScopedMethods: ReadonlySet<string> = new Set([
  runtimeMethods.sessionCancel,
  runtimeMethods.sessionSteer,
]);

const LONG_RUNNING_METHODS: ReadonlySet<string> = new Set([
  runtimeMethods.sessionPrompt,
  runtimeMethods.sessionFollowUp,
  runtimeMethods.sessionCompact,
]);

export function isLongRunningRequest(
  method: string,
  params?: Record<string, unknown> | null,
): boolean {
  return (
    LONG_RUNNING_METHODS.has(method) ||
    (method === runtimeMethods.commandExecute &&
      /^\/compact(?:\s|$)/i.test(String(params?.input || "").trim()))
  );
}

export function createRuntimeRequest(
  requestId: RequestId,
  method: string,
  params: Record<string, unknown> = {},
): RuntimeRequestEnvelope {
  return { kind: "request", request_id: requestId, method, params };
}

export function isRuntimeResponse(message: unknown): message is RuntimeResponseEnvelope {
  return (
    isRecord(message) &&
    message.kind === "response" &&
    isRequestId(message.request_id) &&
    (Object.hasOwn(message, "result") || isRuntimeError(message.error))
  );
}

export function isRuntimeEvent(message: unknown): message is RuntimeEventEnvelope {
  return (
    isRecord(message) &&
    message.kind === "event" &&
    message.method === "session/update" &&
    Number.isInteger(message.sequence) &&
    (message.durability === "durable" || message.durability === "incremental") &&
    typeof message.session_id === "string" &&
    typeof message.turn_id === "string" &&
    isRecord(message.event)
  );
}

export function isRuntimeRequest(message: unknown): message is RuntimeRequestEnvelope {
  return (
    isRecord(message) &&
    message.kind === "request" &&
    isRequestId(message.request_id) &&
    typeof message.method === "string" &&
    isRecord(message.params)
  );
}

export function requireRuntimeInitialization<T extends Record<string, unknown>>(result: unknown): T {
  if (!isRecord(result) || result.protocol_version !== runtimeProtocolVersion) {
    const received = isRecord(result) ? String(result.protocol_version || "missing") : "invalid";
    throw new Error(`Unsupported Runtime protocol version: ${received}.`);
  }
  if (!Array.isArray(result.capabilities) || !Array.isArray(result.methods)) {
    throw new Error("Runtime initialization response is missing capabilities or methods.");
  }
  return result as T;
}

export function runtimeRequestId(message: unknown): RequestId | undefined {
  return isRecord(message) && isRequestId(message.request_id) ? message.request_id : undefined;
}

export function runtimeEventType(message: unknown): string {
  if (!isRecord(message) || !isRecord(message.event)) return "";
  return typeof message.event.type === "string" ? message.event.type : "";
}

export function isRuntimeEventForTurn(
  message: unknown,
  sessionId = "",
  turnId = "",
): boolean {
  const rec = isRecord(message) ? message : null;
  const eventSessionId = String(rec?.session_id || "");
  if (sessionId && eventSessionId && eventSessionId !== sessionId) {
    return false;
  }
  if (runtimeEventType(message) === "turn_started") {
    return Boolean(String(rec?.turn_id || ""));
  }
  const eventTurnId = String(rec?.turn_id || "");
  return !eventTurnId || Boolean(turnId && eventTurnId === turnId);
}

function isRequestId(value: unknown): value is RequestId {
  return (
    (typeof value === "string" && Boolean(value.trim())) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRuntimeError(value: unknown): value is RuntimeErrorObject {
  return isRecord(value) && typeof value.type === "string" && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
