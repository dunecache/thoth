import { nextBackoffDelay, resetBackoffDelay } from './backoff.js';

/**
 * What a scheduled run concluded.
 *
 * - `success` — progress was made; reset the delay.
 * - `retry` — transient failure; back off and try again.
 * - `halt` — retrying cannot help, so stop arming the timer. The scheduler
 *   stays started, so an explicit `trigger()` still runs the task once more
 *   once the underlying problem is fixed.
 * - `skipped` — nothing to do; keep the current delay.
 *
 * Omitting the result (or returning `void`) counts as `success`.
 */
export type TaskOutcome = 'success' | 'retry' | 'halt' | 'skipped';

export interface RetrySchedulerOptions {
  /**
   * Work to run on every tick.
   *
   * A task that catches its own errors must report them as `retry` to
   * participate in the backoff; throwing has the same effect.
   */
  task: () => Promise<TaskOutcome | void>;
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
    let outcome: TaskOutcome = 'success';
    try {
      outcome = (await this.options.task()) ?? 'success';
    } catch (error) {
      outcome = 'retry';
      console.warn('Thoth: retry task failed', error);
    }
    this.applyOutcome(outcome);
    this.running = false;
    // A halt wins over pending. Otherwise a user editing files while their
    // credential is rejected would set `pending` on every change and the
    // scheduler would immediately re-run via the zero-delay branch below,
    // hammering a server that has already refused the request.
    if (outcome === 'halt') {
      this.pending = false;
      this.clearTimer();
      return;
    }
    if (this.pending) {
      this.pending = false;
      // Re-run shortly to handle changes that arrived during the run
      this.schedule(0);
    } else {
      this.schedule(this.delayMs);
    }
  }

  private applyOutcome(outcome: TaskOutcome): void {
    if (outcome === 'success') {
      this.delayMs = resetBackoffDelay(this.baseIntervalMs);
      return;
    }
    if (outcome === 'retry') {
      this.delayMs = nextBackoffDelay(
        this.delayMs,
        this.baseIntervalMs,
        this.options.maxDelayMs ?? 600_000
      );
    }
    // `halt` and `skipped` leave the delay untouched: neither should
    // penalise the interval used once the loop resumes.
  }
}
