declare module "*runtime-client.js" {
  export function createRuntimeClient(options: Record<string, unknown>): {
    start(): unknown; request(method: string, params?: Record<string, unknown>): Promise<any>;
    shutdown(): Promise<void>; forceShutdown(): void;
  };
}

declare module "*shared-runtime.js" {
  export function connectSharedRuntime(options?: any): Promise<{ request(method: string, params?: any): Promise<any>; close(): void; stale?: { reason: string } }>;
  export function createSharedRuntimeClient(options: any): { start(): unknown; request(method: string, params?: any): Promise<any>; shutdown(): Promise<void> };
  export function stopSharedRuntime(options?: any): Promise<boolean>;
}

declare module "*local-files.js" {
  export function privateDirectory(directory: string): Promise<void>;
  export function resolveRindHome(home?: string): string;
}

declare module "*endpoint.js" {
  export function listenOwned(server: any, endpoint: string): Promise<void>;
  export function probeEndpoint(endpoint: string): Promise<boolean>;
  export class EndpointOccupiedError extends Error { code: string }
}

declare module "*process-lock.js" {
  export function acquireProcessLock(lockPath: string, timeoutMs?: number): Promise<{ release(): Promise<void> } | null>;
}

declare module "*build-id.js" {
  export function buildId(sources: Array<{ root?: string; extensions?: string[]; file?: string }>): Promise<string>;
  export function runtimeBuildId(options?: { repoRoot?: string; runtimePath?: string }): Promise<string>;
}
