export type AgentsSnapshot = {
  seq?: number;
  teams: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  connectedSessions?: string[];
  live?: Array<Record<string, unknown>>;
  folderDefaultsVersion?: number;
  notices?: Array<Record<string, unknown>>;
  approvals?: Array<Record<string, unknown>>;
  archivedTeams?: Array<Record<string, unknown>>;
  notes?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
};

export type ManagementStatePayload = {
  snapshot: AgentsSnapshot;
  connection: "connecting" | "connected" | "reconnecting" | "stopped" | "offline";
  service: Record<string, unknown> | null;
  error?: string;
};

export type ManagementBridge = {
  getManagementState(): ManagementStatePayload;
  ensureManagementConnected(options?: { start?: boolean }): Promise<any>;
  requestManagement(method: string, params?: Record<string, unknown>): Promise<unknown>;
  openAgentSession(params: Record<string, unknown>): Promise<any>;
  createAgentSession(params: Record<string, unknown>): Promise<any>;
  enrichSessionReplayParams(sessionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  forwardControlToSharedRuntimeIfNeeded(method: string, params: Record<string, unknown>): Promise<unknown | undefined>;
  subscribeManagement(listener: (payload: ManagementStatePayload) => void): () => void;
  subscribeSharedRuntimeEvents(listener: (event: any) => void): () => void;
  isManagedWorkspacePath(targetPath: string): Promise<boolean>;
  closeManagement(): Promise<void>;
};

export function emptyAgentsSnapshot(): AgentsSnapshot;

export function createManagementBridge(options: {
  getRindHome?: () => string;
  repoRoot?: string;
  getRuntimePath?: () => string;
  getPython?: () => string | undefined;
  requestRuntime: (method: string, params?: Record<string, unknown>) => Promise<any>;
  ensureRuntimeForWorkspace?: (workspaceRoot?: string) => Promise<void>;
  isSharedRuntime?: () => boolean;
  allowSharedObserver?: boolean;
}): ManagementBridge;
