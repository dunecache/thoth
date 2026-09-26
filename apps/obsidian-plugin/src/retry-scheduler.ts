import { nextBackoffDelay, resetBackoffDelay } from './backoff.js';

export interface RetrySchedulerOptions {
  /**
   * Work to run on every tick.
   *
   * Returning `false` marks the run as failed and triggers the backoff, so a
   * task that catches its own errors still participates in it. Throwing has
   * the same effect. `void` and `true` count as success.
   */
  task: () => Promise<boolean | void>;
  /** Delay between successful ticks. */
  baseIntervalMs?: number;
  /** Upper bound for the backoff delay. */
  maxDelayMs?: number;
}

/**
 * Runs an injected task periodically. After a failure the next run is
 * delayed exponentially (base, 2x, 4x, ...) up to maxDelayMs; a success
 * resets the delay. Exposed for tests that need to inject overrides.
 */
export class RetryScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private delayMs: number;
  private started = false;
  private running = false;
  private pending = false;

  constructor(
    private readonly options: RetrySchedulerOptions,
    private readonly setTimeoutFn: typeof setTimeout = globalThis.setTimeout.bind(
      globalThis
    ),
    private readonly clearTimeoutFn: typeof clearTimeout = globalThis.clearTimeout.bind(
      globalThis
    )
  ) {
    this.baseIntervalMs = options.baseIntervalMs ?? 60_000;
    this.previousBaseIntervalMs = this.baseIntervalMs;
    this.delayMs = this.baseIntervalMs;
  }

  private baseIntervalMs: number;
  private previousBaseIntervalMs: number;

  /** Clears any pending timer. */
  private clearTimer(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
  }

  /** Starts the periodic loop. Safe to call multiple times. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(this.delayMs);
  }

  /** Stops the periodic loop. Safe to call multiple times. */
  stop(): void {
    this.started = false;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Updates the delay used after a successful run.
   *
   * Held as scheduler state rather than written back into the options object,
   * which is injected by the caller. An in-progress backoff is preserved so
   * switching intervals does not shorten an existing delay.
   */
  updateBaseInterval(ms: number): void {
    const base = Math.max(1, ms);
    this.baseIntervalMs = base;
    if (this.delayMs === this.previousBaseIntervalMs) {
      this.delayMs = base;
    }
    this.previousBaseIntervalMs = base;
  }

  /** Runs the task immediately (manual sync trigger), then reschedules. */
  async trigger(): Promise<void> {
    this.clearTimer();
    await this.runOnce();
  }

  /**
   * Schedules a run after delayMs, cancelling any pending timer.
   * Repeated calls debounce the run (trailing edge).
   */
  scheduleSoon(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      void this.runOnce();
    }, delayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      void this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    let succeeded = true;
    try {
      const result = await this.options.task();
      succeeded = result !== false;
      if (succeeded) {
        this.delayMs = resetBackoffDelay(this.baseIntervalMs);
      }
    } catch (error) {
      succeeded = false;
      console.warn('Thoth: retry task failed', error);
    }
    if (!succeeded) {
      this.delayMs = nextBackoffDelay(
        this.delayMs,
        this.baseIntervalMs,
        this.options.maxDelayMs ?? 600_000
      );
    }
    this.running = false;
    if (this.pending) {
      this.pending = false;
      // Re-run shortly to handle changes that arrived during the run
      this.schedule(0);
    } else {
      this.schedule(this.delayMs);
    }
  }
}
