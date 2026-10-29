import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalizePath, resolveProjectRoot, resolveRindHome } from "./paths.js";

export const RIND_DOC_FILENAME = "RIND.md";
export const RIND_DOC_NAME = "RIND.md";
export const MAX_RIND_DOC_BYTES = 32 * 1024;
export const RIND_DOC_BYTE_LIMIT = 32 * 1024;
export const RIND_DOC_TRUNCATION_MARKER = "\n...[RIND.md truncated at 32 KiB byte budget]...";

export interface RindDocEntry {
  readonly scope: "user" | "project";
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly byte_size: number;
}

export function resolveUserDocPath(userHome?: string): string {
  const base = userHome ? canonicalizePath(userHome) : resolveRindHome();
  return path.join(base, RIND_DOC_NAME);
}

export function resolveProjectDocPath(workspaceRoot?: string | null): string {
  return path.join(resolveProjectRoot(workspaceRoot), RIND_DOC_NAME);
}

interface RawRindDoc {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  raw_bytes: number;
  injected_bytes: number;
  truncated: boolean;
  content: string;
  error_type: string | null;
}

function readDoc(scope: "user" | "project", filePath: string): RawRindDoc {
  let exists = false;
  try {
    exists = statSync(filePath).isFile();
  } catch {
    exists = false;
  }
  const doc: RawRindDoc = {
    scope,
    path: filePath,
    exists,
    raw_bytes: 0,
    injected_bytes: 0,
    truncated: false,
    content: "",
    error_type: null,
  };
  if (!exists) return doc;
  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch (exc: any) {
    doc.error_type = exc?.name || "Error";
    return doc;
  }
  const rawBytes = raw.byteLength;
  const truncated = rawBytes > RIND_DOC_BYTE_LIMIT;
  const clipped = truncated ? raw.subarray(0, RIND_DOC_BYTE_LIMIT) : raw;
  const text = clipped.toString("utf8");
  doc.raw_bytes = rawBytes;
  doc.injected_bytes = Buffer.byteLength(text, "utf8");
  doc.truncated = truncated;
  doc.content = text;
  return doc;
}

function renderDoc(doc: RawRindDoc): string {
  const warning = doc.truncated
    ? `[warning] ${doc.scope} RIND.md exceeded ${RIND_DOC_BYTE_LIMIT} bytes and was truncated before injection.\n\n`
    : "";
  return `\n\n--- ${doc.scope}-doc ---\n\n${warning}${doc.content}`;
}

export function buildRindDocContext(
  cwd?: string | null,
): [Record<string, unknown>[], Record<string, unknown>, Record<string, unknown>] {
  const userDoc = readDoc("user", resolveUserDocPath());
  const projectDoc = readDoc("project", resolveProjectDocPath(cwd));
  const docs = [userDoc, projectDoc];
  const injectedDocs = docs.filter((d) => d.exists && !d.error_type);

  const stats: Record<string, unknown> = {
    rind_docs_user_exists: Boolean(userDoc.exists),
    rind_docs_project_exists: Boolean(projectDoc.exists),
    rind_docs_user_bytes: userDoc.raw_bytes,
    rind_docs_project_bytes: projectDoc.raw_bytes,
    rind_docs_user_injected_bytes: userDoc.injected_bytes,
    rind_docs_project_injected_bytes: projectDoc.injected_bytes,
    rind_docs_injected_chars: injectedDocs.reduce((acc, d) => acc + d.content.length, 0),
  };

  const truncatedScopes = docs.filter((d) => d.truncated).map((d) => d.scope);
  const errorType = docs.find((d) => d.error_type)?.error_type ?? null;
  const decisions: Record<string, unknown> = {
    rind_docs_injected: injectedDocs.length > 0,
    rind_docs_truncated: truncatedScopes.length > 0,
    rind_docs_truncated_scopes: truncatedScopes,
    rind_docs_user_path: userDoc.path,
    rind_docs_project_path: projectDoc.path,
    rind_docs_error_type: errorType,
  };

  if (injectedDocs.length === 0) {
    return [[], stats, decisions];
  }

  const content = injectedDocs.map(renderDoc).join("");
  return [
    [
      {
        role: "system",
        content,
        _context_kind: "rind_docs",
      },
    ],
    stats,
    decisions,
  ];
}

export function loadRindDocs(workspaceRoot?: string | null, userHome?: string | null): RindDocEntry[] {
  const userDoc = readDoc("user", resolveUserDocPath(userHome ?? undefined));
  const entries: RindDocEntry[] = [];
  if (userDoc.exists && !userDoc.error_type && userDoc.content.trim()) {
    entries.push({
      scope: "user",
      path: userDoc.path,
      content: userDoc.content.trim(),
      truncated: userDoc.truncated,
      byte_size: userDoc.raw_bytes,
    });
  }
  if (workspaceRoot) {
    const projectPath = resolveProjectDocPath(workspaceRoot);
    if (path.resolve(projectPath) !== path.resolve(userDoc.path)) {
      const projectDoc = readDoc("project", projectPath);
      if (projectDoc.exists && !projectDoc.error_type && projectDoc.content.trim()) {
        entries.push({
          scope: "project",
          path: projectDoc.path,
          content: projectDoc.content.trim(),
          truncated: projectDoc.truncated,
          byte_size: projectDoc.raw_bytes,
        });
      }
    }
  }
  return entries;
}

export function formatRindDocsMessage(docs: readonly RindDocEntry[]): string {
  if (!docs || docs.length === 0) return "";
  return docs
    .map((doc) => {
      const warning = doc.truncated
        ? `[warning] ${doc.scope} RIND.md exceeded ${RIND_DOC_BYTE_LIMIT} bytes and was truncated before injection.\n\n`
        : "";
      return `\n\n--- ${doc.scope}-doc ---\n\n${warning}${doc.content}`;
    })
    .join("");
}
