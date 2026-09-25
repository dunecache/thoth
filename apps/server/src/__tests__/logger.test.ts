import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import { createRouter } from '../routes/router.js';

/**
 * The Worker runtime has no `process` global. Vitest runs in Node, so a
 * stray `process.env` reference passes locally and only throws once
 * deployed. These tests remove `process` to reproduce the Worker runtime.
 */
const originalProcess = globalThis.process;

function withoutProcess<T>(run: () => T): T {
  // @ts-expect-error deliberately simulating the Worker runtime
  delete globalThis.process;
  try {
    return run();
  } finally {
    globalThis.process = originalProcess;
  }
}

afterEach(() => {
  globalThis.process = originalProcess;
});

describe('logger', () => {
  it('constructs without a process global', () => {
    const logger = withoutProcess(() => createLogger({ ENVIRONMENT: 'production' }));
    expect(() => logger.info('hello', { requestId: 'r1' })).not.toThrow();
  });

  it('constructs for an unset ENVIRONMENT without a process global', () => {
    expect(() =>
      withoutProcess(() => createLogger({}))
    ).not.toThrow();
  });

  it('still reports errors when the environment is unset', () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => {
      errors.push(line);
    };
    try {
      withoutProcess(() => {
        const logger = createLogger({});
        logger.error('boom', { requestId: 'r1' }, new Error('kaboom'));
      });
    } finally {
      console.error = originalError;
    }
    expect(errors).toHaveLength(1);
    const entry = JSON.parse(String(errors[0])) as {
      level: string;
      error: { message: string; stack?: string };
    };
    expect(entry.level).toBe('error');
    expect(entry.error.message).toBe('kaboom');
    // Stack traces stay out of production logs.
    expect(entry.error.stack).toBeUndefined();
  });
});

describe('router', () => {
  it('serves requests with no process global and no ENVIRONMENT binding', async () => {
    const router = withoutProcess(() =>
      createRouter({ VERSION: '0.1.0' })
    );

    const res = await router(new Request('https://worker.test/health'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });
});
