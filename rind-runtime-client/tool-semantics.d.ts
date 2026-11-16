export type TaskDisplayState = "running" | "error" | "cancelled" | "success" | "";

export function partialJsonStrings(text: unknown): Record<string, string>;

export function parseStructuredToolPayload(value: unknown): {
  structured: boolean;
  payload: Record<string, unknown>;
  parsed: unknown;
};

export function classifyTaskStatus(status: unknown): TaskDisplayState;

export function toolTruncationMeta(meta: unknown): {
  truncated: boolean;
  totalBytes: number | null;
  nextOffset: number | null;
  hasMorePages: boolean;
};

export function unwrapNestedToolData(rawData: unknown): Record<string, unknown>;
