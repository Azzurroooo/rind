declare module "*runtime-client.js" {
  export function createRuntimeClient(options: Record<string, unknown>): {
    start(): unknown; request(method: string, params?: Record<string, unknown>): Promise<any>;
    shutdown(): Promise<void>; forceShutdown(): void;
  };
}
