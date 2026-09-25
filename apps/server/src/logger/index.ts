/**
 * Structured logging for the Worker.
 *
 * Logging is gated on the `ENVIRONMENT` binding only. The Worker runtime has
 * no `process` global, so consulting `process.env` would throw a
 * ReferenceError on the first request that reached it. Stack traces are
 * likewise confined to development so production responses and logs never
 * carry vault paths or contents.
 */

export interface LogContext {
  requestId?: string;
  vaultId?: string;
  revision?: number;
}

export interface Logger {
  info(message: string, ctx?: LogContext): void;
  error(message: string, ctx?: LogContext, error?: unknown): void;
}

export function createLogger(env: { ENVIRONMENT?: string }): Logger {
  const isDev = env.ENVIRONMENT === 'development';

  return {
    info: (message: string, ctx?: LogContext) => {
      if (isDev) {
        console.log(JSON.stringify({ level: 'info', message, ...ctx }));
      }
    },
    error: (message: string, ctx?: LogContext, error?: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          message,
          ...ctx,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: isDev ? error.stack : undefined,
                }
              : error,
        })
      );
    },
  };
}
