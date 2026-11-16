export function sharedRuntimePaths(home?: string): {
  directory: string;
  endpoint: string;
  token: string;
  record: string;
  log: string;
};
export function connectSharedRuntime(options?: any): Promise<{
  request(method: string, params?: any): Promise<any>;
  close(): void;
  spawned?: boolean;
  stale?: { reason: string; pid?: number; busy?: boolean; attached?: boolean };
}>;
export function stopSharedRuntime(options?: any): Promise<boolean>;
export function createSharedRuntimeClient(options: any): {
  start(): unknown;
  request(method: string, params?: any): Promise<any>;
  setVisible(visible: boolean): Promise<void>;
  shutdown(): Promise<void>;
  forceShutdown(): void;
  closeInput(): void;
  readonly child: unknown;
};
