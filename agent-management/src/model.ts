export type Principal = { kind: "user" } | { kind: "manager"; sessionId: string } | { kind: "agent"; sessionId: string };
// addedBy: the member that added this one with delegate; worktreeOf: the repository its folder is a worktree of.
export interface Agent { id: string; name: string; canonicalWorkspace: string; adapter: string; hint?: string; skillRefs?: string[]; addedBy?: string; worktreeOf?: string }
// A deleted team with history keeps its record as a read-only archive.
export interface Team { id: string; name: string; leaderAgentId?: string; createRoot: string; archive?: { at: string; members: Record<string, string> } }
export interface Membership { teamId: string; agentId: string; reportsToAgentId?: string; position?: string; responsibility?: string }
export interface Report { outcome: string; summary: string; evidence: string[]; artifacts: string[]; nextAction?: string }
export interface Task {
  id: string; teamId: string; assigneeAgentId: string; createdBy: string; brief: string;
  status: "queued" | "running" | "done" | "blocked" | "needs_attention" | "cancelled";
  parentTaskId?: string; blockedOn?: { responder: string; action: string };
  report?: Report; error?: string; dispatch?: boolean;
  priority?: "high" | "low";
  deliveredAt?: string; reworkOf?: string;
  // Delegated from a conversation rather than a task: its result goes back to that conversation.
  originSessionId?: string;
  // What the next run is told; the first run is told the brief.
  resume?: string;
  // Its result was handed to whoever delegated it.
  returned?: boolean;
  review?: { decision: "accepted" | "rework"; at: string; feedback?: string; reworkTaskId?: string };
}
// Destructive requests from the Manager wait in the user's Inbox.
// What the Manager changed on its own (a member's model), shown in the user's Inbox until dismissed.
export interface Notice { id: string; teamId: string; agentId: string; title: string; createdAt: string }
export interface Approval { id: string; kind: "deleteTeam" | "cancelRun"; teamId: string; runId?: string; taskId?: string; title: string; requestedBy: string; createdAt: string }
// released: the session's team or membership ended while a window showed it; it is dropped on detach.
export interface Session { id: string; agentId: string; teamId?: string; runtimeSessionId: string; origin: "managed" | "direct"; shared?: boolean; released?: boolean }
export interface Run {
  id: string; sessionId: string; taskId?: string; status: "starting" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt: string; lastObservedAt: string; hostSequence: number; needsInput?: boolean;
}
export interface Note { id: string; taskId: string; author: string; text: string; createdAt: string }
// file: where the copy lives, relative to the artifacts directory.
export interface Artifact { id: string; taskId: string; name: string; file: string; size: number; sha256: string }
// Results waiting for a conversation to be open, keyed by its session ID.
export interface Delivery { texts: string[] }
export interface State {
  seq: number; agents: Record<string, Agent>; teams: Record<string, Team>; memberships: Record<string, Membership>;
  tasks: Record<string, Task>; sessions: Record<string, Session>; runs: Record<string, Run>;
  notes: Record<string, Note>; artifacts: Record<string, Artifact>; approvals: Record<string, Approval>; notices: Record<string, Notice>;
  deliveries: Record<string, Delivery>;
  receipts: Record<string, { input: string; result: unknown; at?: number }>;
}
export const emptyState = (): State => ({ seq: 0, agents: {}, teams: {}, memberships: {}, tasks: {}, sessions: {}, runs: {}, notes: {}, artifacts: {}, approvals: {}, notices: {}, deliveries: {}, receipts: {} });
// A member's model is its workspace's folder default, kept by the Rind runtime.
export type FolderDefaults = (method: "get" | "set" | "unset" | "resolve" | "models", params?: Record<string, unknown>) => Promise<any>;
export class ManagementError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export function requireValue(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new ManagementError(code, message, details);
}
export function text(value: unknown, label: string, limit = 16000): string {
  requireValue(typeof value === "string" && value.trim() && value.length <= limit, "INVALID_INPUT", label + " is required (maximum " + limit + " characters).");
  return value.trim();
}
export const memberKey = (teamId: string, agentId: string) => teamId + "/" + agentId;
export const activeRun = (run: Run) => ["starting", "running", "unknown"].includes(run.status);
export interface AdapterInput { agent: Agent; session: Session; task: Task; input: string; instructions: string; externalTools: object }
export interface AdapterEvent { type: "working"; sequence: number }
export interface AdapterHandle { runtimeSessionId: string; completion: Promise<{ content: string }>; cancel(): Promise<void> }
export interface Adapter { start(input: AdapterInput, emit: (event: AdapterEvent) => void): Promise<AdapterHandle> }
