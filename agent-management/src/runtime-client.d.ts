declare module "*runtime-client.js" {
  export function createRuntimeClient(options: Record<string, unknown>): {
    start(): unknown; request(method: string, params?: Record<string, unknown>): Promise<any>;
    shutdown(): Promise<void>; forceShutdown(): void;
  };
}

declare module "*shared-runtime.js" {
  export function connectSharedRuntime(options?: any): Promise<{ request(method: string, params?: any): Promise<any>; close(): void }>;
  export function createSharedRuntimeClient(options: any): { start(): unknown; request(method: string, params?: any): Promise<any>; shutdown(): Promise<void> };
}

declare module "*local-files.js" { export function privateDirectory(directory: string): Promise<void>; }
