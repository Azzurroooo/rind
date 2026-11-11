import { readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalizePath, resolveProjectRoot, resolveRindHome } from "./paths.js";
import { fileStatSignature } from "./persistence/atomic-files.js";

export const RIND_DOC_NAME = "RIND.md";
export const RIND_DOC_BYTE_LIMIT = 32 * 1024;

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

const DOC_CACHE = new Map<string, [string, RawRindDoc]>();

function readDoc(scope: "user" | "project", filePath: string): RawRindDoc {
  const sig = fileStatSignature(filePath);
  const cacheKey = `${scope}:${filePath}`;
  if (!sig) {
    DOC_CACHE.delete(cacheKey);
    return {
      scope,
      path: filePath,
      exists: false,
      raw_bytes: 0,
      injected_bytes: 0,
      truncated: false,
      content: "",
      error_type: null,
    };
  }
  const cached = DOC_CACHE.get(cacheKey);
  if (cached && cached[0] === sig) {
    return cached[1];
  }
  const doc: RawRindDoc = {
    scope,
    path: filePath,
    exists: true,
    raw_bytes: 0,
    injected_bytes: 0,
    truncated: false,
    content: "",
    error_type: null,
  };
  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch (exc: any) {
    if (exc?.code === "EISDIR") {
      doc.exists = false;
      return doc;
    }
    doc.error_type = exc?.name || "Error";
    return doc;
  }
  const rawBytes = raw.byteLength;
  const truncated = rawBytes > RIND_DOC_BYTE_LIMIT;
  const clipped = truncated ? raw.subarray(0, RIND_DOC_BYTE_LIMIT) : raw;
  const text = truncated ? new StringDecoder("utf8").write(clipped) : clipped.toString("utf8");
  doc.raw_bytes = rawBytes;
  doc.injected_bytes = Buffer.byteLength(text, "utf8");
  doc.truncated = truncated;
  doc.content = text;
  if (!DOC_CACHE.has(cacheKey) && DOC_CACHE.size >= 16) {
    const oldest = DOC_CACHE.keys().next().value;
    if (oldest !== undefined) DOC_CACHE.delete(oldest);
  }
  DOC_CACHE.set(cacheKey, [sig, doc]);
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
