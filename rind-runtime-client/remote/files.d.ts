export type ProjectFileNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
};

export type ProjectFileListing = {
  path: string;
  entries: ProjectFileNode[];
  truncated: boolean;
};

export type ProjectFilePreview = {
  path: string;
  name: string;
  kind: "text" | "image" | "unsupported";
  size: number;
  content?: string;
  dataUrl?: string;
  mimeType?: string;
  truncated?: boolean;
  message?: string;
};

export declare function listProjectFiles(root: string, requestedPath: unknown): Promise<ProjectFileListing>;
export declare function previewProjectFile(root: string, requestedPath: unknown): Promise<ProjectFilePreview>;
export declare function writeWorkspaceUpload(
  workspace: string,
  params?: Record<string, unknown>,
): Promise<{ path: string; size: number }>;
export declare function workspaceFileRequest(
  workspace: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown>;
