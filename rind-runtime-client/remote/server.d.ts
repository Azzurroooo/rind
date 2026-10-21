import { EventEmitter } from "node:events";

export type RemoteOptions = {
  scope: "loopback" | "lan";
  port?: number;
  externalOrigin?: string;
};

export type RemoteState = {
  running: boolean;
  scope: "loopback" | "lan";
  port: number;
  addresses: string[];
  accessCode: string;
  clients: number;
};

export type RemoteEventPayload = {
  type?: string;
  sequence: number;
  durability: "durable" | "incremental";
  sessionId?: string;
  session_id?: string;
  turnId?: string;
  turn_id?: string;
  event: Record<string, unknown>;
  generation?: number;
};

export type RemoteBridge = {
  initialize: () => Promise<unknown>;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: any) => void) => () => void;
  agentsRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  subscribeAgents?: (listener: (state: unknown) => void) => () => void;
  settingsLoad?: () => Promise<unknown>;
  settingsSave?: (value: unknown) => Promise<unknown>;
};

export declare class RemoteWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState: number;
  readonly bufferedAmount: number;
  constructor(url: string | URL, options?: { origin?: string; autoPong?: boolean; headers?: Record<string, string> });
  send(data: string | Buffer | Uint8Array): void;
  ping(data?: string | Buffer): void;
  pong(data?: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export declare const WebSocket: typeof RemoteWebSocket;

export declare class RemoteServer {
  constructor(
    bridge: RemoteBridge,
    webRoot: string,
    changed?: (state: RemoteState) => void,
    options?: { allowMissingWebRoot?: boolean },
  );
  state(): RemoteState;
  start(options: RemoteOptions): Promise<RemoteState>;
  rotate(): RemoteState;
  notifyWorkspacesChanged(): void;
  stop(): Promise<void>;
}

export type DesktopGateway = RemoteServer;
export declare const DesktopGateway: typeof RemoteServer;
