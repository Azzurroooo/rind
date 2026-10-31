import { CancelledError } from "./errors.js";

export type CancelCallback = () => void;

export class CancellationToken {
  private _cancelled = false;
  private _reason: string | null = null;
  private _callbacks: Set<CancelCallback> | null = new Set();
  private readonly _abortController = new AbortController();

  get isCancelled(): boolean {
    return this._cancelled;
  }

  get reason(): string | null {
    return this._reason;
  }

  get cancelReason(): string | null {
    return this._reason;
  }

  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new CancelledError(this._reason || "Operation was cancelled");
    }
  }

  registerCallback(cb: CancelCallback): () => void {
    if (this._cancelled) {
      try {
        cb();
      } catch {}
      return () => {};
    }
    const callbacks = this._callbacks;
    if (!callbacks) {
      try {
        cb();
      } catch {}
      return () => {};
    }
    callbacks.add(cb);
    return () => {
      callbacks.delete(cb);
    };
  }

  onCancel(cb: CancelCallback): () => void {
    return this.registerCallback(cb);
  }

  wait(): Promise<never> {
    if (this._cancelled) {
      return Promise.reject(new CancelledError(this._reason || "Operation was cancelled"));
    }
    return new Promise<never>((_resolve, reject) => {
      this.registerCallback(() => {
        reject(new CancelledError(this._reason || "Operation was cancelled"));
      });
    });
  }

  sleep(ms: number): Promise<void> {
    this.throwIfCancelled();
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, ms);
      const unsubscribe = this.registerCallback(() => {
        clearTimeout(timer);
        reject(new CancelledError(this._reason || "Operation was cancelled"));
      });
    });
  }

  /** @internal */
  _cancel(reason = "User interrupted"): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    const callbacks = this._callbacks;
    this._callbacks = null;
    this._abortController.abort(new CancelledError(reason));
    if (!callbacks) return;
    for (const cb of callbacks) {
      try {
        cb();
      } catch {}
    }
  }
}

export class CancellationTokenSource {
  readonly token = new CancellationToken();
  private _parentUnsubscribe: (() => void) | null = null;

  constructor(parentToken?: CancellationToken | null) {
    if (parentToken) {
      this._parentUnsubscribe = parentToken.registerCallback(() => {
        this.cancel(parentToken.reason || "Parent token cancelled");
      });
    }
  }

  cancel(reason = "User interrupted"): void {
    this.dispose();
    this.token._cancel(reason);
  }

  dispose(): void {
    if (this._parentUnsubscribe) {
      this._parentUnsubscribe();
      this._parentUnsubscribe = null;
    }
  }
}

export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.available = Math.max(1, Math.trunc(maxConcurrent));
  }

  get locked(): boolean {
    return this.available <= 0;
  }

  tryAcquire(token?: CancellationToken | null): Promise<boolean> {
    if (token?.isCancelled) {
      return Promise.resolve(false);
    }
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>(resolve => {
      let unsubscribe: (() => void) | null = null;
      const waiter = (): void => {
        unsubscribe?.();
        if (token?.isCancelled) {
          this.release();
          resolve(false);
          return;
        }
        resolve(true);
      };
      this.waiters.push(waiter);
      if (token) {
        unsubscribe = token.registerCallback(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
            resolve(false);
          }
        });
      }
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}

export async function tryAcquireSlot(
  semaphore: AsyncSemaphore | null | undefined,
  token?: CancellationToken | null,
): Promise<boolean> {
  if (token?.isCancelled) {
    return false;
  }
  if (!semaphore) {
    return true;
  }
  return await semaphore.tryAcquire(token);
}
