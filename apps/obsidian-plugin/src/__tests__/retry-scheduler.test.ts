import { describe, expect, it, vi } from 'vitest';

import { RetryScheduler, type TaskOutcome } from '../retry-scheduler.js';

interface FakeTimer {
  id: number;
  fn: () => void;
  delay: number;
}

function createScheduler(
  task: () => Promise<TaskOutcome | void>,
  options: { baseIntervalMs?: number; maxDelayMs?: number } = {}
) {
  const timers: FakeTimer[] = [];
  let nextId = 1;

  const setFake = (fn: () => void, delay: number): number => {
    const id = nextId++;
    timers.push({ id, fn, delay });
    return id;
  };
  const clearFake = (id: number): void => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) {
      timers.splice(index, 1);
    }
  };

  const scheduler = new RetryScheduler(
    { task, baseIntervalMs: 1000, maxDelayMs: 60_000, ...options },
    setFake as typeof setTimeout,
    clearFake as typeof clearTimeout
  );
  return { scheduler, timers };
}

function fire(timers: FakeTimer[]): void {
  const timer = timers.shift();
  if (timer) {
    timer.fn();
  }
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('RetryScheduler', () => {
  it('schedules the first tick with the base delay on start', () => {
    const { scheduler, timers } = createScheduler(() => Promise.resolve());
    scheduler.start();

    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(1000);

    scheduler.stop();
  });

  it('doubles the delay after a failure and resets after success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const { scheduler, timers } = createScheduler(() => {
      if (fail) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve('success' as const);
    });

    scheduler.start();
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(2000);

    fail = false;
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(1000);

    scheduler.stop();
    warn.mockRestore();
  });

  it('caps the delay at maxDelayMs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { scheduler, timers } = createScheduler(
      () => Promise.reject(new Error('x')),
      { baseIntervalMs: 1000, maxDelayMs: 5000 }
    );

    scheduler.start();
    for (let i = 0; i < 4; i += 1) {
      fire(timers);
      await flush();
    }
    expect(timers[0].delay).toBe(5000);

    scheduler.stop();
    warn.mockRestore();
  });

  it('trigger runs the task immediately', async () => {
    let ran = 0;
    const { scheduler } = createScheduler(() => {
      ran += 1;
      return Promise.resolve();
    });

    scheduler.start();
    await scheduler.trigger();
    expect(ran).toBe(1);

    scheduler.stop();
  });

  it('stop cancels pending timers', () => {
    const { scheduler, timers } = createScheduler(async () => {});
    scheduler.start();
    scheduler.stop();

    expect(timers).toHaveLength(0);
  });

  it('start is idempotent', () => {
    const { scheduler, timers } = createScheduler(async () => {});
    scheduler.start();
    scheduler.start();

    expect(timers).toHaveLength(1);

    scheduler.stop();
  });

  it('backs off when the task reports retry without throwing', async () => {
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve('retry')
    );

    scheduler.start();
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(2000);

    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(4000);

    scheduler.stop();
  });

  it('resets the delay after a successful run', async () => {
    let outcome: TaskOutcome = 'retry';
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve(outcome)
    );

    scheduler.start();
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(2000);

    outcome = 'success';
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(1000);

    scheduler.stop();
  });

  it('leaves the delay untouched when a run is skipped', async () => {
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve('skipped' as const)
    );

    scheduler.start();
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(1000);

    scheduler.stop();
  });

  it('applies an updated base interval to later schedules', async () => {
    const { scheduler, timers } = createScheduler(async () => {});

    scheduler.start();
    scheduler.updateBaseInterval(5000);
    fire(timers);
    await flush();

    expect(timers[0].delay).toBe(5000);

    scheduler.stop();
  });

  it('does not shorten an in-progress backoff when the interval changes', async () => {
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve('retry' as const)
    );

    scheduler.start();
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(2000);

    // Realtime came online and raised the idle interval; the current
    // backoff must stand rather than snapping back to the base.
    scheduler.updateBaseInterval(300_000);
    fire(timers);
    await flush();
    expect(timers[0].delay).toBe(4000);

    scheduler.stop();
  });

  it('stops arming the timer after a halt', async () => {
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve('halt' as const)
    );

    scheduler.start();
    fire(timers);
    await flush();

    // The run consumed the only timer and nothing replaced it.
    expect(timers).toHaveLength(0);

    scheduler.stop();
  });

  it('does not back off when halting', async () => {
    const { scheduler, timers } = createScheduler(() =>
      Promise.resolve('halt' as const)
    );

    scheduler.start();
    fire(timers);
    await flush();
    // A halt is not a transient failure, so the interval used when the loop
    // resumes must not have been penalised.
    scheduler.stop();
    scheduler.start();
    expect(timers[0].delay).toBe(1000);
  });

  it('re-runs after a change arrives during a successful run', async () => {
    // Positive control for the test below: the same mid-run trigger must arm
    // an immediate re-run when the outcome is not a halt.
    let runs = 0;
    let self: RetryScheduler | null = null;
    const { scheduler, timers } = createScheduler(() => {
      runs += 1;
      // Simulates a local change arriving while the run is in flight.
      if (self) {
        void self.trigger();
      }
      return Promise.resolve('success' as const);
    });
    self = scheduler;

    scheduler.start();
    fire(timers);
    await flush();

    // The mid-run trigger set `pending`, which arms an immediate follow-up.
    expect(runs).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(0);

    scheduler.stop();
  });

  it('does not re-run when a change arrived during a halted run', async () => {
    // The regression this guards: a user editing while their credential is
    // rejected sets `pending`, and the zero-delay branch would re-run
    // immediately, hammering a server that already refused the request.
    let runs = 0;
    let self: RetryScheduler | null = null;
    const { scheduler, timers } = createScheduler(() => {
      runs += 1;
      if (self) {
        void self.trigger();
      }
      return Promise.resolve('halt' as const);
    });
    self = scheduler;

    scheduler.start();
    fire(timers);
    await flush();

    expect(runs).toBe(1);
    expect(timers).toHaveLength(0);

    scheduler.stop();
  });

  it('runs once more after a halt when explicitly triggered', async () => {
    // Recovery path: re-registering clears the halt, and trigger() must
    // re-arm the loop even though no timer was pending.
    let outcome: TaskOutcome = 'halt';
    let runs = 0;
    const { scheduler, timers } = createScheduler(() => {
      runs += 1;
      return Promise.resolve(outcome);
    });

    scheduler.start();
    fire(timers);
    await flush();
    expect(runs).toBe(1);
    expect(timers).toHaveLength(0);

    outcome = 'success';
    await scheduler.trigger();
    await flush();
    expect(runs).toBe(2);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(1000);

    scheduler.stop();
  });
});
