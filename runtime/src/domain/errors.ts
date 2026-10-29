export type FailureStatus = "failed" | "retryable_error" | "timed_out" | "rejected" | "unavailable";
export type ToolEventStatus =
  | "completed"
  | "error"
  | "cancelled"
  | "failed"
  | "timed_out"
  | "rejected"
  | "unavailable";
export type ErrorSource = "provider" | "tool" | "persistence" | "runtime";

export class BoundaryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly source: ErrorSource;
  readonly status: FailureStatus;
  readonly details: Record<string, unknown>;
  private readonly _customErrorType?: string;

  constructor(
    message: string,
    options: {
      code?: string | null;
      retryable?: boolean;
      source?: ErrorSource;
      status?: FailureStatus;
      errorType?: string | null;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code || "boundary_error";
    this.retryable = Boolean(options.retryable);
    this.source = options.source || "runtime";
    this.status = options.status || (this.retryable ? "retryable_error" : "failed");
    this.details = options.details ? { ...options.details } : {};
    if (options.errorType) {
      this._customErrorType = options.errorType;
    }
  }

  get failureStatus(): FailureStatus {
    return this.status;
  }

  get errorType(): string {
    return this._customErrorType || this.constructor.name;
  }

  get error_type(): string {
    return this.errorType;
  }
}

export class ProviderError extends BoundaryError {
  readonly statusCode?: number;
  readonly provider?: string;

  constructor(
    message: string,
    options: {
      code?: string | null;
      retryable?: boolean;
      status?: FailureStatus;
      errorType?: string | null;
      statusCode?: number;
      provider?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: options.code || "provider_error",
      retryable: options.retryable,
      source: "provider",
      status: options.status,
      errorType: options.errorType,
      details: options.details,
      cause: options.cause,
    });
    this.statusCode = options.statusCode;
    this.provider = options.provider;
  }
}

export class PersistenceError extends BoundaryError {
  constructor(
    message: string,
    options: {
      code?: string | null;
      retryable?: boolean;
      status?: FailureStatus;
      errorType?: string | null;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: options.code || "persistence_error",
      retryable: options.retryable ?? false,
      source: "persistence",
      status: options.status,
      errorType: options.errorType,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class InputQueueError extends Error {
  readonly errorType: string;

  constructor(message: string, errorType = "InputQueueError") {
    super(message);
    this.name = "InputQueueError";
    this.errorType = errorType;
  }
}

export class CancelledError extends Error {
  constructor(message?: string | null) {
    super(message || "Operation was cancelled");
    this.name = "CancelledError";
  }

  get reason(): string {
    return this.message;
  }
}
