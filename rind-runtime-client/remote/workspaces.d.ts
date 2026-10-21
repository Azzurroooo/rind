export type WorkspaceSessionSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  workspaceRoot: string;
  hasUserMessage: boolean;
};

export type WorkspaceProjectSummary = {
  path: string;
  name: string;
  available: boolean;
  sessions: WorkspaceSessionSummary[];
  totalSessions: number;
};

export function asObject(value: unknown): Record<string, unknown> | null;
export function readJsonObject(filePath: string): Promise<Record<string, unknown>>;
export function writeJsonObject(filePath: string, value: Record<string, unknown>, secret?: boolean): Promise<void>;
export function storedPath(path: string): string;
export function samePath(left: string, right: string): boolean;
export function uniquePaths(paths: string[]): string[];
export function isDirectory(path: string): Promise<boolean>;
export function canonicalDirectory(path: string): Promise<string>;
export function sharedWorkspacesPath(rindHome: string): string;
export function readSharedWorkspaces(
  rindHome: string,
  fallbackConfigFile?: string,
): Promise<{ projects: string[]; activeProjectPath: string; exists: boolean }>;
export function writeSharedWorkspaces(
  rindHome: string,
  state?: { projects?: string[]; activeProjectPath?: string },
): Promise<{ projects: string[]; activeProjectPath: string }>;
export function registerSharedWorkspace(
  rindHome: string,
  workspacePath: string,
  options?: { setActive?: boolean },
): Promise<{ projects: string[]; activeProjectPath: string }>;
export function hasPersistedUserMessage(rindHome: string, sessionId: string): Promise<boolean>;
export function readSessionIndex(sessionIndexFile: string): Promise<WorkspaceSessionSummary[]>;
export function projectSummaryForPath(
  path: string,
  sessions: WorkspaceSessionSummary[],
): Promise<WorkspaceProjectSummary>;
export function listAvailableWorkspaces(
  rindHome: string,
  options?: {
    fallbackConfigFile?: string;
    isManagedWorkspacePath?: (path: string) => Promise<boolean>;
  },
): Promise<{
  availableProjects: WorkspaceProjectSummary[];
  registeredWorkspaces: string[];
  activeProjectPath: string;
}>;
