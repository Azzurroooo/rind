export type Principal = { kind: "user" } | { kind: "manager"; sessionId: string } | { kind: "agent"; sessionId: string };
export interface Agent { id: string; name: string; canonicalWorkspace: string; adapter: string; hint?: string; skillRefs?: string[] }
export interface Team { id: string; name: string; leaderAgentId?: string; createRoot: string }
export interface Membership { teamId: string; agentId: string; reportsToAgentId?: string; position?: string; responsibility?: string }
export interface Report { outcome: string; summary: string; evidence: string[]; artifacts: string[]; nextAction?: string }
export interface Task {
  id: string; teamId: string; assigneeAgentId: string; createdBy: string; brief: string;
  status: "queued" | "running" | "done" | "blocked" | "needs_attention" | "cancelled";
  parentTaskId?: string; blockedOn?: { responder: string; action: string };
  report?: Report; error?: string; dispatch?: boolean;
  priority?: "high" | "low";
}
export interface Session { id: string; agentId: string; teamId?: string; runtimeSessionId: string; origin: "managed" | "direct"; shared?: boolean }
export interface Run {
  id: string; sessionId: string; taskId?: string; status: "starting" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt: string; lastObservedAt: string; hostSequence: number; needsInput?: boolean;
}
export interface Note { id: string; taskId: string; author: string; text: string; createdAt: string }
export interface Artifact { id: string; taskId: string; name: string; size: number; sha256: string }
export interface State {
  seq: number; agents: Record<string, Agent>; teams: Record<string, Team>; memberships: Record<string, Membership>;
  tasks: Record<string, Task>; sessions: Record<string, Session>; runs: Record<string, Run>;
  notes: Record<string, Note>; artifacts: Record<string, Artifact>;
  receipts: Record<string, { input: string; result: unknown; at?: number }>;
}
export const emptyState = (): State => ({ seq: 0, agents: {}, teams: {}, memberships: {}, tasks: {}, sessions: {}, runs: {}, notes: {}, artifacts: {}, receipts: {} });
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
export interface AdapterInput { agent: Agent; session: Session; task: Task; instructions: string; externalTools: object }
export interface AdapterEvent { type: "working" | "needs_input"; sequence: number }
export interface AdapterHandle { runtimeSessionId: string; completion: Promise<{ content: string }>; cancel(): Promise<void> }
export interface Adapter { start(input: AdapterInput, emit: (event: AdapterEvent) => void): Promise<AdapterHandle> }
